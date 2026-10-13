import { describe, expect, it } from "vitest";

import { resolveSessionUsageSummary } from "./context-window-meter.utils";

describe("resolveSessionUsageSummary", () => {
  it("sums the three prompt buckets and output, and takes the cache-read share", () => {
    expect(
      resolveSessionUsageSummary({
        uncachedInputTokens: 1_200,
        cacheReadTokens: 44_000,
        cacheWriteTokens: 300,
        outputTokens: 900,
      }),
    ).toEqual({ totalTokens: 46_400, cacheHitPercent: 97 });
  });

  it("reports nothing when no bucket was reported", () => {
    expect(resolveSessionUsageSummary(null)).toBeNull();
    expect(resolveSessionUsageSummary(undefined)).toBeNull();
    expect(resolveSessionUsageSummary({})).toBeNull();
    expect(
      resolveSessionUsageSummary({
        uncachedInputTokens: null,
        cacheReadTokens: null,
        cacheWriteTokens: null,
        outputTokens: null,
      }),
    ).toBeNull();
  });

  it("treats an unreported bucket as zero", () => {
    expect(resolveSessionUsageSummary({ outputTokens: 500 })).toEqual({
      totalTokens: 500,
      cacheHitPercent: null,
    });
  });

  it("calls a fully cached prompt a hundred percent", () => {
    expect(resolveSessionUsageSummary({ cacheReadTokens: 1_000 })?.cacheHitPercent).toBe(100);
  });

  it("never rounds a partial hit up into a full one", () => {
    // 99.6% would display as 100% at integer precision.
    expect(
      resolveSessionUsageSummary({ cacheReadTokens: 996, uncachedInputTokens: 4 })?.cacheHitPercent,
    ).toBe(99.6);
  });

  it("has no cache-hit share when the prompt side is empty", () => {
    expect(resolveSessionUsageSummary({ outputTokens: 12 })?.cacheHitPercent).toBeNull();
  });
});
