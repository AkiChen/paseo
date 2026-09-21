import type { TFunction } from "i18next";
import type { StreamItem, ToolCallItem } from "@/types/stream";

function pluralKey(count: number): "one" | "other" {
  return count === 1 ? "one" : "other";
}

/**
 * What the control reports: the tool calls or subagent delegations the turned
 * hid. A turn that only thought shows the thought label. Tool calls and
 * subagents are mutually exclusive because a delegation already accounts for the
 * work inside it.
 */
export function buildTurnProcessLabel(t: TFunction, counts: TurnProcessCounts): string {
  if (counts.subAgents > 0) {
    return t(`agentStream.turnProcess.subAgents.${pluralKey(counts.subAgents)}`, {
      count: counts.subAgents,
    });
  }
  if (counts.toolCalls > 0) {
    return t(`agentStream.turnProcess.toolCalls.${pluralKey(counts.toolCalls)}`, {
      count: counts.toolCalls,
    });
  }
  return t("agentStream.turnProcess.thought");
}

/**
 * Folds a finished turn's process rows — reasoning and tool calls — behind one
 * control row. Replies are never folded: an assistant row is a written answer or
 * a note the reader is meant to keep, and it also ends the run of process rows
 * it interrupts. The turn's final answer stays visible, and a turn that is still
 * running is never folded.
 *
 * The fold replaces the members with a host row in the list when it is
 * collapsed, and puts the members back as their own rows when it is expanded, so
 * the transcript keeps one flat virtualized list either way.
 */
export interface TurnProcessCounts {
  toolCalls: number;
  subAgents: number;
}

export interface TurnProcessFold {
  /** Control row. Its id is derived so the members can stay separate rows. */
  host: StreamItem;
  turnId: string;
  members: StreamItem[];
  counts: TurnProcessCounts;
}

/**
 * Only agents that produce a wall of reasoning and tool rows between their
 * answers get a fold. Providers whose transcript reads fine unfolded keep every
 * row they wrote.
 */
const FOLDING_PROVIDERS = new Set(["dsh"]);

export function canFoldTurnProcess(provider: string | undefined): boolean {
  return provider !== undefined && FOLDING_PROVIDERS.has(provider);
}

/** Rows the control owns. Anything else in the turn stays where the reader saw it. */
const PROCESS_ROW_KINDS = new Set<StreamItem["kind"]>(["thought", "tool_call"]);

export function isTurnProcessRow(item: StreamItem): boolean {
  return PROCESS_ROW_KINDS.has(item.kind);
}

export interface FoldTurnProcessesInput {
  items: StreamItem[];
  provider: string | undefined;
  activeTurnId: string | null;
  expandedFoldIds: ReadonlySet<string>;
  /**
   * A grouped run of tool calls is a single row, so the counts need the calls
   * behind it. Defaults to the row itself.
   */
  toolCallsIn?: (item: ToolCallItem) => readonly ToolCallItem[];
}

export interface FoldTurnProcessesResult {
  items: StreamItem[];
  foldsByHostId: Map<string, TurnProcessFold>;
}

const FOLD_ID_SUFFIX = "~turn-process";

export function turnProcessFoldHostId(memberId: string): string {
  return `${memberId}${FOLD_ID_SUFFIX}`;
}

export function foldTurnProcesses(input: FoldTurnProcessesInput): FoldTurnProcessesResult {
  const foldsByHostId = new Map<string, TurnProcessFold>();
  if (!canFoldTurnProcess(input.provider)) {
    return { items: input.items, foldsByHostId };
  }
  const output: StreamItem[] = [];
  let folded = false;
  let index = 0;

  while (index < input.items.length) {
    const item = input.items[index];
    if (!item) {
      index += 1;
      continue;
    }
    const turnId = item.turnId;
    if (turnId === undefined || turnId === input.activeTurnId) {
      output.push(item);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < input.items.length && input.items[end]?.turnId === turnId) {
      end += 1;
    }
    const run = input.items.slice(index, end);
    const built = buildTurnProcessFold({
      run,
      turnId,
      ...(input.toolCallsIn ? { toolCallsIn: input.toolCallsIn } : {}),
    });
    if (!built) {
      output.push(...run);
      index = end;
      continue;
    }
    const { memberStart, ...fold } = built;
    folded = true;
    output.push(...run.slice(0, memberStart));
    output.push(fold.host);
    if (input.expandedFoldIds.has(fold.host.id)) {
      output.push(...fold.members);
    }
    output.push(...run.slice(memberStart + fold.members.length));
    foldsByHostId.set(fold.host.id, fold);
    index = end;
  }

  return { items: folded ? output : input.items, foldsByHostId };
}

function buildTurnProcessFold(input: {
  run: StreamItem[];
  turnId: string;
  toolCallsIn?: (item: ToolCallItem) => readonly ToolCallItem[];
}): (TurnProcessFold & { memberStart: number }) | null {
  const bodyIndex = findFinalBodyIndex(input.run);
  if (bodyIndex <= 0) {
    return null;
  }
  // Only the block of process rows directly in front of the answer folds. A user
  // message, notification, or todo row inside the turn keeps its place, so the
  // reader never loses a prompt or an error behind the control.
  let memberStart = bodyIndex;
  while (memberStart > 0 && isTurnProcessRow(input.run[memberStart - 1]!)) {
    memberStart -= 1;
  }
  const members = input.run.slice(memberStart, bodyIndex);
  const host = members[0];
  if (!host) {
    return null;
  }
  return {
    host: { ...host, id: turnProcessFoldHostId(host.id) },
    turnId: input.turnId,
    members,
    memberStart,
    counts: countProcessRows(members, input.toolCallsIn),
  };
}

/**
 * The last assistant message with text is the turn's answer. A turn whose
 * closing step still runs tools has no answer yet, so it keeps all of its
 * process rows on screen — the same rule the DSH client states for a turn with
 * no final body.
 */
function findFinalBodyIndex(run: readonly StreamItem[]): number {
  let bodyIndex = -1;
  for (let index = run.length - 1; index >= 0; index -= 1) {
    const item = run[index];
    if (item?.kind === "assistant_message" && item.text.trim().length > 0) {
      bodyIndex = index;
      break;
    }
  }
  if (bodyIndex < 0) {
    return -1;
  }
  const closesWithWork = run
    .slice(bodyIndex + 1)
    .some((item) => item.kind === "tool_call" || item.kind === "thought");
  return closesWithWork ? -1 : bodyIndex;
}

function countProcessRows(
  members: readonly StreamItem[],
  toolCallsIn?: (item: ToolCallItem) => readonly ToolCallItem[],
): TurnProcessCounts {
  const counts: TurnProcessCounts = { toolCalls: 0, subAgents: 0 };
  for (const item of members) {
    if (item.kind !== "tool_call") {
      continue;
    }
    const calls = toolCallsIn?.(item) ?? [item];
    for (const call of calls) {
      if (isSubAgentCall(call)) {
        counts.subAgents += 1;
      } else {
        counts.toolCalls += 1;
      }
    }
  }
  return counts;
}

const SUB_AGENT_TOOL_NAME_PATTERN = /(?:^|[_\s-])(?:subagent|sub_agent|task)(?:[_\s-]|$)/;

function isSubAgentCall(call: ToolCallItem): boolean {
  if (call.payload.source !== "agent") {
    return false;
  }
  if (call.payload.data.detail.type === "sub_agent") {
    return true;
  }
  return SUB_AGENT_TOOL_NAME_PATTERN.test(call.payload.data.name.trim().toLowerCase());
}
