import path from "node:path";
import { mkdir, readFile, unlink, writeFile } from "node:fs/promises";
import { app, ipcMain, net, safeStorage } from "electron";

// A `nap_` personal access token from the CN-BOT console replaces the browser
// sign-in this bridge used to drive. The token does not expire and needs no
// refresh session, so nothing here rotates credentials.
const TOKEN_FILE_NAME = "morphic-balance-token.bin";
const PLAIN_TOKEN_FILE_NAME = "morphic-balance-token.json";
const SEED_FILE_NAME = "morphic-balance-seed.json";
// Files left behind by the retired refresh-session flow. They are deleted on
// write so an upgraded install cannot keep serving a stale session.
const RETIRED_FILE_NAMES = ["morphic-balance-session.bin", "morphic-balance-expiry.bin"];
const TOKEN_ENV_VAR = "PASEO_MORPHIC_BALANCE_TOKEN";
const MAX_TOKEN_LENGTH = 16_384;
const MORPHIC_BALANCE_URL = "https://pub-cn-bot.morphic.cn/api/user/self";
const REQUEST_TIMEOUT_MS = 20_000;

interface MorphicBalanceQueryResult {
  ok: boolean;
  status: number;
  body: unknown;
}

function userDataFile(name: string): string {
  return path.join(app.getPath("userData"), name);
}

function encryptionAvailable(): boolean {
  try {
    return safeStorage.isEncryptionAvailable();
  } catch {
    return false;
  }
}

function normalizeToken(rawToken: unknown): string {
  if (typeof rawToken !== "string") throw new Error("Invalid CN-BOT access token");
  const token = rawToken.trim();
  if (!token || token.length > MAX_TOKEN_LENGTH) throw new Error("Invalid CN-BOT access token");
  return token;
}

async function readFileOrNull(target: string): Promise<Buffer | null> {
  try {
    return await readFile(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
}

async function unlinkIfPresent(target: string): Promise<void> {
  try {
    await unlink(target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

async function readStoredToken(): Promise<string | null> {
  if (encryptionAvailable()) {
    const encrypted = await readFileOrNull(userDataFile(TOKEN_FILE_NAME));
    if (!encrypted) return null;
    return normalizeToken(safeStorage.decryptString(encrypted));
  }
  // Without OS credential encryption the token is still usable, so it stays in
  // a plain file rather than failing the whole feature.
  const plain = await readFileOrNull(userDataFile(PLAIN_TOKEN_FILE_NAME));
  if (!plain) return null;
  try {
    const parsed = JSON.parse(plain.toString("utf8")) as { access_token?: unknown };
    return normalizeToken(parsed.access_token);
  } catch {
    return null;
  }
}

async function writeToken(rawToken: unknown): Promise<void> {
  const token = normalizeToken(rawToken);
  if (encryptionAvailable()) {
    const target = userDataFile(TOKEN_FILE_NAME);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, safeStorage.encryptString(token), { mode: 0o600 });
    await unlinkIfPresent(userDataFile(PLAIN_TOKEN_FILE_NAME));
  } else {
    const target = userDataFile(PLAIN_TOKEN_FILE_NAME);
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, JSON.stringify({ access_token: token }), { mode: 0o600 });
  }
  for (const name of RETIRED_FILE_NAMES) await unlinkIfPresent(userDataFile(name));
}

/**
 * A token dropped next to the app's user data as `morphic-balance-seed.json` is
 * imported once, promoted into the encrypted store, and removed. Provisioning
 * wins over whatever is already stored so a rebuild cannot keep a stale token.
 */
async function takeSeedToken(): Promise<string | null> {
  const target = userDataFile(SEED_FILE_NAME);
  const seed = await readFileOrNull(target);
  if (!seed) return null;
  let candidate: unknown;
  try {
    const parsed = JSON.parse(seed.toString("utf8")) as { access_token?: unknown; token?: unknown };
    candidate = parsed.access_token ?? parsed.token;
  } catch {
    candidate = null;
  }
  if (typeof candidate !== "string" || !candidate.trim()) return null;
  const token = normalizeToken(candidate);
  await writeToken(token);
  await unlinkIfPresent(target);
  return token;
}

async function readToken(): Promise<string | null> {
  const seeded = await takeSeedToken();
  if (seeded) return seeded;
  const stored = await readStoredToken();
  if (stored) return stored;
  const fromEnv = process.env[TOKEN_ENV_VAR]?.trim();
  if (!fromEnv) return null;
  await writeToken(fromEnv);
  return normalizeToken(fromEnv);
}

async function queryBalance(rawToken: unknown): Promise<MorphicBalanceQueryResult> {
  const token = normalizeToken(rawToken);
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    // Run the request in the main process: the CN-BOT API sends no CORS headers,
    // so the renderer's own fetch of it would be blocked.
    const response = await net.fetch(MORPHIC_BALANCE_URL, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/json",
        "User-Agent": "paseo-morphic-balance/1.0",
      },
      signal: controller.signal,
    });
    let body: unknown = null;
    try {
      body = await response.json();
    } catch {
      // The renderer turns a non-JSON error response into the HTTP status below.
    }
    return { ok: response.ok, status: response.status, body };
  } finally {
    clearTimeout(timeout);
  }
}

async function removeToken(): Promise<void> {
  await unlinkIfPresent(userDataFile(TOKEN_FILE_NAME));
  await unlinkIfPresent(userDataFile(PLAIN_TOKEN_FILE_NAME));
  for (const name of RETIRED_FILE_NAMES) await unlinkIfPresent(userDataFile(name));
}

export function registerMorphicBalanceTokenHandlers(): void {
  ipcMain.handle("paseo:morphic-balance:get-token", () => readToken());
  ipcMain.handle("paseo:morphic-balance:set-token", (_event, token: unknown) => writeToken(token));
  ipcMain.handle("paseo:morphic-balance:remove-token", () => removeToken());
  ipcMain.handle("paseo:morphic-balance:query", (_event, token: unknown) => queryBalance(token));
}
