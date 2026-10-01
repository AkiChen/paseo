import {
  appendFileSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import type { AgentTimelineRow } from "./agent-timeline-store-types.js";
import { FileAgentTimelineStore } from "./file-agent-timeline-store.js";

const AGENT = "agent-1";
const OTHER_AGENT = "agent-2";

const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function createDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), "paseo-timeline-store-"));
  directories.push(directory);
  return directory;
}

function createStore(options?: { maxRowsPerAgent?: number; maxBytesPerAgent?: number }): {
  store: FileAgentTimelineStore;
  directory: string;
} {
  const directory = createDirectory();
  return {
    store: new FileAgentTimelineStore(directory, options),
    directory,
  };
}

function row(seq: number, text = `row ${seq}`): AgentTimelineRow {
  return {
    seq,
    timestamp: `2026-01-01T00:00:0${Math.min(seq, 9)}.000Z`,
    item: { type: "assistant_message", text },
  };
}

function filePathFor(directory: string, agentId: string): string {
  const encoded = Buffer.from(agentId, "utf8").toString("base64url");
  return join(directory, `agent-${encoded}.jsonl`);
}

function readLines(directory: string, agentId: string): string[] {
  return readFileSync(filePathFor(directory, agentId), "utf8")
    .split("\n")
    .filter((line) => line.length > 0);
}

describe("FileAgentTimelineStore", () => {
  it("loads a missing agent file as an empty timeline", async () => {
    const { store } = createStore();

    expect(await store.getCommittedRows(AGENT)).toEqual([]);
    expect(await store.getLatestCommittedSeq(AGENT)).toBe(0);
    expect(await store.getLastItem(AGENT)).toBeNull();
    expect(await store.getLastAssistantMessage(AGENT)).toBeNull();
  });

  it("round-trips supplied rows without changing sequence or identity", async () => {
    const { store, directory } = createStore();
    const reasoning: AgentTimelineRow = {
      seq: 2,
      timestamp: "2026-01-01T00:00:02.000Z",
      item: { type: "reasoning", text: "thinking" },
    };

    await store.bulkInsert(AGENT, [row(1, "first"), reasoning]);

    expect(await store.getCommittedRows(AGENT)).toEqual([row(1, "first"), reasoning]);
    expect(readLines(directory, AGENT)).toHaveLength(2);
    expect(await store.getLastAssistantMessage(AGENT)).toBe("first");
  });

  it("treats duplicate rows as idempotent and rejects conflicting sequence reuse", async () => {
    const { store, directory } = createStore();

    await store.bulkInsert(AGENT, [row(1)]);
    await store.bulkInsert(AGENT, [row(1)]);

    expect(readLines(directory, AGENT)).toHaveLength(1);
    await expect(store.bulkInsert(AGENT, [row(1, "different text")])).rejects.toThrow(
      /Conflicting timeline row sequence 1/,
    );
  });

  // The store this replaces rewrote the whole transcript on every buffered
  // update. Appending must cost the new record's own bytes and nothing else.
  it("appends without rewriting the rows already on disk", async () => {
    const { store, directory } = createStore();

    await store.bulkInsert(AGENT, [row(1), row(2)]);
    const before = readFileSync(filePathFor(directory, AGENT), "utf8");

    await store.bulkInsert(AGENT, [row(3)]);
    const after = readFileSync(filePathFor(directory, AGENT), "utf8");

    expect(after.startsWith(before)).toBe(true);
    expect(after.slice(before.length)).toBe(`${JSON.stringify({ row: row(3) })}\n`);
  });

  it("keeps every concurrent append for one agent", async () => {
    const { store } = createStore();

    await Promise.all([
      store.bulkInsert(AGENT, [row(1)]),
      store.bulkInsert(AGENT, [row(2)]),
      store.bulkInsert(AGENT, [row(3)]),
    ]);

    expect((await store.getCommittedRows(AGENT)).map((entry) => entry.seq)).toEqual([1, 2, 3]);
  });

  it("updates an existing row in place and rejects a missing sequence", async () => {
    const { store } = createStore();
    await store.bulkInsert(AGENT, [row(1), row(2)]);

    await store.updateCommittedRow(AGENT, { ...row(1), providerMessageId: "provider-1" });

    const rows = await store.getCommittedRows(AGENT);
    expect(rows).toHaveLength(2);
    expect(rows[0]?.providerMessageId).toBe("provider-1");
    await expect(store.updateCommittedRow(AGENT, row(9))).rejects.toThrow(
      /Cannot update missing timeline row sequence 9/,
    );
  });

  it("drops a row whose write failed instead of exposing it", async () => {
    const directory = createDirectory();
    let failWrites = true;
    const store = new FileAgentTimelineStore(directory, {
      writeChunk: async (input) => {
        if (failWrites) {
          throw new Error("disk unavailable");
        }
        await mkdirSync(dirname(input.filePath), { recursive: true });
        if (input.mode === "append") {
          appendFileSync(input.filePath, input.contents, "utf8");
          return;
        }
        writeFileSync(input.filePath, input.contents, "utf8");
      },
    });

    await expect(store.bulkInsert(AGENT, [row(1)])).rejects.toThrow(/disk unavailable/);
    expect(await store.getCommittedRows(AGENT)).toEqual([]);

    failWrites = false;
    await store.bulkInsert(AGENT, [row(2)]);
    expect(await store.getCommittedRows(AGENT)).toEqual([row(2)]);
  });

  it("skips a partial trailing line and keeps the rows before it", async () => {
    const { store, directory } = createStore();
    writeFileSync(
      filePathFor(directory, AGENT),
      `${JSON.stringify({ row: row(1) })}\n${JSON.stringify({ row: row(2) }).slice(0, 40)}`,
      "utf8",
    );

    expect(await store.getCommittedRows(AGENT)).toEqual([row(1)]);
  });

  it("isolates an unreadable agent file from the other agents", async () => {
    const { store, directory } = createStore();
    mkdirSync(filePathFor(directory, OTHER_AGENT), { recursive: true });
    await store.bulkInsert(AGENT, [row(1)]);

    await expect(store.getCommittedRows(OTHER_AGENT)).rejects.toThrow();
    expect(await store.getCommittedRows(AGENT)).toEqual([row(1)]);
  });

  it("folds replacements and trims to the row budget when it compacts", async () => {
    const { store, directory } = createStore({ maxRowsPerAgent: 3 });

    await store.bulkInsert(AGENT, [row(1), row(2)]);
    await store.updateCommittedRow(AGENT, { ...row(2), providerMessageId: "provider-2" });
    await store.bulkInsert(AGENT, [row(3), row(4), row(5)]);

    const rows = await store.getCommittedRows(AGENT);
    expect(rows.map((entry) => entry.seq)).toEqual([3, 4, 5]);
    const lines = readLines(directory, AGENT);
    expect(lines).toHaveLength(3);
    expect(lines.every((line) => line.includes('"row"'))).toBe(true);
  });

  it("still folds an append log whose replacements came from an earlier process", async () => {
    const { store, directory } = createStore();
    await store.bulkInsert(AGENT, [row(1), row(2)]);
    await store.updateCommittedRow(AGENT, { ...row(1), providerMessageId: "provider-1" });
    expect(readLines(directory, AGENT).some((line) => line.includes('"update"'))).toBe(true);

    const restarted = new FileAgentTimelineStore(directory);
    await restarted.bulkInsert(AGENT, [row(3)]);

    const lines = readLines(directory, AGENT);
    expect(lines).toHaveLength(3);
    expect(lines.some((line) => line.includes('"update"'))).toBe(false);
    expect((await restarted.getCommittedRows(AGENT))[0]?.providerMessageId).toBe("provider-1");
  });

  it("reloads every row after a restart", async () => {
    const { store, directory } = createStore();
    await store.bulkInsert(AGENT, [row(1), row(2)]);
    await store.appendCommitted(AGENT, { type: "assistant_message", text: "appended" });
    await store.bulkInsert(OTHER_AGENT, [row(1, "other")]);

    const restarted = new FileAgentTimelineStore(directory);

    expect(await restarted.getLatestCommittedSeq(AGENT)).toBe(3);
    expect((await restarted.getCommittedRows(AGENT)).at(-1)?.item).toEqual({
      type: "assistant_message",
      text: "appended",
    });
    expect(await restarted.getLastAssistantMessage(OTHER_AGENT)).toBe("other");
  });

  it("deletes an agent's file without touching the other agents", async () => {
    const { store, directory } = createStore();
    await store.bulkInsert(AGENT, [row(1)]);
    await store.bulkInsert(OTHER_AGENT, [row(1)]);

    await store.deleteAgent(AGENT);

    expect(await store.getCommittedRows(AGENT)).toEqual([]);
    expect(await store.getCommittedRows(OTHER_AGENT)).toEqual([row(1)]);
    expect(readLines(directory, OTHER_AGENT)).toHaveLength(1);
  });

  it("answers a bounded fetch from the stored rows", async () => {
    const { store } = createStore();
    await store.bulkInsert(AGENT, [row(1), row(2), row(3)]);

    const result = await store.fetchCommitted(AGENT, { direction: "tail", limit: 2 });

    expect(result.rows.map((entry) => entry.seq)).toEqual([2, 3]);
    expect(result.hasOlder).toBe(true);
    expect(result.window).toEqual({ minSeq: 1, maxSeq: 3, nextSeq: 4 });
  });
});
