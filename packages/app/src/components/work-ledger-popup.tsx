import { memo, useCallback, useMemo, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Text, View } from "react-native";
import { useRouter } from "expo-router";
import { ClipboardList } from "lucide-react-native";
import { StyleSheet, withUnistyles } from "react-native-unistyles";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { useWorkLedgerHosts } from "@/hooks/use-work-ledger";
import {
  collectAttentionCounts,
  orderAgentLinks,
  selectPopupHosts,
} from "@/screens/work-ledger-screen-state";
import { formatRelativeAge, shortAgentId } from "@/work-ledger/format";
import type { Theme } from "@/styles/theme";
import type { WorkLedgerItem } from "@getpaseo/protocol/work-ledger/types";

const ThemedIcon = withUnistyles(ClipboardList, (theme: Theme) => ({
  color: theme.colors.foregroundMuted,
}));

interface PopupEntry {
  serverId: string;
  item: WorkLedgerItem;
}

/**
 * The quick view of the index: what needs a look, what waits for verification, and
 * how much is in flight. It opens on demand — an agent writing to the ledger must
 * not interrupt whatever the user is doing.
 */
export function WorkLedgerPopup({ serverId }: { serverId?: string }): ReactElement {
  const { t } = useTranslation();
  const router = useRouter();
  const allHosts = useWorkLedgerHosts();
  const hosts = useMemo(
    () => selectPopupHosts({ hosts: allHosts, serverId }),
    [allHosts, serverId],
  );
  const counts = useMemo(() => collectAttentionCounts(hosts), [hosts]);

  const entries = useMemo<PopupEntry[]>(
    () =>
      hosts
        .flatMap((host) => host.items.map((item) => ({ serverId: host.serverId, item })))
        .sort((left, right) => Date.parse(right.item.updatedAt) - Date.parse(left.item.updatedAt)),
    [hosts],
  );
  const attention = useMemo(
    () => entries.filter((entry) => entry.item.attention.length > 0).slice(0, 4),
    [entries],
  );
  const review = useMemo(
    () => entries.filter((entry) => entry.item.status === "review").slice(0, 4),
    [entries],
  );

  const openItem = useCallback(
    (entry: PopupEntry) => {
      router.push(`/h/${entry.serverId}/work-ledger/item/${encodeURIComponent(entry.item.id)}`);
    },
    [router],
  );
  const openAll = useCallback(() => {
    const target = serverId ?? entries[0]?.serverId;
    if (target) router.push(`/h/${target}/work-ledger`);
  }, [router, serverId, entries]);

  const triggerLabel =
    counts.attention > 0
      ? `${t("workLedger.popup.title")} ${counts.attention}`
      : t("workLedger.popup.title");

  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        testID="work-ledger-popup-trigger"
        accessibilityLabel={t("workLedger.popup.title")}
        style={styles.trigger}
      >
        <ThemedIcon size={14} />
        <Text style={styles.triggerText}>{triggerLabel}</Text>
      </DropdownMenuTrigger>
      <DropdownMenuContent width={340} maxHeight={460} scrollable>
        <View style={styles.menuBody}>
          <Text style={styles.summary}>
            {t("workLedger.filters.attention")} {counts.attention} ·{" "}
            {t("workLedger.filters.review")} {counts.review} · {t("workLedger.filters.in_progress")}{" "}
            {counts.inProgress}
          </Text>
          {attention.length === 0 && review.length === 0 ? (
            <Text style={styles.muted}>{t("workLedger.popup.none")}</Text>
          ) : null}
          <PopupGroup
            title={attention.length > 0 ? t("workLedger.popup.attention") : null}
            entries={attention}
            onOpen={openItem}
          />
          <PopupGroup
            title={review.length > 0 ? t("workLedger.popup.review") : null}
            entries={review}
            onOpen={openItem}
          />
          <DropdownMenuItem testID="work-ledger-popup-open-all" onSelect={openAll}>
            {t("workLedger.popup.open")}
          </DropdownMenuItem>
        </View>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function PopupGroup({
  title,
  entries,
  onOpen,
}: {
  title: string | null;
  entries: readonly PopupEntry[];
  onOpen: (entry: PopupEntry) => void;
}): ReactElement | null {
  if (entries.length === 0) return null;
  return (
    <>
      {title ? <Text style={styles.groupTitle}>{title}</Text> : null}
      {entries.map((entry) => (
        <PopupRow key={`${entry.serverId}:${entry.item.id}`} entry={entry} onOpen={onOpen} />
      ))}
    </>
  );
}

const PopupRow = memo(function PopupRow({
  entry,
  onOpen,
}: {
  entry: PopupEntry;
  onOpen: (entry: PopupEntry) => void;
}): ReactElement {
  const { t, i18n } = useTranslation();
  const description = useMemo(
    () => describeEntry(entry.item, t, i18n.language),
    [entry.item, t, i18n.language],
  );
  const handleSelect = useCallback(() => onOpen(entry), [onOpen, entry]);
  return (
    <DropdownMenuItem
      description={description}
      onSelect={handleSelect}
      testID={`work-ledger-popup-item-${entry.item.number}`}
    >
      {`${entry.item.number} · ${entry.item.title}`}
    </DropdownMenuItem>
  );
});

function describeEntry(item: WorkLedgerItem, t: (key: string) => string, locale: string): string {
  const agents = orderAgentLinks(item.agents);
  const age = formatRelativeAge({
    iso: item.lastProgressAt ?? item.createdAt,
    now: Date.now(),
    locale,
    justNow: t("workLedger.time.justNow"),
    minute: t("workLedger.time.minutesAgo"),
    hour: t("workLedger.time.hoursAgo"),
    day: t("workLedger.time.daysAgo"),
  });
  const who = agents.length > 0 ? shortAgentId(agents[0]!.agentId) : t("workLedger.agents.none");
  return [age, who].filter(Boolean).join(" · ");
}

const styles = StyleSheet.create((theme) => ({
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    paddingHorizontal: theme.spacing[2],
    paddingVertical: 4,
    borderRadius: theme.borderRadius.full,
    borderWidth: 1,
    borderColor: theme.colors.border,
  },
  triggerText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  menuBody: {
    padding: theme.spacing[2],
    gap: theme.spacing[1],
  },
  summary: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    paddingHorizontal: theme.spacing[2],
    paddingBottom: theme.spacing[1],
  },
  groupTitle: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    fontWeight: theme.fontWeight.medium,
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
  },
  muted: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
    padding: theme.spacing[2],
  },
}));
