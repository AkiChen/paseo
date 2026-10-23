import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

/**
 * What the sidebar lists: the workspace tree, or the agents themselves.
 *
 * This is a list mode, not a grouping. `groupMode` in the sidebar view store still decides how the
 * workspace tree is arranged; switching to agents only replaces what the body shows.
 */
export type SidebarListMode = "workspaces" | "agents";

export const SIDEBAR_LIST_MODES: readonly SidebarListMode[] = ["workspaces", "agents"];

const SIDEBAR_LIST_MODE_STORAGE_KEY = "sidebar-list-mode";
const SIDEBAR_LIST_MODE_STORE_VERSION = 1;

interface SidebarListModeStoreState {
  mode: SidebarListMode;
  setMode: (mode: SidebarListMode) => void;
}

interface SidebarListModePersistedState {
  mode: SidebarListMode;
}

const SidebarListModePersistedStateSchema = z.strictObject({
  mode: z.enum(["workspaces", "agents"]).optional(),
});

export function migrateSidebarListModeState(
  persistedState: unknown,
): SidebarListModePersistedState {
  const result = SidebarListModePersistedStateSchema.safeParse(persistedState);
  return { mode: result.success && result.data.mode ? result.data.mode : "workspaces" };
}

export const useSidebarListModeStore = create<SidebarListModeStoreState>()(
  persist(
    (set) => ({
      mode: "workspaces",
      setMode: (mode) => set({ mode }),
    }),
    {
      name: SIDEBAR_LIST_MODE_STORAGE_KEY,
      version: SIDEBAR_LIST_MODE_STORE_VERSION,
      storage: createValidatedPersistStorage(AsyncStorage, SidebarListModePersistedStateSchema),
      partialize: (state) => ({ mode: state.mode }),
      migrate: migrateSidebarListModeState,
    },
  ),
);
