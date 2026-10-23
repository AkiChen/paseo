import { describe, expect, it } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { TURN_LIVENESS_IDLE } from "@/timeline/turn-liveness";
import {
  buildRecentAgentGroups,
  selectRecentAgents,
  type RecentAgentGroup,
} from "./sidebar-recent-agents-model";

function agentIdsByGroup(groups: RecentAgentGroup[]): string[][] {
  return groups.map((group) => group.agents.map((agent) => agent.id));
}

function allAgentIds(groups: RecentAgentGroup[]): string[] {
  return agentIdsByGroup(groups).flat();
}

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

describe("selectRecentAgents", () => {
  it("orders agents by most recent activity", () => {
    const recent = createAgent({
      id: "recent",
      lastActivityAt: new Date("2026-10-01T12:00:00.000Z"),
    });
    const older = createAgent({
      id: "older",
      lastActivityAt: new Date("2026-10-01T09:00:00.000Z"),
    });

    expect(selectRecentAgents([older, recent]).map((agent) => agent.id)).toEqual([
      "recent",
      "older",
    ]);
  });

  it("drops archived agents", () => {
    const archived = createAgent({
      id: "archived",
      lastActivityAt: new Date("2026-10-01T12:00:00.000Z"),
      archivedAt: new Date("2026-10-01T13:00:00.000Z"),
    });
    const open = createAgent({ id: "open" });

    expect(selectRecentAgents([archived, open]).map((agent) => agent.id)).toEqual(["open"]);
  });

  it("drops subagents", () => {
    const subagent = createAgent({
      id: "subagent",
      lastActivityAt: new Date("2026-10-01T12:00:00.000Z"),
      parentAgentId: "agent-a",
    });
    const root = createAgent({ id: "root" });

    expect(selectRecentAgents([subagent, root]).map((agent) => agent.id)).toEqual(["root"]);
  });

  it("breaks a shared timestamp by host and id instead of preserving input order", () => {
    const sameDate = new Date("2026-10-01T12:00:00.000Z");
    const second = createAgent({ id: "agent-b", serverId: "host-a", lastActivityAt: sameDate });
    const first = createAgent({ id: "agent-a", serverId: "host-a", lastActivityAt: sameDate });
    const otherHost = createAgent({ id: "agent-c", serverId: "host-b", lastActivityAt: sameDate });

    expect(selectRecentAgents([second, otherHost, first]).map((agent) => agent.id)).toEqual([
      "agent-a",
      "agent-b",
      "agent-c",
    ]);
  });

  it("leaves the input array untouched", () => {
    const newer = createAgent({
      id: "newer",
      lastActivityAt: new Date("2026-10-01T12:00:00.000Z"),
    });
    const older = createAgent({
      id: "older",
      lastActivityAt: new Date("2026-10-01T09:00:00.000Z"),
    });
    const input = [older, newer];

    selectRecentAgents(input);

    expect(input.map((agent) => agent.id)).toEqual(["older", "newer"]);
  });
});

describe("buildRecentAgentGroups", () => {
  it("groups agents by status in urgent-to-done order", () => {
    const agents = [
      createAgent({ id: "done" }),
      createAgent({ id: "running", status: "running" }),
      createAgent({ id: "needs", pendingPermissionCount: 1 }),
      createAgent({ id: "failed", status: "error" }),
      createAgent({ id: "attention", requiresAttention: true }),
    ];

    const groups = buildRecentAgentGroups(agents);

    expect(groups.map((group) => group.bucket)).toEqual([
      "needs_input",
      "failed",
      "attention",
      "running",
      "done",
    ]);
    expect(groups.map((group) => group.label)).toEqual([
      "Needs input",
      "Failed",
      "Ready to review",
      "Working",
      "Done",
    ]);
    expect(agentIdsByGroup(groups)).toEqual([
      ["needs"],
      ["failed"],
      ["attention"],
      ["running"],
      ["done"],
    ]);
  });

  it("sorts working agents by id instead of activity", () => {
    const later = createAgent({
      id: "b-agent",
      status: "running",
      lastActivityAt: new Date("2026-10-01T12:00:00.000Z"),
    });
    const earlier = createAgent({
      id: "a-agent",
      status: "running",
      lastActivityAt: new Date("2026-10-01T09:00:00.000Z"),
    });

    const running = buildRecentAgentGroups([later, earlier]).find(
      (group) => group.bucket === "running",
    );

    expect(running?.agents.map((agent) => agent.id)).toEqual(["a-agent", "b-agent"]);
  });

  it("keeps non-running groups newest-activity-first", () => {
    const older = createAgent({
      id: "a-agent",
      lastActivityAt: new Date("2026-10-01T09:00:00.000Z"),
    });
    const newer = createAgent({
      id: "z-agent",
      lastActivityAt: new Date("2026-10-01T12:00:00.000Z"),
    });

    const done = buildRecentAgentGroups([older, newer]).find((group) => group.bucket === "done");

    expect(done?.agents.map((agent) => agent.id)).toEqual(["z-agent", "a-agent"]);
  });

  it("leaves archived agents and subagents out of every group", () => {
    const groups = buildRecentAgentGroups([
      createAgent({ id: "root" }),
      createAgent({ id: "archived", archivedAt: new Date("2026-10-01T13:00:00.000Z") }),
      createAgent({ id: "child", parentAgentId: "root" }),
    ]);

    expect(allAgentIds(groups)).toEqual(["root"]);
  });
});
