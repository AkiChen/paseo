import { shareCheckoutDiff } from "./diff-sharing";
import { useMemo } from "react";
import { useRetainedPanelActive } from "@/components/retained-panel";
import { useReplicaQuery } from "@/data/query";
import { checkoutDiffPushRoute } from "@/data/push-router";
import { useHostRuntimeIsConnected } from "@/runtime/host-runtime";
import type { ParsedDiffFile, SubscribeCheckoutDiffResponse } from "@getpaseo/protocol/messages";
import { checkoutDiffQueryKey } from "@/git/query-keys";

interface UseCheckoutDiffQueryOptions {
  serverId: string;
  cwd: string;
  mode: "uncommitted" | "base";
  baseRef?: string;
  ignoreWhitespace?: boolean;
  contextLines?: number;
  enabled?: boolean;
  queryScope?: string;
}

type CheckoutDiffQueryPayload = Omit<SubscribeCheckoutDiffResponse["payload"], "subscriptionId">;

// Re-export the canonical protocol type so all consumers share one definition.
export type { ParsedDiffFile };
export type DiffHunk = ParsedDiffFile["hunks"][number];
export type DiffLine = DiffHunk["lines"][number];
export type HighlightToken = NonNullable<DiffLine["tokens"]>[number];

function normalizeCheckoutDiffCompare(compare: {
  mode: "uncommitted" | "base";
  baseRef?: string;
  ignoreWhitespace?: boolean;
  contextLines?: number;
}): {
  mode: "uncommitted" | "base";
  baseRef?: string;
  ignoreWhitespace?: boolean;
  contextLines?: number;
} {
  const ignoreWhitespace = compare.ignoreWhitespace === true;
  const contextLines = compare.contextLines;
  if (compare.mode === "uncommitted") {
    return { mode: "uncommitted", ignoreWhitespace, contextLines };
  }
  const trimmedBaseRef = compare.baseRef?.trim();
  return trimmedBaseRef
    ? { mode: "base", baseRef: trimmedBaseRef, ignoreWhitespace, contextLines }
    : { mode: "base", ignoreWhitespace, contextLines };
}

export function useCheckoutDiffQuery({
  serverId,
  cwd,
  mode,
  baseRef,
  ignoreWhitespace,
  contextLines,
  enabled = true,
  queryScope,
}: UseCheckoutDiffQueryOptions) {
  const retainedPanelActive = useRetainedPanelActive();
  const queryEnabled = enabled && retainedPanelActive;
  const isConnected = useHostRuntimeIsConnected(serverId);
  const normalizedCompare = useMemo(
    () =>
      normalizeCheckoutDiffCompare({
        mode,
        baseRef,
        ignoreWhitespace,
        contextLines,
      }),
    [mode, baseRef, ignoreWhitespace, contextLines],
  );
  const compareMode = normalizedCompare.mode;
  const compareBaseRef = normalizedCompare.baseRef;
  const compareIgnoreWhitespace = normalizedCompare.ignoreWhitespace;
  const compareContextLines = normalizedCompare.contextLines;
  const queryKey = useMemo(() => {
    const comparisonKey = checkoutDiffQueryKey(
      serverId,
      cwd,
      compareMode,
      compareBaseRef,
      compareIgnoreWhitespace,
      compareContextLines,
    );
    const normalizedScope = queryScope?.trim();
    return normalizedScope ? [...comparisonKey, "scope", normalizedScope] : comparisonKey;
  }, [
    serverId,
    cwd,
    compareMode,
    compareBaseRef,
    compareIgnoreWhitespace,
    compareContextLines,
    queryScope,
  ]);
  const subscriptionId = useMemo(() => `checkoutDiff:${JSON.stringify(queryKey)}`, [queryKey]);
  const routeEnabled = Boolean(queryEnabled && isConnected && cwd);

  const query = useReplicaQuery<CheckoutDiffQueryPayload>({
    queryKey,
    structuralSharing: shareCheckoutDiff,
    enabled: routeEnabled,
    pushEvent: "checkout_diff_update",
    meta: checkoutDiffPushRoute({
      enabled: routeEnabled,
      serverId,
      subscriptionId,
      cwd,
      compare: {
        mode: compareMode,
        ...(compareBaseRef ? { baseRef: compareBaseRef } : {}),
        ignoreWhitespace: compareIgnoreWhitespace,
        ...(compareContextLines !== undefined ? { contextLines: compareContextLines } : {}),
      },
    }),
  });

  const payload = query.data ?? null;
  const payloadError = payload?.error ?? null;

  return {
    files: payload?.files ?? [],
    payloadError,
    diffTooLarge: payload?.diffTooLarge === true,
    isLoading: payload === null && queryEnabled && isConnected,
    isFetching: false,
    isError: Boolean(payloadError),
    error: null,
  };
}
