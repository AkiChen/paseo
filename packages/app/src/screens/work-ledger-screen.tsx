import { useCallback, useMemo, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, ScrollView, Text, View } from "react-native";
import { useIsFocused } from "@react-navigation/native";
import { useRouter } from "expo-router";
import { ClipboardList } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import { MenuHeader } from "@/components/headers/menu-header";
import { Button } from "@/components/ui/button";
import { LoadingSpinner } from "@/components/ui/loading-spinner";
import { SearchField } from "@/components/ui/search-field";
import { SegmentedControl } from "@/components/ui/segmented-control";
import { useProjects } from "@/hooks/use-projects";
import { useWorkLedgerHosts } from "@/hooks/use-work-ledger";

import {
  buildScopeOptions,
  buildWorkLedgerRows,
  resolveWorkLedgerBodyState,
  type WorkLedgerRow,
  type WorkLedgerScopeFilter,
  type WorkLedgerStatusFilter,
} from "@/screens/work-ledger-screen-state";
import { formatRelativeAge, itemProgressLine, shortAgentId } from "@/work-ledger/format";
import { WorkLedgerAttentionPill, WorkLedgerStatusPill } from "@/work-ledger/status-pill";
import type { Theme } from "@/styles/theme";
import type { WorkLedgerItem } from "@getpaseo/protocol/work-ledger/types";

const ThemedEmptyIcon = withUnistyles(ClipboardList, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));

const STATUS_OPTIONS: { value: WorkLedgerStatusFilter; key: string }[] = [
  { value: "all", key: "all" },
  { value: "pending", key: "pending" },
  { value: "in_progress", key: "in_progress" },
  { value: "review", key: "review" },
  { value: "attention", key: "attention" },
  { value: "completed", key: "completed" },
  { value: "cancelled", key: "cancelled" },
];

/**
 * The work index: one project's long-lived tasks plus everything in the workspaces
 * under it. Read-only by construction — agents write through Paseo tools, and there
 * is no control here that could change an item's state.
 */
export function WorkLedgerScreen(): ReactElement {
  const isFocused = useIsFocused();
  if (!isFocused) return <View style={styles.container} />;
  return <WorkLedgerScreenContent />;
}

function WorkLedgerScreenContent(): ReactElement {
  const { t, i18n } = useTranslation();
  const hosts = useWorkLedgerHosts();
  const { projects } = useProjects();
  const [query, setQuery] = useState("");
  const [status, setStatus] = useState<WorkLedgerStatusFilter>("all");
  const [scopeKey, setScopeKey] = useState("all");

  // Project ids are daemon-local; two hosts can reuse one. Scope options carry the
  // host so a project scope is never applied to another host's items.
  const scopeOptions = useMemo(
    () =>
      buildScopeOptions({
        // One entry per (host, project); the label is what a person would call it.
        projects: projects.flatMap((project) =>
          project.hosts.map((host) => ({
            projectId: host.projectId,
            name: host.projectCustomName ?? host.projectName,
          })),
        ),
        items: hosts.flatMap((host) => host.items),
        allLabel: t("workLedger.scope.all"),
      }),
    [projects, hosts, t],
  );
  // Depend on the selected option, not the derived object: the object is rebuilt on
  // every render and would invalidate the row projection each time.
  const selectedScope = scopeOptions.find((option) => option.id === scopeKey);
  const rows = useMemo(() => {
    const scope: WorkLedgerScopeFilter = selectedScope?.scope ?? { kind: "all" };
    return buildWorkLedgerRows({ hosts, filters: { query, status, scope } });
  }, [hosts, query, status, selectedScope]);
  const filtersActive = query.trim().length > 0 || status !== "all" || scopeKey !== "all";
  const bodyState = resolveWorkLedgerBodyState({ hosts, rows, filtersActive });

  const statusControlOptions = useMemo(
    () =>
      STATUS_OPTIONS.map((option) => ({
        value: option.value,
        label: t(`workLedger.filters.${option.key}`),
        testID: `work-ledger-filter-${option.value}`,
      })),
    [t],
  );

  const reset = useCallback(() => {
    setQuery("");
    setStatus("all");
    setScopeKey("all");
  }, []);

  const now = Date.now();
  const ageLabels = useMemo(
    () => ({
      locale: i18n.language,
      justNow: t("workLedger.time.justNow"),
      minute: t("workLedger.time.minutesAgo"),
      hour: t("workLedger.time.hoursAgo"),
      day: t("workLedger.time.daysAgo"),
    }),
    [i18n.language, t],
  );

  return (
    <View style={styles.container}>
      <MenuHeader title={t("workLedger.title")} />
      <View style={styles.filterBar}>
        <SearchField
          value={query}
          onChangeText={setQuery}
          placeholder={t("workLedger.filters.search")}
          clearAccessibilityLabel={t("common.clear", { defaultValue: "Clear" })}
          testID="work-ledger-search"
        />
        <SegmentedControl
          size="sm"
          value={status}
          onValueChange={setStatus}
          options={statusControlOptions}
          testID="work-ledger-status-filter"
        />
        {scopeOptions.length > 1 ? (
          <SegmentedControl
            size="sm"
            value={scopeKey}
            onValueChange={setScopeKey}
            options={scopeOptions.map((option) => ({ value: option.id, label: option.label }))}
            testID="work-ledger-scope-filter"
          />
        ) : null}
        {filtersActive ? (
          <Button variant="ghost" size="sm" onPress={reset} testID="work-ledger-reset">
            {t("workLedger.filters.reset")}
          </Button>
        ) : null}
      </View>
      <Text style={styles.readOnlyNote}>{t("workLedger.readOnly")}</Text>
      <WorkLedgerBody
        bodyState={bodyState}
        rows={rows}
        hosts={hosts}
        ageLabels={ageLabels}
        now={now}
      />
    </View>
  );
}

function WorkLedgerBody({
  bodyState,
  rows,
  hosts,
  ageLabels,
  now,
}: {
  bodyState: ReturnType<typeof resolveWorkLedgerBodyState>;
  rows: WorkLedgerRow[];
  hosts: ReturnType<typeof useWorkLedgerHosts>;
  ageLabels: React.ComponentProps<typeof RelativeAge>["labels"];
  now: number;
}): ReactElement {
  const { t } = useTranslation();
  if (bodyState.kind === "loading") {
    return (
      <View style={styles.centered}>
        <LoadingSpinner size="large" color={styles.spinner.color} />
      </View>
    );
  }
  if (bodyState.kind === "unsupported") {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>{t("workLedger.stub")}</Text>
      </View>
    );
  }
  if (bodyState.kind === "load-error") {
    return (
      <View style={styles.centered}>
        <Text style={styles.message}>{t("workLedger.errors.load")}</Text>
      </View>
    );
  }
  if (bodyState.kind === "empty") {
    return (
      <View style={styles.centered}>
        <ThemedEmptyIcon size={36} />
        <Text style={styles.emptyTitle}>{t("workLedger.empty.title")}</Text>
        <Text style={styles.emptyBody}>{t("workLedger.empty.body")}</Text>
      </View>
    );
  }

  const staleHosts = hosts.filter((host) => host.status !== "online");
  return (
    <ScrollView style={styles.scroll} contentContainerStyle={styles.scrollContent}>
      {staleHosts.length > 0 ? (
        <Text style={styles.staleNote} testID="work-ledger-stale-hosts">
          {staleHosts.map((host) => host.serverName).join(", ")} · {t("workLedger.offline")}
        </Text>
      ) : null}
      {rows.map((row) => (
        <WorkLedgerRowCard
          key={`${row.serverId}:${row.item.id}`}
          row={row}
          ageLabels={ageLabels}
          now={now}
        />
      ))}
    </ScrollView>
  );
}

function WorkLedgerRowCard({
  row,
  ageLabels,
  now,
}: {
  row: WorkLedgerRow;
  ageLabels: React.ComponentProps<typeof RelativeAge>["labels"];
  now: number;
}): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const { item } = row;
  const progress = itemProgressLine(item);
  const openDetail = useCallback(() => {
    router.push(`/h/${row.serverId}/work-ledger/item/${encodeURIComponent(item.id)}`);
  }, [router, row.serverId, item.id]);
  return (
    <Pressable
      style={styles.card}
      onPress={openDetail}
      accessibilityRole="button"
      accessibilityLabel={`${item.number} ${item.title}`}
      testID={`work-ledger-row-${item.number}`}
    >
      <View style={styles.cardHeader}>
        <Text style={styles.itemNumber}>{item.number}</Text>
        <WorkLedgerStatusPill status={item.status} />
        {item.attention.map((reason) => (
          <WorkLedgerAttentionPill key={reason} reason={reason} />
        ))}
        {row.showServer ? <Text style={styles.serverTag}>{row.serverName}</Text> : null}
      </View>
      <Text style={styles.itemTitle}>{item.title}</Text>
      {progress ? <Text style={styles.progressText}>{progress}</Text> : null}
      <View style={styles.metaRow}>
        {row.agents.length > 0 ? (
          <Text style={styles.metaText}>
            {row.agents
              .map(
                (link) =>
                  `${shortAgentId(link.agentId)}${
                    link.state === "candidate" ? ` (${t("workLedger.agents.candidate")})` : ""
                  }`,
              )
              .join(" · ")}
          </Text>
        ) : (
          <Text style={styles.metaMuted}>{t("workLedger.agents.none")}</Text>
        )}
        <RelativeAge
          iso={item.lastInspectedAt ?? item.lastProgressAt}
          labels={ageLabels}
          now={now}
        />
      </View>
    </Pressable>
  );
}

function RelativeAge({
  iso,
  labels,
  now,
}: {
  iso: string | null | undefined;
  labels: { locale: string; justNow: string; minute: string; hour: string; day: string };
  now: number;
}): ReactElement | null {
  const text = formatRelativeAge({ iso, now, ...labels });
  if (!text) return null;
  return <Text style={styles.metaMuted}>{text}</Text>;
}

export type { WorkLedgerItem };

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  filterBar: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[4],
  },
  readOnlyNote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: { xs: theme.spacing[3], md: theme.spacing[6] },
    paddingTop: theme.spacing[2],
  },
  scroll: {
    flex: 1,
    minHeight: 0,
  },
  scrollContent: {
    gap: theme.spacing[2],
    padding: { xs: theme.spacing[3], md: theme.spacing[6] },
  },
  staleNote: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  card: {
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.surface1,
    padding: theme.spacing[3],
    gap: theme.spacing[1],
  },
  cardHeader: {
    flexDirection: "row",
    alignItems: "center",
    flexWrap: "wrap",
    gap: theme.spacing[2],
  },
  itemNumber: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontFamily: theme.fontFamily.mono,
  },
  itemTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  progressText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  metaRow: {
    flexDirection: "row",
    alignItems: "center",
    justifyContent: "space-between",
    gap: theme.spacing[2],
  },
  metaText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    flexShrink: 1,
  },
  metaMuted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  serverTag: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    marginLeft: "auto",
  },
  centered: {
    flex: 1,
    justifyContent: "center",
    alignItems: "center",
    gap: theme.spacing[3],
    padding: theme.spacing[6],
  },
  emptyTitle: {
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  emptyBody: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    textAlign: "center",
    maxWidth: 420,
  },
  message: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    textAlign: "center",
    maxWidth: 420,
  },
  spinner: {
    color: theme.colors.foregroundMuted,
  },
}));
