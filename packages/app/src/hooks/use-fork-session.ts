import { useTranslation } from "react-i18next";
import type { AgentForkSessionOptions } from "@getpaseo/client/internal/daemon-client";
import type { ToastApi } from "@/components/toast-host";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useSessionStore } from "@/stores/session-store";
import { toErrorMessage } from "@/utils/error-messages";
import { navigateToAgent } from "@/utils/navigate-to-agent";

/**
 * Boundary the native fork stops at. Same shape the chat-history fork pins, so
 * both buttons fork the turn the user clicked.
 */
export type ForkSessionBoundary = Pick<
  AgentForkSessionOptions,
  "boundaryCursor" | "boundaryMessageId"
>;

export interface ForkSessionRequest {
  agentId: string;
  workspaceId?: string | null;
  boundary?: ForkSessionBoundary;
}

export interface UseForkSessionInput {
  serverId: string;
  toast?: ToastApi | null;
  /** Read-only surfaces (provider subagent panes) must never fork. */
  readOnly?: boolean;
}

/**
 * Drives the native session fork: the daemon branches the provider session and
 * registers a new agent, and the client opens it. Nothing is copied into the
 * composer, so there is no draft and no first prompt to send.
 */
export function useForkSession(
  input: UseForkSessionInput,
): (request: ForkSessionRequest) => Promise<void> {
  const { serverId, toast, readOnly = false } = input;
  const { t } = useTranslation();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);

  return useStableEvent(async ({ agentId, workspaceId, boundary }: ForkSessionRequest) => {
    if (readOnly) {
      return;
    }
    try {
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      const payload = await client.forkAgentSession(agentId, boundary);
      if (!payload.forkedAgentId) {
        throw new Error(t("message.actions.forkSessionFailed"));
      }
      navigateToAgent({
        serverId,
        agentId: payload.forkedAgentId,
        workspaceId: workspaceId ?? undefined,
      });
    } catch (error) {
      toast?.error(toErrorMessage(error) || t("message.actions.forkSessionFailed"));
    }
  });
}
