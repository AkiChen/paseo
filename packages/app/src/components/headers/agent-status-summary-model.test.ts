import { describe, expect, it } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { TURN_LIVENESS_IDLE } from "@/timeline/turn-liveness";
import { summarizeAgentStatusCounts } from "./agent-status-summary-model";

function createAgent(overrides: Partial<AggregatedAgent> = {}): AggregatedAgent {
  return {
    id: "agent-a",
    serverId: "host-a",
    serverLabel: "Host A",
    title: "Agent",
    status: "idle",
    turn: TURN_LIVENESS_IDLE,
    lastActivityAt: new Date("2026-10-01T12:00:00.000Z"),
    cwd: "/repo",
    workspaceId: "workspace-a",
    provider: "claude",
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    createdAt: new Date("2026-10-01T10:00:00.000Z"),
    labels: {},
    parentAgentId: null,
    ...overrides,
  };
}

describe("summarizeAgentStatusCounts", () => {
  it("keeps ready-to-review separate from waiting for input and ignores done", () => {
    const counts = summarizeAgentStatusCounts([
      createAgent({ id: "permission", pendingPermissionCount: 1 }),
      createAgent({ id: "review", requiresAttention: true }),
      createAgent({ id: "running", status: "running" }),
      createAgent({ id: "failed", status: "error" }),
      createAgent({ id: "done" }),
    ]);

    expect(counts).toEqual({
      waiting: 1,
      failed: 1,
      attention: 1,
      running: 1,
    });
  });

  it("counts an initializing agent as running instead of done", () => {
    expect(summarizeAgentStatusCounts([createAgent({ status: "initializing" })])).toEqual({
      waiting: 0,
      failed: 0,
      attention: 0,
      running: 1,
    });
  });

  it("excludes archived agents and subagents like the sidebar's Agents list", () => {
    expect(
      summarizeAgentStatusCounts([
        createAgent({ id: "archived", archivedAt: new Date("2026-10-01T13:00:00.000Z") }),
        createAgent({ id: "subagent", parentAgentId: "agent-a", status: "running" }),
        createAgent({ id: "root", status: "running" }),
      ]),
    ).toEqual({ waiting: 0, failed: 0, attention: 0, running: 1 });
  });
});
