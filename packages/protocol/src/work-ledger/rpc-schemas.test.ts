import { describe, expect, test } from "vitest";
import {
  SessionInboundMessageSchema,
  SessionOutboundMessageSchema,
  parseServerInfoStatusPayload,
} from "../messages.js";
import {
  countWorkLedgerItems,
  emptyWorkLedgerCounts,
  workLedgerScopeKey,
  type WorkLedgerItem,
} from "./types.js";

function item(overrides: Partial<WorkLedgerItem> = {}): WorkLedgerItem {
  return {
    id: "wli_1",
    number: "TODO-20261111-010",
    scope: { kind: "project", projectId: "prj_abc" },
    projectId: "prj_abc",
    workspaceId: null,
    title: "Evaluate loader speed",
    goal: null,
    acceptanceCriteria: null,
    status: "in_progress",
    attention: [],
    attentionNote: null,
    blockedReason: null,
    latestSummary: null,
    labels: [],
    agents: [],
    entries: [],
    entryCount: 0,
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
    lastProgressAt: null,
    lastInspectedAt: null,
    completedAt: null,
    cancelledAt: null,
    revision: 1,
    ...overrides,
  };
}

describe("work ledger wire schemas", () => {
  test("accepts a list request with no scope and with a workspace scope", () => {
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "work_ledger.list.request",
        requestId: "r1",
      }).success,
    ).toBe(true);
    expect(
      SessionInboundMessageSchema.safeParse({
        type: "work_ledger.list.request",
        requestId: "r2",
        scope: { kind: "workspace", workspaceId: "ws_1" },
        subscribe: { subscriptionId: "sub_1" },
      }).success,
    ).toBe(true);
  });

  test("accepts a snapshot response and a live upsert", () => {
    const snapshot = SessionOutboundMessageSchema.safeParse({
      type: "work_ledger.list.response",
      payload: {
        requestId: "r1",
        items: [item()],
        counts: { ...emptyWorkLedgerCounts(), total: 1, inProgress: 1 },
        sync: { mode: "snapshot", generation: "gen", headSeq: 4, removedItemIds: [] },
        generatedAt: "2026-11-11T00:00:00.000Z",
      },
    });
    expect(snapshot.success).toBe(true);

    const update = SessionOutboundMessageSchema.safeParse({
      type: "work_ledger.update",
      payload: {
        kind: "upsert",
        item: item({ attention: ["blocked"], blockedReason: "Waiting on credentials" }),
        counts: { ...emptyWorkLedgerCounts(), total: 1, inProgress: 1, attention: 1 },
        generation: "gen",
        seq: 5,
      },
    });
    expect(update.success).toBe(true);
  });

  test("rejects an unknown status", () => {
    const parsed = SessionOutboundMessageSchema.safeParse({
      type: "work_ledger.update",
      payload: {
        kind: "upsert",
        item: item({ status: "done" as never }),
        counts: emptyWorkLedgerCounts(),
        generation: "gen",
        seq: 1,
      },
    });
    expect(parsed.success).toBe(false);
  });

  test("item.get carries a history window", () => {
    const parsed = SessionOutboundMessageSchema.safeParse({
      type: "work_ledger.item.get.response",
      payload: {
        requestId: "r3",
        item: item(),
        entries: [],
        hasMore: false,
      },
    });
    expect(parsed.success).toBe(true);
  });

  test("server info advertises the work ledger feature", () => {
    const parsed = parseServerInfoStatusPayload({
      status: "server_info",
      serverId: "srv_1",
      features: { workLedger: true },
    });
    expect(parsed?.features?.workLedger).toBe(true);
  });
});

describe("work ledger counts", () => {
  test("attention overlaps status buckets instead of adding to them", () => {
    const counts = countWorkLedgerItems([
      item({ status: "pending" }),
      item({ id: "b", status: "in_progress", attention: ["stalled"] }),
      item({ id: "c", status: "review", attention: ["awaiting_confirmation"] }),
      item({ id: "d", status: "completed" }),
      item({ id: "e", status: "cancelled" }),
    ]);
    expect(counts).toEqual({
      total: 5,
      pending: 1,
      inProgress: 1,
      review: 1,
      completed: 1,
      cancelled: 1,
      attention: 2,
    });
    const statusSum =
      counts.pending + counts.inProgress + counts.review + counts.completed + counts.cancelled;
    expect(statusSum).toBe(counts.total);
  });

  test("scope keys distinguish project and workspace ownership", () => {
    expect(workLedgerScopeKey({ kind: "project", projectId: "p" })).toBe("project:p");
    expect(workLedgerScopeKey({ kind: "workspace", workspaceId: "w" })).toBe("workspace:w");
  });
});
