import AsyncStorage from "@react-native-async-storage/async-storage";
import { getDesktopHost } from "@/desktop/host";
import type { MorphicBalanceSnapshot } from "./model";

const SNAPSHOT_KEY = "morphic-balance.snapshot";

export async function readMorphicAccessToken(): Promise<string | null> {
  const desktopReader = getDesktopHost()?.morphicBalance?.getAccessToken;
  const value = desktopReader ? await desktopReader() : null;
  return value?.trim() || null;
}

export async function saveMorphicAccessToken(token: string): Promise<void> {
  const desktopWriter = getDesktopHost()?.morphicBalance?.setAccessToken;
  if (!desktopWriter) throw new Error("CN-BOT tokens are only stored in the desktop app");
  await desktopWriter(token.trim());
}

export async function removeMorphicAccessToken(): Promise<void> {
  const desktopRemover = getDesktopHost()?.morphicBalance?.removeAccessToken;
  if (desktopRemover) {
    await desktopRemover();
  }
}

export async function readMorphicBalanceSnapshot(): Promise<MorphicBalanceSnapshot | null> {
  const value = await AsyncStorage.getItem(SNAPSHOT_KEY);
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as Partial<MorphicBalanceSnapshot>;
    if (
      typeof parsed.quota === "number" &&
      Number.isFinite(parsed.quota) &&
      typeof parsed.balanceUsd === "number" &&
      Number.isFinite(parsed.balanceUsd) &&
      typeof parsed.updatedAt === "string" &&
      Number.isFinite(Date.parse(parsed.updatedAt))
    ) {
      return parsed as MorphicBalanceSnapshot;
    }
  } catch {
    // Invalid cache is equivalent to a cold start.
  }
  await AsyncStorage.removeItem(SNAPSHOT_KEY);
  return null;
}

export async function writeMorphicBalanceSnapshot(snapshot: MorphicBalanceSnapshot): Promise<void> {
  await AsyncStorage.setItem(SNAPSHOT_KEY, JSON.stringify(snapshot));
}
