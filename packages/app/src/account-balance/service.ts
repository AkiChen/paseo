import { getDesktopHost } from "@/desktop/host";
import { parseAccountBalanceResponse, type AccountBalanceSnapshot } from "./model";

const REQUEST_TIMEOUT_MS = 20_000;

export interface AccountBalanceHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type AccountBalanceHttpClient = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<AccountBalanceHttpResponse>;

export async function queryAccountBalance(
  endpointUrl: string,
  accessToken: string,
  httpClient?: AccountBalanceHttpClient,
  now: () => Date = () => new Date(),
): Promise<AccountBalanceSnapshot> {
  const endpoint = endpointUrl.trim();
  if (!/^https?:\/\//i.test(endpoint)) {
    throw new Error("Set an http(s) balance endpoint first");
  }
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    };
    const desktopQuery = httpClient ? undefined : getDesktopHost()?.accountBalance?.query;
    const response = desktopQuery
      ? await desktopQuery(endpoint, accessToken).then((result) => ({
          ok: result.ok,
          status: result.status,
          json: async () => result.body,
        }))
      : await (httpClient ?? fetch)(endpoint, {
          headers,
          signal: controller.signal,
        });
    const body = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { ...parseAccountBalanceResponse(body), updatedAt: now().toISOString() };
  } finally {
    clearTimeout(timeout);
  }
}
