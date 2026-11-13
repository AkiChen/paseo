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

function selectHosts(
  state: { hosts: Record<string, WorkLedgerHostSnapshot> },
  serverIds: readonly string[],
): WorkLedgerHostSnapshot[] {
  return serverIds.flatMap((serverId) => {
    const host = state.hosts[serverId];
    return host ? [host] : [];
  });
}

/**
 * Every host this device knows, viewed through the ledger. Hosts that have not
 * reported yet are their own loading state, so a screen can tell "still connecting"
 * from "connected, no tasks".
 */
export function useWorkLedgerHosts(): WorkLedgerHostView[] {
  const hosts = useHosts();
  const serverIds = useMemo(() => hosts.map((host) => host.serverId), [hosts]);
  const serverIdKey = serverIds.join("\u0000");
  const snapshots = useSyncExternalStore(
    (onStoreChange) => useWorkLedger.subscribe(onStoreChange),
    () => selectHosts(useWorkLedger.getState(), serverIds),
    () => selectHosts(useWorkLedger.getState(), serverIds),
  );

  return useMemo(() => {
    void serverIdKey;
    return serverIds.map((serverId, index) => {
      const host = hosts[index];
      const snapshot = snapshots.find((candidate) => candidate.serverId === serverId);
      const fallback: WorkLedgerHostSnapshot = {
        serverId,
        items: workLedgerHostItems(snapshot),
        counts: snapshot?.counts ?? {
          total: 0,
          pending: 0,
          inProgress: 0,
          review: 0,
          completed: 0,
          cancelled: 0,
          attention: 0,
        },
        status: "offline",
        syncedAt: null,
        error: null,
      };
      const resolved = snapshot ?? fallback;
      return {
        serverId,
        serverName: normalizeHostLabel(host?.label, serverId),
        items: resolved.items,
        status: resolved.status,
        error: resolved.error,
        syncedAt: resolved.syncedAt,
      } satisfies WorkLedgerHostView;
    });
  }, [hosts, serverIds, snapshots, serverIdKey]);
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
