import { z } from "zod";
import {
  WorkLedgerCountsSchema,
  WorkLedgerItemSchema,
  WorkLedgerScopeSchema,
  WorkLedgerSyncMetadataSchema,
} from "./types.js";

/**
 * Wire schemas for the read-only work ledger surface.
 *
 * Clients only ever read: agents mutate the ledger through Paseo tools, so there is
 * no client-side create/update/complete RPC and no path to accidentally turn the
 * index into an editor. Purity rules apply — no `.transform()`/`.catch()`/`.preprocess()`
 * on message schemas.
 */

export const WorkLedgerSyncCursorSchema = z.object({
  generation: z.string(),
  afterSeq: z.number().int().nonnegative(),
});

/**
 * `scope` narrows the snapshot to one project or one workspace. `includeCompleted`
 * keeps finished items in the payload; the index and the popup both need to be able
 * to count them without a second request.
 */
export const WorkLedgerListRequestSchema = z.object({
  type: z.literal("work_ledger.list.request"),
  requestId: z.string(),
  scope: WorkLedgerScopeSchema.optional(),
  includeCompleted: z.boolean().optional(),
  subscribe: z.object({ subscriptionId: z.string().optional() }).optional(),
  sync: WorkLedgerSyncCursorSchema.optional(),
});

export const WorkLedgerListResponseSchema = z.object({
  type: z.literal("work_ledger.list.response"),
  payload: z.object({
    requestId: z.string(),
    subscriptionId: z.string().optional(),
    items: z.array(WorkLedgerItemSchema),
    counts: WorkLedgerCountsSchema,
    sync: WorkLedgerSyncMetadataSchema,
    /** Server clock at snapshot time, so a client can say "as of …" without trusting its own. */
    generatedAt: z.string(),
  }),
});

/** Live change after a snapshot. `upsert` carries the whole item. */
export const WorkLedgerUpdateSchema = z.object({
  type: z.literal("work_ledger.update"),
  payload: z.discriminatedUnion("kind", [
    z.object({
      subscriptionId: z.string().optional(),
      kind: z.literal("upsert"),
      item: WorkLedgerItemSchema,
      counts: WorkLedgerCountsSchema,
      generation: z.string(),
      seq: z.number().int().positive(),
    }),
    z.object({
      subscriptionId: z.string().optional(),
      kind: z.literal("remove"),
      itemId: z.string(),
      counts: WorkLedgerCountsSchema,
      generation: z.string(),
      seq: z.number().int().positive(),
    }),
  ]),
});

export const WorkLedgerItemGetRequestSchema = z.object({
  type: z.literal("work_ledger.item.get.request"),
  requestId: z.string(),
  itemId: z.string(),
  /** Page back through history; omitted means the newest page. */
  beforeEntryId: z.string().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

export const WorkLedgerItemGetResponseSchema = z.object({
  type: z.literal("work_ledger.item.get.response"),
  payload: z.object({
    requestId: z.string(),
    item: WorkLedgerItemSchema,
    /** Every entry in the window, newest first (the item's `entries` is a prefix of this). */
    entries: z.array(WorkLedgerItemSchema.shape.entries.element),
    hasMore: z.boolean(),
  }),
});

/**
 * Ask for specific items by id. Used to apply a `changes` catch-up: the client sends
 * one request for the ids the ledger says changed (empty when everything changed was
 * a removal) instead of insisting on a full snapshot.
 */
export const WorkLedgerItemListRequestSchema = z.object({
  type: z.literal("work_ledger.item.list.request"),
  requestId: z.string(),
  itemIds: z.array(z.string().min(1)).max(200),
});

export const WorkLedgerItemListResponseSchema = z.object({
  type: z.literal("work_ledger.item.list.response"),
  payload: z.object({
    requestId: z.string(),
    items: z.array(WorkLedgerItemSchema),
    /** Ids asked for that no longer exist. */
    missingItemIds: z.array(z.string()),
    counts: WorkLedgerCountsSchema,
    generation: z.string(),
    headSeq: z.number().int().nonnegative(),
    generatedAt: z.string(),
  }),
});

export type WorkLedgerListRequest = z.infer<typeof WorkLedgerListRequestSchema>;
export type WorkLedgerListPayload = z.infer<typeof WorkLedgerListResponseSchema>["payload"];
export type WorkLedgerUpdatePayload = z.infer<typeof WorkLedgerUpdateSchema>["payload"];
export type WorkLedgerItemGetPayload = z.infer<typeof WorkLedgerItemGetResponseSchema>["payload"];
export type WorkLedgerItemListPayload = z.infer<typeof WorkLedgerItemListResponseSchema>["payload"];

/**
 * Daemon-side status change with an agent link in one operation. Agents maintain the
 * ledger through tools, and "started working on it" is both facts at once; two RPC-ish
 * tool calls that can half-apply would leave the index untruthful.
 */
export const WorkLedgerItemSetStatusRequestSchema = z.object({
  type: z.literal("work_ledger.item.set_status.request"),
  requestId: z.string(),
  itemId: z.string(),
  status: z.enum(["pending", "in_progress", "review", "completed", "cancelled"]),
  expectedRevision: z.number().int().positive().optional(),
  agentId: z.string().optional(),
  agentRole: z.enum(["executor", "monitor", "verifier"]).optional(),
  agentLabel: z.string().optional(),
  linkReason: z.string().optional(),
  note: z.string().optional(),
});

export const WorkLedgerItemSetStatusResponseSchema = z.object({
  type: z.literal("work_ledger.item.set_status.response"),
  payload: z.object({
    requestId: z.string(),
    item: WorkLedgerItemSchema,
  }),
});

export type WorkLedgerItemSetStatusPayload = z.infer<
  typeof WorkLedgerItemSetStatusResponseSchema
>["payload"];
