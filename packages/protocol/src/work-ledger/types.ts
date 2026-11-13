import { z } from "zod";

/**
 * Work ledger: the durable, cross-session task registry a project keeps.
 *
 * The daemon owns every item and every entry. Agents write through Paseo tools,
 * clients read. Nothing here carries a UI concern: statuses are lifecycle states,
 * attention is a separate flag so an item can be both "in progress" and "needs a
 * look", and three clocks are kept apart so a routine sweep cannot make an idle
 * item look busy.
 *
 * zod-aot loads this module through type stripping, which resolves neither
 * `import type` aliases inside schema declarations nor interface bodies. Schema
 * fields stay structural; derived types are exported separately.
 */

export const WorkLedgerScopeSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("project"), projectId: z.string().min(1) }),
  z.object({ kind: z.literal("workspace"), workspaceId: z.string().min(1) }),
]);

/** Lifecycle state. `review` means a result exists and waits for verification. */
export const WorkLedgerStatusSchema = z.enum([
  "pending",
  "in_progress",
  "review",
  "completed",
  "cancelled",
]);

/**
 * Why an item needs a human look. Independent of status on purpose: an item can
 * be `in_progress` and `awaiting_confirmation`, or `review` and `stalled`.
 */
export const WorkLedgerAttentionReasonSchema = z.enum([
  "blocked",
  "needs_input",
  "awaiting_confirmation",
  "stalled",
  "missing_evidence",
]);

export const WorkLedgerAgentRoleSchema = z.enum(["executor", "monitor", "verifier"]);
export const WorkLedgerLinkSourceSchema = z.enum(["user", "tool", "inferred"]);
export const WorkLedgerLinkStateSchema = z.enum(["confirmed", "candidate"]);
export const WorkLedgerEntryKindSchema = z.enum(["progress", "inspection", "note"]);

/** Where an entry's claims came from, so a later reader can weigh them. */
export const WorkLedgerEntrySourceSchema = z.enum(["agent", "user", "inspection"]);
export const WorkLedgerEntryOutcomeSchema = z.enum([
  "progressed",
  "no_change",
  "incomplete",
  "failed",
]);

export const WorkLedgerEvidenceSchema = z.object({
  label: z.string().min(1),
  /** Repo-relative or absolute path, URL, or a short identifier the reader can follow. */
  reference: z.string().nullable().optional(),
  note: z.string().nullable().optional(),
});

export const WorkLedgerAgentLinkSchema = z.object({
  agentId: z.string().min(1),
  /** Short label for compact surfaces; the id above stays authoritative. */
  label: z.string().nullable().optional(),
  role: WorkLedgerAgentRoleSchema,
  source: WorkLedgerLinkSourceSchema,
  state: WorkLedgerLinkStateSchema,
  reason: z.string().nullable().optional(),
  linkedAt: z.string(),
  linkedBy: z.string().nullable().optional(),
});

export const WorkLedgerEntrySchema = z.object({
  id: z.string(),
  kind: WorkLedgerEntryKindSchema,
  source: WorkLedgerEntrySourceSchema,
  agentId: z.string().nullable().optional(),
  /** What happened. For inspections: what was checked and what it showed. */
  summary: z.string().min(1),
  /** Where the item stands after this entry; replaces the previous current state. */
  currentState: z.string().nullable().optional(),
  outcome: WorkLedgerEntryOutcomeSchema.nullable().optional(),
  /** Inspections only: sources the inspection could not read, so its verdict is partial. */
  unreadSources: z.array(z.string()).nullable().optional(),
  evidence: z.array(WorkLedgerEvidenceSchema).nullable().optional(),
  createdAt: z.string(),
});

export const WorkLedgerItemSchema = z.object({
  id: z.string(),
  /**
   * `TODO-20261111-010`. The stored suffix is a per-day counter, so the same number
   * can exist on another daemon — treat (serverId, number) as the identity.
   */
  number: z.string(),
  scope: WorkLedgerScopeSchema,
  projectId: z.string(),
  /** Workspace that currently drives the item, when one does. Never its owner. */
  workspaceId: z.string().nullable().optional(),
  title: z.string().min(1),
  /** What question the item answers or what must be delivered. */
  goal: z.string().nullable().optional(),
  /** How completion is judged. Without this, `completed` is only an agent's claim. */
  acceptanceCriteria: z.string().nullable().optional(),
  status: WorkLedgerStatusSchema,
  attention: z.array(WorkLedgerAttentionReasonSchema),
  attentionNote: z.string().nullable().optional(),
  blockedReason: z.string().nullable().optional(),
  /** The state the index shows; replaced by the latest entry's currentState. */
  latestSummary: z.string().nullable().optional(),
  labels: z.array(z.string()),
  agents: z.array(WorkLedgerAgentLinkSchema),
  /**
   * The newest WORK_LEDGER_LIST_ENTRIES entries, newest first. Full history is only
   * available from item.get, which keeps every live update small.
   */
  entries: z.array(WorkLedgerEntrySchema),
  entryCount: z.number().int().nonnegative(),
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Last time an entry recorded real movement. Inspections that found nothing do not move it. */
  lastProgressAt: z.string().nullable(),
  /** Last inspection, whether or not it found anything. */
  lastInspectedAt: z.string().nullable(),
  completedAt: z.string().nullable(),
  cancelledAt: z.string().nullable(),
  revision: z.number().int().positive(),
});

export const WorkLedgerCountsSchema = z.object({
  total: z.number().int().nonnegative(),
  pending: z.number().int().nonnegative(),
  inProgress: z.number().int().nonnegative(),
  review: z.number().int().nonnegative(),
  completed: z.number().int().nonnegative(),
  cancelled: z.number().int().nonnegative(),
  /** Cross-cutting: overlaps every status bucket above, so it never sums with them. */
  attention: z.number().int().nonnegative(),
});

export const WorkLedgerSyncMetadataSchema = z.object({
  mode: z.enum(["snapshot", "changes"]),
  generation: z.string(),
  headSeq: z.number().int().nonnegative(),
  removedItemIds: z.array(z.string()),
  /** Present only when `mode` is `changes`: ids the client must re-read. */
  changedItemIds: z.array(z.string()).optional(),
});

export type WorkLedgerScope = z.infer<typeof WorkLedgerScopeSchema>;
export type WorkLedgerStatus = z.infer<typeof WorkLedgerStatusSchema>;
export type WorkLedgerAttentionReason = z.infer<typeof WorkLedgerAttentionReasonSchema>;
export type WorkLedgerAgentRole = z.infer<typeof WorkLedgerAgentRoleSchema>;
export type WorkLedgerLinkSource = z.infer<typeof WorkLedgerLinkSourceSchema>;
export type WorkLedgerLinkState = z.infer<typeof WorkLedgerLinkStateSchema>;
export type WorkLedgerEntryKind = z.infer<typeof WorkLedgerEntryKindSchema>;
export type WorkLedgerEntrySource = z.infer<typeof WorkLedgerEntrySourceSchema>;
export type WorkLedgerEntryOutcome = z.infer<typeof WorkLedgerEntryOutcomeSchema>;
export type WorkLedgerEvidence = z.infer<typeof WorkLedgerEvidenceSchema>;
export type WorkLedgerAgentLink = z.infer<typeof WorkLedgerAgentLinkSchema>;
export type WorkLedgerEntry = z.infer<typeof WorkLedgerEntrySchema>;
export type WorkLedgerItem = z.infer<typeof WorkLedgerItemSchema>;
export type WorkLedgerCounts = z.infer<typeof WorkLedgerCountsSchema>;
export type WorkLedgerSyncMetadata = z.infer<typeof WorkLedgerSyncMetadataSchema>;

/** Number of entries kept on an item inside list payloads. */
export const WORK_LEDGER_LIST_ENTRIES = 3;

export function emptyWorkLedgerCounts(): WorkLedgerCounts {
  return {
    total: 0,
    pending: 0,
    inProgress: 0,
    review: 0,
    completed: 0,
    cancelled: 0,
    attention: 0,
  };
}

export function countWorkLedgerItems(items: readonly WorkLedgerItem[]): WorkLedgerCounts {
  const counts = emptyWorkLedgerCounts();
  for (const item of items) {
    counts.total += 1;
    switch (item.status) {
      case "pending":
        counts.pending += 1;
        break;
      case "in_progress":
        counts.inProgress += 1;
        break;
      case "review":
        counts.review += 1;
        break;
      case "completed":
        counts.completed += 1;
        break;
      case "cancelled":
        counts.cancelled += 1;
        break;
    }
    if (item.attention.length > 0) counts.attention += 1;
  }
  return counts;
}

const TERMINAL_STATUSES: ReadonlySet<WorkLedgerStatus> = new Set(["completed", "cancelled"]);

export function isTerminalWorkLedgerStatus(status: WorkLedgerStatus): boolean {
  return TERMINAL_STATUSES.has(status);
}

/** Scope display key used to group items in clients without re-deriving ownership. */
export function workLedgerScopeKey(scope: WorkLedgerScope): string {
  return scope.kind === "project" ? `project:${scope.projectId}` : `workspace:${scope.workspaceId}`;
}
