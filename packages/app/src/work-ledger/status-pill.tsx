import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import type {
  WorkLedgerAttentionReason,
  WorkLedgerStatus,
} from "@getpaseo/protocol/work-ledger/types";

/**
 * Status and attention chips. They are labels, never controls: the ledger is
 * read-only here, and a chip that looks tappable invites the user to try to change
 * state from a surface that cannot.
 */
export function WorkLedgerStatusPill({ status }: { status: WorkLedgerStatus }) {
  const { t } = useTranslation();
  const styleByStatus = {
    pending: styles.pending,
    in_progress: styles.inProgress,
    review: styles.review,
    completed: styles.completed,
    cancelled: styles.cancelled,
  } as const;
  const textStyleByStatus = {
    pending: styles.pendingText,
    in_progress: styles.inProgressText,
    review: styles.reviewText,
    completed: styles.completedText,
    cancelled: styles.cancelledText,
  } as const;
  return (
    <View style={[styles.pill, styleByStatus[status]]}>
      <Text style={[styles.pillText, textStyleByStatus[status]]}>
        {t(`workLedger.filters.${status}`)}
      </Text>
    </View>
  );
}

export function WorkLedgerAttentionPill({ reason }: { reason: WorkLedgerAttentionReason }) {
  const { t } = useTranslation();
  return (
    <View style={[styles.pill, styles.attention]}>
      <Text style={[styles.pillText, styles.attentionText]}>
        {t(`workLedger.attention.${reason}`)}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  pill: {
    flexDirection: "row",
    alignItems: "center",
    alignSelf: "flex-start",
    borderRadius: theme.borderRadius.full,
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 2,
  },
  pillText: {
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  pending: {
    backgroundColor: theme.colors.surface3,
  },
  pendingText: {
    color: theme.colors.foregroundMuted,
  },
  inProgress: {
    backgroundColor: theme.colors.surface3,
  },
  inProgressText: {
    color: theme.colors.foreground,
  },
  review: {
    backgroundColor: theme.colors.statusWarningTint,
  },
  reviewText: {
    color: theme.colors.statusWarning,
  },
  completed: {
    backgroundColor: theme.colors.statusSuccessTint,
  },
  completedText: {
    color: theme.colors.statusSuccess,
  },
  cancelled: {
    backgroundColor: theme.colors.surface3,
  },
  cancelledText: {
    color: theme.colors.foregroundMuted,
  },
  attention: {
    backgroundColor: theme.colors.statusDangerTint,
  },
  attentionText: {
    color: theme.colors.statusDanger,
  },
}));
