export const MORPHIC_BALANCE_URL = "https://pub-cn-bot.morphic.cn/api/user/self";
export const MORPHIC_QUOTA_PER_USD = 500_000;
export const MORPHIC_BALANCE_REFRESH_INTERVAL_MS = 5 * 60 * 1_000;

export type BalanceTone = "healthy" | "warning" | "danger";

export interface MorphicBalanceSnapshot {
  quota: number;
  balanceUsd: number;
  updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

export function parseMorphicBalanceResponse(
  value: unknown,
): Omit<MorphicBalanceSnapshot, "updatedAt"> {
  if (!isRecord(value)) {
    throw new Error("Morphic returned an invalid response");
  }
  if (value.success !== true) {
    const message = typeof value.message === "string" ? value.message.trim() : "";
    throw new Error(message || "Morphic rejected the balance request");
  }
  const data = value.data;
  const quota = isRecord(data) ? data.quota : undefined;
  if (typeof quota !== "number" || !Number.isFinite(quota)) {
    throw new Error("Morphic response does not contain a valid data.quota value");
  }
  return { quota, balanceUsd: quota / MORPHIC_QUOTA_PER_USD };
}

export function getBalanceTone(balanceUsd: number): BalanceTone {
  if (balanceUsd >= 500) return "healthy";
  if (balanceUsd >= 100) return "warning";
  return "danger";
}
