import type { DaemonClient } from "@getpaseo/client/internal/daemon-client";
import {
  emptyWorkLedgerCounts,
  type WorkLedgerCounts,
  type WorkLedgerEntry,
  type WorkLedgerItem,
} from "@getpaseo/protocol/work-ledger/types";
import { create } from "zustand";
import { i18n } from "@/i18n/i18next";

export type WorkLedgerHostStatus = "offline" | "online" | "unsupported";

export interface WorkLedgerHostSnapshot {
  serverId: string;
  items: readonly WorkLedgerItem[];
  counts: WorkLedgerCounts;
  status: WorkLedgerHostStatus;
  /** Server clock of the last accepted snapshot; null before the first one. */
  syncedAt: string | null;
  error: string | null;
}

export interface WorkLedgerItemSnapshot {
  serverId: string;
  itemId: string;
  status: "loading" | "loaded" | "error";
  item: WorkLedgerItem | null;
  /** Entries loaded so far, newest first. Grows when older pages are requested. */
  entries: WorkLedgerEntry[];
  hasMore: boolean;
  loadingOlder: boolean;
  error: string | null;
}

interface WorkLedgerState {
  hosts: Record<string, WorkLedgerHostSnapshot>;
  items: Record<string, WorkLedgerItemSnapshot>;
  setHost: (host: WorkLedgerHostSnapshot) => void;
  setItem: (item: WorkLedgerItemSnapshot) => void;
}

const EMPTY_ITEMS: readonly WorkLedgerItem[] = [];

export const useWorkLedger = create<WorkLedgerState>((set) => ({
  hosts: {},
  items: {},
  setHost: (host) => set((state) => ({ hosts: { ...state.hosts, [host.serverId]: host } })),
  setItem: (item) =>
    set((state) => ({ items: { ...state.items, [`${item.serverId}:${item.itemId}`]: item } })),
}));

export function selectWorkLedgerHost(
  state: { hosts: Record<string, WorkLedgerHostSnapshot> },
  serverId: string,
): WorkLedgerHostSnapshot | undefined {
  return state.hosts[serverId];
}

export function workLedgerHostItems(
  host: WorkLedgerHostSnapshot | undefined,
): readonly WorkLedgerItem[] {
  return host?.items ?? EMPTY_ITEMS;
}

/**
 * A connected host whose snapshot failed is not evidence that the ledger is empty.
 * Surfaces show the error and refuse to render "no items" from it.
 */
export function hasWorkLedgerData(host: WorkLedgerHostSnapshot | undefined): boolean {
  return (
    host !== undefined && host.status === "online" && host.error === null && host.syncedAt !== null
  );
}

export interface WorkLedgerHostReplica {
  applySnapshot(payload: {
    items: readonly WorkLedgerItem[];
    counts: WorkLedgerCounts;
    generatedAt: string;
  }): void;
  applyUpsert(item: WorkLedgerItem, counts: WorkLedgerCounts): void;
  applyRemove(itemId: string, counts: WorkLedgerCounts): void;
  recordError(error: string): void;
  markStatus(status: WorkLedgerHostStatus): void;
  snapshot(): WorkLedgerHostSnapshot;
}

export function createWorkLedgerHostReplica(serverId: string): WorkLedgerHostReplica {
  let items: readonly WorkLedgerItem[] = EMPTY_ITEMS;
  let counts: WorkLedgerCounts = emptyWorkLedgerCounts();
  let status: WorkLedgerHostStatus = "offline";
  let syncedAt: string | null = null;
  let error: string | null = null;

  const snapshot = (): WorkLedgerHostSnapshot => ({
    serverId,
    items,
    counts,
    status,
    syncedAt,
    error,
  });

  return {
    applySnapshot(payload) {
      items = payload.items;
      counts = payload.counts;
      syncedAt = payload.generatedAt;
      error = null;
      status = "online";
    },
    applyUpsert(item, nextCounts) {
      const next = items.filter((candidate) => candidate.id !== item.id);
      items = [...next, item];
      counts = nextCounts;
      syncedAt = new Date().toISOString();
      status = "online";
    },
    applyRemove(itemId, nextCounts) {
      items = items.filter((item) => item.id !== itemId);
      counts = nextCounts;
      syncedAt = new Date().toISOString();
      status = "online";
    },
    recordError(message) {
      error = message;
    },
    markStatus(nextStatus) {
      status = nextStatus;
      if (nextStatus !== "online") error = null;
    },
    snapshot,
  };
}

interface HostConnection {
  client: DaemonClient;
  replica: WorkLedgerHostReplica;
  release: () => void;
}

/**
 * One live, read-only subscription per host. The ledger is small enough to keep the
 * whole snapshot; each live change supersedes the item it names.
 */
class WorkLedgerController {
  private readonly replicas = new Map<string, WorkLedgerHostReplica>();
  private readonly connections = new Map<string, HostConnection>();
  private readonly itemRequests = new Map<string, Promise<void>>();

  connect(input: { serverId: string; client: DaemonClient; supportsWorkLedger: boolean }): void {
    const existing = this.connections.get(input.serverId);
    if (existing?.client === input.client) return;
    this.disconnect(input.serverId);

    const replica =
      this.replicas.get(input.serverId) ?? createWorkLedgerHostReplica(input.serverId);
    this.replicas.set(input.serverId, replica);
    if (!input.supportsWorkLedger) {
      replica.markStatus("unsupported");
      this.publish(input.serverId, replica);
      return;
    }

    const subscription = input.client.observeWorkLedger();
    const connection: HostConnection = {
      client: input.client,
      replica,
      release: () => {
        void subscription.release().catch(() => undefined);
      },
    };
    this.connections.set(input.serverId, connection);
    subscription.subscribe({
      snapshot: (payload) => {
        connection.replica.applySnapshot(payload);
        this.publish(input.serverId, connection.replica);
        // A `changes` catch-up names the items that moved while this client was
        // away; the snapshot already carries removed ones. Re-read only those.
        if (payload.sync.mode === "changes") {
          void this.catchUpChanges(input.serverId, connection, payload.sync.changedItemIds ?? []);
        }
      },
      update: (message) => {
        if (message.type !== "work_ledger.update") return;
        if (message.payload.kind === "upsert") {
          connection.replica.applyUpsert(message.payload.item, message.payload.counts);
        } else {
          connection.replica.applyRemove(message.payload.itemId, message.payload.counts);
        }
        this.publish(input.serverId, connection.replica);
      },
      error: (error) => {
        connection.replica.recordError(
          error instanceof Error ? error.message : i18n.t("workLedger.errors.load"),
        );
        this.publish(input.serverId, connection.replica);
      },
    });
  }

  private async catchUpChanges(
    serverId: string,
    connection: HostConnection,
    itemIds: readonly string[],
  ): Promise<void> {
    if (itemIds.length === 0) return;
    try {
      const payload = await connection.client.listWorkLedgerItems({ itemIds: [...itemIds] });
      if (this.connections.get(serverId) !== connection) return;
      for (const item of payload.items) {
        connection.replica.applyUpsert(item, payload.counts);
      }
      this.publish(serverId, connection.replica);
    } catch {
      // Nothing to report: the next reconnect asks for a full snapshot anyway, and a
      // silent catch-up failure is less confusing than a transient error banner.
    }
  }

  disconnect(serverId: string): void {
    const connection = this.connections.get(serverId);
    connection?.release();
    this.connections.delete(serverId);
    const replica = this.replicas.get(serverId);
    if (replica) {
      replica.markStatus("offline");
      this.publish(serverId, replica);
    }
  }

  /**
   * Full history for one item. The ledger snapshot only carries the newest entries,
   * so the detail screen asks for the rest and caches it per item.
   */
  async loadItem(input: {
    serverId: string;
    itemId: string;
    beforeEntryId?: string;
  }): Promise<void> {
    const connection = this.connections.get(input.serverId);
    if (!connection) throw new Error(i18n.t("workLedger.errors.offline"));
    const key = `${input.serverId}:${input.itemId}`;
    const pagingKey = `${key}:${input.beforeEntryId ?? "head"}`;
    if (this.itemRequests.has(pagingKey)) return this.itemRequests.get(pagingKey);
    const isPaging = input.beforeEntryId !== undefined;
    const previous = useWorkLedger.getState().items[key];
    this.setState({
      serverId: input.serverId,
      itemId: input.itemId,
      status: isPaging ? (previous?.status ?? "loading") : "loading",
      item: previous?.item ?? null,
      entries: previous?.entries ?? [],
      hasMore: previous?.hasMore ?? false,
      loadingOlder: isPaging,
      error: null,
    });
    const request = (async () => {
      try {
        const payload = await connection.client.getWorkLedgerItem({
          itemId: input.itemId,
          ...(input.beforeEntryId ? { beforeEntryId: input.beforeEntryId } : {}),
        });
        // Older pages append; the head request replaces. Ids make re-application safe.
        const entries = isPaging
          ? [...(useWorkLedger.getState().items[key]?.entries ?? []), ...payload.entries]
          : payload.entries;
        const seen = new Set<string>();
        const deduped = entries.filter((entry) => {
          if (seen.has(entry.id)) return false;
          seen.add(entry.id);
          return true;
        });
        this.setState({
          serverId: input.serverId,
          itemId: input.itemId,
          status: "loaded",
          item: payload.item,
          entries: deduped,
          hasMore: payload.hasMore,
          loadingOlder: false,
          error: null,
        });
      } catch (error) {
        this.setState({
          serverId: input.serverId,
          itemId: input.itemId,
          status: previous?.item ? "loaded" : "error",
          item: previous?.item ?? null,
          entries: previous?.entries ?? [],
          hasMore: previous?.hasMore ?? false,
          loadingOlder: false,
          error: error instanceof Error ? error.message : i18n.t("workLedger.errors.load"),
        });
        throw error;
      }
    })().finally(() => {
      this.itemRequests.delete(pagingKey);
    });
    this.itemRequests.set(pagingKey, request);
    return request;
  }

  private setState(item: WorkLedgerItemSnapshot): void {
    useWorkLedger.getState().setItem(item);
  }

  private publish(serverId: string, replica: WorkLedgerHostReplica): void {
    useWorkLedger.getState().setHost(replica.snapshot());
  }
}

export const workLedger = new WorkLedgerController();

export type { WorkLedgerScope } from "@getpaseo/protocol/work-ledger/types";
