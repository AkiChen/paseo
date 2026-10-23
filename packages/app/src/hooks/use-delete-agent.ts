import { useMutation, useQueryClient, type QueryClient } from "@tanstack/react-query";
import { useCallback } from "react";
import { useTranslation } from "react-i18next";
import { useToast } from "@/contexts/toast-context";
import { getHostRuntimeStore } from "@/runtime/host-runtime";
import { useSessionStore } from "@/stores/session-store";
import { useWorkspaceLayoutStore } from "@/stores/workspace-layout-store";
import { allAgentHistoryQueryRootKey, agentHistoryQueryKey } from "./agent-history-query-key";
import { removeAgentFromCachedLists, type AgentHistoryQueryData } from "./use-archive-agent";

export interface DeleteAgentInput {
  serverId: string;
  agentId: string;
}

/**
 * A hard delete: the daemon removes Paseo's record and timeline, and — because this client asks
 * for it explicitly — the provider's own stored session. The client mirrors the removal locally
 * so the row, History entry, and open tabs go away together instead of waiting for the next
 * directory refresh.
 */
export function useDeleteAgent() {
  const queryClient = useQueryClient();
  const { t } = useTranslation();
  const toast = useToast();

  const mutation = useMutation({
    mutationFn: async (input: DeleteAgentInput): Promise<void> => {
      const client = useSessionStore.getState().sessions[input.serverId]?.client ?? null;
      if (!client) {
        throw new Error(t("common.errors.daemonClientUnavailable"));
      }
      await client.deleteAgent(input.agentId, { deleteProviderSession: true });
    },
    onSuccess: (_result, input) => {
      applyDeletedAgent(queryClient, input);
    },
    onError: (error) => {
      toast.error(
        t("agentDelete.failed", {
          message: error instanceof Error ? error.message : String(error),
        }),
      );
    },
  });

  const deleteMutationAsync = mutation.mutateAsync;
  const deleteAgent = useCallback(
    async (input: DeleteAgentInput): Promise<void> => {
      try {
        await deleteMutationAsync(input);
      } catch {
        // The mutation's onError already surfaced the failure.
      }
    },
    [deleteMutationAsync],
  );

  const isDeletingAgent = useCallback(
    (input: DeleteAgentInput): boolean =>
      mutation.isPending &&
      mutation.variables?.serverId === input.serverId &&
      mutation.variables.agentId === input.agentId,
    [mutation.isPending, mutation.variables],
  );

  return { deleteAgent, isDeletingAgent };
}

function applyDeletedAgent(queryClient: QueryClient, input: DeleteAgentInput): void {
  try {
    getHostRuntimeStore().restoreAgentSnapshot(input.serverId, input.agentId, undefined);
  } catch {
    // No directory for this host yet; the daemon's own update removes it when it arrives.
  }
  removeAgentFromCachedLists(queryClient, input);
  removeAgentFromHistoryCaches(queryClient, input);
  closeAgentTabs(input);
  invalidateAgentQueries(queryClient, input.serverId);
}

function removeAgentFromHistoryCaches(queryClient: QueryClient, input: DeleteAgentInput): void {
  queryClient.setQueryData<AgentHistoryQueryData | undefined>(
    agentHistoryQueryKey(input.serverId),
    (current) => removeAgentFromHistoryPayload(current, input),
  );
  queryClient.setQueriesData<AgentHistoryQueryData | undefined>(
    { queryKey: allAgentHistoryQueryRootKey() },
    (current) => removeAgentFromHistoryPayload(current, input),
  );
}

function removeAgentFromHistoryPayload<T extends AgentHistoryQueryData | undefined>(
  payload: T,
  input: DeleteAgentInput,
): T {
  if (!payload || !Array.isArray(payload.pages)) {
    return payload;
  }
  let changed = false;
  const pages = payload.pages.map((page) => {
    if (!Array.isArray(page.agents)) {
      return page;
    }
    const agents = page.agents.filter(
      (agent) =>
        agent.id !== input.agentId || (agent.serverId != null && agent.serverId !== input.serverId),
    );
    if (agents.length === page.agents.length) {
      return page;
    }
    changed = true;
    return { ...page, agents };
  });
  return changed ? ({ ...payload, pages } as T) : payload;
}

function closeAgentTabs(input: DeleteAgentInput): void {
  const store = useWorkspaceLayoutStore.getState();
  const prefix = `${input.serverId}:`;
  for (const workspaceKey of Object.keys(store.layoutByWorkspace)) {
    if (!workspaceKey.startsWith(prefix)) continue;
    for (const tab of store.getWorkspaceTabs(workspaceKey)) {
      if (tab.target.kind === "agent" && tab.target.agentId === input.agentId) {
        store.closeTab(workspaceKey, tab.tabId);
      }
    }
  }
}

function invalidateAgentQueries(queryClient: QueryClient, serverId: string): void {
  void queryClient.invalidateQueries({ queryKey: ["sidebarAgentsList", serverId] });
  void queryClient.invalidateQueries({ queryKey: ["allAgents", serverId] });
  void queryClient.invalidateQueries({ queryKey: agentHistoryQueryKey(serverId) });
  void queryClient.invalidateQueries({ queryKey: allAgentHistoryQueryRootKey() });
}
