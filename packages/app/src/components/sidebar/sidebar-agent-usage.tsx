import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { useTranslation } from "react-i18next";
import { formatTokenCount } from "@/components/context-window-meter.utils";
import { estimateSessionCostUsd, sessionTotalTokens } from "@/utils/model-pricing";
import type { AgentUsage } from "@getpaseo/protocol/agent-types";

export interface SidebarAgentUsageProps {
  usage: AgentUsage | null | undefined;
  model: string | null | undefined;
  testID?: string;
}

/**
 * The token spend of one agent, in the sidebar row.
 *
 * The token figure is exact — it is the provider's own session-cumulative projection. The dollar
 * figure is an estimate from the published unit prices, so it carries a `~` and is dropped on
 * models the table does not cover. Providers that only report a per-turn figure (claude, codex)
 * have no session total, and their rows show nothing rather than a misleading last-turn number.
 */
export function SidebarAgentUsage({ usage, model, testID }: SidebarAgentUsageProps) {
  const { t } = useTranslation();
  const totalTokens = sessionTotalTokens(usage);
  if (totalTokens === null) {
    return null;
  }
  const cost = estimateSessionCostUsd(usage, model);
  const tokensLabel = formatTokenCount(totalTokens);
  const costLabel = cost === null ? null : formatEstimatedCost(cost);
  return (
    <View
      style={styles.pill}
      accessibilityLabel={[
        t("contextWindow.sessionTokens", { total: tokensLabel }),
        costLabel ? t("contextWindow.sessionCost", { cost: costLabel }) : null,
      ]
        .filter(Boolean)
        .join(" · ")}
      testID={testID}
    >
      <Text style={styles.text} numberOfLines={1}>
        {costLabel ? `${tokensLabel} · ${costLabel}` : tokensLabel}
      </Text>
    </View>
  );
}

/**
 * Dollars at the magnitude the row can carry. Below a cent the exact figure is meaningless next
 * to a token count, so it collapses to `<$0.01` instead of a confusing `$0.00`.
 */
function formatEstimatedCost(costUsd: number): string {
  if (costUsd < 0.01) {
    return "<$0.01";
  }
  if (costUsd < 1) {
    return `~$${costUsd.toFixed(2)}`;
  }
  if (costUsd < 100) {
    return `~$${costUsd.toFixed(1)}`;
  }
  return `~$${Math.round(costUsd)}`;
}

const styles = StyleSheet.create((theme) => ({
  pill: {
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    flexShrink: 0,
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));
