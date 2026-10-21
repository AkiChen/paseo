import { describe, expect, it } from "vitest";
import { MORPHIC_BALANCE_URL } from "./model";
import { queryMorphicBalance, type MorphicBalanceHttpClient } from "./service";

describe("Morphic balance service", () => {
  it("queries the user endpoint with bearer authentication", async () => {
    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const httpClient: MorphicBalanceHttpClient = async (url, init) => {
      requests.push({ url, authorization: init.headers.Authorization });
      return {
        ok: true,
        status: 200,
        json: async () => ({ success: true, data: { quota: 250_000_000 } }),
      };
    };

    await expect(
      queryMorphicBalance("secret-token", httpClient, () => new Date("2026-09-17T08:00:00Z")),
    ).resolves.toEqual({
      quota: 250_000_000,
      balanceUsd: 500,
      updatedAt: "2026-09-17T08:00:00.000Z",
    });
    expect(requests).toEqual([{ url: MORPHIC_BALANCE_URL, authorization: "Bearer secret-token" }]);
  });

  it("surfaces the HTTP status without exposing the token", async () => {
    const httpClient: MorphicBalanceHttpClient = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ success: false }),
    });
    await expect(queryMorphicBalance("secret-token", httpClient)).rejects.toThrow("HTTP 401");
  });
});
