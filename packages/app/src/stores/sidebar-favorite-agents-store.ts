import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { z } from "zod";
import { createValidatedPersistStorage } from "@/storage/validated-persist-storage";

/**
 * The agents the user starred from the sidebar's kebab menu.
 *
 * This is a view preference, not agent data: it lives in client storage next to the
 * sidebar's pinned order, so starring works against every daemon version and never touches
 * the wire. Keys are `workspaceKey`s (`serverId:workspaceId`), the same key the sidebar rows,
 * the pinned order and the shortcut index are all addressed by.
 */
interface SidebarFavoriteAgentsState {
  /** Starred rows, most recently starred first. */
  favoriteAgentKeys: string[];
  toggleFavoriteAgent: (workspaceKey: string) => void;
}

const SidebarFavoriteAgentsPersistedStateSchema = z.strictObject({
  favoriteAgentKeys: z.array(z.string()).optional(),
});

interface SidebarFavoriteAgentsPersistedState {
  favoriteAgentKeys?: string[];
}

export const useSidebarFavoriteAgentsStore = create<SidebarFavoriteAgentsState>()(
  persist<SidebarFavoriteAgentsState, [], [], SidebarFavoriteAgentsPersistedState>(
    (set) => ({
      favoriteAgentKeys: [],
      toggleFavoriteAgent: (workspaceKey) =>
        set((state) => {
          const favoriteAgentKeys = toggleFavoriteAgentKey(state.favoriteAgentKeys, workspaceKey);
          return favoriteAgentKeys === state.favoriteAgentKeys
            ? state
            : { ...state, favoriteAgentKeys };
        }),
    }),
    {
      name: "sidebar-favorite-agents",
      storage: createValidatedPersistStorage(
        AsyncStorage,
        SidebarFavoriteAgentsPersistedStateSchema,
      ),
      partialize: (state) => ({ favoriteAgentKeys: state.favoriteAgentKeys }),
      merge: (persistedState, currentState) => {
        const result = SidebarFavoriteAgentsPersistedStateSchema.safeParse(persistedState);
        if (!result.success) return currentState;
        const favoriteAgentKeys = dedupeKeys(result.data.favoriteAgentKeys ?? []);
        return { ...currentState, favoriteAgentKeys };
      },
    },
  ),
);

/** Most recently starred first, the way the pinned section leads with the latest pin. */
export function toggleFavoriteAgentKey(keys: string[], workspaceKey: string): string[] {
  const key = workspaceKey.trim();
  if (!key) return keys;
  return keys.includes(key) ? keys.filter((entry) => entry !== key) : [key, ...keys];
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
