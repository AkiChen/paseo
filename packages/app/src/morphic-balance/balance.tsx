import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Text, View } from "react-native";
import { useTranslation } from "react-i18next";
import { StyleSheet } from "react-native-unistyles";
import {
  AdaptiveModalSheet,
  AdaptiveTextInput,
  type SheetHeader,
} from "@/components/adaptive-modal-sheet";
import { Button } from "@/components/ui/button";
import { buttonControlHeight, HEADER_CONTROL_HEIGHT } from "@/components/ui/control-geometry";
import {
  MORPHIC_BALANCE_REFRESH_INTERVAL_MS,
  getBalanceTone,
  type BalanceTone,
  type MorphicBalanceSnapshot,
} from "./model";
import { queryMorphicBalance } from "./service";
import {
  readMorphicAccessToken,
  readMorphicBalanceSnapshot,
  saveMorphicAccessToken,
  writeMorphicBalanceSnapshot,
} from "./storage";

function balanceBadgeStyle(tone: BalanceTone | null) {
  if (tone === "healthy") return styles.badgeHealthy;
  if (tone === "warning") return styles.badgeWarning;
  if (tone === "danger") return styles.badgeDanger;
  return null;
}

function balanceTextStyle(tone: BalanceTone | null) {
  if (tone === "healthy") return styles.textHealthy;
  if (tone === "warning") return styles.textWarning;
  if (tone === "danger") return styles.textDanger;
  return null;
}

function balanceLabel(
  snapshot: MorphicBalanceSnapshot | null,
  isRefreshing: boolean,
  queryingLabel: string,
  setupLabel: string,
): string {
  if (snapshot) return `$${snapshot.balanceUsd.toFixed(2)}`;
  return isRefreshing ? queryingLabel : setupLabel;
}

export function MorphicBalance() {
  const { t } = useTranslation();
  const [hydrated, setHydrated] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<MorphicBalanceSnapshot | null>(null);
  const [tokenDraft, setTokenDraft] = useState("");
  const [sheetVisible, setSheetVisible] = useState(false);
  const [isRefreshing, setIsRefreshing] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const refreshingRef = useRef(false);

  useEffect(() => {
    let active = true;
    void (async () => {
      try {
        const [storedToken, storedSnapshot] = await Promise.all([
          readMorphicAccessToken(),
          readMorphicBalanceSnapshot(),
        ]);
        if (!active) return;
        setToken(storedToken);
        setSnapshot(storedSnapshot);
      } finally {
        if (active) setHydrated(true);
      }
    })();
    return () => {
      active = false;
    };
  }, []);

  const refresh = useCallback(
    async (accessToken = token): Promise<boolean> => {
      if (!accessToken || refreshingRef.current) return false;
      refreshingRef.current = true;
      setIsRefreshing(true);
      setError(null);
      try {
        const next = await queryMorphicBalance(accessToken);
        setSnapshot(next);
        await writeMorphicBalanceSnapshot(next);
        return true;
      } catch (cause) {
        setError(
          cause instanceof Error
            ? t("workspace.morphicBalance.errors.query", {
                detail: cause.message,
              })
            : t("workspace.morphicBalance.errors.queryUnknown"),
        );
        return false;
      } finally {
        refreshingRef.current = false;
        setIsRefreshing(false);
      }
    },
    [t, token],
  );

  useEffect(() => {
    if (!hydrated || !token) return;
    const age = snapshot ? Date.now() - Date.parse(snapshot.updatedAt) : Number.POSITIVE_INFINITY;
    const initialDelay = Math.min(
      MORPHIC_BALANCE_REFRESH_INTERVAL_MS,
      Math.max(0, MORPHIC_BALANCE_REFRESH_INTERVAL_MS - age),
    );
    let interval: ReturnType<typeof setInterval> | null = null;
    const timeout = setTimeout(() => {
      void refresh();
      interval = setInterval(() => void refresh(), MORPHIC_BALANCE_REFRESH_INTERVAL_MS);
    }, initialDelay);
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, [hydrated, refresh, snapshot, token]);

  const handleOpen = useCallback(() => {
    setTokenDraft("");
    setError(null);
    setSheetVisible(true);
  }, []);
  const handleClose = useCallback(() => {
    if (!isSaving) setSheetVisible(false);
  }, [isSaving]);
  const handleSave = useCallback((): void => {
    const nextToken = tokenDraft.trim();
    if (!nextToken || isSaving) return;
    setIsSaving(true);
    setError(null);
    void (async () => {
      try {
        await saveMorphicAccessToken(nextToken);
        setToken(nextToken);
        if (await refresh(nextToken)) {
          setTokenDraft("");
          setSheetVisible(false);
        }
      } catch (cause) {
        setError(
          cause instanceof Error
            ? t("workspace.morphicBalance.errors.save", { detail: cause.message })
            : t("workspace.morphicBalance.errors.saveUnknown"),
        );
      } finally {
        setIsSaving(false);
      }
    })();
  }, [isSaving, refresh, t, tokenDraft]);
  const handleRefresh = useCallback(() => void refresh(), [refresh]);

  const tone = snapshot ? getBalanceTone(snapshot.balanceUsd) : null;
  const label = balanceLabel(
    snapshot,
    isRefreshing,
    t("workspace.morphicBalance.querying"),
    t("workspace.morphicBalance.setup"),
  );
  const accessibilityLabel = token
    ? t("workspace.morphicBalance.accessibility.balance", { balance: label })
    : t("workspace.morphicBalance.accessibility.setup");
  const header = useMemo<SheetHeader>(() => ({ title: t("workspace.morphicBalance.title") }), [t]);
  const updatedAt = snapshot
    ? t("workspace.morphicBalance.updatedAt", {
        value: new Date(snapshot.updatedAt).toLocaleString(),
      })
    : null;

  return (
    <>
      <Button
        testID="morphic-balance"
        accessibilityLabel={accessibilityLabel}
        onPress={handleOpen}
        variant="outline"
        size="sm"
        style={[styles.badge, balanceBadgeStyle(tone)]}
        textStyle={[styles.badgeText, balanceTextStyle(tone)]}
      >
        {label}
      </Button>
      <AdaptiveModalSheet
        header={header}
        visible={sheetVisible}
        onClose={handleClose}
        testID="morphic-balance-sheet"
      >
        <Text style={styles.helper}>{t("workspace.morphicBalance.helper")}</Text>
        <Text style={styles.label}>{t("workspace.morphicBalance.tokenLabel")}</Text>
        <AdaptiveTextInput
          initialValue=""
          resetKey={sheetVisible ? "open" : "closed"}
          onChangeText={setTokenDraft}
          placeholder={
            token
              ? t("workspace.morphicBalance.tokenReplacementPlaceholder")
              : t("workspace.morphicBalance.tokenPlaceholder")
          }
          autoCapitalize="none"
          autoCorrect={false}
          secureTextEntry
          editable={!isSaving}
          returnKeyType="done"
          onSubmitEditing={handleSave}
          style={styles.input}
          testID="morphic-balance-token"
          accessibilityLabel={t("workspace.morphicBalance.tokenLabel")}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {updatedAt ? <Text style={styles.updatedAt}>{updatedAt}</Text> : null}
        <View style={styles.actions}>
          {token ? (
            <Button variant="outline" onPress={handleRefresh} disabled={isRefreshing || isSaving}>
              {isRefreshing
                ? t("workspace.morphicBalance.querying")
                : t("workspace.morphicBalance.refresh")}
            </Button>
          ) : null}
          <Button variant="secondary" onPress={handleClose} disabled={isSaving}>
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            onPress={handleSave}
            disabled={!tokenDraft.trim() || isSaving}
            loading={isSaving}
          >
            {t("workspace.morphicBalance.saveAndQuery")}
          </Button>
        </View>
      </AdaptiveModalSheet>
    </>
  );
}

const styles = StyleSheet.create((theme) => ({
  badge: {
    minHeight: {
      xs: buttonControlHeight.xs,
      md: HEADER_CONTROL_HEIGHT,
    },
    height: {
      xs: buttonControlHeight.xs,
      md: HEADER_CONTROL_HEIGHT,
    },
    paddingHorizontal: {
      xs: theme.spacing[3],
      md: theme.spacing[2],
    },
    borderRadius: theme.borderRadius.md,
  },
  badgeText: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.normal,
  },
  badgeHealthy: { borderColor: theme.colors.statusSuccess },
  badgeWarning: { borderColor: theme.colors.statusWarning },
  badgeDanger: { borderColor: theme.colors.statusDanger },
  textHealthy: { color: theme.colors.statusSuccess },
  textWarning: { color: theme.colors.statusWarning },
  textDanger: { color: theme.colors.statusDanger },
  helper: {
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.base,
  },
  label: {
    marginTop: theme.spacing[4],
    color: theme.colors.foreground,
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.medium,
  },
  input: {
    marginTop: theme.spacing[2],
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[3],
    color: theme.colors.foreground,
    backgroundColor: theme.colors.surface2,
    borderWidth: 1,
    borderColor: theme.colors.border,
    borderRadius: theme.borderRadius.md,
  },
  error: {
    marginTop: theme.spacing[2],
    color: theme.colors.destructive,
    fontSize: theme.fontSize.sm,
  },
  updatedAt: {
    marginTop: theme.spacing[2],
    color: theme.colors.foregroundMuted,
    fontSize: theme.fontSize.sm,
  },
  actions: {
    flexDirection: "row",
    justifyContent: "flex-end",
    gap: theme.spacing[2],
    marginTop: theme.spacing[4],
  },
}));
