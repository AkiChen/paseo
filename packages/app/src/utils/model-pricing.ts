import type { AgentUsage } from "@getpaseo/protocol/agent-types";

/**
 * Published unit prices, USD per million tokens.
 *
 * Read from the gateway's model cards (`cn-bot.morphic.cn/pricing`) on 2026-11-23. The cards call
 * this "动态计费" — the site re-prices with the provider, so these numbers drift. They are here to
 * turn a session's token buckets into a magnitude, never to reproduce an invoice: the site also
 * bills through a group multiplier, and its per-request billing does not scale with tokens the way
 * the formula does. Everything shown from this table is therefore an estimate, and the UI says so.
 */
export interface ModelUnitPrice {
  input: number;
  output: number;
  cacheRead: number;
}

const MODEL_UNIT_PRICES: Record<string, ModelUnitPrice> = {
  "deepseek-v4.1-flash-1017": { input: 0.286, output: 1.14, cacheRead: 0.06 },
  "deepseek-v4.1-flash": { input: 0.286, output: 1.14, cacheRead: 0.06 },
  "kimi-k3-1-pro-261024": { input: 2, output: 10, cacheRead: 0.2 },
};

/**
 * Session-cumulative token count across every bucket the provider reports.
 *
 * The three prompt buckets are disjoint and `outputTokens` is the completion side, so the total
 * is their sum. Null when the provider reported no bucket at all (claude and codex report a
 * per-turn figure instead, and their rows deliberately show no total).
 */
export function sessionTotalTokens(usage: AgentUsage | null | undefined): number | null {
  if (!usage) return null;
  const buckets = [
    usage.sessionUncachedInputTokens,
    usage.sessionCacheReadTokens,
    usage.sessionCacheWriteTokens,
    usage.sessionOutputTokens,
  ];
  if (buckets.every((value) => value === null || value === undefined)) {
    return null;
  }
  return buckets.reduce<number>((sum, value) => sum + countTokens(value), 0);
}

/**
 * Rough USD cost of the session so far, or null when it cannot be estimated.
 *
 * Null rather than a guess when the model has no published price: a wrong dollar figure is worse
 * than none on a row that is read at a glance.
 */
export function estimateSessionCostUsd(
  usage: AgentUsage | null | undefined,
  model: string | null | undefined,
): number | null {
  if (!usage || !model) return null;
  const price = MODEL_UNIT_PRICES[model];
  if (!price) return null;
  const uncached = countTokens(usage.sessionUncachedInputTokens);
  const cacheRead = countTokens(usage.sessionCacheReadTokens);
  const cacheWrite = countTokens(usage.sessionCacheWriteTokens);
  const output = countTokens(usage.sessionOutputTokens);
  if (uncached + cacheRead + cacheWrite + output === 0) {
    return null;
  }
  // A cache write is billed at the input rate; the gateway only publishes a discounted read rate.
  return (
    (uncached * price.input +
      cacheRead * price.cacheRead +
      cacheWrite * price.input +
      output * price.output) /
    1_000_000
  );
}

function countTokens(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}
