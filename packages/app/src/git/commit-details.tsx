import { useCallback, useMemo, useState } from "react";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import type { CheckoutCommit } from "@getpaseo/protocol/messages";
import { CODE_SURFACE_DATASET } from "@/styles/code-surface";
import { ThemedChevron, chevronColorMapping } from "@/git/themed-chevron";

type CommitWithDetails = CheckoutCommit & { message?: string; authorEmail?: string };

export function resolveCommitMessage(commit: CommitWithDetails): string {
  return commit.message?.trim() || commit.subject;
}

export function CommitDetails({ commit }: { commit: CommitWithDetails }) {
  const { t, i18n } = useTranslation();
  const [collapsed, setCollapsed] = useState(false);
  const accessibilityState = useMemo(() => ({ expanded: !collapsed }), [collapsed]);
  const handleToggle = useCallback(() => {
    setCollapsed((value) => !value);
  }, []);
  const author = commit.authorEmail
    ? `${commit.authorName} <${commit.authorEmail}>`
    : commit.authorName;
  const date = useMemo(() => {
    const parsed = new Date(commit.authorDate);
    return Number.isNaN(parsed.getTime())
      ? commit.authorDate
      : new Intl.DateTimeFormat(i18n.language, {
          dateStyle: "full",
          timeStyle: "long",
        }).format(parsed);
  }, [commit.authorDate, i18n.language]);

  return (
    <View style={styles.container} testID="commit-details">
      <Pressable
        accessibilityRole="button"
        accessibilityState={accessibilityState}
        accessibilityLabel={t("panels.diff.commitDetails.toggle")}
        onPress={handleToggle}
        style={styles.header}
        testID="commit-details-toggle"
      >
        <View style={[styles.chevron, !collapsed && styles.chevronExpanded]}>
          <ThemedChevron size={14} uniProps={chevronColorMapping} />
        </View>
        <Text style={styles.subject} numberOfLines={1}>
          {commit.subject}
        </Text>
        <Text dataSet={CODE_SURFACE_DATASET} style={styles.shortSha} selectable>
          {commit.shortSha}
        </Text>
      </Pressable>
      {collapsed ? null : (
        <ScrollView style={styles.content} contentContainerStyle={styles.contentInner}>
          <CommitMetadataRow
            label={t("panels.diff.commitDetails.commit")}
            value={commit.sha}
            mono
          />
          <CommitMetadataRow label={t("panels.diff.commitDetails.author")} value={author} />
          <CommitMetadataRow label={t("panels.diff.commitDetails.date")} value={date} />
          <Text
            dataSet={CODE_SURFACE_DATASET}
            selectable
            style={styles.message}
            testID="commit-details-message"
          >
            {resolveCommitMessage(commit)}
          </Text>
        </ScrollView>
      )}
    </View>
  );
}

function CommitMetadataRow({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <View style={styles.metadataRow}>
      <Text style={styles.metadataLabel}>{label}</Text>
      <Text
        dataSet={mono ? CODE_SURFACE_DATASET : undefined}
        selectable
        style={[styles.metadataValue, mono && styles.mono]}
      >
        {value}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flexShrink: 0,
    borderBottomWidth: theme.borderWidth[1],
    borderBottomColor: theme.colors.border,
    backgroundColor: theme.colors.background,
  },
  header: {
    minHeight: 38,
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
  },
  chevron: {
    width: 16,
    height: 16,
    alignItems: "center",
    justifyContent: "center",
    flexShrink: 0,
  },
  chevronExpanded: {
    transform: [{ rotate: "90deg" }],
  },
  subject: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.base,
    color: theme.colors.foreground,
    fontWeight: "600",
  },
  shortSha: {
    flexShrink: 0,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  content: {
    maxHeight: 280,
  },
  contentInner: {
    gap: theme.spacing[1],
    paddingLeft: theme.spacing[8],
    paddingRight: theme.spacing[4],
    paddingBottom: theme.spacing[3],
  },
  metadataRow: {
    flexDirection: "row",
    alignItems: "flex-start",
    gap: theme.spacing[2],
  },
  metadataLabel: {
    width: 56,
    flexShrink: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foregroundMuted,
  },
  metadataValue: {
    flex: 1,
    minWidth: 0,
    fontSize: theme.fontSize.sm,
    color: theme.colors.foreground,
  },
  mono: {
    fontFamily: theme.fontFamily.mono,
  },
  message: {
    marginTop: theme.spacing[2],
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
    lineHeight: 20,
    color: theme.colors.foreground,
  },
}));
