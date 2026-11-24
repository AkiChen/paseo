import { describe, expect, it } from "vitest";
import {
  estimateSessionCostUsd,
  normalizeModelId,
  sessionTotalTokens,
} from "@/utils/model-pricing";

describe("normalizeModelId", () => {
  it("unwraps the serialized route/model pair the daemon records", () => {
    expect(normalizeModelId('["morphic-kimi","kimi-k3-1-pro-261024"]')).toBe(
      "kimi-k3-1-pro-261024",
    );
  });

  it("takes the model out of a comma-joined pair", () => {
    expect(normalizeModelId("morphic-kimi,kimi-k3-1-pro-261024")).toBe("kimi-k3-1-pro-261024");
  });

  it("keeps a plain model id as it is", () => {
    expect(normalizeModelId("deepseek-v4.1-flash-1017")).toBe("deepseek-v4.1-flash-1017");
    expect(normalizeModelId(null)).toBeNull();
  });

  it("falls back to the last id when nothing in the pair is priced", () => {
    expect(normalizeModelId('["route","unlisted-model"]')).toBe("unlisted-model");
  });
});

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

  it("prices a model recorded as a route/model pair", () => {
    const usage = { sessionUncachedInputTokens: 1_000_000, sessionOutputTokens: 0 };
    expect(estimateSessionCostUsd(usage, '["morphic-kimi","kimi-k3-1-pro-261024"]')).toBeCloseTo(
      2,
      6,
    );
    expect(
      estimateSessionCostUsd(usage, '["deepseek-official","deepseek-v4.1-flash-1017"]'),
    ).toBeCloseTo(0.286, 6);
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

  it("prices each model in the session's split at its own rate", () => {
    // The same session billed one million uncached input tokens on kimi and one on deepseek.
    const cost = estimateSessionCostUsd(
      {
        sessionUncachedInputTokens: 2_000_000,
        sessionCacheReadTokens: 0,
        sessionCacheWriteTokens: 0,
        sessionOutputTokens: 0,
        sessionUsageByModel: {
          "kimi-k3-1-pro-261024": {
            uncachedInputTokens: 1_000_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0,
          },
          "deepseek-v4.1-flash-1017": {
            uncachedInputTokens: 1_000_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0,
          },
        },
      },
      // The agent is now set to kimi; the deepseek half must not be re-priced at kimi rates.
      '["morphic-kimi","kimi-k3-1-pro-261024"]',
    );
    expect(cost).toBeCloseTo(2 + 0.286, 6);
  });

  it("skips models in the split that have no published price", () => {
    const cost = estimateSessionCostUsd(
      {
        sessionUsageByModel: {
          "kimi-k3-1-pro-261024": {
            uncachedInputTokens: 1_000_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0,
          },
          "gpt-6.1-sol": {
            uncachedInputTokens: 1_000_000,
            cacheReadTokens: 0,
            cacheWriteTokens: 0,
            outputTokens: 0,
          },
        },
      },
      null,
    );
    expect(cost).toBeCloseTo(2, 6);
  });

  it("returns null when no model in the split is priced", () => {
    expect(
      estimateSessionCostUsd(
        {
          sessionUsageByModel: {
            "gpt-6.1-sol": {
              uncachedInputTokens: 1_000_000,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              outputTokens: 0,
            },
          },
        },
        null,
      ),
    ).toBeNull();
  });
});
