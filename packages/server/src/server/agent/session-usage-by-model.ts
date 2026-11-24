import type { SessionUsageBuckets, SessionUsageByModel } from "./agent-sdk-types.js";

/** The key a session's usage gets when the agent could not name the model it was billed on. */
export const UNKNOWN_SESSION_USAGE_MODEL = "unknown";

/**
 * The token delta between two cumulative snapshots.
 *
 * Negative components are clamped to zero. A rewind or a compaction can lower the provider's
 * cumulative totals, and a negative delta would otherwise eat another model's already-attributed
 * tokens.
 */
export function sessionUsageDelta(
  previous: SessionUsageBuckets | null,
  next: SessionUsageBuckets,
): SessionUsageBuckets {
  const delta = (from: number | undefined, to: number): number => {
    const value = to - (from ?? 0);
    return value > 0 ? value : 0;
  };
  return {
    uncachedInputTokens: delta(previous?.uncachedInputTokens, next.uncachedInputTokens),
    cacheReadTokens: delta(previous?.cacheReadTokens, next.cacheReadTokens),
    cacheWriteTokens: delta(previous?.cacheWriteTokens, next.cacheWriteTokens),
    outputTokens: delta(previous?.outputTokens, next.outputTokens),
  };
}

/**
 * Add a delta to the bucket of the model that produced it.
 *
 * Attribution happens at the snapshot boundary rather than per request: the provider reports one
 * cumulative total, and whatever changed since the previous read belongs to the model that was
 * selected for it. A model switch between turns is therefore exact; a switch in the middle of a
 * turn would be attributed to the model that was current when the snapshot landed.
 */
export function addSessionUsage(
  byModel: SessionUsageByModel | undefined,
  model: string | null,
  delta: SessionUsageBuckets,
): SessionUsageByModel {
  const unchanged =
    delta.uncachedInputTokens === 0 &&
    delta.cacheReadTokens === 0 &&
    delta.cacheWriteTokens === 0 &&
    delta.outputTokens === 0;
  const result: SessionUsageByModel = { ...byModel };
  if (unchanged) {
    return result;
  }
  const key = model?.trim() || UNKNOWN_SESSION_USAGE_MODEL;
  const current = result[key];
  result[key] = {
    uncachedInputTokens: (current?.uncachedInputTokens ?? 0) + delta.uncachedInputTokens,
    cacheReadTokens: (current?.cacheReadTokens ?? 0) + delta.cacheReadTokens,
    cacheWriteTokens: (current?.cacheWriteTokens ?? 0) + delta.cacheWriteTokens,
    outputTokens: (current?.outputTokens ?? 0) + delta.outputTokens,
  };
  return result;
}
