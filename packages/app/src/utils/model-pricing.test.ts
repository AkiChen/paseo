import { describe, expect, it } from "vitest";
import { estimateSessionCostUsd, sessionTotalTokens } from "@/utils/model-pricing";

describe("sessionTotalTokens", () => {
  it("sums the four disjoint buckets", () => {
    expect(
      sessionTotalTokens({
        sessionUncachedInputTokens: 1_000,
        sessionCacheReadTokens: 10_000,
        sessionCacheWriteTokens: 500,
        sessionOutputTokens: 200,
      }),
    ).toBe(11_700);
  });

  it("returns null when the provider reported no session bucket", () => {
    expect(sessionTotalTokens({ inputTokens: 10, outputTokens: 2 })).toBeNull();
    expect(sessionTotalTokens(null)).toBeNull();
    expect(sessionTotalTokens(undefined)).toBeNull();
  });

  it("treats a reported zero as a real total", () => {
    expect(
      sessionTotalTokens({
        sessionUncachedInputTokens: 0,
        sessionCacheReadTokens: 0,
        sessionCacheWriteTokens: 0,
        sessionOutputTokens: 0,
      }),
    ).toBe(0);
  });
});

describe("estimateSessionCostUsd", () => {
  it("bills cache reads at the discounted rate", () => {
    // 1M uncached at 0.286 + 1M cache reads at 0.06 + 1M output at 1.14.
    const cost = estimateSessionCostUsd(
      {
        sessionUncachedInputTokens: 1_000_000,
        sessionCacheReadTokens: 1_000_000,
        sessionCacheWriteTokens: 0,
        sessionOutputTokens: 1_000_000,
      },
      "deepseek-v4.1-flash-1017",
    );
    expect(cost).toBeCloseTo(0.286 + 0.06 + 1.14, 6);
  });

  it("bills a cache write at the input rate", () => {
    const cost = estimateSessionCostUsd(
      { sessionCacheWriteTokens: 1_000_000, sessionUncachedInputTokens: 0, sessionOutputTokens: 0 },
      "deepseek-v4.1-flash-1017",
    );
    expect(cost).toBeCloseTo(0.286, 6);
  });

  it("prices kimi from its own row", () => {
    const cost = estimateSessionCostUsd(
      { sessionUncachedInputTokens: 1_000_000, sessionOutputTokens: 0, sessionCacheReadTokens: 0 },
      "kimi-k3-1-pro-261024",
    );
    expect(cost).toBeCloseTo(2, 6);
  });

  it("refuses to guess for an unknown model", () => {
    expect(
      estimateSessionCostUsd({ sessionUncachedInputTokens: 100_000 }, "some-unlisted-model"),
    ).toBeNull();
    expect(estimateSessionCostUsd({ sessionUncachedInputTokens: 100_000 }, null)).toBeNull();
  });

  it("returns null when nothing was billed yet", () => {
    expect(
      estimateSessionCostUsd(
        {
          sessionUncachedInputTokens: 0,
          sessionCacheReadTokens: 0,
          sessionCacheWriteTokens: 0,
          sessionOutputTokens: 0,
        },
        "deepseek-v4.1-flash-1017",
      ),
    ).toBeNull();
  });
});
