import { useCallback, useMemo } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { CircleCheck, CircleDot, CircleX, MessageCircleWarning } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { ToolbarButton } from "@/components/ui/pane-content-toolbar";
import { useAggregatedAgents } from "@/hooks/use-aggregated-agents";
import { usePanelStore } from "@/stores/panel-store";
import { useSidebarListModeStore } from "@/stores/sidebar-list-mode-store";
import type { Theme } from "@/styles/theme";
import { summarizeAgentStatusCounts } from "./agent-status-summary-model";

const ICON_SIZE = 16;

const ThemedCircleDot = withUnistyles(CircleDot);
const ThemedCircleX = withUnistyles(CircleX);
const ThemedCircleCheck = withUnistyles(CircleCheck);
const ThemedMessageCircleWarning = withUnistyles(MessageCircleWarning);

const waitingColorMapping = (theme: Theme) => ({ color: theme.colors.statusDotWarning });
const failedColorMapping = (theme: Theme) => ({ color: theme.colors.statusDotDanger });
const runningColorMapping = (theme: Theme) => ({ color: theme.colors.statusDotRunning });
const attentionColorMapping = (theme: Theme) => ({ color: theme.colors.statusDotSuccess });

/**
 * The top bar's live agent pulse. It reads one global aggregate, not the
 * focused workspace, because a failure in another workspace is still the
 * user's failure to deal with.
 */
export function AgentStatusSummary() {
  const { t } = useTranslation();
  const { agents } = useAggregatedAgents();
  const desktopAgentListOpen = usePanelStore((state) => state.desktop.agentListOpen);
  const toggleDesktopAgentList = usePanelStore((state) => state.toggleDesktopAgentList);
  const setSidebarListMode = useSidebarListModeStore((state) => state.setMode);

  const counts = useMemo(() => summarizeAgentStatusCounts(agents), [agents]);

  const handleOpenAgents = useCallback(() => {
    setSidebarListMode("agents");
    if (!desktopAgentListOpen) {
      toggleDesktopAgentList();
    }
  }, [desktopAgentListOpen, setSidebarListMode, toggleDesktopAgentList]);

  const items = useMemo(() => {
    const entries = [
      counts.waiting > 0
        ? {
            key: "waiting" as const,
            count: counts.waiting,
            label: t("agentStatusSummary.waiting", { count: counts.waiting }),
            icon: <ThemedMessageCircleWarning size={ICON_SIZE} uniProps={waitingColorMapping} />,
          }
        : null,
      counts.failed > 0
        ? {
            key: "failed" as const,
            count: counts.failed,
            label: t("agentStatusSummary.failed", { count: counts.failed }),
            icon: <ThemedCircleX size={ICON_SIZE} uniProps={failedColorMapping} />,
          }
        : null,
      counts.attention > 0
        ? {
            key: "attention" as const,
            count: counts.attention,
            label: t("agentStatusSummary.attention", { count: counts.attention }),
            icon: <ThemedCircleCheck size={ICON_SIZE} uniProps={attentionColorMapping} />,
          }
        : null,
      counts.running > 0
        ? {
            key: "running" as const,
            count: counts.running,
            label: t("agentStatusSummary.running", { count: counts.running }),
            icon: <ThemedCircleDot size={ICON_SIZE} uniProps={runningColorMapping} />,
          }
        : null,
    ];
    return entries.filter((entry) => entry !== null);
  }, [counts, t]);

  if (items.length === 0) {
    return null;
  }

  return (
    <View style={styles.row} testID="agent-status-summary">
      {items.map((item) => (
        <ToolbarButton
          key={item.key}
          testID={`agent-status-summary-${item.key}`}
          label={item.label}
          onPress={handleOpenAgents}
          style={styles.item}
        >
          {item.icon}
          <Text style={styles.count}>{item.count}</Text>
        </ToolbarButton>
      ))}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  row: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  item: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    width: "auto",
    paddingHorizontal: theme.spacing[1],
  },
  count: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    color: theme.colors.foreground,
    fontVariant: ["tabular-nums"],
  },
}));
