import type { WorkLedgerItem, WorkLedgerStatus } from "@getpaseo/protocol/work-ledger/types";

/** Short agent id used beside a full id; long ids keep their recognizable head. */
export function shortAgentId(agentId: string): string {
  return agentId.length > 8 ? agentId.slice(0, 8) : agentId;
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Coarse age, deliberately vague: "3d" is enough to notice a stale item, and an
 * exact clock under every row is noise the reader has to parse.
 */
export function formatRelativeAge(input: {
  iso: string | null | undefined;
  now: number;
  locale: string;
  justNow: string;
  minute: string;
  hour: string;
  day: string;
}): string | null {
  if (!input.iso) return null;
  const then = Date.parse(input.iso);
  if (Number.isNaN(then)) return null;
  const delta = Math.max(input.now - then, 0);
  if (delta < MINUTE) return input.justNow;
  const formatter = (unit: "minute" | "hour" | "day", value: number) =>
    new Intl.NumberFormat(input.locale).format(value);
  if (delta < HOUR)
    return input.minute.replace("{{count}}", formatter("minute", Math.floor(delta / MINUTE)));
  if (delta < DAY)
    return input.hour.replace("{{count}}", formatter("hour", Math.floor(delta / HOUR)));
  return input.day.replace("{{count}}", formatter("day", Math.floor(delta / DAY)));
}

/** Locale-correct absolute timestamp for detail surfaces. */
export function formatTimestamp(iso: string | null | undefined, locale: string): string | null {
  if (!iso) return null;
  const parsed = Date.parse(iso);
  if (Number.isNaN(parsed)) return null;
  const formatter = new Intl.DateTimeFormat(locale, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
  return formatter.format(new Date(parsed));
}

let sharedCollator: Intl.Collator | null = null;

/** Natural order for item numbers in one list (TODO-…-002 before TODO-…-010). */
export function compareItemNumbers(left: string, right: string): number {
  sharedCollator ??= new Intl.Collator(undefined, { numeric: true, sensitivity: "base" });
  return sharedCollator.compare(left, right);
}

/** One line under the title: the current state, else the block reason. */
export function itemProgressLine(item: WorkLedgerItem): string | null {
  const summary = item.latestSummary?.trim();
  if (summary) return summary;
  const blocked = item.blockedReason?.trim();
  return blocked ? blocked : null;
}

export const STATUS_ORDER: readonly WorkLedgerStatus[] = [
  "pending",
  "in_progress",
  "review",
  "completed",
  "cancelled",
];

export function daysSince(iso: string | null | undefined, now: number): number | null {
  if (!iso) return null;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return null;
  return Math.floor((now - then) / DAY);
}
