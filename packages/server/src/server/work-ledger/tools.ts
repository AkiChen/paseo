import { z } from "zod";
import {
  WorkLedgerAgentRoleSchema,
  WorkLedgerAttentionReasonSchema,
  WorkLedgerEntryKindSchema,
  WorkLedgerEntryOutcomeSchema,
  WorkLedgerEvidenceSchema,
  WorkLedgerStatusSchema,
  type WorkLedgerItem,
} from "@getpaseo/protocol/work-ledger/types";
import type {
  PaseoToolConfig,
  PaseoToolExecutionContext,
  PaseoToolResult,
} from "../agent/tools/types.js";
import { WorkLedgerError, type WorkLedgerService } from "./index.js";

/**
 * Agent-facing ledger tools.
 *
 * The index is a place agents record what they are doing and what they found, so
 * these tools bias toward the smallest call that leaves the ledger truthful:
 * set_status links the caller and moves the item in one commit, entry_add carries
 * the evidence with the claim. Everything a human sees is derived here; the model
 * never hand-writes a status line.
 */

export interface RegisterWorkLedgerToolsOptions {
  service: WorkLedgerService;
  registerTool: (
    name: string,
    config: PaseoToolConfig,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- Inputs are validated by the catalog before execution.
    handler: (input: any, context: PaseoToolExecutionContext) => Promise<PaseoToolResult>,
  ) => void;
  callerAgentId?: string;
  resolveCallerAgent: () => { id: string; workspaceId?: string; cwd: string } | null;
  /** Resolves `project:…` / `workspace:…` / bare ids; returns null for anything unknown. */
  resolveScopeReference?: (reference: string) => Promise<{
    kind: "project" | "workspace";
    id: string;
  } | null>;
  /** Case-insensitive search across active agents, used only for candidate links. */
  searchAgentIds?: (query: string) => Promise<string[]>;
}

const DESCRIPTION_PREFIX =
  "Paseo work ledger (this project's long-lived task index, shared across agent sessions). ";

/** Accepts `projectId`/`workspaceId` as an alternative to one `scope` string. */
function scopeReferenceFromIds(input: {
  projectId?: string;
  workspaceId?: string;
}): string | undefined {
  if (input.projectId) return `project:${input.projectId}`;
  if (input.workspaceId) return `workspace:${input.workspaceId}`;
  return undefined;
}

const ITEM_REFERENCE = z
  .string()
  .trim()
  .min(1)
  .describe("Item number like TODO-20261111-010, or the item id.");

function ok(structuredContent: unknown, text?: string): PaseoToolResult {
  return {
    content: text ? [{ type: "text", text }] : [],
    structuredContent,
  };
}

function fail(error: unknown): PaseoToolResult {
  const message = error instanceof Error ? error.message : String(error);
  const code = error instanceof WorkLedgerError ? error.code : "work_ledger_failed";
  return {
    content: [{ type: "text", text: `${message} (${code})` }],
    structuredContent: {
      error: message,
      code,
      ...(error instanceof WorkLedgerError && error.currentRevision !== undefined
        ? { currentRevision: error.currentRevision }
        : {}),
    },
    isError: true,
  };
}

function summarizeItem(item: WorkLedgerItem) {
  return {
    id: item.id,
    number: item.number,
    scope: item.scope,
    title: item.title,
    status: item.status,
    attention: item.attention,
    blockedReason: item.blockedReason,
    latestSummary: item.latestSummary,
    revision: item.revision,
    lastProgressAt: item.lastProgressAt,
    lastInspectedAt: item.lastInspectedAt,
    agents: item.agents.map((link) => ({
      agentId: link.agentId,
      role: link.role,
      state: link.state,
      source: link.source,
    })),
    entryCount: item.entryCount,
    // Newest first: a caller checking "did my note land?" reads the same order the
    // UI shows.
    entries: item.entries.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      outcome: entry.outcome ?? null,
      summary: entry.summary,
      currentState: entry.currentState ?? null,
      createdAt: entry.createdAt,
    })),
  };
}

export function registerWorkLedgerTools(options: RegisterWorkLedgerToolsOptions): void {
  const { service, registerTool, callerAgentId, resolveCallerAgent } = options;

  const requireItem = async (reference: string): Promise<WorkLedgerItem> => {
    const item = await service.resolveItem(reference);
    if (!item) {
      throw new WorkLedgerError(
        "item_not_found",
        `No work ledger item matches "${reference}". Call work_ledger_search first.`,
      );
    }
    return item;
  };

  const resolveCreateScope = async (reference: string | undefined) => {
    const workspaceId = resolveCallerAgent()?.workspaceId ?? null;
    if (!reference) {
      const fallback = await service.resolveDefaultScope({ workspaceId });
      if (!fallback) {
        throw new WorkLedgerError(
          "scope_not_found",
          "This agent has no workspace. Pass projectId or workspaceId, or call list_workspaces first.",
        );
      }
      return { scope: fallback.scope, workspaceId };
    }
    const resolved = await options.resolveScopeReference?.(reference);
    if (!resolved) {
      throw new WorkLedgerError(
        "scope_not_found",
        `Unknown project or workspace "${reference}". Use project:ID or workspace:ID.`,
      );
    }
    return resolved.kind === "project"
      ? { scope: { kind: "project" as const, projectId: resolved.id }, workspaceId }
      : {
          scope: { kind: "workspace" as const, workspaceId: resolved.id },
          workspaceId: resolved.id,
        };
  };

  registerTool(
    "work_ledger_search",
    {
      title: "Search work ledger",
      description:
        `${DESCRIPTION_PREFIX}Use it before creating an item so a session does not duplicate work that already exists, and to find the item you were asked to work on. ` +
        "Matches item numbers, titles, and agent ids. Returns counts so you can report progress without listing everything.",
      inputSchema: {
        query: z.string().trim().optional().describe("Item number, title text, or agent id."),
        status: WorkLedgerStatusSchema.optional(),
        attentionOnly: z
          .boolean()
          .optional()
          .describe("Only items flagged as needing a human look."),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async (input: { query?: string; status?: string; attentionOnly?: boolean; limit?: number }) => {
      try {
        const items = input.query?.trim()
          ? await service.search(input.query)
          : await service.listItems();
        const filtered = items.filter(
          (item) =>
            (input.status === undefined || item.status === input.status) &&
            (input.attentionOnly !== true || item.attention.length > 0),
        );
        const limit = input.limit ?? 50;
        return ok({
          items: filtered.slice(0, limit).map(summarizeItem),
          total: filtered.length,
          counts: await service.counts(),
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  registerTool(
    "work_ledger_item_get",
    {
      title: "Read a work ledger item",
      description:
        `${DESCRIPTION_PREFIX}Returns the full item with its description, agent links, and recent history. ` +
        "Call it before updating so you know the goal, the acceptance criteria, and the current revision.",
      inputSchema: {
        item: ITEM_REFERENCE,
        historyLimit: z.number().int().positive().max(100).optional(),
      },
    },
    async (input: { item: string; historyLimit?: number }) => {
      try {
        const resolved = await requireItem(input.item);
        const history = await service.getItemHistory({
          itemId: resolved.id,
          limit: input.historyLimit ?? 20,
        });
        if (!history) throw new WorkLedgerError("item_not_found", "Item disappeared while reading");
        return ok(history);
      } catch (error) {
        return fail(error);
      }
    },
  );

  registerTool(
    "work_ledger_item_create",
    {
      title: "Create a work ledger item",
      description:
        `${DESCRIPTION_PREFIX}Creates a numbered item that survives this session. ` +
        "Write `goal` and `acceptanceCriteria` so a later agent can tell whether the work is actually done. " +
        "The item belongs to the caller's project by default.",
      inputSchema: {
        title: z.string().trim().min(1).describe("Short one-line title a human would recognize."),
        goal: z.string().trim().optional().describe("What question to answer or what to deliver."),
        acceptanceCriteria: z
          .string()
          .trim()
          .optional()
          .describe("Concrete evidence that would make this item complete."),
        scope: z
          .string()
          .trim()
          .optional()
          .describe("project:ID or workspace:ID. Defaults to the caller's project."),
        projectId: z
          .string()
          .trim()
          .optional()
          .describe('Alternative spelling of scope="project:ID".'),
        workspaceId: z
          .string()
          .trim()
          .optional()
          .describe('Alternative spelling of scope="workspace:ID".'),
        status: WorkLedgerStatusSchema.optional().describe(
          "Defaults to pending; pass in_progress if you start on it now.",
        ),
        labels: z.array(z.string().trim().min(1)).optional(),
      },
    },
    async (input: {
      title: string;
      goal?: string;
      acceptanceCriteria?: string;
      scope?: string;
      projectId?: string;
      workspaceId?: string;
      status?: WorkLedgerItem["status"];
      labels?: string[];
    }) => {
      try {
        const reference = input.scope ?? scopeReferenceFromIds(input);
        const resolved = await resolveCreateScope(reference);
        const item = await service.createItem({
          title: input.title,
          goal: input.goal,
          acceptanceCriteria: input.acceptanceCriteria,
          scope: resolved.scope,
          workspaceId: resolved.workspaceId,
          status: input.status,
          labels: input.labels,
          createdBy: callerAgentId ?? null,
        });
        const created = callerAgentId
          ? await service.linkAgent({
              itemId: item.id,
              agentId: callerAgentId,
              role: "executor",
              reason: "Created the item",
              source: "tool",
              linkedBy: callerAgentId,
            })
          : item;
        return ok({ item: summarizeItem(created), number: created.number });
      } catch (error) {
        return fail(error);
      }
    },
  );

  registerTool(
    "work_ledger_item_set_status",
    {
      title: "Move a work ledger item",
      description:
        `${DESCRIPTION_PREFIX}Moves the item and links you as the agent doing the work in one step. ` +
        "Use in_progress when you start, review when a result exists and needs verification, completed only after the acceptance criteria are met. " +
        "Finished items accept no status change: reopen them with work_ledger_entry_add.",
      inputSchema: {
        item: ITEM_REFERENCE,
        status: WorkLedgerStatusSchema,
        expectedRevision: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("Revision you last read. Prevents overwriting a concurrent update."),
        note: z
          .string()
          .trim()
          .optional()
          .describe("One sentence on what triggered this change; recorded as an entry."),
        blockedReason: z.string().trim().nullable().optional(),
        attention: z.array(WorkLedgerAttentionReasonSchema).optional(),
        attentionNote: z.string().trim().nullable().optional(),
      },
    },
    async (input: {
      item: string;
      status: WorkLedgerItem["status"];
      expectedRevision?: number;
      note?: string;
      blockedReason?: string | null;
      attention?: WorkLedgerItem["attention"];
      attentionNote?: string | null;
    }) => {
      try {
        const item = await requireItem(input.item);
        const updated = await service.moveItem({
          itemId: item.id,
          status: input.status,
          expectedRevision: input.expectedRevision,
          attention: input.attention,
          attentionNote: input.attentionNote,
          blockedReason: input.blockedReason,
          ...(callerAgentId
            ? {
                link: {
                  agentId: callerAgentId,
                  role: "executor" as const,
                  reason: "Moving the item's status",
                  source: "tool" as const,
                },
              }
            : {}),
          ...(input.note?.trim()
            ? { note: { summary: input.note.trim(), agentId: callerAgentId ?? null } }
            : {}),
        });
        return ok({ item: summarizeItem(updated), status: updated.status });
      } catch (error) {
        return fail(error);
      }
    },
  );

  registerTool(
    "work_ledger_entry_add",
    {
      title: "Record work ledger progress",
      description:
        `${DESCRIPTION_PREFIX}Appends what happened, where the item now stands, and the evidence behind it. ` +
        'Use kind="inspection" for a scheduled sweep: say what you checked and, if you could not read a source, list it in unreadSources — the ledger then says the sweep was incomplete instead of claiming there was no news.',
      inputSchema: {
        item: ITEM_REFERENCE,
        summary: z
          .string()
          .trim()
          .min(1)
          .describe("What happened, in one or two sentences a reader can act on."),
        currentState: z
          .string()
          .trim()
          .optional()
          .describe("Where the item stands now; replaces the index's latest summary."),
        kind: WorkLedgerEntryKindSchema.optional().describe("Defaults to progress."),
        outcome: WorkLedgerEntryOutcomeSchema.optional(),
        evidence: z
          .array(WorkLedgerEvidenceSchema)
          .optional()
          .describe("Each piece with a label and a path, URL, or identifier."),
        unreadSources: z
          .array(z.string().trim().min(1))
          .optional()
          .describe("Inspection only: sources that could not be read."),
        status: WorkLedgerStatusSchema.optional().describe("Also move the item's status."),
        attention: z.array(WorkLedgerAttentionReasonSchema).nullable().optional(),
        attentionNote: z.string().trim().nullable().optional(),
        blockedReason: z.string().trim().nullable().optional(),
        expectedRevision: z.number().int().positive().optional(),
      },
    },
    async (input: {
      item: string;
      summary: string;
      currentState?: string;
      kind?: "progress" | "inspection" | "note";
      outcome?: "progressed" | "no_change" | "incomplete" | "failed";
      evidence?: Array<{ label: string; reference?: string | null; note?: string | null }>;
      unreadSources?: string[];
      status?: WorkLedgerItem["status"];
      attention?: WorkLedgerItem["attention"] | null;
      attentionNote?: string | null;
      blockedReason?: string | null;
      expectedRevision?: number;
    }) => {
      try {
        const item = await requireItem(input.item);
        if (input.expectedRevision !== undefined && input.expectedRevision !== item.revision) {
          throw new WorkLedgerError(
            "revision_conflict",
            `Item ${item.number} changed since revision ${input.expectedRevision} (now ${item.revision}); read it again and retry`,
            item.revision,
          );
        }
        const kind = input.kind ?? "progress";
        const outcome = input.outcome ?? (kind === "inspection" ? "no_change" : null);
        const result = await service.recordEntry({
          itemId: item.id,
          kind,
          source: kind === "inspection" ? "inspection" : "agent",
          agentId: callerAgentId ?? null,
          summary: input.summary,
          currentState: input.currentState,
          outcome,
          unreadSources: input.unreadSources,
          evidence: input.evidence,
          status: input.status,
          attention: input.attention ?? undefined,
          attentionNote: input.attentionNote,
          blockedReason: input.blockedReason,
          movesProgress: kind === "progress" || kind === "note" || outcome === "progressed",
        });
        if (callerAgentId) {
          await service.linkAgent({
            itemId: item.id,
            agentId: callerAgentId,
            role: kind === "inspection" ? "monitor" : "executor",
            reason: kind === "inspection" ? "Recorded an inspection" : "Recorded progress",
            linkedBy: callerAgentId,
          });
        }
        return ok({
          item: summarizeItem(result.item),
          entryId: result.entry.id,
          lastProgressAt: result.item.lastProgressAt,
        });
      } catch (error) {
        return fail(error);
      }
    },
  );

  registerTool(
    "work_ledger_link_agent",
    {
      title: "Link an agent to a work ledger item",
      description:
        `${DESCRIPTION_PREFIX}Links another agent session to an item, or records a candidate link. ` +
        "Candidate links appear in the UI as unverified suggestions; only tools or people confirm links.",
      inputSchema: {
        item: ITEM_REFERENCE,
        agentId: z.string().trim().min(1),
        role: WorkLedgerAgentRoleSchema.optional(),
        reason: z.string().trim().optional().describe("Why this agent belongs to the item."),
        state: z.enum(["confirmed", "candidate"]).optional(),
        label: z.string().trim().optional(),
      },
    },
    async (input: {
      item: string;
      agentId: string;
      role?: "executor" | "monitor" | "verifier";
      reason?: string;
      state?: "confirmed" | "candidate";
      label?: string;
    }) => {
      try {
        const item = await requireItem(input.item);
        const updated = await service.linkAgent({
          itemId: item.id,
          agentId: input.agentId,
          role: input.role ?? "executor",
          state: input.state ?? "confirmed",
          source: input.state === "candidate" ? "inferred" : "tool",
          reason: input.reason ?? null,
          label: input.label ?? null,
          linkedBy: callerAgentId ?? null,
        });
        return ok({ item: summarizeItem(updated) });
      } catch (error) {
        return fail(error);
      }
    },
  );

  if (!options.searchAgentIds) return;
  const searchAgentIds = options.searchAgentIds;
  registerTool(
    "work_ledger_find_agent_candidates",
    {
      title: "Find agent candidates for a work ledger item",
      description:
        `${DESCRIPTION_PREFIX}Lists active agents whose id contains a hint, so you can propose a ` +
        "candidate link. Reason about the match before linking: a shared keyword is not evidence that " +
        "the agent worked on the item.",
      inputSchema: {
        item: ITEM_REFERENCE,
        hint: z.string().trim().min(1).describe("Part of the agent id, or a keyword to search."),
      },
    },
    async (input: { item: string; hint: string }) => {
      try {
        const item = await requireItem(input.item);
        const linked = new Set(item.agents.map((link) => link.agentId));
        const matches = (await searchAgentIds(input.hint))
          .filter((agentId) => !linked.has(agentId))
          .slice(0, 20);
        return ok({
          itemNumber: item.number,
          candidates: matches,
          note: "Candidates only. Confirm a link with work_ledger_link_agent after you have read the session.",
        });
      } catch (error) {
        return fail(error);
      }
    },
  );
}
