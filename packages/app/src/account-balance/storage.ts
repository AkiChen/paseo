import AsyncStorage from "@react-native-async-storage/async-storage";
import { getDesktopHost } from "@/desktop/host";
import type { AccountBalanceSnapshot } from "./model";

const SNAPSHOT_KEY = "account-balance.snapshot";
const ENDPOINT_KEY = "account-balance.endpoint";

export async function readAccountBalanceEndpoint(): Promise<string | null> {
  const value = await AsyncStorage.getItem(ENDPOINT_KEY);
  return value?.trim() || null;
}

export async function writeAccountBalanceEndpoint(endpoint: string): Promise<void> {
  const trimmed = endpoint.trim();
  if (!trimmed) {
    await AsyncStorage.removeItem(ENDPOINT_KEY);
    return;
  }
  await AsyncStorage.setItem(ENDPOINT_KEY, trimmed);
}

export async function readAccountAccessToken(): Promise<string | null> {
  const desktopReader = getDesktopHost()?.accountBalance?.getAccessToken;
  const value = desktopReader ? await desktopReader() : null;
  return value?.trim() || null;
}

export async function writeAccountAccessToken(token: string): Promise<void> {
  const setter = getDesktopHost()?.accountBalance?.setAccessToken;
  if (!setter) throw new Error("Saving a token is only available in the desktop app");
  await setter(token);
}

export async function removeAccountAccessToken(): Promise<void> {
  const desktopRemover = getDesktopHost()?.accountBalance?.removeAccessToken;
  if (desktopRemover) {
    await desktopRemover();
  }
}

export async function readAccountBalanceSnapshot(): Promise<AccountBalanceSnapshot | null> {
  const value = await AsyncStorage.getItem(SNAPSHOT_KEY);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<AccountBalanceSnapshot>;
    if (
      typeof parsed.quota === "number" &&
      Number.isFinite(parsed.quota) &&
      typeof parsed.balanceUsd === "number" &&
      Number.isFinite(parsed.balanceUsd) &&
      typeof parsed.updatedAt === "string" &&
      Number.isFinite(Date.parse(parsed.updatedAt))
    ) {
      return parsed as AccountBalanceSnapshot;
    }
  } catch {
    // Invalid cache is equivalent to a cold start.
  }
  await AsyncStorage.removeItem(SNAPSHOT_KEY);
  return null;
}

export async function writeAccountBalanceSnapshot(snapshot: AccountBalanceSnapshot): Promise<void> {
  await AsyncStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
}
