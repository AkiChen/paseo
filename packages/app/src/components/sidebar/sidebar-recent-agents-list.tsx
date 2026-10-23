import { Archive, CircleAlert, CircleCheck, CircleDot, CircleX, Trash2 } from "lucide-react-native";
import { memo, useCallback, useMemo, useState } from "react";
import { useTranslation } from "react-i18next";
import { RefreshControl, ScrollView, Text, View } from "react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { AgentStatusDot } from "@/components/agent-status-dot";
import { getProviderIcon } from "@/components/provider-icons";
import { SidebarAgentListSkeleton } from "@/components/sidebar-agent-list-skeleton";
import { StatusRing } from "@/components/status-ring";
import { STATUS_RING_FRAME_SIZE } from "@/components/status-ring/geometry";
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from "@/components/ui/context-menu";
import { useAggregatedAgents, type AggregatedAgent } from "@/hooks/use-aggregated-agents";
import { useArchiveAgent } from "@/hooks/use-archive-agent";
import { useCompactTimeAgo } from "@/hooks/use-compact-time-ago";
import { useDeleteAgent, type DeleteAgentInput } from "@/hooks/use-delete-agent";
import { useHosts } from "@/runtime/host-runtime";
import { ICON_SIZE, type Theme } from "@/styles/theme";
import { confirmDialog } from "@/utils/confirm-dialog";
import { deriveSidebarStateBucket, type SidebarStateBucket } from "@/utils/sidebar-agent-state";
import { navigateToAgent } from "@/utils/navigate-to-agent";
import { buildRecentAgentGroups } from "./sidebar-recent-agents-model";

const foregroundMutedColorMapping = (theme: Theme) => ({ color: theme.colors.foregroundMuted });
const destructiveColorMapping = (theme: Theme) => ({ color: theme.colors.destructive });
const needsInputColorMapping = (theme: Theme) => ({ color: theme.colors.statusDotWarning });
const failedColorMapping = (theme: Theme) => ({ color: theme.colors.statusDotDanger });
const attentionColorMapping = (theme: Theme) => ({ color: theme.colors.statusDotSuccess });
const runningColorMapping = (theme: Theme) => ({ color: theme.colors.statusDotRunning });
const mutedRefreshMapping = (theme: Theme) => ({
  tintColor: theme.colors.foregroundMuted,
  colors: [theme.colors.foregroundMuted],
});
const ThemedRefreshControl = withUnistyles(RefreshControl);
const ThemedArchive = withUnistyles(Archive);
const ThemedTrash = withUnistyles(Trash2);
const ThemedCircleAlert = withUnistyles(CircleAlert);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedCircleX = withUnistyles(CircleX);
const archiveLeadingIcon = <ThemedArchive size={14} uniProps={foregroundMutedColorMapping} />;
const deleteLeadingIcon = <ThemedTrash size={14} uniProps={destructiveColorMapping} />;

interface SidebarRecentAgentsListProps {
  /** Whether the sidebar is on screen. Directory demand is only held while it is. */
  active: boolean;
  /** Runs before the agent opens, so compact layouts can close their overlay first. */
  onBeforeNavigate?: () => void;
}

/**
 * The sidebar's Agents mode: every root agent across hosts, grouped by status.
 *
 * Workspace membership is deliberately not a grouping here. The point of the mode is to reach an
 * agent without first finding the workspace it lives in, so the workspace name is context on the
 * row rather than a heading above it.
 */
export function SidebarRecentAgentsList({
  active,
  onBeforeNavigate,
}: SidebarRecentAgentsListProps) {
  const { t } = useTranslation();
  const hosts = useHosts();
  const showHost = hosts.length > 1;
  const { deleteAgent } = useDeleteAgent();
  const { archiveAgent } = useArchiveAgent();
  const { agents, isInitialLoad, isRevalidating, refreshAll } = useAggregatedAgents({
    demand: active,
  });
  const groups = useMemo(() => buildRecentAgentGroups(agents), [agents]);

  const handleRefresh = useCallback(() => {
    refreshAll();
  }, [refreshAll]);

  const refreshControl = useMemo(
    () => (
      <ThemedRefreshControl
        refreshing={isRevalidating}
        onRefresh={handleRefresh}
        uniProps={mutedRefreshMapping}
      />
    ),
    [handleRefresh, isRevalidating],
  );

  if (isInitialLoad) {
    return <SidebarAgentListSkeleton />;
  }

  if (groups.length === 0) {
    return (
      <View style={styles.empty} testID="sidebar-recent-agents-empty">
        <Text style={styles.emptyText}>{t("sidebar.agents.empty")}</Text>
      </View>
    );
  }

  return (
    <ScrollView
      style={styles.list}
      contentContainerStyle={styles.listContent}
      showsVerticalScrollIndicator={false}
      testID="sidebar-recent-agents-scroll"
      refreshControl={refreshControl}
    >
      {groups.map((group) => (
        <View key={group.bucket} style={styles.group}>
          <RecentAgentGroupHeader bucket={group.bucket} label={group.label} />
          {group.agents.map((agent) => (
            <SidebarRecentAgentRow
              key={`${agent.serverId}:${agent.id}`}
              agent={agent}
              showHost={showHost}
              onArchive={archiveAgent}
              onDelete={deleteAgent}
              onBeforeNavigate={onBeforeNavigate}
            />
          ))}
        </View>
      ))}
    </ScrollView>
  );
}

function RecentAgentGroupHeader({ bucket, label }: { bucket: SidebarStateBucket; label: string }) {
  return (
    <View style={styles.groupHeader} testID={`sidebar-recent-agents-group-${bucket}`}>
      <View style={styles.groupIconSlot}>
        <RecentAgentGroupIcon bucket={bucket} />
      </View>
      <Text numberOfLines={1} style={styles.groupTitle}>
        {label}
      </Text>
    </View>
  );
}

function RecentAgentGroupIcon({ bucket }: { bucket: SidebarStateBucket }) {
  switch (bucket) {
    case "needs_input":
      return <ThemedCircleAlert size={14} uniProps={needsInputColorMapping} />;
    case "failed":
      return <ThemedCircleX size={14} uniProps={failedColorMapping} />;
    case "attention":
      return <ThemedCircleCheck size={14} uniProps={attentionColorMapping} />;
    case "running":
      return <ThemedCircleDot size={14} uniProps={runningColorMapping} />;
    case "done":
      return <ThemedCircleCheck size={14} uniProps={foregroundMutedColorMapping} />;
  }
}

const SidebarRecentAgentRow = memo(function SidebarRecentAgentRow({
  agent,
  showHost,
  onArchive,
  onDelete,
  onBeforeNavigate,
}: {
  agent: AggregatedAgent;
  showHost: boolean;
  onArchive: (input: DeleteAgentInput) => Promise<void>;
  onDelete: (input: DeleteAgentInput) => Promise<void>;
  onBeforeNavigate?: () => void;
}) {
  const { t } = useTranslation();
  const timeAgo = useCompactTimeAgo(agent.lastActivityAt);
  const [isBusy, setIsBusy] = useState(false);
  const ProviderIcon = getProviderIcon(agent.provider, agent.serverId);
  const ThemedProviderIcon = useMemo(() => withUnistyles(ProviderIcon), [ProviderIcon]);
  const title = agent.title?.trim() || t("agentList.fallbackTitle");
  const subtitle = resolveAgentSubtitle(agent, showHost);
  const target = useMemo(
    () => ({ serverId: agent.serverId, agentId: agent.id }),
    [agent.serverId, agent.id],
  );
  const statusBucket = deriveSidebarStateBucket({
    status: agent.status,
    requiresAttention: Boolean(agent.requiresAttention),
    attentionReason: agent.attentionReason ?? null,
    pendingPermissionCount: agent.pendingPermissionCount ?? 0,
  });

  const handlePress = useCallback(() => {
    onBeforeNavigate?.();
    navigateToAgent({
      serverId: agent.serverId,
      agentId: agent.id,
      workspaceId: agent.workspaceId,
      pin: true,
    });
  }, [agent.id, agent.serverId, agent.workspaceId, onBeforeNavigate]);

  const handleArchive = useCallback(async () => {
    if (agent.status === "running") {
      const confirmed = await confirmDialog({
        title: t("workspace.tabs.confirmations.archiveRunningAgentTitle"),
        message: t("workspace.tabs.confirmations.archiveRunningAgentMessage"),
        confirmLabel: t("workspace.tabs.confirmations.archive"),
        cancelLabel: t("workspace.tabs.confirmations.cancel"),
        destructive: true,
      });
      if (!confirmed) return;
    }
    setIsBusy(true);
    try {
      await onArchive(target);
    } finally {
      setIsBusy(false);
    }
  }, [agent.status, onArchive, t, target]);

  const handleDelete = useCallback(async () => {
    const confirmed = await confirmDialog({
      title: t("agentDelete.title"),
      message: t("agentDelete.message", { title }),
      confirmLabel: t("agentDelete.confirm"),
      cancelLabel: t("agentDelete.cancel"),
      destructive: true,
    });
    if (!confirmed) return;
    setIsBusy(true);
    try {
      await onDelete(target);
    } finally {
      setIsBusy(false);
    }
  }, [onDelete, t, target, title]);

  const rowStyle = useCallback(
    ({ hovered, pressed }: { hovered: boolean; pressed: boolean }) => [
      styles.row,
      hovered && styles.rowHovered,
      pressed && styles.rowPressed,
    ],
    [],
  );

  return (
    <ContextMenu>
      <ContextMenuTrigger
        accessibilityRole="button"
        accessibilityLabel={subtitle ? `${title}, ${subtitle}` : title}
        onPress={handlePress}
        style={rowStyle}
        testID={`sidebar-recent-agent-${agent.serverId}-${agent.id}`}
      >
        <View style={styles.iconSlot}>
          <ThemedProviderIcon size={ICON_SIZE.sm} uniProps={foregroundMutedColorMapping} />
        </View>
        <View style={styles.content}>
          <Text numberOfLines={1} style={styles.title}>
            {title}
          </Text>
          {subtitle ? (
            <Text numberOfLines={1} style={styles.subtitle}>
              {subtitle}
            </Text>
          ) : null}
        </View>
        <View style={styles.trailing}>
          <View style={styles.statusSlot}>
            {statusBucket === "running" ? (
              <StatusRing />
            ) : (
              <AgentStatusDot
                status={agent.status}
                requiresAttention={agent.requiresAttention}
                attentionReason={agent.attentionReason}
                pendingPermissionCount={agent.pendingPermissionCount}
              />
            )}
          </View>
          <Text style={styles.time}>{timeAgo}</Text>
        </View>
      </ContextMenuTrigger>
      <ContextMenuContent
        align="start"
        width={220}
        testID={`sidebar-recent-agent-menu-${agent.serverId}-${agent.id}`}
      >
        <ContextMenuItem leading={archiveLeadingIcon} onSelect={handleArchive} disabled={isBusy}>
          {t("agentList.archiveSheet.archive")}
        </ContextMenuItem>
        <ContextMenuSeparator />
        <ContextMenuItem
          leading={deleteLeadingIcon}
          destructive
          onSelect={handleDelete}
          disabled={isBusy}
          testID={`sidebar-recent-agent-delete-${agent.serverId}-${agent.id}`}
        >
          {isBusy ? t("agentDelete.deleting") : t("agentDelete.action")}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
});

function resolveAgentSubtitle(agent: AggregatedAgent, showHost: boolean): string {
  const placement = agent.projectPlacement;
  const workspaceName = placement?.workspaceName?.trim() || placement?.projectName?.trim() || "";
  const hostName = showHost ? agent.serverLabel.trim() : "";
  return [workspaceName, hostName].filter((part) => part.length > 0).join(" · ");
}

const styles = StyleSheet.create((theme) => ({
  list: {
    flex: 1,
  },
  listContent: {
    paddingHorizontal: theme.spacing[2],
    // Optical inset shared with the workspace list: the first row sits where that list's header
    // would, so switching modes does not move the content rail.
    paddingTop: 2,
    paddingBottom: theme.spacing[4],
    gap: theme.spacing[0.5],
  },
  // The same shape as a workspace status group: a 16pt leading glyph and a muted label, so the
  // two lists read as one sidebar rather than two different ones.
  group: {
    gap: theme.spacing[0.5],
  },
  groupHeader: {
    minHeight: 32,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[1],
    userSelect: "none",
  },
  groupIconSlot: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  groupTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  row: {
    minHeight: 44,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingVertical: theme.spacing[1.5],
    paddingHorizontal: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    userSelect: "none",
  },
  rowHovered: {
    backgroundColor: theme.colors.surfaceSidebarHover,
  },
  rowPressed: {
    backgroundColor: theme.colors.surface2,
  },
  iconSlot: {
    width: theme.iconSize.md,
    height: theme.iconSize.md,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  content: {
    flex: 1,
    minWidth: 0,
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
  },
  subtitle: {
    marginTop: 1,
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  trailing: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1.5],
    flexShrink: 0,
  },
  // The same mark the tab strip and workspace rows use for a busy agent. Reserving the ring's
  // frame keeps the timestamp on one rail whether the row is running or resting.
  statusSlot: {
    width: STATUS_RING_FRAME_SIZE,
    height: STATUS_RING_FRAME_SIZE,
    alignItems: "center",
    justifyContent: "center",
  },
  time: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  empty: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  emptyText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
  },
}));
