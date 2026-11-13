import { useEffect, useMemo, useSyncExternalStore } from "react";
import type { WorkLedgerItem } from "@getpaseo/protocol/work-ledger/types";
import { useHosts } from "@/runtime/host-runtime";
import { normalizeHostLabel } from "@/types/host-connection";
import type { WorkLedgerHostView } from "@/screens/work-ledger-screen-state";
import {
  hasWorkLedgerData,
  useWorkLedger,
  workLedger,
  workLedgerHostItems,
  type WorkLedgerHostSnapshot,
} from "@/work-ledger";

/**
 * `useSyncExternalStore` compares snapshots by reference, so the selector must
 * return the stored object itself, never a rebuilt array: a fresh array on every
 * call reads as "the store changed" and renders forever (React error #185).
 */
function selectHostState(state: { hosts: Record<string, WorkLedgerHostSnapshot> }) {
  return state.hosts;
}

/**
 * Every host this device knows, viewed through the ledger. Hosts that have not
 * reported yet are their own loading state, so a screen can tell "still connecting"
 * from "connected, no tasks".
 */
export function useWorkLedgerHosts(): WorkLedgerHostView[] {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const hostState = useSyncExternalStore(
    (onStoreChange) => useWorkLedger.subscribe(onStoreChange),
    () => selectHostState(useWorkLedger.getState()),
    () => selectHostState(useWorkLedger.getState()),
  );

  return useMemo(() => {
    return serverIds.map((serverId, index) => {
      const host = hosts[index];
      const snapshot = hostState[serverId];
      return {
        serverId,
        serverName: normalizeHostLabel(host?.label, serverId),
        items: workLedgerHostItems(snapshot),
        status: snapshot?.status ?? "offline",
        error: snapshot?.error ?? null,
        syncedAt: snapshot?.syncedAt ?? null,
      } satisfies WorkLedgerHostView;
    });
  }, [hosts, serverIds, hostState]);
}

/** Ledger data for one host, plus whether it is trustworthy enough to render. */
export function useWorkLedgerHost(serverId: string): {
  host: WorkLedgerHostSnapshot | undefined;
  ready: boolean;
} {
  const host = useSyncExternalStore(
    (onStoreChange) => useWorkLedger.subscribe(onStoreChange),
    () => useWorkLedger.getState().hosts[serverId],
    () => useWorkLedger.getState().hosts[serverId],
  );
  return { host, ready: hasWorkLedgerData(host) };
}

/** Full history for one item; triggers the daemon read the snapshot does not carry. */
export function useWorkLedgerItem({ serverId, itemId }: { serverId: string; itemId: string }) {
  const key = `${serverId}:${itemId}`;
  const snapshot = useSyncExternalStore(
    (onStoreChange) => useWorkLedger.subscribe(onStoreChange),
    () => useWorkLedger.getState().items[key],
    () => useWorkLedger.getState().items[key],
  );
  useEffect(() => {
    if (!serverId || !itemId) return;
    void workLedger.loadItem({ serverId, itemId }).catch(() => undefined);
  }, [serverId, itemId]);
  return snapshot ?? null;
}

/**
 * The item's live row from the ledger (status, revision, summary), which the detail
 * read does not refresh. Detail surfaces prefer it so the header never lags a change.
 */
export function useWorkLedgerItemRow(input: {
  serverId: string;
  itemId: string;
}): WorkLedgerItem | null {
  return useSyncExternalStore(
    (onStoreChange) => useWorkLedger.subscribe(onStoreChange),
    () =>
      workLedgerHostItems(useWorkLedger.getState().hosts[input.serverId]).find(
        (item) => item.id === input.itemId,
      ) ?? null,
    () =>
      workLedgerHostItems(useWorkLedger.getState().hosts[input.serverId]).find(
        (item) => item.id === input.itemId,
      ) ?? null,
  );
}

export function loadOlderWorkLedgerEntries(input: {
  serverId: string;
  itemId: string;
  beforeEntryId: string;
}): Promise<void> {
  return workLedger.loadItem(input);
}
