import { describe, expect, it } from "vitest";
import { getBalanceTone, parseMorphicBalanceResponse } from "./model";

describe("Morphic balance model", () => {
  it("converts quota units to US dollars", () => {
    expect(parseMorphicBalanceResponse({ success: true, data: { quota: 160_100_000 } })).toEqual({
      quota: 160_100_000,
      balanceUsd: 320.2,
    });
  });

  it("rejects unsuccessful and malformed responses", () => {
    expect(() => parseMorphicBalanceResponse({ success: false, message: "expired" })).toThrow(
      "expired",
    );
    expect(() => parseMorphicBalanceResponse({ success: true, data: {} })).toThrow("data.quota");
  });

  it.each([
    [500, "healthy"],
    [499.99, "warning"],
    [100, "warning"],
    [99.99, "danger"],
  ] as const)("maps a $%s balance to %s", (balanceUsd, expected) => {
    expect(getBalanceTone(balanceUsd)).toBe(expected);
  });
});
