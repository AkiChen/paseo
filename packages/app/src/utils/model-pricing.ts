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
 * The model id out of whatever the daemon recorded as the agent's model.
 *
 * A harness that routes several vendors (DeepSeek Harness here) records the selection as the
 * `[routeId, modelId]` pair it made, serialized — `["morphic-kimi","kimi-k3-1-pro-261024"]` — and
 * the same array can surface as a list or a comma-joined string. The model is the id that has a
 * price, so the pair is unwrapped before lookup.
 */
export function normalizeModelId(model: string | null | undefined): string | null {
  if (!model) return null;
  const trimmed = model.trim();
  if (trimmed.startsWith("[") || trimmed.includes(",")) {
    const ids = trimmed
      .replace(/^\[|\]$/g, "")
      .split(",")
      .map((part) => part.trim().replace(/^["']|["']$/g, ""))
      .filter(Boolean);
    const priced = ids.find((id) => id in MODEL_UNIT_PRICES);
    if (priced) return priced;
    return ids.at(-1) ?? null;
  }
  return trimmed || null;
}

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
 * A session that switched models mid-flight is priced per model, from the split the daemon
 * attributes as it watches the session — that is the same session total, just billed at each
 * model's own rates. Without a split (an older daemon, or a provider that reports one figure for
 * everything) the whole session is priced at the model the agent is set to now, which is also what
 * a session with a single model needs.
 *
 * Null rather than a guess when nothing in play has a published price: a wrong dollar figure is
 * worse than none on a row that is read at a glance.
 */
export function estimateSessionCostUsd(
  usage: AgentUsage | null | undefined,
  model: string | null | undefined,
): number | null {
  if (!usage) return null;
  const byModel = usage.sessionUsageByModel;
  if (byModel && Object.keys(byModel).length > 0) {
    let total = 0;
    let priced = false;
    for (const [bucketedModel, buckets] of Object.entries(byModel)) {
      const price = priceFor(bucketedModel);
      if (!price) continue;
      const cost = costOfBuckets(buckets, price);
      if (cost === null) continue;
      total += cost;
      priced = true;
    }
    return priced ? total : null;
  }

  const price = priceFor(model);
  if (!price) return null;
  return costOfBuckets(
    {
      uncachedInputTokens: usage.sessionUncachedInputTokens ?? 0,
      cacheReadTokens: usage.sessionCacheReadTokens ?? 0,
      cacheWriteTokens: usage.sessionCacheWriteTokens ?? 0,
      outputTokens: usage.sessionOutputTokens ?? 0,
    },
    price,
  );
}

function priceFor(model: string | null | undefined): ModelUnitPrice | null {
  const modelId = normalizeModelId(model);
  return modelId ? (MODEL_UNIT_PRICES[modelId] ?? null) : null;
}

/**
 * The bill for one bucket set at one price, or null when the bucket set says nothing.
 *
 * A cache write is billed at the input rate; the gateway only publishes a discounted read rate.
 */
function costOfBuckets(
  buckets: {
    uncachedInputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    outputTokens: number;
  },
  price: ModelUnitPrice,
): number | null {
  const uncached = countTokens(buckets.uncachedInputTokens);
  const cacheRead = countTokens(buckets.cacheReadTokens);
  const cacheWrite = countTokens(buckets.cacheWriteTokens);
  const output = countTokens(buckets.outputTokens);
  if (uncached + cacheRead + cacheWrite + output === 0) {
    return null;
  }
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
