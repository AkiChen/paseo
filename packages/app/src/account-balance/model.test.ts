import { describe, expect, it } from "vitest";
import { getBalanceTone, parseAccountBalanceResponse } from "./model";

describe("Account balance model", () => {
  it("reads a direct balance value", () => {
    expect(parseAccountBalanceResponse({ balance: 42.5 })).toEqual({
      quota: 42.5,
      balanceUsd: 42.5,
    });
  });

  it("reads a nested quota value and normalizes it with the configured rate", () => {
    expect(
      parseAccountBalanceResponse({ success: true, data: { quota: 160_100_000 } }, 500_000),
    ).toEqual({ quota: 160_100_000, balanceUsd: 320.2 });
  });

  it("reads a bare quota value", () => {
    expect(parseAccountBalanceResponse({ quota: 7 })).toEqual({ quota: 7, balanceUsd: 7 });
  });

  it("surfaces an explicit failure and rejects a response without a number", () => {
    expect(() => parseAccountBalanceResponse({ success: false, message: "expired" })).toThrow(
      "expired",
    );
    expect(() => parseAccountBalanceResponse({ success: true, data: {} })).toThrow("numeric");
    expect(() => parseAccountBalanceResponse("nope")).toThrow("invalid response");
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
