import { useShallow } from "zustand/shallow";
import { useTranslation } from "react-i18next";
import { i18n } from "@/i18n/i18next";
import { useModelIcon } from "@/components/model-icons";
import type { PanelDescriptor } from "@/panels/panel-registry";
import { useSessionStore, selectAgentTurnPresentation, type Agent } from "@/stores/session-store";
import { deriveSidebarStateBucket } from "@/utils/sidebar-agent-state";

/**
 * Live first: `model_changed` writes runtimeInfo, so it is the model the agent is running now; the
 * snapshot field covers agents created before any runtime info existed.
 */
export function resolveAgentModel(agent: Agent | null | undefined): string | null {
  return agent?.runtimeInfo?.model ?? agent?.model ?? null;
}

function formatProviderLabel(provider: Agent["provider"]): string {
  if (!provider) {
    return "Agent";
  }
  return provider
    .split(/[-_\s]+/)
    .filter((part) => part.length > 0)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

export function resolveAgentLabel(title: string | null | undefined): string | null {
  if (typeof title !== "string") {
    return null;
  }
  const normalized = title.trim();
  if (!normalized) {
    return null;
  }
  if (normalized.toLowerCase() === "new agent") {
    return null;
  }
  return normalized;
}

export function useAgentDescriptor(
  target: { kind: "agent"; agentId: string },
  context: { serverId: string },
): PanelDescriptor {
  useTranslation();
  const descriptorState = useSessionStore(
    useShallow((state) => {
      const session = state.sessions[context.serverId];
      const agent =
        session?.agents?.get(target.agentId) ?? session?.agentDetails?.get(target.agentId) ?? null;
      return {
        provider: agent?.provider ?? "codex",
        model: resolveAgentModel(agent),
        title: agent?.title ?? null,
        status: agent?.status ?? null,
        backgroundWork: agent?.backgroundWork,
        pendingPermissionCount: agent?.pendingPermissions.length ?? 0,
        requiresAttention: agent?.requiresAttention ?? false,
        attentionReason: agent?.attentionReason ?? null,
        isTurnActive: selectAgentTurnPresentation(session, target.agentId).isActive,
      };
    }),
  );
  // The tab glyph follows the agent's model, not just its provider, so a harness
  // that fronts several vendors does not show one robot for all of them.
  const icon = useModelIcon({
    provider: descriptorState.provider,
    modelId: descriptorState.model,
    serverId: context.serverId,
  });
  return buildAgentDescriptor({ ...descriptorState, icon });
}

export function buildAgentDescriptor(input: {
  provider: Agent["provider"];
  title: string | null;
  status: Agent["status"] | null;
  backgroundWork?: Agent["backgroundWork"];
  pendingPermissionCount: number;
  requiresAttention: boolean;
  attentionReason: Agent["attentionReason"];
  isTurnActive: boolean;
  icon: PanelDescriptor["icon"];
}): PanelDescriptor {
  const provider = input.provider;
  const label = resolveAgentLabel(input.title);
  const statusBucket = input.status
    ? deriveSidebarStateBucket({
        status: input.isTurnActive ? "running" : input.status,
        backgroundWork: input.backgroundWork,
        pendingPermissionCount: input.pendingPermissionCount,
        requiresAttention: input.requiresAttention,
        attentionReason: input.attentionReason,
      })
    : null;

  return {
    label: label ?? "",
    subtitle:
      statusBucket === "running" && !input.isTurnActive && input.status !== "running"
        ? i18n.t("message.backgroundWork.running")
        : `${formatProviderLabel(provider)} agent`,
    tooltip: label ?? `${formatProviderLabel(provider)} agent`,
    titleState: label ? "ready" : "loading",
    icon: input.icon,
    statusBucket,
  };
}
