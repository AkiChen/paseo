import { describe, expect, it } from "vitest";
import { queryAccountBalance, type AccountBalanceHttpClient } from "./service";

const ENDPOINT = "https://example.com/api/balance";

describe("Account balance service", () => {
  it("queries the configured endpoint with bearer authentication", async () => {
    const requests: Array<{ url: string; authorization: string | undefined }> = [];
    const httpClient: AccountBalanceHttpClient = async (url, init) => {
      requests.push({ url, authorization: init.headers.Authorization });
      return {
        ok: true,
        status: 200,
        json: async () => ({ balance: 500 }),
      };
    };

    await expect(
      queryAccountBalance(
        ENDPOINT,
        "secret-token",
        httpClient,
        () => new Date("2026-09-17T08:00:00Z"),
      ),
    ).resolves.toEqual({
      quota: 500,
      balanceUsd: 500,
      updatedAt: "2026-09-17T08:00:00.000Z",
    });
    expect(requests).toEqual([{ url: ENDPOINT, authorization: "Bearer secret-token" }]);
  });

  it("refuses an endpoint that is not http(s)", async () => {
    await expect(queryAccountBalance("", "secret-token")).rejects.toThrow("http(s)");
    await expect(queryAccountBalance("example.com", "secret-token")).rejects.toThrow("http(s)");
  });

  it("surfaces the HTTP status without exposing the token", async () => {
    const httpClient: AccountBalanceHttpClient = async () => ({
      ok: false,
      status: 401,
      json: async () => ({ success: false }),
    });
    await expect(queryAccountBalance(ENDPOINT, "secret-token", httpClient)).rejects.toThrow(
      "HTTP 401",
    );
  });
});
