import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import pino from "pino";
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import {
  WorkLedgerError,
  WorkLedgerService,
  WorkLedgerStore,
  isItemVisibleInScope,
  matchItemReference,
} from "./index.js";

const logger = pino({ level: "silent" });

const PROJECT_ID = "prj_alpha";
const WORKSPACE_ID = "ws_main";
const OTHER_WORKSPACE_ID = "ws_feature";

function createTestService(options: { clock?: () => Date } = {}) {
  const scopes = {
    projectIdForWorkspace: async (workspaceId: string) =>
      workspaceId === WORKSPACE_ID || workspaceId === OTHER_WORKSPACE_ID ? PROJECT_ID : null,
    projectExists: async (projectId: string) => projectId === PROJECT_ID,
  };
  return (dir: string) =>
    new WorkLedgerService(
      new WorkLedgerStore(dir, logger),
      scopes,
      options.clock ? { clock: { now: options.clock } } : {},
    );
}

describe("WorkLedgerService", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "paseo-work-ledger-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  test("an item created in one session is visible to a service started later", async () => {
    const first = createTestService()(dir);
    const created = await first.createItem({
      title: "Sync H265 dataset to wulan OSS",
      goal: "Downstream copy exists and matches the baseline",
      acceptanceCriteria: "Object count and bytes match; spot check passes",
      workspaceId: WORKSPACE_ID,
    });
    expect(created.number).toMatch(/^TODO-\d{8}-001$/);
    expect(created.scope).toEqual({ kind: "project", projectId: PROJECT_ID });

    // A new session means a new service over the same home directory.
    const second = createTestService()(dir);
    const listed = await second.listItems();
    expect(listed.map((item) => item.number)).toEqual([created.number]);
    expect(listed[0]?.acceptanceCriteria).toContain("Object count");
  });

  test("numbers increase per day and survive a deleted counter file", async () => {
    const service = createTestService()(dir);
    const a = await service.createItem({ title: "A", workspaceId: WORKSPACE_ID });
    const b = await service.createItem({ title: "B", workspaceId: WORKSPACE_ID });
    expect(a.number.endsWith("-001")).toBe(true);
    expect(b.number.endsWith("-002")).toBe(true);

    await rm(join(dir, ".counters.json"), { force: true });
    const c = await createTestService()(dir).createItem({ title: "C", workspaceId: WORKSPACE_ID });
    expect(c.number.endsWith("-003")).toBe(true);
  });

  test("a stale revision is rejected instead of overwriting a concurrent update", async () => {
    const service = createTestService()(dir);
    const item = await service.createItem({ title: "Race", workspaceId: WORKSPACE_ID });
    const agentA = await service.getItem(item.id);
    const agentB = await service.getItem(item.id);
    if (!agentA || !agentB) throw new Error("item missing");

    await service.moveItem({
      itemId: item.id,
      status: "in_progress",
      expectedRevision: agentA.revision,
    });

    await expect(
      service.moveItem({ itemId: item.id, status: "review", expectedRevision: agentB.revision }),
    ).rejects.toMatchObject({ code: "revision_conflict", currentRevision: agentB.revision + 1 });
    const current = await service.getItem(item.id);
    expect(current?.status).toBe("in_progress");
  });

  test("an inspection that finds nothing does not move the progress clock", async () => {
    const times = [
      "2026-11-12T01:00:00.000Z",
      "2026-11-12T02:00:00.000Z",
      "2026-11-12T03:00:00.000Z",
    ];
    let index = 0;
    const service = createTestService({ clock: () => new Date(times[index++] ?? times[2]!) })(dir);
    const item = await service.createItem({ title: "Sweep", workspaceId: WORKSPACE_ID });

    const progressed = await service.recordEntry({
      itemId: item.id,
      kind: "progress",
      source: "agent",
      summary: "Rewrote the report",
      outcome: "progressed",
      status: "review",
      movesProgress: true,
    });
    expect(progressed.item.lastProgressAt).toBe("2026-11-12T02:00:00.000Z");

    const swept = await service.recordEntry({
      itemId: item.id,
      kind: "inspection",
      source: "inspection",
      summary: "No new output from the linked session",
      outcome: "no_change",
      movesProgress: false,
    });
    expect(swept.item.lastInspectedAt).toBe("2026-11-12T03:00:00.000Z");
    expect(swept.item.lastProgressAt).toBe("2026-11-12T02:00:00.000Z");
  });

  test("finishing an item with no recorded result is refused", async () => {
    const service = createTestService()(dir);
    const item = await service.createItem({ title: "Finish me", workspaceId: WORKSPACE_ID });
    await expect(service.moveItem({ itemId: item.id, status: "completed" })).rejects.toMatchObject({
      code: "invalid_input",
    });

    await service.recordEntry({
      itemId: item.id,
      kind: "progress",
      source: "agent",
      summary: "Delivered the report",
      outcome: "progressed",
      movesProgress: true,
    });
    const completed = await service.moveItem({ itemId: item.id, status: "completed" });
    expect(completed.status).toBe("completed");
    expect(completed.completedAt).not.toBeNull();

    // A finished item is not silently moved by a later status call.
    await expect(
      service.moveItem({ itemId: item.id, status: "in_progress" }),
    ).rejects.toMatchObject({ code: "invalid_transition" });
  });

  test("moving an item links the agent and records the note in one commit", async () => {
    const service = createTestService()(dir);
    const item = await service.createItem({ title: "Linked", workspaceId: WORKSPACE_ID });
    const moved = await service.moveItem({
      itemId: item.id,
      status: "in_progress",
      link: { agentId: "agent-1", role: "executor", reason: "Picked it up" },
      note: { summary: "Started the copy", agentId: "agent-1" },
    });
    expect(moved.status).toBe("in_progress");
    expect(moved.agents).toHaveLength(1);
    expect(moved.agents[0]).toMatchObject({
      agentId: "agent-1",
      state: "confirmed",
      source: "tool",
    });
    expect(moved.entryCount).toBe(1);
    expect(moved.revision).toBe(item.revision + 1);
  });

  test("a candidate link never demotes a confirmed one", async () => {
    const service = createTestService()(dir);
    const item = await service.createItem({ title: "Links", workspaceId: WORKSPACE_ID });
    await service.linkAgent({ itemId: item.id, agentId: "agent-1", state: "confirmed" });
    const demoted = await service.linkAgent({
      itemId: item.id,
      agentId: "agent-1",
      state: "candidate",
      source: "inferred",
    });
    expect(demoted.agents[0]?.state).toBe("confirmed");
  });

  test("a workspace scope sees its own items and project items driven there", async () => {
    const service = createTestService()(dir);
    const projectItem = await service.createItem({
      title: "Project task",
      workspaceId: WORKSPACE_ID,
    });
    const workspaceItem = await service.createItem({
      title: "Branch task",
      scope: { kind: "workspace", workspaceId: OTHER_WORKSPACE_ID },
    });
    const moved = await service.updateItem({
      itemId: projectItem.id,
      workspaceId: OTHER_WORKSPACE_ID,
    });
    const all = await service.listItems();

    expect(
      isItemVisibleInScope(moved, { kind: "workspace", workspaceId: OTHER_WORKSPACE_ID }),
    ).toBe(true);
    expect(
      isItemVisibleInScope(workspaceItem, { kind: "workspace", workspaceId: OTHER_WORKSPACE_ID }),
    ).toBe(true);

    const snapshot = await service.synchronize({
      scope: { kind: "workspace", workspaceId: WORKSPACE_ID },
    });
    expect(snapshot.items.map((item) => item.title)).toEqual([]);
    expect(snapshot.counts.total).toBe(all.length);
  });

  test("catch-up returns changed ids instead of a full snapshot while the cursor is covered", async () => {
    const service = createTestService()(dir);
    const item = await service.createItem({ title: "Catch up", workspaceId: WORKSPACE_ID });
    const first = await service.synchronize();
    await service.moveItem({ itemId: item.id, status: "in_progress" });
    const catchUp = await service.synchronize({
      cursor: { generation: first.generation, afterSeq: first.headSeq },
    });
    expect(catchUp.mode).toBe("changes");
    expect(catchUp.changedItemIds).toEqual([item.id]);

    const stale = await service.synchronize({ cursor: { generation: "other-boot", afterSeq: 0 } });
    expect(stale.mode).toBe("snapshot");
  });

  test("item lookups accept a number, an id, or a bare ordinal", async () => {
    const service = createTestService()(dir);
    const a = await service.createItem({ title: "A", workspaceId: WORKSPACE_ID });
    const b = await service.createItem({ title: "B", workspaceId: WORKSPACE_ID });

    expect((await service.resolveItem(a.number))?.id).toBe(a.id);
    expect((await service.resolveItem(a.id))?.id).toBe(a.id);
    expect((await service.resolveItem(b.number.slice(-3)))?.id).toBe(b.id);
    await expect(service.resolveItem("TODO-19990101-001")).resolves.toBeNull();
  });

  test("history pages back through entries without losing the newest", async () => {
    const service = createTestService()(dir);
    const item = await service.createItem({ title: "History", workspaceId: WORKSPACE_ID });
    for (let index = 1; index <= 5; index += 1) {
      await service.recordEntry({
        itemId: item.id,
        kind: "progress",
        source: "agent",
        summary: `Step ${index}`,
        movesProgress: true,
      });
    }
    const page = await service.getItemHistory({ itemId: item.id, limit: 2 });
    expect(page?.entries.map((entry) => entry.summary)).toEqual(["Step 5", "Step 4"]);
    expect(page?.hasMore).toBe(true);
    const older = await service.getItemHistory({
      itemId: item.id,
      limit: 2,
      beforeEntryId: page!.entries[1]!.id,
    });
    expect(older?.entries.map((entry) => entry.summary)).toEqual(["Step 3", "Step 2"]);
  });

  test("an unknown workspace cannot own a new item", async () => {
    const service = createTestService()(dir);
    await expect(
      service.createItem({ title: "Orphan", scope: { kind: "workspace", workspaceId: "ws_nope" } }),
    ).rejects.toBeInstanceOf(WorkLedgerError);
  });
});

describe("matchItemReference", () => {
  const base = {
    projectId: PROJECT_ID,
    scope: { kind: "project" as const, projectId: PROJECT_ID },
    title: "t",
    status: "pending" as const,
    attention: [],
    labels: [],
    agents: [],
    entries: [],
    entryCount: 0,
    createdAt: "2026-11-12T00:00:00.000Z",
    updatedAt: "2026-11-12T00:00:00.000Z",
    lastProgressAt: null,
    lastInspectedAt: null,
    completedAt: null,
    cancelledAt: null,
    revision: 1,
  };

  test("refuses a bare ordinal that matches more than one item", () => {
    const items = [
      { ...base, id: "a", number: "TODO-20261111-001" },
      { ...base, id: "b", number: "TODO-20261112-001" },
    ];
    expect(matchItemReference(items, "1")).toBeNull();
    expect(matchItemReference(items, "TODO-20261112-001")?.id).toBe("b");
  });
});
