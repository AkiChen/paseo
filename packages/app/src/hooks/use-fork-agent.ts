import { useRouter, type Href } from "expo-router";
import { useTranslation } from "react-i18next";
import type {
  AgentForkContextOptions,
  DaemonClient,
} from "@getpaseo/client/internal/daemon-client";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import type { AssistantForkTarget } from "@/components/assistant-fork-menu";
import type { ToastApi } from "@/components/toast-host";
import type { AgentScreenAgent } from "@/hooks/use-agent-screen-state-machine";
import { useStableEvent } from "@/hooks/use-stable-event";
import { useHostFeature } from "@/runtime/host-features";
import { generateDraftId } from "@/stores/draft-keys";
import { navigateToWorkspace } from "@/stores/navigation-active-workspace-store";
import { useSessionStore } from "@/stores/session-store";
import {
  buildDraftWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { useWorkspaceDraftSubmissionStore } from "@/stores/workspace-draft-submission-store";
import { toErrorMessage } from "@/utils/error-messages";
import { buildHostAgentDetailRoute, buildNewWorkspaceRoute } from "@/utils/host-routes";
import type { WorkspaceDraftTabSetup, WorkspaceTabTarget } from "@/workspace-tabs/model";

/**
 * The subset of an agent record that a fork needs in order to seed the new
 * draft. Kept structural so both `AgentScreenAgent` (the agent-stream view's
 * live context) and the session store's `Agent` record satisfy it without a
 * projection step.
 */
export type ForkAgentSource = Pick<
  AgentScreenAgent,
  | "provider"
  | "cwd"
  | "workspaceId"
  | "currentModeId"
  | "model"
  | "thinkingOptionId"
  | "runtimeInfo"
  | "features"
  | "projectPlacement"
>;

/**
 * Boundary marking where the forked context should stop. Omit it entirely to
 * fork the whole timeline *up to now* — including a partially streamed
 * in-flight turn. `selectForkContextRows` projects the full timeline when
 * neither field is present, which is what makes mid-run forking work.
 */
export type ForkAgentBoundary = Pick<
  AgentForkContextOptions,
  "boundaryCursor" | "boundaryMessageId"
>;

export interface ForkAgentRequest {
  agentId: string;
  agent: ForkAgentSource;
  workspaceId?: string;
  target: AssistantForkTarget;
  boundary?: ForkAgentBoundary;
}

export interface UseForkAgentInput {
  serverId: string;
  toast?: ToastApi | null;
  /** Read-only surfaces (provider subagent panes) must never fork. */
  readOnly?: boolean;
}

type AgentForkContextPayload = Awaited<ReturnType<DaemonClient["buildAgentForkContext"]>>;

function buildChatHistoryAttachment(input: {
  draftId: string;
  serverId: string;
  agentId: string;
  payload: AgentForkContextPayload;
  missingAttachmentMessage: string;
}): WorkspaceComposerAttachment {
  if (!input.payload.attachment) {
    throw new Error(input.missingAttachmentMessage);
  }
  return {
    kind: "chat_history",
    id: `chat_history:${input.draftId}`,
    attachment: input.payload.attachment,
    source: {
      serverId: input.serverId,
      agentId: input.agentId,
      boundaryMessageId: input.payload.boundaryMessageId,
      boundaryCursor: input.payload.boundaryCursor,
      itemCount: input.payload.itemCount,
    },
  };
}

function buildForkDraftSetup(agent: ForkAgentSource): WorkspaceDraftTabSetup | undefined {
  if (!agent.provider) {
    return undefined;
  }

  const featureValues: Record<string, unknown> = {};
  for (const feature of agent.features ?? []) {
    featureValues[feature.id] = feature.value;
  }

  return {
    provider: agent.provider,
    cwd: agent.cwd,
    modeId: agent.currentModeId ?? agent.runtimeInfo?.modeId ?? null,
    model: agent.model ?? agent.runtimeInfo?.model ?? null,
    thinkingOptionId: agent.thinkingOptionId ?? agent.runtimeInfo?.thinkingOptionId ?? null,
    featureValues,
  };
}

function buildForkDraftTabTarget(
  setup: WorkspaceDraftTabSetup | undefined,
  draftId: string,
): WorkspaceTabTarget {
  return setup ? { kind: "draft", draftId, setup } : { kind: "draft", draftId };
}

/**
 * The workspace a tab fork pins its new agent into, or `undefined` when the fork
 * goes to a new workspace. A tab fork cannot proceed without one.
 */
function resolveForkTabWorkspace(input: {
  target: AssistantForkTarget;
  workspaceId: string | undefined;
  missingWorkspaceMessage: string;
}): string | undefined {
  if (input.target !== "tab") {
    return undefined;
  }
  if (!input.workspaceId) {
    throw new Error(input.missingWorkspaceMessage);
  }
  return input.workspaceId;
}

/**
 * Seed the new conversation's draft with the chat-history attachment. This is the
 * path a fork takes whenever the provider's own session fork is not usable.
 */
function seedForkDraftWithAttachment(input: {
  serverId: string;
  agentId: string;
  payload: AgentForkContextPayload;
  missingAttachmentMessage: string;
}): string {
  const draftId = generateDraftId();
  const attachment = buildChatHistoryAttachment({
    draftId,
    serverId: input.serverId,
    agentId: input.agentId,
    payload: input.payload,
    missingAttachmentMessage: input.missingAttachmentMessage,
  });
  useWorkspaceAttachmentsStore.getState().setWorkspaceAttachments({
    scopeKey: buildDraftWorkspaceAttachmentScopeKey(draftId),
    attachments: [attachment],
  });
  return draftId;
}

/**
 * Open an agent the daemon already created by forking the provider's session. A tab
 * fork pins it into the workspace it was forked from; a new-workspace fork deep-links
 * to the agent and lets the host route resolve its workspace.
 */
function openProviderForkedAgent(input: {
  serverId: string;
  forkedAgentId: string;
  tabWorkspaceId: string | undefined;
  agentWorkspaceId: string | undefined;
  push: (route: Href) => void;
}): void {
  if (input.tabWorkspaceId) {
    navigateToWorkspace({
      serverId: input.serverId,
      workspaceId: input.tabWorkspaceId,
      target: { kind: "agent", agentId: input.forkedAgentId },
    });
    return;
  }
  input.push(
    buildHostAgentDetailRoute(input.serverId, input.forkedAgentId, input.agentWorkspaceId),
  );
}

/**
 * Send a chat-history fork into its own workspace, carrying the source agent's
 * provider configuration as the new draft's setup.
 */
function openForkWorkspace(input: {
  serverId: string;
  agent: ForkAgentSource;
  draftId: string;
  draftSetup: WorkspaceDraftTabSetup | undefined;
  push: (route: Href) => void;
}): void {
  const sourceDirectory =
    input.agent.projectPlacement?.checkout?.cwd?.trim() || input.agent.cwd.trim() || undefined;
  if (input.draftSetup) {
    useWorkspaceDraftSubmissionStore.getState().setDraftSetup({
      draftId: input.draftId,
      setup: input.draftSetup,
      sourceDirectory,
    });
  }
  input.push(
    buildNewWorkspaceRoute({
      serverId: input.serverId,
      sourceDirectory,
      displayName: input.agent.projectPlacement?.projectName,
      projectId: input.agent.projectPlacement?.projectKey,
      draftId: input.draftId,
    }),
  );
}

/**
 * Shared fork driver behind both turn-footer fork affordances: the completed
 * turn's footer (which supplies a boundary pinned to that turn) and the
 * in-flight turn's footer next to the progress loader (which omits the boundary
 * so the fork captures the still-streaming response).
 */
export function useForkAgent(
  input: UseForkAgentInput,
): (request: ForkAgentRequest) => Promise<void> {
  const { serverId, toast, readOnly = false } = input;
  const { t } = useTranslation();
  const router = useRouter();
  const client = useSessionStore((state) => state.sessions[serverId]?.client ?? null);
  const supportsAgentForkContext = useHostFeature(serverId, "agentForkContext") && !readOnly;

  return useStableEvent(async ({ agentId, agent, workspaceId, target, boundary }) => {
    try {
      if (!supportsAgentForkContext) {
        toast?.error(t("message.actions.forkUnavailable"));
        return;
      }
      if (!client) {
        throw new Error(t("workspace.terminal.hostDisconnected"));
      }
      // A provider fork has already created its agent on the daemon by the time the
      // call below returns, so the workspace a tab fork pins into is resolved first:
      // a tab fork without one must fail before anything is forked.
      const tabWorkspaceId = resolveForkTabWorkspace({
        target,
        workspaceId,
        missingWorkspaceMessage: t("message.actions.forkMissingWorkspace"),
      });
      const draftSetup = buildForkDraftSetup(agent);
      // A fork keeps the source provider by default, so `targetProvider` is the draft
      // provider. The daemon decides whether that earns a provider session fork or the
      // chat-history attachment.
      const payload = await client.buildAgentForkContext(agentId, {
        ...boundary,
        ...(draftSetup?.provider ? { targetProvider: draftSetup.provider } : {}),
      });

      if (payload.forkedAgentId) {
        openProviderForkedAgent({
          serverId,
          forkedAgentId: payload.forkedAgentId,
          tabWorkspaceId,
          agentWorkspaceId: agent.workspaceId,
          push: (route) => router.push(route),
        });
        return;
      }

      const draftId = seedForkDraftWithAttachment({
        serverId,
        agentId,
        payload,
        missingAttachmentMessage: t("message.actions.forkFailed"),
      });

      if (tabWorkspaceId) {
        navigateToWorkspace({
          serverId,
          workspaceId: tabWorkspaceId,
          target: buildForkDraftTabTarget(draftSetup, draftId),
        });
        return;
      }

      openForkWorkspace({
        serverId,
        agent,
        draftId,
        draftSetup,
        push: (route) => router.push(route),
      });
    } catch (error) {
      toast?.error(toErrorMessage(error) || t("message.actions.forkFailed"));
    }
  });
}
