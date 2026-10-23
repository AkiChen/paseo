import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@react-native-async-storage/async-storage", () => {
  const storage = new Map<string, string>();
  return {
    default: {
      getItem: vi.fn(async (key: string) => storage.get(key) ?? null),
      setItem: vi.fn(async (key: string, value: string) => {
        storage.set(key, value);
      }),
      removeItem: vi.fn(async (key: string) => {
        storage.delete(key);
      }),
    },
  };
});

import { migrateSidebarListModeState, useSidebarListModeStore } from "./sidebar-list-mode-store";

describe("sidebar list mode store", () => {
  beforeEach(() => {
    useSidebarListModeStore.setState({ mode: "workspaces" });
  });

  it("defaults to the workspace tree", () => {
    expect(useSidebarListModeStore.getState().mode).toBe("workspaces");
  });

  it("switches to the agent list and back", () => {
    const { setMode } = useSidebarListModeStore.getState();

    setMode("agents");
    expect(useSidebarListModeStore.getState().mode).toBe("agents");

    setMode("workspaces");
    expect(useSidebarListModeStore.getState().mode).toBe("workspaces");
  });

  it("keeps a persisted agent mode across a migration", () => {
    expect(migrateSidebarListModeState({ mode: "agents" })).toEqual({ mode: "agents" });
  });

  it("falls back to the workspace tree for state the schema rejects", () => {
    expect(migrateSidebarListModeState({ mode: "recent" })).toEqual({ mode: "workspaces" });
    expect(migrateSidebarListModeState({ mode: "agents", unknown: true })).toEqual({
      mode: "workspaces",
    });
    expect(migrateSidebarListModeState(null)).toEqual({ mode: "workspaces" });
  });
});
