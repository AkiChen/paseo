import { describe, expect, test } from "vitest";
import type { WorkLedgerItem } from "@getpaseo/protocol/work-ledger/types";
import { selectPopupHosts, type WorkLedgerHostView } from "./work-ledger-screen-state";

function item(overrides: Partial<WorkLedgerItem> = {}): WorkLedgerItem {
  return {
    id: "wli_1",
    number: "TODO-20261113-001",
    scope: { kind: "project", projectId: "p1" },
    projectId: "p1",
    workspaceId: null,
    title: "Remote work",
    status: "in_progress",
    attention: [],
    labels: [],
    agents: [],
    entries: [],
    entryCount: 0,
    createdAt: "2026-11-13T00:00:00.000Z",
    updatedAt: "2026-11-13T00:00:00.000Z",
    lastProgressAt: null,
    lastInspectedAt: null,
    completedAt: null,
    cancelledAt: null,
    revision: 1,
    ...overrides,
  };
}

function host(overrides: Partial<WorkLedgerHostView> = {}): WorkLedgerHostView {
  return {
    serverId: "srv_local",
    serverName: "this-laptop",
    items: [],
    status: "online",
    error: null,
    syncedAt: "2026-11-13T00:00:00.000Z",
    ...overrides,
  };
}

/**
 * The reported symptom: the workspace is on the host with no items, while another
 * connected host holds the 13 real ones. The popup must not go blank.
 */
describe("popup across hosts with an empty current host", () => {
  test("an empty current host does not hide another host's items", () => {
    const hosts = [
      host({ serverId: "srv_local", items: [] }),
      host({ serverId: "srv_remote", serverName: "dev-box", items: [item(), item({ id: "b" })] }),
    ];

    const selected = selectPopupHosts({ hosts, serverId: "srv_local" });

    expect(selected.map((entry) => entry.serverId)).toEqual(["srv_local", "srv_remote"]);
    expect(selected.flatMap((entry) => entry.items)).toHaveLength(2);
  });

  test("a current host that has not synced yet also does not hide the others", () => {
    const hosts = [
      host({ serverId: "srv_local", items: [], syncedAt: null }),
      host({ serverId: "srv_remote", items: [item()] }),
    ];
    const selected = selectPopupHosts({ hosts, serverId: "srv_local" });
    expect(selected.map((entry) => entry.serverId)).toEqual(["srv_local", "srv_remote"]);
  });

  test("a host whose status has not settled still contributes its items", () => {
    const hosts = [
      host({ serverId: "srv_local", status: "offline", items: [] }),
      host({ serverId: "srv_remote", status: "offline", items: [item()] }),
    ];
    expect(selectPopupHosts({ hosts, serverId: "srv_local" }).map((e) => e.serverId)).toEqual([
      "srv_local",
      "srv_remote",
    ]);
  });
});
