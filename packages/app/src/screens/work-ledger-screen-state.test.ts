import { describe, expect, test } from "vitest";
import type { WorkLedgerItem } from "@getpaseo/protocol/work-ledger/types";
import {
  buildScopeOptions,
  buildWorkLedgerRows,
  collectAttentionCounts,
  itemMatchesStatusFilter,
  orderAgentLinks,
  resolveWorkLedgerBodyState,
  selectPopupHosts,
  type WorkLedgerHostView,
} from "./work-ledger-screen-state";

function item(overrides: Partial<WorkLedgerItem> = {}): WorkLedgerItem {
  return {
    id: "wli_1",
    number: "TODO-20261111-001",
    scope: { kind: "project", projectId: "p1" },
    projectId: "p1",
    workspaceId: null,
    title: "Sync dataset",
    goal: "Downstream copy matches baseline",
    acceptanceCriteria: "Counts match",
    status: "in_progress",
    attention: [],
    labels: [],
    agents: [],
    entries: [],
    entryCount: 0,
    createdAt: "2026-11-11T00:00:00.000Z",
    updatedAt: "2026-11-11T00:00:00.000Z",
    lastProgressAt: "2026-11-11T00:00:00.000Z",
    lastInspectedAt: null,
    completedAt: null,
    cancelledAt: null,
    revision: 1,
    ...overrides,
  };
}

function host(overrides: Partial<WorkLedgerHostView> = {}): WorkLedgerHostView {
  return {
    serverId: "srv_1",
    serverName: "dev-box",
    items: [],
    status: "online",
    error: null,
    syncedAt: "2026-11-12T01:00:00.000Z",
    ...overrides,
  };
}

const noFilters = {
  query: "",
  status: "all" as const,
  scope: { kind: "all" as const },
};

describe("work ledger index filters", () => {
  test("the default view hides finished work", () => {
    expect(itemMatchesStatusFilter(item({ status: "completed" }), "all")).toBe(false);
    expect(itemMatchesStatusFilter(item({ status: "cancelled" }), "all")).toBe(false);
    expect(itemMatchesStatusFilter(item({ status: "review" }), "all")).toBe(true);
    expect(itemMatchesStatusFilter(item({ status: "completed" }), "completed")).toBe(true);
  });

  test("attention is cross-cutting and does not replace the status bucket", () => {
    const blocked = item({ status: "in_progress", attention: ["blocked"] });
    expect(itemMatchesStatusFilter(blocked, "all")).toBe(true);
    expect(itemMatchesStatusFilter(blocked, "attention")).toBe(true);
    expect(itemMatchesStatusFilter(item({ status: "pending" }), "attention")).toBe(false);
  });

  test("search reads number, title, summary, and agent ids", () => {
    const target = item({
      number: "TODO-20261111-007",
      latestSummary: "Validation contract check pending",
      agents: [
        { agentId: "9d6d452e", role: "executor", source: "user", state: "confirmed", linkedAt: "" },
      ],
    });
    const rows = buildWorkLedgerRows({
      hosts: [host({ items: [target] })],
      filters: noFilters,
    });
    for (const query of ["007", "validation", "9d6d45"]) {
      expect(
        buildWorkLedgerRows({
          hosts: [host({ items: [target] })],
          filters: { ...noFilters, query },
        }),
      ).toHaveLength(1);
    }
    expect(
      buildWorkLedgerRows({
        hosts: [host({ items: [target] })],
        filters: { ...noFilters, query: "unrelated" },
      }),
    ).toHaveLength(0);
    expect(rows).toHaveLength(1);
  });

  test("a workspace scope shows its own items and project items driven there", () => {
    const projectItem = item({ id: "a", workspaceId: "ws_1" });
    const branchItem = item({
      id: "b",
      scope: { kind: "workspace", workspaceId: "ws_2" },
      workspaceId: "ws_2",
    });
    const rows = buildWorkLedgerRows({
      hosts: [host({ items: [projectItem, branchItem] })],
      filters: { ...noFilters, scope: { kind: "workspace", workspaceId: "ws_1" } },
    });
    expect(rows.map((row) => row.item.id)).toEqual(["a"]);
  });
});

describe("work ledger ordering", () => {
  test("progress outranks a later inspection with no news", () => {
    const progressed = item({ id: "a", lastProgressAt: "2026-11-12T00:00:00.000Z" });
    const swept = item({
      id: "b",
      lastProgressAt: "2026-11-10T00:00:00.000Z",
      lastInspectedAt: "2026-11-12T05:00:00.000Z",
    });
    const rows = buildWorkLedgerRows({
      hosts: [host({ items: [swept, progressed] })],
      filters: noFilters,
    });
    expect(rows.map((row) => row.item.id)).toEqual(["b", "a"]);
  });

  test("confirmed links sort before candidates and executors first", () => {
    const ordered = orderAgentLinks([
      { agentId: "z", role: "monitor", source: "tool", state: "confirmed", linkedAt: "" },
      { agentId: "c", role: "executor", source: "inferred", state: "candidate", linkedAt: "" },
      { agentId: "b", role: "verifier", source: "user", state: "confirmed", linkedAt: "" },
      { agentId: "a", role: "executor", source: "user", state: "confirmed", linkedAt: "" },
    ]);
    expect(ordered.map((link) => link.agentId)).toEqual(["a", "b", "z", "c"]);
  });

  test("multiple hosts show a server label on each row", () => {
    const rows = buildWorkLedgerRows({
      hosts: [
        host({ serverId: "s1", items: [item({ id: "a" })] }),
        host({ serverId: "s2", serverName: "cloud", items: [item({ id: "b" })] }),
      ],
      filters: noFilters,
    });
    expect(rows.every((row) => row.showServer)).toBe(true);
  });
});

describe("work ledger body state", () => {
  const filtersActive = false;

  test("before the first snapshot the body is loading, not empty", () => {
    expect(
      resolveWorkLedgerBodyState({
        hosts: [host({ syncedAt: null })],
        rows: [],
        filtersActive,
      }).kind,
    ).toBe("loading");
  });

  test("a host that never loaded the feature shows the update hint", () => {
    expect(
      resolveWorkLedgerBodyState({
        hosts: [host({ status: "unsupported", syncedAt: null, items: [] })],
        rows: [],
        filtersActive,
      }).kind,
    ).toBe("unsupported");
  });

  test("a loaded ledger with no items is empty; a filtered-out result is also empty", () => {
    expect(resolveWorkLedgerBodyState({ hosts: [host()], rows: [], filtersActive }).kind).toBe(
      "empty",
    );
    expect(
      resolveWorkLedgerBodyState({
        hosts: [host({ items: [item()] })],
        rows: [],
        filtersActive: true,
      }).kind,
    ).toBe("empty");
  });

  test("a failed snapshot is an error, never an empty index", () => {
    expect(
      resolveWorkLedgerBodyState({
        hosts: [host({ error: "boom", syncedAt: null })],
        rows: [],
        filtersActive,
      }).kind,
    ).toBe("load-error");
  });

  test("popup counts include cached items from hosts whose status has not settled", () => {
    const counts = collectAttentionCounts([
      host({ items: [item({ attention: ["blocked"] }), item({ id: "b", status: "review" })] }),
      host({
        serverId: "s2",
        status: "offline",
        items: [item({ id: "c", attention: ["stalled"] })],
      }),
    ]);
    // Real work must not disappear from the summary because a host's status lags.
    expect(counts).toEqual({ attention: 2, review: 1, inProgress: 2, total: 3 });
  });
});

describe("popup host selection", () => {
  test("every host with items is summarized, whichever one the workspace is on", () => {
    const hosts = [
      host({ serverId: "s1", items: [item({ id: "local" })] }),
      host({ serverId: "s2", items: [item({ id: "remote" })] }),
      host({ serverId: "s3", status: "offline" }),
      host({ serverId: "s4", status: "unsupported", syncedAt: null }),
    ];
    expect(selectPopupHosts({ hosts, serverId: "s1" }).map((entry) => entry.serverId)).toEqual([
      "s1",
      "s2",
    ]);
    expect(selectPopupHosts({ hosts }).map((entry) => entry.serverId)).toEqual(["s1", "s2"]);
  });

  test("an empty host only shows while it is the current one, and unsupported never shows", () => {
    const hosts = [
      host({ serverId: "s1" }),
      host({ serverId: "s2", status: "unsupported", syncedAt: null }),
    ];
    expect(selectPopupHosts({ hosts, serverId: "s2" })).toEqual([]);
    expect(selectPopupHosts({ hosts, serverId: "missing" })).toEqual([]);
    expect(selectPopupHosts({ hosts, serverId: "s1" }).map((entry) => entry.serverId)).toEqual([
      "s1",
    ]);
  });
});

describe("work ledger scope options", () => {
  test("a project scope is named from the project list, and the workspace option names itself", () => {
    const options = buildScopeOptions({
      projects: [
        { projectId: "p1", name: "Acme" },
        { projectId: "p2", name: "Beta" },
      ],
      items: [item({ id: "a", projectId: "p1" }), item({ id: "b", projectId: "p2" })],
      workspace: { workspaceId: "ws_1", name: "feat/login" },
    });
    expect(options.map((option) => option.label)).toEqual([
      "All projects",
      "Acme",
      "Beta",
      "feat/login",
    ]);
    expect(options[1]?.scope).toEqual({ kind: "project", projectId: "p1" });
    expect(options[3]?.scope).toEqual({ kind: "workspace", workspaceId: "ws_1" });
  });

  test("a project with no registry entry still appears, named by its id", () => {
    const options = buildScopeOptions({
      projects: [],
      items: [item({ id: "a", projectId: "prj_unknown" })],
    });
    expect(options.map((option) => option.label)).toEqual(["All projects", "prj_unknown"]);
  });
});
