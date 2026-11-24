import { describe, expect, it } from "vitest";
import {
  addSessionUsage,
  sessionUsageDelta,
  UNKNOWN_SESSION_USAGE_MODEL,
} from "./session-usage-by-model.js";

describe("sessionUsageDelta", () => {
  it("is the difference between two cumulative snapshots", () => {
    expect(
      sessionUsageDelta(
        {
          uncachedInputTokens: 100,
          cacheReadTokens: 1_000,
          cacheWriteTokens: 0,
          outputTokens: 10,
        },
        {
          uncachedInputTokens: 250,
          cacheReadTokens: 2_500,
          cacheWriteTokens: 0,
          outputTokens: 40,
        },
      ),
    ).toEqual({
      uncachedInputTokens: 150,
      cacheReadTokens: 1_500,
      cacheWriteTokens: 0,
      outputTokens: 30,
    });
  });

  it("treats the first snapshot as a delta from zero", () => {
    expect(
      sessionUsageDelta(null, {
        uncachedInputTokens: 7,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 3,
      }),
    ).toEqual({ uncachedInputTokens: 7, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 3 });
  });

  it("clamps a shrinking total to zero instead of going negative", () => {
    // A rewind or compaction can lower the provider's cumulative numbers.
    expect(
      sessionUsageDelta(
        {
          uncachedInputTokens: 100,
          cacheReadTokens: 1_000,
          cacheWriteTokens: 5,
          outputTokens: 10,
        },
        { uncachedInputTokens: 40, cacheReadTokens: 900, cacheWriteTokens: 0, outputTokens: 0 },
      ),
    ).toEqual({ uncachedInputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, outputTokens: 0 });
  });
});

describe("addSessionUsage", () => {
  it("accumulates the delta under the model that produced it", () => {
    const first = addSessionUsage(undefined, "kimi-k3-1-pro-261024", {
      uncachedInputTokens: 100,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 10,
    });
    const second = addSessionUsage(first, "deepseek-v4.1-flash-1017", {
      uncachedInputTokens: 50,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 5,
    });
    const third = addSessionUsage(second, "kimi-k3-1-pro-261024", {
      uncachedInputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 1,
    });

    expect(third).toEqual({
      "kimi-k3-1-pro-261024": {
        uncachedInputTokens: 101,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 11,
      },
      "deepseek-v4.1-flash-1017": {
        uncachedInputTokens: 50,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 5,
      },
    });
  });

  it("does not introduce a model bucket for an empty delta", () => {
    expect(
      addSessionUsage(undefined, "kimi-k3-1-pro-261024", {
        uncachedInputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      }),
    ).toEqual({});
  });

  it("keeps unattributed tokens under a placeholder key", () => {
    expect(
      addSessionUsage(undefined, null, {
        uncachedInputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      }),
    ).toEqual({
      [UNKNOWN_SESSION_USAGE_MODEL]: {
        uncachedInputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      },
    });
  });

  it("leaves the input map untouched", () => {
    const byModel = {
      "kimi-k3-1-pro-261024": {
        uncachedInputTokens: 1,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        outputTokens: 0,
      },
    };
    const next = addSessionUsage(byModel, "kimi-k3-1-pro-261024", {
      uncachedInputTokens: 1,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      outputTokens: 0,
    });
    expect(byModel["kimi-k3-1-pro-261024"].uncachedInputTokens).toBe(1);
    expect(next["kimi-k3-1-pro-261024"].uncachedInputTokens).toBe(2);
  });
});
