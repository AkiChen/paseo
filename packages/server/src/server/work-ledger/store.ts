import { randomBytes } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import type { Logger } from "pino";
import {
  WorkLedgerItemSchema,
  type WorkLedgerEntry,
  type WorkLedgerItem,
} from "@getpaseo/protocol/work-ledger/types";
import { writeJsonFileAtomic } from "../atomic-file.js";

/**
 * Entries are unbounded over an item's life, so the stored record differs from the
 * wire item: persistence keeps the whole history, publications carry only the newest
 * few. Keeping that split here means the service never has to reason about it.
 */
const StoredWorkLedgerItemSchema = WorkLedgerItemSchema.omit({ entries: true }).extend({
  entries: WorkLedgerItemSchema.shape.entries,
});

export type StoredWorkLedgerItem = {
  [K in keyof WorkLedgerItem]: K extends "entries" ? WorkLedgerEntry[] : WorkLedgerItem[K];
};

function generateItemId(): string {
  return `wli_${randomBytes(8).toString("hex")}`;
}

/**
 * One JSON file per item under `$PASEO_HOME/work-ledger/`. Writes are atomic per file
 * and mutations for one id are serialized, so two agents updating different items
 * never block each other and two updating the same item never interleave.
 */
export class WorkLedgerStore {
  private readonly mutations = new Map<string, Promise<unknown>>();
  private readonly reportedInvalidFiles = new Set<string>();

  constructor(
    private readonly dir: string,
    private readonly logger: Logger,
  ) {}

  private filePath(id: string): string {
    return join(this.dir, `${id}.json`);
  }

  async list(): Promise<StoredWorkLedgerItem[]> {
    await mkdir(this.dir, { recursive: true });
    const entries = await readdir(this.dir, { withFileTypes: true });
    const invalidFiles = new Set<string>();
    const items: StoredWorkLedgerItem[] = [];
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
      const filePath = join(this.dir, entry.name);
      const parsed = parseStoredItem(await readFile(filePath, "utf-8"));
      if (parsed.success) {
        items.push(parsed.data);
        continue;
      }
      invalidFiles.add(filePath);
      if (!this.reportedInvalidFiles.has(filePath)) {
        this.logger.error({ err: parsed.error, filePath }, "Skipping invalid work ledger file");
      }
    }
    for (const filePath of invalidFiles) this.reportedInvalidFiles.add(filePath);
    for (const filePath of Array.from(this.reportedInvalidFiles)) {
      if (!invalidFiles.has(filePath)) this.reportedInvalidFiles.delete(filePath);
    }
    return items.sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  }

  async get(id: string): Promise<StoredWorkLedgerItem | null> {
    try {
      const content = await readFile(this.filePath(id), "utf-8");
      const parsed = parseStoredItem(content);
      if (!parsed.success) {
        throw new Error(`Work ledger file for ${id} is not a valid item: ${String(parsed.error)}`);
      }
      return parsed.data;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  /** Runs `mutate` against the current record of `id` and persists what it returns. */
  async update(
    id: string,
    mutate: (current: StoredWorkLedgerItem) => StoredWorkLedgerItem,
  ): Promise<StoredWorkLedgerItem> {
    return this.serialize(id, async () => {
      const current = await this.get(id);
      if (!current) throw new Error(`Work ledger item not found: ${id}`);
      const next = mutate(current);
      if (next.id !== id) throw new Error(`Work ledger update cannot change id: ${id}`);
      const parsed = StoredWorkLedgerItemSchema.parse(next);
      await writeJsonFileAtomic(this.filePath(id), parsed);
      return parsed;
    });
  }

  async create(record: Omit<StoredWorkLedgerItem, "id">): Promise<StoredWorkLedgerItem> {
    const created = StoredWorkLedgerItemSchema.parse({ ...record, id: generateItemId() });
    await writeJsonFileAtomic(this.filePath(created.id), created);
    return created;
  }

  /**
   * Reserves the next item number for `dayKey` (`YYYYMMDD`). The counter lives in a
   * file so it survives a restart and never re-issues a number already on disk; the
   * check against existing items covers a deleted counter file.
   */
  async allocateNumber(dayKey: string): Promise<string> {
    const counterPath = join(this.dir, ".counters.json");
    return this.serialize(".counter", async () => {
      await mkdir(this.dir, { recursive: true });
      let counters: Record<string, number> = {};
      try {
        const raw = await readFile(counterPath, "utf-8");
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          counters = parsed as Record<string, number>;
        }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
      const existing = new Set(
        (await this.list())
          .filter((item) => item.number.startsWith(`TODO-${dayKey}-`))
          .map((item) => item.number),
      );
      let next = Math.max(counters[dayKey] ?? 0, existing.size) + 1;
      let number = formatItemNumber(dayKey, next);
      while (existing.has(number)) {
        next += 1;
        number = formatItemNumber(dayKey, next);
      }
      counters[dayKey] = next;
      await writeJsonFileAtomic(counterPath, counters);
      return number;
    });
  }

  async delete(id: string): Promise<void> {
    await this.serialize(id, async () => {
      await rm(this.filePath(id), { force: true });
    });
  }

  private async serialize<T>(key: string, mutation: () => Promise<T>): Promise<T> {
    const previous = this.mutations.get(key) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(mutation);
    this.mutations.set(key, next);
    try {
      return await next;
    } finally {
      if (this.mutations.get(key) === next) this.mutations.delete(key);
    }
  }
}

export function formatItemNumber(dayKey: string, ordinal: number): string {
  return `TODO-${dayKey}-${String(ordinal).padStart(3, "0")}`;
}

function parseStoredItem(
  content: string,
): { success: true; data: StoredWorkLedgerItem } | { success: false; error: unknown } {
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch (error) {
    return { success: false, error };
  }
  return StoredWorkLedgerItemSchema.safeParse(json);
}
