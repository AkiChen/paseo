import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from "react";
import { useTranslation } from "react-i18next";
import { Pressable, Text, View } from "react-native";
import { useRouter } from "expo-router";
import { useIsFocused } from "@react-navigation/native";
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
import { isNative } from "@/constants/platform";
import { HEADER_CONTROL_HEIGHT } from "@/components/ui/control-geometry";
import { useHoverSafeZone } from "@/hooks/use-hover-safe-zone";

/** Grace period before a hover-opened popover closes, absorbing edge jitter. */
const HOVER_GRACE_MS = 260;
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
  // Everything not already shown above, newest first. The popup is the only surface
  // reachable from a workspace, so restricting it to two buckets left in-progress and
  // pending work invisible.
  const attentionIds = useMemo(
    () => new Set(attention.map((entry) => `${entry.serverId}:${entry.item.id}`)),
    [attention],
  );
  const recent = useMemo(
    () =>
      entries
        .filter((entry) => !attentionIds.has(`${entry.serverId}:${entry.item.id}`))
        .slice(0, 6),
    [entries, attentionIds],
  );

  const openItem = useCallback(
    (entry: PopupEntry) => {
      router.push(`/h/${entry.serverId}/work-ledger/item/${encodeURIComponent(entry.item.id)}`);
    },
    [router],
  );
  const openAll = useCallback(() => {
    // From a workspace header the popup is host-scoped; without a host it is the
    // cross-host summary, so "view all" opens the all-hosts index.
    if (serverId) {
      router.push(`/h/${serverId}/work-ledger`);
      return;
    }
    router.push("/work-ledger");
  }, [router, serverId]);

  const triggerLabel =
    counts.attention > 0
      ? `${t("workLedger.popup.title")} ${counts.attention}`
      : t("workLedger.popup.title");

  // Hover opens it: the popup is a glance, and a click to look at a summary is a
  // step too many. This follows docs/hover.md rather than Pressable's own hover
  // state: hover is tracked on a plain View via pointerenter/pointerleave, press
  // lives on a separate inner Pressable, and the popover (a portal, so there is a
  // real gap) is bridged with useHoverSafeZone.
  const triggerRef = useRef<View>(null);
  const contentRef = useRef<View>(null);
  const [open, setOpen] = useState(false);
  const graceTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearGraceTimer = useCallback(() => {
    if (graceTimerRef.current) {
      clearTimeout(graceTimerRef.current);
      graceTimerRef.current = null;
    }
  }, []);

  const scheduleClose = useCallback(() => {
    if (graceTimerRef.current) return;
    graceTimerRef.current = setTimeout(() => {
      graceTimerRef.current = null;
      setOpen(false);
    }, HOVER_GRACE_MS);
  }, []);

  const handleTriggerEnter = useCallback(() => {
    clearGraceTimer();
    setOpen(true);
  }, [clearGraceTimer]);

  const handleTriggerLeave = useCallback(() => {
    scheduleClose();
  }, [scheduleClose]);

  // Covers trigger + content + the bridge between them; leaving the zone starts the
  // close, re-entering it cancels.
  useHoverSafeZone({
    enabled: open,
    triggerRef,
    contentRef,
    onEnterSafeZone: clearGraceTimer,
    onLeaveSafeZone: scheduleClose,
  });

  // A pointerleave that never arrives must not outlive the trigger. The popover renders
  // through a portal, so navigating away with it open leaves it floating over whatever
  // screen comes next, pointing at a trigger that no longer exists.
  useEffect(
    () => () => {
      clearGraceTimer();
      setOpen(false);
    },
    [clearGraceTimer],
  );

  // The workspace screen stays mounted across navigation, so unmount is not enough:
  // losing route focus with the popover open is what stranded it on the next screen.
  const isFocused = useIsFocused();
  useEffect(() => {
    if (!isFocused) {
      clearGraceTimer();
      setOpen(false);
    }
  }, [isFocused, clearGraceTimer]);

  // Native has no hover, so a tap is the only way in there.
  const handlePress = useCallback(() => {
    setOpen((current) => !current);
  }, []);

  return (
    <View
      ref={triggerRef}
      collapsable={false}
      onPointerEnter={handleTriggerEnter}
      onPointerLeave={handleTriggerLeave}
      style={styles.hoverRegion}
      testID="work-ledger-popup-region"
    >
      <DropdownMenu open={open} onOpenChange={setOpen}>
        <DropdownMenuTrigger
          testID="work-ledger-popup-trigger"
          accessibilityLabel={t("workLedger.popup.title")}
          style={styles.trigger}
        >
          <Pressable onPress={isNative ? handlePress : undefined} style={styles.triggerContent}>
            <ThemedIcon size={14} />
            <Text style={styles.triggerText}>{triggerLabel}</Text>
          </Pressable>
        </DropdownMenuTrigger>
        <DropdownMenuContent width={340} maxHeight={460} scrollable>
          <View ref={contentRef} collapsable={false} style={styles.menuBody}>
            <Text style={styles.summary}>
              {t("workLedger.hosts.summary", {
                count: counts.total,
                hosts: hosts
                  .filter((host) => host.items.length > 0)
                  .map((host) => host.serverName)
                  .join(", "),
              })}
            </Text>
            <Text style={styles.summary}>
              {t("workLedger.filters.attention")} {counts.attention} ·{" "}
              {t("workLedger.filters.review")} {counts.review} ·{" "}
              {t("workLedger.filters.in_progress")} {counts.inProgress}
            </Text>
            {attention.length === 0 && recent.length === 0 ? (
              <Text style={styles.muted}>{t("workLedger.popup.none")}</Text>
            ) : null}
            <PopupGroup
              title={attention.length > 0 ? t("workLedger.popup.attention") : null}
              entries={attention}
              onOpen={openItem}
            />
            <PopupGroup
              title={recent.length > 0 ? t("workLedger.popup.recent") : null}
              entries={recent}
              onOpen={openItem}
            />
            <DropdownMenuItem testID="work-ledger-popup-open-all" onSelect={openAll}>
              {t("workLedger.popup.open")}
            </DropdownMenuItem>
          </View>
        </DropdownMenuContent>
      </DropdownMenu>
    </View>
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
      {entry.item.title}
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
  // The hover region owns both the trigger and, on wide layouts, the space the
  // popover opens into, so crossing the gap does not close it.
  hoverRegion: {
    flexDirection: "row",
    alignItems: "center",
  },
  triggerContent: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
  },
  trigger: {
    flexDirection: "row",
    alignItems: "center",
    gap: theme.spacing[1],
    height: HEADER_CONTROL_HEIGHT,
    paddingHorizontal: theme.spacing[2],
    borderWidth: 1,
    // Same geometry as the header's other pills (balance, commit): shared height
    // token and radius, so the row reads as one set of controls.
    borderRadius: theme.borderRadius.md,
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
