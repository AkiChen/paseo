import { useCallback, useMemo, type ReactElement, type ReactNode } from "react";
import { useTranslation } from "react-i18next";
import { ScrollView, Text, View } from "react-native";
import { StyleSheet } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import {
  loadOlderWorkLedgerEntries,
  useWorkLedgerItem,
  useWorkLedgerItemRow,
} from "@/hooks/use-work-ledger";
import { orderAgentLinks, sortAttentionReasons } from "@/screens/work-ledger-screen-state";
import { daysSince, formatRelativeAge, formatTimestamp, shortAgentId } from "@/work-ledger/format";
import { WorkLedgerAttentionPill, WorkLedgerStatusPill } from "@/work-ledger/status-pill";
import type { WorkLedgerEntry, WorkLedgerItem } from "@getpaseo/protocol/work-ledger/types";

/** Items with no real movement for this long are worth a second look. */
const STALE_AFTER_DAYS = 2;

interface AgeLabels {
  locale: string;
  justNow: string;
  minute: string;
  hour: string;
  day: string;
}

export function WorkLedgerItemScreen({
  serverId,
  itemId,
}: {
  serverId: string;
  itemId: string;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const snapshot = useWorkLedgerItem({ serverId, itemId });
  const liveRow = useWorkLedgerItemRow({ serverId, itemId });
  // The live row moves when an agent changes the item; the history read does not.
  const item = liveRow ?? snapshot?.item ?? null;

  const ageLabels = useMemo<AgeLabels>(
    () => ({
      locale: i18n.language,
      justNow: t("workLedger.time.justNow"),
      minute: t("workLedger.time.minutesAgo"),
      hour: t("workLedger.time.hoursAgo"),
      day: t("workLedger.time.daysAgo"),
    }),
    [i18n.language, t],
  );
  const oldestLoaded = snapshot?.entries.at(-1)?.id;
  const loadOlder = useCallback(() => {
    if (!oldestLoaded) return;
    void loadOlderWorkLedgerEntries({ serverId, itemId, beforeEntryId: oldestLoaded }).catch(
      () => undefined,
    );
  }, [serverId, itemId, oldestLoaded]);

  if (!item) {
    return (
      <View style={styles.container}>
        <MenuHeader title={t("workLedger.title")} />
        <View style={styles.centered}>
          {snapshot?.status === "error" ? (
            <Text style={styles.muted}>{t("workLedger.errors.item")}</Text>
          ) : (
            <LoadingSpinner size="large" color={styles.spinner.color} />
          )}
        </View>
      </View>
    );
  }

  const entries = snapshot?.entries ?? item.entries;
  return (
    <View style={styles.container}>
      <MenuHeader title={item.number} />
      <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
        <ItemHeader item={item} />
        <GoalSections item={item} />
        <CurrentState item={item} ageLabels={ageLabels} />
        <AgentSection item={item} />
        <Section title={t("workLedger.detail.history")}>
          <View style={styles.timeline}>
            {entries.map((entry) => (
              <EntryRow key={entry.id} entry={entry} locale={i18n.language} />
            ))}
            {snapshot?.hasMore ? (
              <Button
                variant="outline"
                size="sm"
                loading={snapshot.loadingOlder}
                onPress={loadOlder}
                testID="work-ledger-load-older"
              >
                {t("workLedger.detail.older")}
              </Button>
            ) : null}
          </View>
        </Section>
      </ScrollView>
    </View>
  );
}

function isStaleItem(item: WorkLedgerItem, now: number): boolean {
  if (item.status !== "in_progress" && item.status !== "pending") return false;
  const days = daysSince(item.lastProgressAt ?? item.createdAt, now);
  return days !== null && days >= STALE_AFTER_DAYS;
}

function ItemHeader({ item }: { item: WorkLedgerItem }): ReactElement {
  const now = Date.now();
  const attention = sortAttentionReasons(item.attention);
  return (
    <>
      <View style={styles.titleRow}>
        <WorkLedgerStatusPill status={item.status} />
        {attention.map((reason) => (
          <WorkLedgerAttentionPill key={reason} reason={reason} />
        ))}
        {/* A quiet item is not the same as a finished one; say so where status lives. */}
        {isStaleItem(item, now) && !attention.includes("stalled") ? (
          <WorkLedgerAttentionPill reason="stalled" />
        ) : null}
      </View>
      <Text style={styles.title}>{item.title}</Text>
      {item.attentionNote ? <Text style={styles.attentionNote}>{item.attentionNote}</Text> : null}
      {item.blockedReason ? (
        <Text style={styles.blocked} testID="work-ledger-blocked-reason">
          {item.blockedReason}
        </Text>
      ) : null}
    </>
  );
}

function GoalSections({ item }: { item: WorkLedgerItem }): ReactElement {
  const { t } = useTranslation();
  return (
    <>
      <Section title={t("workLedger.detail.goal")}>
        <Text style={styles.body}>{item.goal ?? t("workLedger.detail.noGoal")}</Text>
      </Section>
      <Section title={t("workLedger.detail.acceptance")}>
        <Text style={styles.body}>
          {item.acceptanceCriteria ?? t("workLedger.detail.noAcceptance")}
        </Text>
      </Section>
    </>
  );
}

function CurrentState({
  item,
  ageLabels,
}: {
  item: WorkLedgerItem;
  ageLabels: AgeLabels;
}): ReactElement {
  const { t } = useTranslation();
  const now = Date.now();
  const progressed = formatRelativeAge({ ...ageLabels, iso: item.lastProgressAt, now }) ?? "—";
  const inspected = formatRelativeAge({ ...ageLabels, iso: item.lastInspectedAt, now }) ?? "—";
  return (
    <Section title={t("workLedger.detail.current")}>
      <Text style={styles.body}>{item.latestSummary ?? t("workLedger.detail.noGoal")}</Text>
      <View style={styles.clockRow}>
        {/* Two clocks: movement and checking. A sweep moves only the second. */}
        <Text style={styles.clock}>
          {t("workLedger.detail.progressedAt", { time: progressed })}
        </Text>
        <Text style={styles.clock}>{t("workLedger.detail.inspectedAt", { time: inspected })}</Text>
      </View>
    </Section>
  );
}

function AgentSection({ item }: { item: WorkLedgerItem }): ReactElement {
  const { t } = useTranslation();
  const agents = orderAgentLinks(item.agents);
  return (
    <Section title={t("workLedger.detail.agents")}>
      {agents.length === 0 ? (
        <Text style={styles.muted}>{t("workLedger.agents.none")}</Text>
      ) : (
        agents.map((link) => (
          <View key={`${link.agentId}:${link.role}`} style={styles.agentRow}>
            <Text style={styles.agentId}>{shortAgentId(link.agentId)}</Text>
            <Text style={styles.agentRole}>{t(`workLedger.agents.${link.role}`)}</Text>
            {link.state === "candidate" ? (
              <Text style={styles.agentCandidate}>{t("workLedger.agents.candidateNote")}</Text>
            ) : null}
            {link.reason ? <Text style={styles.agentReason}>{link.reason}</Text> : null}
          </View>
        ))
      )}
    </Section>
  );
}

function EntryRow({ entry, locale }: { entry: WorkLedgerEntry; locale: string }): ReactElement {
  const { t } = useTranslation();
  const unread = entry.unreadSources ?? [];
  const evidence = entry.evidence ?? [];
  return (
    <View style={styles.entry}>
      <View style={styles.entryHeader}>
        <Text style={styles.entryKind}>
          {t(`workLedger.entryKinds.${entry.kind}`)}
          {entry.outcome ? ` · ${t(`workLedger.outcomes.${entry.outcome}`)}` : ""}
        </Text>
        <Text style={styles.entryTime}>{formatTimestamp(entry.createdAt, locale) ?? ""}</Text>
      </View>
      <Text style={styles.entrySummary}>{entry.summary}</Text>
      {entry.currentState ? <Text style={styles.entryState}>{entry.currentState}</Text> : null}
      {/* An inspection that could not read a source is incomplete, not "no news". */}
      {unread.length > 0 ? (
        <Text style={styles.entryUnread}>
          {t("workLedger.detail.unread")}: {unread.join(", ")}
        </Text>
      ) : null}
      {evidence.length > 0 ? (
        <View style={styles.evidence}>
          {evidence.map((item) => (
            <Text key={`${item.label}:${item.reference ?? ""}`} style={styles.evidenceText}>
              {item.label}
              {item.reference ? ` · ${item.reference}` : ""}
            </Text>
          ))}
        </View>
      ) : null}
    </View>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }): ReactElement {
  return (
    <View style={styles.section}>
      <Text style={styles.sectionTitle}>{title}</Text>
      {children}
    </View>
  );
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    gap: theme.spacing[3],
    padding: { xs: theme.spacing[3], md: theme.spacing[6] },
    maxWidth: 920,
    width: "100%",
    alignSelf: "center",
  },
  titleRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  title: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.lg,
    fontWeight: theme.fontWeight.medium,
  },
  attentionNote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  blocked: {
    color: theme.colors.statusDanger,
    fontSize: theme.fontSize.sm,
  },
  section: {
    gap: theme.spacing[2],
    borderTopWidth: 1,
    borderTopColor: theme.colors.border,
    paddingTop: theme.spacing[3],
  },
  sectionTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    textTransform: "uppercase",
  },
  body: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  clockRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    gap: theme.spacing[3],
  },
  clock: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  agentRow: {
    flexDirection: "row",
    flexWrap: "wrap",
    alignItems: "center",
    gap: theme.spacing[2],
  },
  agentId: {
    color: theme.colors.foreground,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  agentRole: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  agentCandidate: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
  },
  agentReason: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexBasis: "100%",
  },
  timeline: {
    gap: theme.spacing[3],
  },
  entry: {
    gap: theme.spacing[1],
    borderLeftWidth: 2,
    borderLeftColor: theme.colors.border,
    paddingLeft: theme.spacing[3],
  },
  entryHeader: {
    flexDirection: "row",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  entryKind: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
  },
  entryTime: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  entrySummary: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.sm,
  },
  entryState: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontStyle: "italic",
  },
  entryUnread: {
    color: theme.colors.statusWarning,
    fontSize: theme.fontSize.sm,
  },
  evidence: {
    gap: 2,
  },
  evidenceText: {
    color: theme.colors.foregroundMuted,
    fontFamily: theme.fontFamily.mono,
    fontSize: theme.fontSize.sm,
  },
  centered: {
    flex: 1,
    alignItems: "center",
    justifyContent: "center",
    padding: theme.spacing[6],
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
