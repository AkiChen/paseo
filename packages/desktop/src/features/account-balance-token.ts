import path from "node:path";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { app, ipcMain, net, safeStorage } from "electron";

/**
 * Desktop-side token storage and balance queries.
 *
 * The token is encrypted with the OS credential store and the request runs in
 * the main process so the endpoint's CORS policy cannot block it. Nothing about
 * the endpoint is built in: the renderer passes whatever the user configured.
 */

const TOKEN_FILE_NAME = "account-balance-token.bin";
const MAX_TOKEN_LENGTH = 16_384;
const REQUEST_TIMEOUT_MS = 20_000;

export interface AccountBalanceQueryResult {
  ok: boolean;
  status: number;
  body: unknown;
}

function tokenFilePath(): string {
  return path.join(app.getPath("userData"), TOKEN_FILE_NAME);
}

function requireEncryption(): void {
  if (!safeStorage.isEncryptionAvailable()) {
    throw new Error("System credential encryption is unavailable");
  }
}

function normalizeToken(rawToken: unknown): string {
  if (typeof rawToken !== "string") throw new Error("Invalid access token");
  const token = rawToken.trim();
  if (!token || token.length > MAX_TOKEN_LENGTH) throw new Error("Invalid access token");
  return token;
}

function normalizeEndpoint(rawEndpoint: unknown): string {
  if (typeof rawEndpoint !== "string") throw new Error("Invalid balance endpoint");
  const endpoint = rawEndpoint.trim();
  if (!/^https:\/\//i.test(endpoint)) throw new Error("The balance endpoint must be https");
  return endpoint;
}

async function readToken(): Promise<string | null> {
  requireEncryption();
  try {
    const encrypted = await readFile(tokenFilePath());
    return safeStorage.decryptString(encrypted).trim() || null;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function writeToken(rawToken: unknown): Promise<void> {
  const token = normalizeToken(rawToken);
  requireEncryption();
  const target = tokenFilePath();
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, safeStorage.encryptString(token), { mode: 0o600 });
}

async function removeToken(): Promise<void> {
  try {
    await unlink(tokenFilePath());
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function queryBalance(
  rawEndpoint: unknown,
  rawToken: unknown,
): Promise<AccountBalanceQueryResult> {
  const endpoint = normalizeEndpoint(rawEndpoint);
  const token = normalizeToken(rawToken);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await net.fetch(endpoint, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "paseo-account-balance/1.0",
      },
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // The renderer turns a non-JSON error response into the HTTP status.
    }
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

export function registerAccountBalanceTokenHandlers(): void {
  ipcMain.handle("paseo:account-balance:get-token", readToken);
  ipcMain.handle("paseo:account-balance:set-token", (_event, token: unknown) => writeToken(token));
  ipcMain.handle("paseo:account-balance:remove-token", removeToken);
  ipcMain.handle("paseo:account-balance:query", (_event, endpoint: unknown, token: unknown) =>
    queryBalance(endpoint, token),
  );
}
