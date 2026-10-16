import type { TFunction } from "i18next";
import { describeToolCall } from "@/tool-calls/detail-level/grouping";
import type { StreamItem, ToolCallItem } from "@/types/stream";

function pluralKey(count: number): "one" | "other" {
  return count === 1 ? "one" : "other";
}

/**
 * What the control reports. A range that has finished reports the work it hid;
 * the range a running turn is still inside reports what is happening now, so the
 * row never claims a total the reader cannot act on.
 */
export interface TurnProcessCounts {
  toolCalls: number;
  subAgents: number;
  /** The turn is still running and this is the range it is inside. */
  live: boolean;
  /** A call in this range is still executing. */
  running: boolean;
}

/**
 * The control row's label: activity while the turn runs, a total once it ends.
 * Tool calls and subagents are mutually exclusive in the total because a
 * delegation already accounts for the work inside it.
 */
export function buildTurnProcessLabel(t: TFunction, counts: TurnProcessCounts): string {
  if (counts.live) {
    return counts.running
      ? t("agentStream.turnProcess.running")
      : t("agentStream.turnProcess.thinking");
  }
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
 * Folds a turn's process rows — reasoning and tool calls — behind one control
 * row per run. Replies are never folded: an assistant row is a written answer or
 * a note the reader is meant to keep, and it also ends the run of process rows
 * it interrupts. Everything else in the turn (a prompt, a notification, a todo
 * row) keeps its place, so the reader never loses a prompt or an error behind a
 * control row.
 *
 * The fold replaces a run with a host row in the list when it is collapsed, and
 * puts the members back as their own rows when it is expanded, so the transcript
 * keeps one flat virtualized list either way.
 */
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
   * Whether this list may fold the turn that is still running. The settled tail
   * folds the run in progress; the streaming head keeps its rows, so the live
   * assistant text is never replaced by a control row.
   */
  foldActiveTurn?: boolean;
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

interface TurnProcessSegment {
  /** Index in the turn's items of the first member. */
  start: number;
  /** Index one past the last member. */
  end: number;
  fold: TurnProcessFold;
}

export function foldTurnProcesses(input: FoldTurnProcessesInput): FoldTurnProcessesResult {
  const foldsByHostId = new Map<string, TurnProcessFold>();
  if (!canFoldTurnProcess(input.provider)) {
    return { items: input.items, foldsByHostId };
  }
  const foldActiveTurn = input.foldActiveTurn ?? false;
  const output: StreamItem[] = [];
  let folded = false;
  let index = 0;

  while (index < input.items.length) {
    const item = input.items[index];
    if (item === undefined) {
      index += 1;
      continue;
    }
    const turnId = item.turnId;
    const live = turnId !== undefined && turnId === input.activeTurnId;
    if (turnId === undefined || (live && !foldActiveTurn)) {
      output.push(item);
      index += 1;
      continue;
    }
    let end = index + 1;
    while (end < input.items.length && input.items[end]?.turnId === turnId) {
      end += 1;
    }
    const run = input.items.slice(index, end);
    const segments = buildTurnProcessSegments({
      run,
      turnId,
      live,
      ...(input.toolCallsIn ? { toolCallsIn: input.toolCallsIn } : {}),
    });
    if (segments.length === 0) {
      output.push(...run);
      index = end;
      continue;
    }
    folded = true;
    const segmentsByStart = new Map(segments.map((segment) => [segment.start, segment]));
    for (let runIndex = 0; runIndex < run.length; ) {
      const segment = segmentsByStart.get(runIndex);
      if (segment === undefined) {
        output.push(run[runIndex]!);
        runIndex += 1;
        continue;
      }
      output.push(segment.fold.host);
      if (input.expandedFoldIds.has(segment.fold.host.id)) {
        output.push(...segment.fold.members);
      }
      foldsByHostId.set(segment.fold.host.id, segment.fold);
      runIndex = segment.end;
    }
    index = end;
  }

  return { items: folded ? output : input.items, foldsByHostId };
}

/**
 * One segment per maximal run of process rows in the turn. A turn keeps as many
 * control rows as it wrote runs: a reply ends the run above it, and the run the
 * turn is still inside is the one that tracks it live.
 */
function buildTurnProcessSegments(input: {
  run: StreamItem[];
  turnId: string;
  live: boolean;
  toolCallsIn?: (item: ToolCallItem) => readonly ToolCallItem[];
}): TurnProcessSegment[] {
  const segments: TurnProcessSegment[] = [];
  let start = -1;
  for (let index = 0; index <= input.run.length; index += 1) {
    const item = input.run[index];
    if (item !== undefined && isTurnProcessRow(item)) {
      if (start < 0) start = index;
      continue;
    }
    if (start < 0) continue;
    const members = input.run.slice(start, index);
    const host = members[0];
    if (host !== undefined) {
      segments.push({
        start,
        end: index,
        fold: {
          host: { ...host, id: turnProcessFoldHostId(host.id) },
          turnId: input.turnId,
          members,
          counts: countProcessRows(
            members,
            input.live && index >= input.run.length,
            input.toolCallsIn,
          ),
        },
      });
    }
    start = -1;
  }
  return segments;
}

function countProcessRows(
  members: readonly StreamItem[],
  live: boolean,
  toolCallsIn?: (item: ToolCallItem) => readonly ToolCallItem[],
): TurnProcessCounts {
  const counts: TurnProcessCounts = { toolCalls: 0, subAgents: 0, live, running: false };
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
      const status = describeToolCall(call).status;
      if (status === "running" || status === "executing") {
        counts.running = true;
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
