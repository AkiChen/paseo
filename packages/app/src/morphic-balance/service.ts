import { getDesktopHost } from "@/desktop/host";
import {
  MORPHIC_BALANCE_URL,
  parseMorphicBalanceResponse,
  type MorphicBalanceSnapshot,
} from "./model";

const REQUEST_TIMEOUT_MS = 20_000;

export interface MorphicBalanceHttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type MorphicBalanceHttpClient = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
) => Promise<MorphicBalanceHttpResponse>;

export async function queryMorphicBalance(
  accessToken: string,
  httpClient?: MorphicBalanceHttpClient,
  now: () => Date = () => new Date(),
): Promise<MorphicBalanceSnapshot> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const headers = {
      Authorization: `Bearer ${accessToken}`,
      Accept: "application/json",
    };
    // The CN-BOT API sends no CORS headers, so the renderer cannot call it
    // directly and the request runs through the desktop process instead.
    const desktopQuery = httpClient ? undefined : getDesktopHost()?.morphicBalance?.query;
    let response: MorphicBalanceHttpResponse;
    if (httpClient) {
      response = await httpClient(MORPHIC_BALANCE_URL, {
        headers,
        signal: controller.signal,
      });
    } else if (desktopQuery) {
      const result = await desktopQuery(accessToken);
      response = { ok: result.ok, status: result.status, json: async () => result.body };
    } else {
      throw new Error("Balance queries are only available in the desktop app");
    }
    const body = await response.json();
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { ...parseMorphicBalanceResponse(body), updatedAt: now().toISOString() };
  } finally {
    clearTimeout(timeout);
  }
}
