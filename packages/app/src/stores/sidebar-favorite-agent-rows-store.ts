import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

/**
 * The agents the user starred from the sidebar's Agents mode.
 *
 * Agents mode lists agents, not workspaces — one workspace can own several — so this is a
 * second set of stars beside `sidebar-favorite-agents-store.ts` rather than a reuse of it.
 * Workspaces and agents are different rows in different modes, and a star means "this row" in
 * both.
 *
 * Like the workspace stars, this is a view preference: client storage, never on the wire, so
 * it works against every daemon version.
 */
export interface FavoriteAgentRef {
  id: string;
  serverId: string;
}

interface SidebarFavoriteAgentsState {
  /** Starred agent keys (`serverId:agentId`), most recently starred first. */
  favoriteAgentIds: string[];
  toggleFavoriteAgent: (agentKey: string) => void;
}

const SidebarFavoriteAgentsPersistedStateSchema = z.strictObject({
  favoriteAgentIds: z.array(z.string()).optional(),
});

interface SidebarFavoriteAgentsPersistedState {
  favoriteAgentIds?: string[];
}

/** The row identity for an agent, the same shape `workspaceKey` is for a workspace. */
export function favoriteAgentKey({ serverId, id }: FavoriteAgentRef): string {
  return `${serverId}:${id}`;
}

export const useSidebarFavoriteAgentsStore = create<SidebarFavoriteAgentsState>()(
  persist<SidebarFavoriteAgentsState, [], [], SidebarFavoriteAgentsPersistedState>(
    (set) => ({
      favoriteAgentIds: [],
      toggleFavoriteAgent: (agentKey) =>
        set((state) => {
          const favoriteAgentIds = toggleFavoriteKey(state.favoriteAgentIds, agentKey);
          return favoriteAgentIds === state.favoriteAgentIds
            ? state
            : { ...state, favoriteAgentIds };
        }),
    }),
    {
      name: "sidebar-favorite-agent-rows",
      storage: createValidatedPersistStorage(
        AsyncStorage,
        SidebarFavoriteAgentsPersistedStateSchema,
      ),
      partialize: (state) => ({ favoriteAgentIds: state.favoriteAgentIds }),
      merge: (persistedState, currentState) => {
        const result = SidebarFavoriteAgentsPersistedStateSchema.safeParse(persistedState);
        if (!result.success) return currentState;
        const favoriteAgentIds = dedupeKeys(result.data.favoriteAgentIds ?? []);
        return { ...currentState, favoriteAgentIds };
      },
    },
  ),
);

/** Most recently starred first, the way the Pinned section leads with the latest pin. */
export function toggleFavoriteKey(keys: string[], key: string): string[] {
  const trimmed = key.trim();
  if (!trimmed) return keys;
  return keys.includes(trimmed) ? keys.filter((entry) => entry !== trimmed) : [trimmed, ...keys];
}

function dedupeKeys(keys: string[]): string[] {
  const seen = new Set<string>();
  const deduped: string[] = [];
  for (const key of keys) {
    if (!key || seen.has(key)) continue;
    seen.add(key);
    deduped.push(key);
  }
  return deduped;
}
