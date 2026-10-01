import { promises as fs } from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";

import { writeFileAtomic } from "../atomic-file.js";
import type { AgentTimelineItem } from "./agent-sdk-types.js";
import { InMemoryAgentTimelineStore } from "./agent-timeline-store.js";
import type {
  AgentTimelineFetchOptions,
  AgentTimelineFetchResult,
  AgentTimelineRow,
  AgentTimelineStore,
} from "./agent-timeline-store-types.js";

const DEFAULT_MAX_ROWS_PER_AGENT = 4000;
const DEFAULT_MAX_BYTES_PER_AGENT = 24 * 1024 * 1024;
/** Replacements accumulate in the append log instead of rewriting; past this, fold them away. */
const COMPACT_AFTER_UPDATE_RECORDS = 512;

type TimelineRecord = { row: AgentTimelineRow } | { update: AgentTimelineRow };

interface AgentTimelineFileState {
  /** Rows as last persisted; buffered records are layered over them for reads. */
  persisted: AgentTimelineRow[];
  pending: TimelineRecord[];
  /** Serialized bytes of `persisted`, used to decide when a compaction must trim. */
  bytes: number;
  pendingUpdates: number;
  pendingBytes: number;
  needsCompaction: boolean;
  loading: Promise<void> | null;
  lane: Promise<void>;
}

export interface FileAgentTimelineStoreOptions {
  maxRowsPerAgent?: number;
  maxBytesPerAgent?: number;
  /** Test seam: lets a test fail exactly one writer without breaking reads. */
  writeChunk?: (input: {
    filePath: string;
    contents: string;
    mode: "append" | "replace";
  }) => Promise<void>;
}

function fileNameForAgent(agentId: string): string {
  return `agent-${Buffer.from(agentId, "utf8").toString("base64url")}.jsonl`;
}

function cloneRow(row: AgentTimelineRow): AgentTimelineRow {
  return { ...row, item: structuredClone(row.item) };
}

function serializeRecord(record: TimelineRecord): string {
  return `${JSON.stringify(record)}\n`;
}

function serializeRows(rows: readonly AgentTimelineRow[]): string {
  return rows.map((row) => serializeRecord({ row })).join("");
}

function parseRecord(line: string): TimelineRecord | null {
  if (line.trim().length === 0) {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    // A write interrupted mid-append leaves a partial trailing line.
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const candidate = parsed as { row?: unknown; update?: unknown };
  const raw = candidate.update ?? candidate.row;
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const row = raw as AgentTimelineRow;
  if (
    typeof row.seq !== "number" ||
    !Number.isInteger(row.seq) ||
    row.seq <= 0 ||
    typeof row.timestamp !== "string" ||
    typeof row.item !== "object" ||
    row.item === null
  ) {
    return null;
  }
  return candidate.update ? { update: row } : { row };
}

function mergeRecords(
  persisted: readonly AgentTimelineRow[],
  records: readonly TimelineRecord[],
): AgentTimelineRow[] {
  const rows = persisted.map(cloneRow);
  for (const record of records) {
    const incoming = "update" in record ? record.update : record.row;
    const index = rows.findIndex((candidate) => candidate.seq === incoming.seq);
    if (index >= 0) {
      rows[index] = incoming;
    } else {
      rows.push(incoming);
    }
  }
  rows.sort((left, right) => left.seq - right.seq);
  return rows;
}

function lastAssistantMessage(rows: readonly AgentTimelineRow[]): string | null {
  const chunks: string[] = [];
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const item = rows[index]?.item;
    if (!item) {
      continue;
    }
    if (item.type !== "assistant_message") {
      if (chunks.length > 0) break;
      continue;
    }
    chunks.push(item.text);
  }
  return chunks.length > 0 ? chunks.toReversed().join("") : null;
}

/**
 * Durable canonical timeline rows, one append-only JSONL file per agent.
 *
 * The store this replaces rewrote an agent's whole transcript on every buffered
 * update, and that write amplification is why it left production. Here a row
 * costs one `appendFile` of its own bytes; replacements and retention trims are
 * written as records and folded away by a compaction rewrite only once enough of
 * them accumulate. Reads layer buffered records over the persisted rows, so a
 * failed write drops exactly the records it failed to persist and never leaves a
 * row visible that is not on disk.
 */
export class FileAgentTimelineStore implements AgentTimelineStore {
  private readonly states = new Map<string, AgentTimelineFileState>();
  private readonly maxRowsPerAgent: number;
  private readonly maxBytesPerAgent: number;
  private readonly writeChunk: NonNullable<FileAgentTimelineStoreOptions["writeChunk"]>;

  constructor(
    private readonly directory: string,
    options?: FileAgentTimelineStoreOptions,
  ) {
    this.maxRowsPerAgent = options?.maxRowsPerAgent ?? DEFAULT_MAX_ROWS_PER_AGENT;
    this.maxBytesPerAgent = options?.maxBytesPerAgent ?? DEFAULT_MAX_BYTES_PER_AGENT;
    this.writeChunk = options?.writeChunk ?? ((input) => this.writeChunkToDisk(input));
  }

  private async writeChunkToDisk(input: {
    filePath: string;
    contents: string;
    mode: "append" | "replace";
  }): Promise<void> {
    if (input.mode === "append") {
      await fs.mkdir(this.directory, { recursive: true });
      await fs.appendFile(input.filePath, input.contents, "utf8");
      return;
    }
    await writeFileAtomic(input.filePath, input.contents);
  }

  async appendCommitted(
    agentId: string,
    item: AgentTimelineItem,
    options?: { timestamp?: string; turnId?: string },
  ): Promise<AgentTimelineRow> {
    const state = await this.load(agentId);
    const rows = this.readRows(state);
    const row: AgentTimelineRow = {
      seq: (rows.at(-1)?.seq ?? 0) + 1,
      timestamp: options?.timestamp ?? new Date().toISOString(),
      item: structuredClone(item),
      ...(options?.turnId ? { turnId: options.turnId } : {}),
    };
    this.buffer(state, [{ row }], 0);
    await this.flush(agentId, state);
    return cloneRow(row);
  }

  async fetchCommitted(
    agentId: string,
    options?: AgentTimelineFetchOptions,
  ): Promise<AgentTimelineFetchResult> {
    const rows = await this.getCommittedRows(agentId);
    const memory = new InMemoryAgentTimelineStore();
    memory.initialize(agentId, { rows, nextSeq: (rows.at(-1)?.seq ?? 0) + 1 });
    return memory.fetch(agentId, options);
  }

  async getLatestCommittedSeq(agentId: string): Promise<number> {
    return (await this.getCommittedRows(agentId)).at(-1)?.seq ?? 0;
  }

  async getCommittedRows(agentId: string): Promise<AgentTimelineRow[]> {
    const state = await this.load(agentId);
    return this.readRows(state);
  }

  async getLastItem(agentId: string): Promise<AgentTimelineItem | null> {
    const item = (await this.getCommittedRows(agentId)).at(-1)?.item;
    return item ? structuredClone(item) : null;
  }

  async getLastAssistantMessage(agentId: string): Promise<string | null> {
    return lastAssistantMessage(await this.getCommittedRows(agentId));
  }

  async deleteAgent(agentId: string): Promise<void> {
    const state = await this.load(agentId);
    await this.runInLane(state, async () => {
      await fs.rm(this.filePath(agentId), { force: true });
    });
    this.states.delete(agentId);
  }

  async bulkInsert(agentId: string, rows: readonly AgentTimelineRow[]): Promise<void> {
    if (rows.length === 0) {
      return;
    }
    const state = await this.load(agentId);
    const current = this.readRows(state);
    const records: TimelineRecord[] = [];
    for (const row of rows) {
      const existing = current.find((candidate) => candidate.seq === row.seq);
      if (existing) {
        if (!isDeepStrictEqual(existing, row)) {
          throw new Error(`Conflicting timeline row sequence ${row.seq}`);
        }
        continue;
      }
      records.push({ row: cloneRow(row) });
    }
    if (records.length === 0) {
      return;
    }
    this.buffer(state, records, 0);
    await this.flush(agentId, state);
  }

  async updateCommittedRow(agentId: string, row: AgentTimelineRow): Promise<void> {
    const state = await this.load(agentId);
    if (!this.readRows(state).some((candidate) => candidate.seq === row.seq)) {
      throw new Error(`Cannot update missing timeline row sequence ${row.seq}`);
    }
    this.buffer(state, [{ update: cloneRow(row) }], 1);
    await this.flush(agentId, state);
  }

  private buffer(
    state: AgentTimelineFileState,
    records: readonly TimelineRecord[],
    updateCount: number,
  ): void {
    state.pending.push(...records);
    state.pendingUpdates += updateCount;
    for (const record of records) {
      state.pendingBytes += serializeRecord(record).length;
    }
  }

  /** Buffered records layered over the persisted rows. Always a fresh sorted array. */
  private readRows(state: AgentTimelineFileState): AgentTimelineRow[] {
    return mergeRecords(state.persisted, state.pending);
  }

  private async flush(agentId: string, state: AgentTimelineFileState): Promise<void> {
    return this.runInLane(state, async () => {
      const batch = state.pending.splice(0, state.pending.length);
      const batchBytes = state.pendingBytes;
      state.pendingBytes = 0;
      const updatesInBatch = this.countUpdates(batch);
      // Replacement records stay in the append log until a compaction folds them.
      const accumulatedUpdates = state.pendingUpdates + updatesInBatch;
      const compact =
        state.needsCompaction ||
        accumulatedUpdates >= COMPACT_AFTER_UPDATE_RECORDS ||
        state.persisted.length + batch.length > this.maxRowsPerAgent ||
        state.bytes + batchBytes > this.maxBytesPerAgent;
      if (batch.length === 0 && !compact) {
        return;
      }
      if (compact) {
        const rows = retainNewestRows(
          mergeRecords(state.persisted, batch),
          this.maxRowsPerAgent,
          this.maxBytesPerAgent,
        );
        const contents = serializeRows(rows);
        await this.writeChunk({ filePath: this.filePath(agentId), contents, mode: "replace" });
        state.persisted = rows;
        state.bytes = contents.length;
        state.pendingUpdates = 0;
        state.needsCompaction = false;
        return;
      }
      const contents = batch.map(serializeRecord).join("");
      await this.writeChunk({ filePath: this.filePath(agentId), contents, mode: "append" });
      state.persisted = mergeRecords(state.persisted, batch);
      state.bytes += contents.length;
      state.pendingUpdates = accumulatedUpdates;
    });
  }

  private countUpdates(records: readonly TimelineRecord[]): number {
    let updates = 0;
    for (const record of records) {
      if ("update" in record) {
        updates += 1;
      }
    }
    return updates;
  }

  private async load(agentId: string): Promise<AgentTimelineFileState> {
    const existing = this.states.get(agentId);
    if (existing) {
      const pendingLoad = existing.loading;
      if (pendingLoad) {
        await pendingLoad;
      }
      return existing;
    }
    const state: AgentTimelineFileState = {
      persisted: [],
      pending: [],
      bytes: 0,
      pendingUpdates: 0,
      pendingBytes: 0,
      needsCompaction: false,
      loading: null,
      lane: Promise.resolve(),
    };
    this.states.set(agentId, state);
    const loading = (async () => {
      const loaded = await this.loadFile(agentId);
      state.persisted = loaded.rows;
      state.bytes = loaded.bytes;
      // Folding the log is required once it holds replacements or a trimmed head.
      state.needsCompaction = loaded.recordCount > loaded.rows.length;
      state.loading = null;
    })();
    state.loading = loading;
    await loading;
    return state;
  }

  private async loadFile(
    agentId: string,
  ): Promise<{ rows: AgentTimelineRow[]; bytes: number; recordCount: number }> {
    let contents: string;
    try {
      contents = await fs.readFile(this.filePath(agentId), "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { rows: [], bytes: 0, recordCount: 0 };
      }
      throw error;
    }
    const merged: AgentTimelineRow[] = [];
    let recordCount = 0;
    for (const line of contents.split("\n")) {
      const record = parseRecord(line);
      if (!record) {
        continue;
      }
      recordCount += 1;
      const incoming = "update" in record ? record.update : record.row;
      const index = merged.findIndex((candidate) => candidate.seq === incoming.seq);
      if (index >= 0) {
        merged[index] = incoming;
      } else {
        merged.push(incoming);
      }
    }
    merged.sort((left, right) => left.seq - right.seq);
    const rows = retainNewestRows(merged, this.maxRowsPerAgent, this.maxBytesPerAgent);
    return { rows, bytes: serializeRows(rows).length, recordCount };
  }

  private filePath(agentId: string): string {
    return path.join(this.directory, fileNameForAgent(agentId));
  }

  private runInLane<T>(state: AgentTimelineFileState, operation: () => Promise<T>): Promise<T> {
    const result = state.lane.then(operation, operation);
    state.lane = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

/** Keep the newest rows that fit both budgets; a single oversized row is still kept. */
function retainNewestRows(
  rows: readonly AgentTimelineRow[],
  maxRows: number,
  maxBytes: number,
): AgentTimelineRow[] {
  if (rows.length === 0) {
    return [];
  }
  const retained: AgentTimelineRow[] = [];
  let bytes = 0;
  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index];
    if (!row) {
      continue;
    }
    const rowBytes = serializeRecord({ row }).length;
    if (retained.length > 0 && (bytes + rowBytes > maxBytes || retained.length >= maxRows)) {
      break;
    }
    bytes += rowBytes;
    retained.push(row);
  }
  return retained.length === rows.length ? [...rows] : retained.toReversed();
}
