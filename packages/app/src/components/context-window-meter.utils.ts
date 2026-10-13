export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${Math.round(value / 1_000_000)}m`;
  }
  if (value >= 1_000) {
    return `${Math.round(value / 1_000)}k`;
  }
  return Math.round(value).toString();
}

/**
 * Session-cumulative token buckets, as a provider reports them.
 *
 * Only providers that can describe a whole session rather than one turn fill
 * these; the rest leave the summary empty and the tooltip unchanged.
 */
export interface SessionUsageBuckets {
  uncachedInputTokens?: number | null;
  cacheReadTokens?: number | null;
  cacheWriteTokens?: number | null;
  outputTokens?: number | null;
}

export interface SessionUsageSummary {
  totalTokens: number;
  /** Null when the session has no billed prompt tokens to take a share of. */
  cacheHitPercent: number | null;
}

/**
 * The session totals the context meter tooltip shows.
 *
 * Prompt tokens split into three disjoint buckets a provider bills separately
 * (input that missed the cache, input read from it, input written to it), so the
 * total is all three plus output, and the cache-hit share is the read bucket's
 * share of the prompt side.
 *
 * @param buckets - the reported buckets, or null when the provider reports none.
 * @returns the summary, or null when nothing was reported for any bucket.
 */
export function resolveSessionUsageSummary(
  buckets: SessionUsageBuckets | null | undefined,
): SessionUsageSummary | null {
  if (!buckets) {
    return null;
  }
  const reported = [
    buckets.uncachedInputTokens,
    buckets.cacheReadTokens,
    buckets.cacheWriteTokens,
    buckets.outputTokens,
  ];
  if (reported.every(isUnreported)) {
    return null;
  }

  const uncachedInputTokens = tokenCount(buckets.uncachedInputTokens);
  const cacheReadTokens = tokenCount(buckets.cacheReadTokens);
  const cacheWriteTokens = tokenCount(buckets.cacheWriteTokens);
  const outputTokens = tokenCount(buckets.outputTokens);
  const billedInputTokens = uncachedInputTokens + cacheReadTokens + cacheWriteTokens;

  return {
    totalTokens: billedInputTokens + outputTokens,
    cacheHitPercent: cacheHitPercent(cacheReadTokens, billedInputTokens),
  };
}

function isUnreported(value: number | null | undefined): boolean {
  return value === null || value === undefined;
}

function tokenCount(value: number | null | undefined): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * Cache-read share of the session's prompt tokens.
 *
 * A partial hit is never rounded up into a full one: a share that would display
 * as 100% keeps one decimal instead, so the number stays true. The tie-breaking
 * exactness DeepSeek Harness applies to its own pill is not worth reproducing
 * here — the tooltip's job is the magnitude, not the last digit.
 */
function cacheHitPercent(cacheReadTokens: number, billedInputTokens: number): number | null {
  if (billedInputTokens <= 0) {
    return null;
  }
  if (cacheReadTokens >= billedInputTokens) {
    return 100;
  }
  const percent = (cacheReadTokens / billedInputTokens) * 100;
  return Math.round(percent) >= 100 ? Math.floor(percent * 10) / 10 : Math.round(percent);
}
