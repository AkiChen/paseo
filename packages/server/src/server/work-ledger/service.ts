import { randomUUID } from "node:crypto";
import {
  WORK_LEDGER_LIST_ENTRIES,
  countWorkLedgerItems,
  isTerminalWorkLedgerStatus,
  type WorkLedgerAgentLink,
  type WorkLedgerAgentRole,
  type WorkLedgerAttentionReason,
  type WorkLedgerCounts,
  type WorkLedgerEntry,
  type WorkLedgerEntryKind,
  type WorkLedgerEntryOutcome,
  type WorkLedgerEntrySource,
  type WorkLedgerEvidence,
  type WorkLedgerItem,
  type WorkLedgerLinkSource,
  type WorkLedgerLinkState,
  type WorkLedgerScope,
  type WorkLedgerStatus,
} from "@getpaseo/protocol/work-ledger/types";
import { WorkLedgerSequence, type WorkLedgerCursor } from "./sequence.js";
import type { StoredWorkLedgerItem, WorkLedgerStore } from "./store.js";

/** Error codes the session and tool layers both surface; never silent. */
export type WorkLedgerErrorCode =
  | "item_not_found"
  | "revision_conflict"
  | "invalid_transition"
  | "invalid_input"
  | "scope_not_found"
  | "agent_not_found";

export class WorkLedgerError extends Error {
  constructor(
    public readonly code: WorkLedgerErrorCode,
    message: string,
    public readonly currentRevision?: number,
  ) {
    super(message);
    this.name = "WorkLedgerError";
  }
}

export interface ScopeResolver {
  /** Resolves the owning project for a workspace, or null when it is unknown/archived. */
  projectIdForWorkspace(workspaceId: string): Promise<string | null>;
  projectExists(projectId: string): Promise<boolean>;
}

function unavailableScopeResolver(): ScopeResolver {
  return {
    projectIdForWorkspace: async () => null,
    projectExists: async () => false,
  };
}

export interface CreateItemInput {
  title: string;
  scope?: WorkLedgerScope;
  workspaceId?: string | null;
  goal?: string | null;
  acceptanceCriteria?: string | null;
  labels?: string[];
  status?: WorkLedgerStatus;
  createdBy?: string | null;
}

export interface MoveItemInput {
  itemId: string;
  status: WorkLedgerStatus;
  expectedRevision?: number;
  attention?: WorkLedgerAttentionReason[];
  attentionNote?: string | null;
  blockedReason?: string | null;
  link?: {
    agentId: string;
    role?: WorkLedgerAgentRole;
    label?: string | null;
    reason?: string | null;
    source?: WorkLedgerLinkSource;
  };
  note?: { summary: string; agentId?: string | null; source?: WorkLedgerEntrySource };
}

export interface UpdateItemInput {
  itemId: string;
  expectedRevision?: number;
  title?: string;
  goal?: string | null;
  acceptanceCriteria?: string | null;
  labels?: string[];
  status?: WorkLedgerStatus;
  attention?: WorkLedgerAttentionReason[];
  attentionNote?: string | null;
  blockedReason?: string | null;
  workspaceId?: string | null;
  agentId?: string | null;
}

export interface RecordEntryInput {
  itemId: string;
  kind: WorkLedgerEntryKind;
  source: WorkLedgerEntrySource;
  agentId?: string | null;
  summary: string;
  currentState?: string | null;
  outcome?: WorkLedgerEntryOutcome | null;
  unreadSources?: string[];
  evidence?: WorkLedgerEvidence[];
  status?: WorkLedgerStatus;
  attention?: WorkLedgerAttentionReason[];
  attentionNote?: string | null;
  blockedReason?: string | null;
  /** Advances lastProgressAt. Progress and user entries do; inspections only on `progressed`. */
  movesProgress: boolean;
}

interface Clock {
  now(): Date;
}

function defaultClock(): Clock {
  return { now: () => new Date() };
}

function dayKeyOf(date: Date): string {
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  return `${year}${month}${day}`;
}

function trimToNull(value: string | null | undefined): string | null | undefined {
  if (value === undefined) return undefined;
  if (value === null) return null;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

/**
 * Finds an item by its number (`TODO-20261111-010`), by `itemId`, or by the trailing
 * ordinal of a number. Numbers repeat across days' counters on different daemons; on
 * one daemon they are unique, which is why items are looked up by number at all.
 */
export function matchItemReference(
  items: readonly WorkLedgerItem[],
  reference: string,
): WorkLedgerItem | null {
  const needle = reference.trim();
  if (!needle) return null;
  const normalized = needle.toUpperCase();
  const byId = items.find((item) => item.id === needle);
  if (byId) return byId;
  const byNumber = items.find((item) => item.number.toUpperCase() === normalized);
  if (byNumber) return byNumber;
  const ordinal = /^(\d{1,4})$/.exec(needle)?.[1];
  if (ordinal !== undefined) {
    const suffix = `-${ordinal.padStart(3, "0")}`;
    const matches = items.filter((item) => item.number.endsWith(suffix));
    if (matches.length === 1) return matches[0]!;
  }
  return null;
}

/** True when the item is stored under exactly this scope. */
export function scopeMatches(item: WorkLedgerItem, scope: WorkLedgerScope): boolean {
  if (scope.kind === "project")
    return item.scope.kind === "project" && item.projectId === scope.projectId;
  return item.scope.kind === "workspace" && item.scope.workspaceId === scope.workspaceId;
}

/**
 * What a queried scope shows. A project scope sees every item in the project,
 * including items one of its workspaces owns. A workspace scope sees its own items
 * plus project items currently being worked in that workspace — the "shared
 * project items + this workspace's own" view the workspace screen renders.
 */
export function isItemVisibleInScope(item: WorkLedgerItem, scope: WorkLedgerScope): boolean {
  if (scope.kind === "project") return item.projectId === scope.projectId;
  if (item.scope.kind === "workspace") return item.scope.workspaceId === scope.workspaceId;
  return item.workspaceId === scope.workspaceId;
}

// Stored oldest-last; the wire is newest-first, so the index's "recent activity"
// reads top-down without every consumer reversing it.
function newestFirst(entries: readonly WorkLedgerEntry[]): WorkLedgerEntry[] {
  return entries.toReversed();
}

/**
 * Optimistic concurrency: a caller that read revision N may only write over N.
 * Without this, two agents working the same item silently keep the later write.
 */
function assertRevision(current: StoredWorkLedgerItem, expectedRevision: number | undefined): void {
  if (expectedRevision === undefined || current.revision === expectedRevision) return;
  throw new WorkLedgerError(
    "revision_conflict",
    `Item ${current.number} changed since revision ${expectedRevision} (now ${current.revision}); read it again and retry`,
    current.revision,
  );
}

/** `undefined` leaves the field alone; `null` and whitespace clear it. */
function pickTrimmed<T>(next: string | null | undefined, current: T): T | string | null {
  if (next === undefined) return current;
  return trimToNull(next) ?? null;
}

/**
 * A blocked flag without a reason shows a block nobody can read, and a reason
 * without the flag is a fact the index never surfaces. They move together.
 */
function nextBlockedReason(input: {
  current: StoredWorkLedgerItem;
  attention: readonly WorkLedgerAttentionReason[];
  blockedReason: string | null | undefined;
}): string | null {
  if (input.blockedReason !== undefined) return trimToNull(input.blockedReason) ?? null;
  return input.attention.includes("blocked") ? (input.current.blockedReason ?? null) : null;
}

/** Completion and cancellation stamps survive any status edit that keeps them. */
function nextTerminalStamp(input: {
  current: string | null;
  status: WorkLedgerStatus;
  milestone: "completed" | "cancelled";
  previousStatus: WorkLedgerStatus;
  timestamp: string;
}): string | null {
  if (input.status !== input.milestone) return null;
  if (input.previousStatus === input.milestone) return input.current;
  return input.timestamp;
}

/**
 * The rules a status change must satisfy, in one place so every mutation path
 * enforces them identically.
 */
function assertStatusTransition(input: {
  item: StoredWorkLedgerItem;
  nextStatus: WorkLedgerStatus;
  hasResult: boolean;
  /** Only the plain status update insists on a prior result; entry_add *is* the result. */
  requireResult?: boolean;
}): void {
  const { item, nextStatus } = input;
  if (nextStatus === item.status) return;
  if (isTerminalWorkLedgerStatus(item.status)) {
    throw new WorkLedgerError(
      "invalid_transition",
      `Item ${item.number} is ${item.status}; a finished item changes state only through work_ledger_entry_add`,
    );
  }
  if (isTerminalWorkLedgerStatus(nextStatus) && !input.hasResult && input.requireResult) {
    throw new WorkLedgerError(
      "invalid_input",
      `Record the result with work_ledger_entry_add (outcome and evidence) before setting ${item.number} to ${nextStatus}`,
    );
  }
}

/** Adds the moving agent to the item, unless it is already linked. */
function linkFromMove(
  current: StoredWorkLedgerItem,
  link: NonNullable<MoveItemInput["link"]> | undefined,
  timestamp: string,
): StoredWorkLedgerItem["agents"] {
  if (!link) return current.agents;
  if (current.agents.some((candidate) => candidate.agentId === link.agentId)) return current.agents;
  return [
    ...current.agents,
    {
      agentId: link.agentId,
      label: link.label ?? null,
      role: link.role ?? "executor",
      source: link.source ?? "tool",
      state: "confirmed",
      reason: link.reason ?? null,
      linkedAt: timestamp,
      linkedBy: link.agentId,
    },
  ];
}

/** The one-line entry a status move may record; it carries no claim beyond "moved". */
function progressNoteEntry(
  note: NonNullable<MoveItemInput["note"]>,
  timestamp: string,
): WorkLedgerEntry {
  return {
    id: `wle_${randomUUID()}`,
    kind: "progress",
    source: note.source ?? "agent",
    agentId: note.agentId ?? null,
    summary: note.summary.trim(),
    currentState: null,
    outcome: null,
    unreadSources: null,
    evidence: null,
    createdAt: timestamp,
  };
}

function isSameLink(existing: WorkLedgerAgentLink | undefined, next: ResolvedLinkPatch): boolean {
  if (!existing) return false;
  return (
    existing.state === next.state &&
    existing.role === next.role &&
    existing.label === next.label &&
    existing.reason === next.reason
  );
}

/** Links never rewrite history: a candidate cannot demote a confirmed link. */
function applyAgentLink(input: {
  current: StoredWorkLedgerItem;
  agentId: string;
  input: {
    role?: WorkLedgerAgentRole;
    state?: WorkLedgerLinkState;
    source?: WorkLedgerLinkSource;
    reason?: string | null;
    label?: string | null;
    linkedBy?: string | null;
  };
  timestamp: string;
}): StoredWorkLedgerItem {
  const { current } = input;
  const existing = current.agents.find((link) => link.agentId === input.agentId);
  const resolved = resolveLinkPatch(existing, input.input);
  if (existing?.state === "confirmed" && resolved.state === "candidate") return current;
  if (isSameLink(existing, resolved)) return current;
  const link: WorkLedgerAgentLink = {
    agentId: input.agentId,
    label: resolved.label,
    role: resolved.role,
    source: resolved.source,
    state: resolved.state,
    reason: resolved.reason,
    linkedAt: existing?.linkedAt ?? input.timestamp,
    linkedBy: resolved.linkedBy ?? existing?.linkedBy ?? null,
  };
  return {
    ...current,
    agents: existing
      ? current.agents.map((candidate) => (candidate.agentId === input.agentId ? link : candidate))
      : [...current.agents, link],
    updatedAt: input.timestamp,
    revision: current.revision + 1,
  };
}

interface ResolvedLinkPatch {
  role: WorkLedgerAgentRole;
  state: WorkLedgerLinkState;
  source: WorkLedgerLinkSource;
  reason: string | null;
  label: string | null;
  linkedBy: string | null | undefined;
}

/** A patch inherits whatever the caller left out from the link already stored. */
function resolveLinkPatch(
  existing: WorkLedgerAgentLink | undefined,
  patch: {
    role?: WorkLedgerAgentRole;
    state?: WorkLedgerLinkState;
    source?: WorkLedgerLinkSource;
    reason?: string | null;
    label?: string | null;
    linkedBy?: string | null;
  },
): ResolvedLinkPatch {
  return {
    role: patch.role ?? existing?.role ?? "executor",
    state: patch.state ?? existing?.state ?? "confirmed",
    source: patch.source ?? existing?.source ?? "tool",
    reason: patch.reason ?? existing?.reason ?? null,
    label: patch.label ?? existing?.label ?? null,
    linkedBy: patch.linkedBy,
  };
}

function toWireItem(item: StoredWorkLedgerItem): WorkLedgerItem {
  return { ...item, entries: newestFirst(item.entries).slice(0, WORK_LEDGER_LIST_ENTRIES) };
}

function toFullWireItem(item: StoredWorkLedgerItem): WorkLedgerItem {
  return { ...item, entries: newestFirst(item.entries) };
}

/**
 * Owns the ledger. Every mutation is durable before it is published, so a client that
 * sees an upsert can trust the reload it triggers. Publication carries ids only; the
 * session layer re-reads the item and broadcasts it.
 */
export class WorkLedgerService {
  private operations: Promise<void> = Promise.resolve();
  private readonly sequence = new WorkLedgerSequence();
  private readonly listeners = new Set<(change: { itemId: string }) => void>();
  private readonly clock: Clock;

  constructor(
    private readonly store: WorkLedgerStore,
    private readonly scopes: ScopeResolver = unavailableScopeResolver(),
    options: { clock?: Clock } = {},
  ) {
    this.clock = options.clock ?? defaultClock();
  }

  subscribe(listener: (change: { itemId: string }) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get generation(): string {
    return this.sequence.currentGeneration;
  }

  /** Current head of the change journal. */
  get headSeq(): number {
    return this.sequence.currentHeadSeq;
  }

  /** The seq a live update for `itemId` carries: the head at publication. */
  seqFor(_itemId: string): number {
    return this.sequence.currentHeadSeq;
  }

  async getItem(itemId: string): Promise<WorkLedgerItem | null> {
    const stored = await this.store.get(itemId);
    return stored ? toFullWireItem(stored) : null;
  }

  async listItems(): Promise<WorkLedgerItem[]> {
    return (await this.store.list()).map(toWireItem);
  }

  /** Snapshot or catch-up for a read-only subscriber. */
  async synchronize(input: { cursor?: WorkLedgerCursor; scope?: WorkLedgerScope } = {}): Promise<{
    items: WorkLedgerItem[];
    counts: WorkLedgerCounts;
    mode: "snapshot" | "changes";
    generation: string;
    headSeq: number;
    changedItemIds: string[];
    removedItemIds: string[];
    generatedAt: string;
  }> {
    // Read the sequence bounds before the items so a concurrent write during the read
    // is either included here or seen as a later seq — never lost.
    const generation = this.sequence.currentGeneration;
    const sync = this.sequence.synchronize(input.cursor);
    const all = await this.store.list();
    const visible = all.filter((item) =>
      input.scope ? isItemVisibleInScope(item, input.scope) : true,
    );
    const items = visible.map(toWireItem);
    const counts = countWorkLedgerItems(all.map(toWireItem));
    const visibleIds = new Set(visible.map((item) => item.id));
    return {
      items,
      counts,
      mode: sync.mode,
      generation,
      headSeq: sync.headSeq,
      changedItemIds: sync.changedItemIds.filter((id) => visibleIds.has(id)),
      removedItemIds: sync.removedItemIds,
      generatedAt: this.clock.now().toISOString(),
    };
  }

  async getItemsByIds(
    itemIds: readonly string[],
  ): Promise<{ items: WorkLedgerItem[]; missingItemIds: string[] }> {
    const unique = [...new Set(itemIds)];
    const found = await Promise.all(unique.map((id) => this.getItem(id)));
    const items: WorkLedgerItem[] = [];
    const missingItemIds: string[] = [];
    found.forEach((item, index) => {
      if (item) items.push(item);
      else missingItemIds.push(unique[index]!);
    });
    return { items, missingItemIds };
  }

  async counts(): Promise<WorkLedgerCounts> {
    return countWorkLedgerItems(await this.listItems());
  }

  /** Resolves a number/id reference against the whole ledger; see matchItemReference. */
  async resolveItem(reference: string): Promise<WorkLedgerItem | null> {
    const direct = await this.getItem(reference.trim());
    if (direct) return direct;
    return matchItemReference(await this.listItems(), reference);
  }

  async getItemHistory(input: {
    itemId: string;
    beforeEntryId?: string;
    limit?: number;
  }): Promise<{ item: WorkLedgerItem; entries: WorkLedgerEntry[]; hasMore: boolean } | null> {
    const stored = await this.store.get(input.itemId);
    if (!stored) return null;
    const limit = Math.min(Math.max(input.limit ?? 50, 1), 200);
    const entries = stored.entries;
    let end = entries.length;
    if (input.beforeEntryId) {
      const index = entries.findIndex((entry) => entry.id === input.beforeEntryId);
      end = index === -1 ? entries.length : index;
    }
    const window = entries.slice(Math.max(end - limit, 0), end).toReversed();
    return { item: toWireItem(stored), entries: window, hasMore: end - window.length > 0 };
  }

  /**
   * Finds where a caller's item lives when they did not name a scope: their workspace
   * first, then the owning project. Returns null when neither exists yet.
   */
  async resolveDefaultScope(input: {
    workspaceId?: string | null;
  }): Promise<{ scope: WorkLedgerScope; projectId: string } | null> {
    const workspaceId = input.workspaceId?.trim();
    if (!workspaceId) return null;
    const projectId = await this.scopes.projectIdForWorkspace(workspaceId);
    if (!projectId) return null;
    return { scope: { kind: "project", projectId }, projectId };
  }

  async createItem(input: CreateItemInput): Promise<WorkLedgerItem> {
    const title = trimToNull(input.title);
    if (!title) throw new WorkLedgerError("invalid_input", "Item title is required");
    const workspaceId = input.workspaceId?.trim() || null;
    const scope = input.scope ?? (await this.resolveDefaultScope({ workspaceId }))?.scope;
    if (!scope) {
      throw new WorkLedgerError(
        "scope_not_found",
        "Provide a project or workspace: the caller has no workspace to infer one from",
      );
    }
    const projectId = await this.projectIdForScope(scope);
    const now = this.clock.now();
    const timestamp = now.toISOString();
    const number = await this.store.allocateNumber(dayKeyOf(now));
    const created = await this.store.create({
      number,
      scope,
      projectId,
      workspaceId,
      title,
      goal: trimToNull(input.goal) ?? null,
      acceptanceCriteria: trimToNull(input.acceptanceCriteria) ?? null,
      status: input.status ?? "pending",
      attention: [],
      attentionNote: null,
      blockedReason: null,
      labels: input.labels ?? [],
      agents: [],
      entries: [],
      latestSummary: null,
      entryCount: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      lastProgressAt: null,
      lastInspectedAt: null,
      completedAt: null,
      cancelledAt: null,
      revision: 1,
    });
    this.publish(created.id);
    return toWireItem(created);
  }

  /**
   * Everything a status change may carry, committed once: the new status, attention
   * flags, a block reason, an agent link, and a one-line entry. Splitting these into
   * separate calls lets "started working on it" land half-applied, and a half-applied
   * ledger is worse than a stale one.
   */
  async moveItem(input: MoveItemInput): Promise<WorkLedgerItem> {
    return this.exclusive(async () => {
      const timestamp = this.clock.now().toISOString();
      const updated = await this.store.update(input.itemId, (current) => {
        assertRevision(current, input.expectedRevision);
        const assertTransition = current.status !== input.status;
        assertStatusTransition({
          item: current,
          nextStatus: input.status,
          // A note recorded in this same commit is the result being reported.
          hasResult: current.entries.length > 0 || input.note !== undefined,
          requireResult: true,
        });
        const agents = linkFromMove(current, input.link, timestamp);
        const entry = input.note ? progressNoteEntry(input.note, timestamp) : null;
        // A blocked item always says why: dropping the reason while the flag stays
        // would leave the index reporting a block nobody can read.
        const attention = input.attention ?? current.attention;
        const blockedReason = nextBlockedReason({
          current,
          attention,
          blockedReason: input.blockedReason,
        });
        return {
          ...current,
          status: input.status,
          attention,
          attentionNote: pickTrimmed(input.attentionNote, current.attentionNote),
          blockedReason: blockedReason ?? null,
          agents,
          entries: entry ? [...current.entries, entry] : current.entries,
          entryCount: entry ? current.entries.length + 1 : current.entryCount,
          completedAt: input.status === "completed" ? (current.completedAt ?? timestamp) : null,
          cancelledAt: input.status === "cancelled" ? (current.cancelledAt ?? timestamp) : null,
          lastProgressAt: assertTransition ? timestamp : current.lastProgressAt,
          updatedAt: timestamp,
          revision: current.revision + 1,
        };
      });
      this.publish(input.itemId);
      return toWireItem(updated);
    });
  }

  async updateItem(input: UpdateItemInput): Promise<WorkLedgerItem> {
    return this.exclusive(async () => {
      const updated = await this.store.update(input.itemId, (current) => {
        assertRevision(current, input.expectedRevision);
        const nextStatus = input.status ?? current.status;
        assertStatusTransition({
          item: current,
          nextStatus,
          hasResult: current.entries.length > 0,
          requireResult: true,
        });
        const timestamp = this.clock.now().toISOString();
        return {
          ...current,
          title: trimToNull(input.title) || current.title,
          goal: pickTrimmed(input.goal, current.goal),
          acceptanceCriteria: pickTrimmed(input.acceptanceCriteria, current.acceptanceCriteria),
          labels: input.labels ?? current.labels,
          status: nextStatus,
          attention: input.attention ?? current.attention,
          attentionNote: pickTrimmed(input.attentionNote, current.attentionNote),
          blockedReason: pickTrimmed(input.blockedReason, current.blockedReason),
          workspaceId: input.workspaceId === undefined ? current.workspaceId : input.workspaceId,
          completedAt: nextTerminalStamp({
            current: current.completedAt,
            status: nextStatus,
            milestone: "completed",
            previousStatus: current.status,
            timestamp,
          }),
          cancelledAt: nextTerminalStamp({
            current: current.cancelledAt,
            status: nextStatus,
            milestone: "cancelled",
            previousStatus: current.status,
            timestamp,
          }),
          updatedAt: timestamp,
          revision: current.revision + 1,
        };
      });
      return toWireItem(updated);
    });
  }

  async recordEntry(
    input: RecordEntryInput,
  ): Promise<{ item: WorkLedgerItem; entry: WorkLedgerEntry }> {
    if (!input.summary.trim()) {
      throw new WorkLedgerError("invalid_input", "Entry summary is required");
    }
    return this.exclusive(async () => {
      const timestamp = this.clock.now().toISOString();
      const entry: WorkLedgerEntry = {
        id: `wle_${randomUUID()}`,
        kind: input.kind,
        source: input.source,
        agentId: input.agentId ?? null,
        summary: input.summary.trim(),
        currentState: trimToNull(input.currentState) ?? null,
        outcome: input.outcome ?? null,
        unreadSources: input.unreadSources?.length ? input.unreadSources : null,
        evidence: input.evidence?.length ? input.evidence : null,
        createdAt: timestamp,
      };
      const updated = await this.store.update(input.itemId, (current) => {
        const nextStatus = input.status ?? current.status;
        if (
          current.status !== nextStatus &&
          isTerminalWorkLedgerStatus(current.status) &&
          !isTerminalWorkLedgerStatus(nextStatus) &&
          entry.currentState === null
        ) {
          // Reopening is a deliberate act; it must carry the state that justifies it.
          throw new WorkLedgerError(
            "invalid_input",
            `Reopening ${current.number} needs currentState explaining where it stands now`,
          );
        }
        const statusChanged = nextStatus !== current.status;
        const attention = input.attention ?? current.attention;
        const isInspection = input.kind === "inspection" || input.source === "inspection";
        return {
          ...current,
          status: nextStatus,
          attention,
          attentionNote: pickTrimmed(input.attentionNote, current.attentionNote),
          blockedReason: nextBlockedReason({
            current,
            attention,
            blockedReason: input.blockedReason,
          }),
          latestSummary: entry.currentState ?? current.latestSummary,
          entries: [...current.entries, entry],
          entryCount: current.entries.length + 1,
          lastProgressAt: input.movesProgress || statusChanged ? timestamp : current.lastProgressAt,
          // A sweep is evidence the item was checked, never that it moved.
          lastInspectedAt: isInspection ? timestamp : current.lastInspectedAt,
          completedAt: nextTerminalStamp({
            current: current.completedAt,
            status: nextStatus,
            milestone: "completed",
            previousStatus: current.status,
            timestamp,
          }),
          cancelledAt: nextTerminalStamp({
            current: current.cancelledAt,
            status: nextStatus,
            milestone: "cancelled",
            previousStatus: current.status,
            timestamp,
          }),
          updatedAt: timestamp,
          revision: current.revision + 1,
        };
      });
      this.publish(input.itemId);
      return { item: toWireItem(updated), entry };
    });
  }

  async deleteItem(itemId: string): Promise<void> {
    await this.exclusive(async () => {
      await this.store.delete(itemId);
    });
    this.sequence.publish({ kind: "remove", itemId });
    this.publish(itemId);
  }

  /**
   * Links an agent to an item. A confirmed link replaces an existing entry for the
   * same agent; a candidate link never overwrites a confirmed one, so a later guess
   * cannot demote a fact.
   */
  async linkAgent(input: {
    itemId: string;
    agentId: string;
    role?: WorkLedgerAgentRole;
    state?: WorkLedgerLinkState;
    source?: WorkLedgerLinkSource;
    reason?: string | null;
    label?: string | null;
    linkedBy?: string | null;
  }): Promise<WorkLedgerItem> {
    const agentId = input.agentId.trim();
    if (!agentId) throw new WorkLedgerError("invalid_input", "agentId is required");
    return this.exclusive(async () => {
      const timestamp = this.clock.now().toISOString();
      const updated = await this.store.update(input.itemId, (current) =>
        applyAgentLink({ current, agentId, input, timestamp }),
      );
      this.publish(input.itemId);
      return toWireItem(updated);
    });
  }

  /** Removes an agent link; used when a link turns out to be wrong. */
  async unlinkAgent(input: { itemId: string; agentId: string }): Promise<WorkLedgerItem | null> {
    return this.exclusive(async () => {
      const current = await this.store.get(input.itemId);
      if (!current) return null;
      const agents = current.agents.filter((link) => link.agentId !== input.agentId);
      if (agents.length === current.agents.length) return toWireItem(current);
      const updated = await this.store.update(input.itemId, (item) => ({
        ...item,
        agents,
        updatedAt: this.clock.now().toISOString(),
        revision: item.revision + 1,
      }));
      this.publish(input.itemId);
      return toWireItem(updated);
    });
  }

  /** Items whose number, title, or agent ids mention `query`, for agent lookups. */
  async search(query: string): Promise<WorkLedgerItem[]> {
    const needle = query.trim().toLowerCase();
    if (!needle) return [];
    const items = await this.listItems();
    return items.filter(
      (item) =>
        item.number.toLowerCase().includes(needle) ||
        item.title.toLowerCase().includes(needle) ||
        item.agents.some((link) => link.agentId.toLowerCase().startsWith(needle)),
    );
  }

  private async projectIdForScope(scope: WorkLedgerScope): Promise<string> {
    if (scope.kind === "project") {
      if (!(await this.scopes.projectExists(scope.projectId))) {
        throw new WorkLedgerError("scope_not_found", `Project not found: ${scope.projectId}`);
      }
      return scope.projectId;
    }
    const projectId = await this.scopes.projectIdForWorkspace(scope.workspaceId);
    if (!projectId) {
      throw new WorkLedgerError("scope_not_found", `Workspace not found: ${scope.workspaceId}`);
    }
    return projectId;
  }

  private publish(itemId: string): void {
    // Journal first: a subscriber that reacts synchronously must not see a seq the
    // catch-up path has not recorded yet.
    this.sequence.publish({ kind: "upsert", itemId });
    for (const listener of this.listeners) {
      try {
        listener({ itemId });
      } catch {
        // Publication cannot fail the mutation that already persisted.
      }
    }
  }

  private async exclusive<T>(operation: () => Promise<T>): Promise<T> {
    const previous = this.operations;
    let release!: () => void;
    this.operations = new Promise<void>((resolve) => {
      release = resolve;
    });
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}
