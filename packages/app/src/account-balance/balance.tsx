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
  ACCOUNT_BALANCE_REFRESH_INTERVAL_MS,
  getBalanceTone,
  type BalanceTone,
  type AccountBalanceSnapshot,
} from "./model";
import { queryAccountBalance } from "./service";
import {
  readAccountAccessToken,
  readAccountBalanceEndpoint,
  readAccountBalanceSnapshot,
  writeAccountAccessToken,
  writeAccountBalanceEndpoint,
  writeAccountBalanceSnapshot,
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
  snapshot: AccountBalanceSnapshot | null,
  isRefreshing: boolean,
  queryingLabel: string,
  setupLabel: string,
): string {
  if (snapshot) return `$${snapshot.balanceUsd.toFixed(2)}`;
  return isRefreshing ? queryingLabel : setupLabel;
}

export function AccountBalance() {
  const { t } = useTranslation();
  const [hydrated, setHydrated] = useState(false);
  const [token, setToken] = useState<string | null>(null);
  const [snapshot, setSnapshot] = useState<AccountBalanceSnapshot | null>(null);
  const [urlDraft, setUrlDraft] = useState("");
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
        const [storedToken, storedSnapshot, storedEndpoint] = await Promise.all([
          readAccountAccessToken(),
          readAccountBalanceSnapshot(),
          readAccountBalanceEndpoint(),
        ]);
        if (!active) return;
        setToken(storedToken);
        setSnapshot(storedSnapshot);
        setUrlDraft(storedEndpoint ?? "");
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
        const next = await queryAccountBalance(urlDraft, accessToken);
        setSnapshot(next);
        await writeAccountBalanceSnapshot(next);
        // The desktop process may have rotated the token while serving this query.
        const currentToken = await readAccountAccessToken();
        if (currentToken && currentToken !== accessToken) setToken(currentToken);
        return true;
      } catch (cause) {
        setError(
          cause instanceof Error
            ? t("workspace.accountBalance.errors.query", {
                detail: cause.message,
              })
            : t("workspace.accountBalance.errors.queryUnknown"),
        );
        return false;
      } finally {
        refreshingRef.current = false;
        setIsRefreshing(false);
      }
    },
    [t, token, urlDraft],
  );

  useEffect(() => {
    if (!hydrated || !token) return;
    const age = snapshot ? Date.now() - Date.parse(snapshot.updatedAt) : Number.POSITIVE_INFINITY;
    const initialDelay = Math.min(
      ACCOUNT_BALANCE_REFRESH_INTERVAL_MS,
      Math.max(0, ACCOUNT_BALANCE_REFRESH_INTERVAL_MS - age),
    );
    let interval: ReturnType<typeof setInterval> | null = null;
    const timeout = setTimeout(() => {
      void refresh();
      interval = setInterval(() => void refresh(), ACCOUNT_BALANCE_REFRESH_INTERVAL_MS);
    }, initialDelay);
    return () => {
      clearTimeout(timeout);
      if (interval) clearInterval(interval);
    };
  }, [hydrated, refresh, snapshot, token]);

  const handleOpen = useCallback(() => {
    setSheetVisible(true);
  }, []);
  const handleClose = useCallback(() => {
    if (!isSaving) setSheetVisible(false);
  }, [isSaving]);
  const handleSave = useCallback(async () => {
    const endpoint = urlDraft.trim();
    const draftToken = tokenDraft.trim();
    if (!endpoint || !draftToken || isSaving) return;
    setIsSaving(true);
    setError(null);
    try {
      await writeAccountBalanceEndpoint(endpoint);
      await writeAccountAccessToken(draftToken);
      setToken(draftToken);
      if (await refresh(draftToken)) setSheetVisible(false);
    } catch (cause) {
      setError(
        cause instanceof Error
          ? t("workspace.accountBalance.errors.save", { detail: cause.message })
          : t("workspace.accountBalance.errors.saveUnknown"),
      );
    } finally {
      setIsSaving(false);
    }
  }, [isSaving, refresh, t, tokenDraft, urlDraft]);
  const handleRefresh = useCallback(() => void refresh(), [refresh]);

  const tone = snapshot ? getBalanceTone(snapshot.balanceUsd) : null;
  const label = balanceLabel(
    snapshot,
    isRefreshing,
    t("workspace.accountBalance.querying"),
    t("workspace.accountBalance.setup"),
  );
  const accessibilityLabel = token
    ? t("workspace.accountBalance.accessibility.balance", { balance: label })
    : t("workspace.accountBalance.accessibility.setup");
  const header = useMemo<SheetHeader>(() => ({ title: t("workspace.accountBalance.title") }), [t]);
  const updatedAt = snapshot
    ? t("workspace.accountBalance.updatedAt", {
        value: new Date(snapshot.updatedAt).toLocaleString(),
      })
    : null;

  return (
    <>
      <Button
        testID="account-balance"
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
        testID="account-balance-sheet"
      >
        <Text style={styles.helper}>{t("workspace.accountBalance.helper")}</Text>
        <AdaptiveTextInput
          initialValue=""
          resetKey={sheetVisible ? "open" : "closed"}
          onChangeText={setUrlDraft}
          placeholder="https://example.com/balance"
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          testID="account-balance-url"
          accessibilityLabel={t("workspace.accountBalance.endpointLabel")}
        />
        <AdaptiveTextInput
          initialValue=""
          resetKey={sheetVisible ? "open" : "closed"}
          onChangeText={setTokenDraft}
          placeholder={t("workspace.accountBalance.tokenPlaceholder")}
          autoCapitalize="none"
          autoCorrect={false}
          style={styles.input}
          testID="account-balance-token"
          accessibilityLabel={t("workspace.accountBalance.tokenLabel")}
        />
        {error ? <Text style={styles.error}>{error}</Text> : null}
        {updatedAt ? <Text style={styles.updatedAt}>{updatedAt}</Text> : null}
        <View style={styles.actions}>
          {token ? (
            <Button variant="outline" onPress={handleRefresh} disabled={isRefreshing || isSaving}>
              {isRefreshing
                ? t("workspace.accountBalance.querying")
                : t("workspace.accountBalance.refresh")}
            </Button>
          ) : null}
          <Button variant="secondary" onPress={handleClose} disabled={isSaving}>
            {t("common.actions.cancel")}
          </Button>
          <Button
            variant="default"
            onPress={handleSave}
            disabled={!urlDraft.trim() || !tokenDraft.trim() || isSaving}
            loading={isSaving}
          >
            {t("workspace.accountBalance.saveAndQuery")}
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
  input: {
    marginTop: theme.spacing[3],
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
