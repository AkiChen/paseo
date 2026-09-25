/**
 * The endpoint is whatever the user configured; nothing about it is baked in.
 * A response may carry the amount either at `balance` or at `data.quota`, and
 * `quotaPerUsd` normalizes the latter into the value the badge shows.
 */
export const DEFAULT_QUOTA_PER_USD = 1;
export const ACCOUNT_BALANCE_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

export type BalanceTone = "healthy" | "warning" | "danger";

export interface AccountBalanceSnapshot {
  quota: number;
  balanceUsd: number;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function readNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

export function parseAccountBalanceResponse(
  value: unknown,
  quotaPerUsd: number = DEFAULT_QUOTA_PER_USD,
): Omit<AccountBalanceSnapshot, "updatedAt"> {
  if (!isRecord(value)) {
    throw new Error("The balance endpoint returned an invalid response");
  }
  if (value.success === false) {
    const message = typeof value.message === "string" ? value.message.trim() : "";
    throw new Error(message || "The balance endpoint rejected the request");
  }
  const direct = readNumber(value.balance) ?? readNumber(value.quota);
  const nested = isRecord(value.data)
    ? (readNumber(value.data.quota) ?? readNumber(value.data.balance))
    : null;
  const quota = direct ?? nested;
  if (quota === null) {
    throw new Error("The balance response has no numeric balance or data.quota value");
  }
  return { quota, balanceUsd: quota / quotaPerUsd };
}

export function getBalanceTone(balanceUsd: number): BalanceTone {
  if (balanceUsd >= 500) return "healthy";
  if (balanceUsd >= 100) return "warning";
  return "danger";
}
