import React from "react";
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
  const costParts = cost === null ? null : formatEstimatedCost(cost);
  return (
    <View
      style={styles.pill}
      accessibilityLabel={[
        costParts ? t("contextWindow.sessionCost", { cost: costParts.spoken }) : null,
        t("contextWindow.sessionTokens", { total: tokensLabel }),
      ]
        .filter(Boolean)
        .join(" · ")}
      testID={testID}
    >
      {/* Money first, both to read as "[what it cost] / [how big it got]" and because the token
          count keeps growing while the amount spent is what the row is asked about. The `~` rides
          on the number rather than the label: the pill's glyph already says "dollars", and the
          figure stays an estimate until a real invoice exists. */}
      {costParts ? (
        <>
          <Text style={styles.cost} numberOfLines={1}>
            {`${COST_GLYPH}${costParts.display}`}
          </Text>
          <Text style={styles.divider} numberOfLines={1}>
            {" / "}
          </Text>
        </>
      ) : null}
      <Text style={styles.text} numberOfLines={1}>
        {`${TOKENS_GLYPH}${tokensLabel}`}
      </Text>
    </View>
  );
}

const COST_GLYPH = "💲";
const TOKENS_GLYPH = "🔹";

export interface EstimatedCostLabel {
  /** What the pill prints after the dollar glyph, e.g. `~0.72` or `~<0.01`. */
  display: string;
  /** The same figure as a sentence can carry it, e.g. `≈ $0.72` — screen readers get the unit. */
  spoken: string;
}

/**
 * Dollars at the magnitude the row can carry, without the currency symbol.
 *
 * The pill prints its own `💲`, so the label never repeats `$`. Below a cent the exact figure is
 * meaningless next to a token count, so it collapses to `~<0.01`. `~` stays on the number: the
 * price table is published per-model and re-priced by the gateway, so this is never an invoice.
 */
export function formatEstimatedCost(costUsd: number): EstimatedCostLabel {
  if (costUsd < 0.01) {
    return { display: "~<0.01", spoken: "≈ <$0.01" };
  }
  if (costUsd < 1) {
    return { display: `~${costUsd.toFixed(2)}`, spoken: `≈ $${costUsd.toFixed(2)}` };
  }
  if (costUsd < 100) {
    return { display: `~${costUsd.toFixed(1)}`, spoken: `≈ $${costUsd.toFixed(1)}` };
  }
  return { display: `~${Math.round(costUsd)}`, spoken: `≈ $${Math.round(costUsd)}` };
}

const styles = StyleSheet.create((theme) => ({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    paddingHorizontal: theme.spacing[1],
    borderRadius: theme.borderRadius.sm,
    backgroundColor: theme.colors.surface2,
    flexShrink: 0,
  },
  // The cost is the headline of the pair, so it keeps the foreground color while the token
  // count — the number that keeps climbing — stays muted.
  cost: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
  divider: {
    color: theme.colors.foregroundExtraMuted,
    fontSize: theme.fontSize.sm,
  },
  text: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontVariant: ["tabular-nums"],
  },
}));
