import { randomUUID } from "node:crypto";

export type WorkLedgerChange =
  | { kind: "upsert"; itemId: string }
  | { kind: "remove"; itemId: string };

interface SequencedChange {
  generation: string;
  seq: number;
  change: WorkLedgerChange;
}

export interface WorkLedgerCursor {
  generation: string;
  afterSeq: number;
}

/**
 * Daemon-global change sequence for the ledger.
 *
 * A reconnecting client sends its cursor. If the journal still covers it, the daemon
 * answers with the ids that changed (clients re-read only those) instead of a full
 * snapshot; otherwise it falls back to a snapshot. The generation changes on every
 * daemon start, so a client cannot confuse last boot's seq with this one's.
 */
export class WorkLedgerSequence {
  private readonly generation = randomUUID();
  private headSeq = 0;
  private readonly journal: SequencedChange[] = [];
  private readonly subscribers = new Set<(change: SequencedChange) => void>();

  constructor(private readonly journalLimit = 512) {}

  get currentGeneration(): string {
    return this.generation;
  }

  get currentHeadSeq(): number {
    return this.headSeq;
  }

  subscribe(listener: (change: SequencedChange) => void): () => void {
    this.subscribers.add(listener);
    return () => this.subscribers.delete(listener);
  }

  publish(change: WorkLedgerChange): void {
    const entry = { generation: this.generation, seq: ++this.headSeq, change };
    this.journal.push(entry);
    if (this.journal.length > this.journalLimit) this.journal.shift();
    for (const subscriber of this.subscribers) {
      try {
        subscriber(entry);
      } catch {
        // Publication follows durable persistence and must not fail the mutation.
      }
    }
  }

  /**
   * Returns the ids that need re-reading and whether the caller can apply them as
   * a delta. `mode: "snapshot"` means the caller must re-read everything.
   */
  synchronize(cursor?: WorkLedgerCursor): {
    mode: "snapshot" | "changes";
    changedItemIds: string[];
    removedItemIds: string[];
    headSeq: number;
  } {
    const oldestSeq = this.journal[0]?.seq ?? this.headSeq + 1;
    const canCatchUp =
      cursor !== undefined &&
      cursor.generation === this.generation &&
      cursor.afterSeq <= this.headSeq &&
      cursor.afterSeq >= oldestSeq - 1;
    if (!canCatchUp) {
      return { mode: "snapshot", changedItemIds: [], removedItemIds: [], headSeq: this.headSeq };
    }
    const changed = new Set<string>();
    const removed = new Set<string>();
    for (const entry of this.journal) {
      if (entry.seq <= cursor.afterSeq) continue;
      if (entry.change.kind === "remove") {
        removed.add(entry.change.itemId);
        changed.delete(entry.change.itemId);
        continue;
      }
      removed.delete(entry.change.itemId);
      changed.add(entry.change.itemId);
    }
    return {
      mode: "changes",
      changedItemIds: [...changed],
      removedItemIds: [...removed],
      headSeq: this.headSeq,
    };
  }
}
