import { describe, expect, it } from "vitest";
import type { ToolCallDetail } from "@getpaseo/protocol/agent-types";
import type { StreamItem, ToolCallItem } from "@/types/stream";
import { canFoldTurnProcess, foldTurnProcesses, turnProcessFoldHostId } from "./model";

const timestamp = new Date(0);

function thought(id: string, turnId: string, text = "weighing options"): StreamItem {
  return { kind: "thought", id, turnId, text, timestamp, status: "ready" };
}

function assistant(id: string, turnId: string, text: string): StreamItem {
  return { kind: "assistant_message", id, turnId, text, timestamp };
}

function toolCall(
  id: string,
  turnId: string,
  options: { detail?: ToolCallDetail; name?: string } = {},
): ToolCallItem {
  return {
    kind: "tool_call",
    id,
    turnId,
    timestamp,
    payload: {
      source: "agent",
      data: {
        provider: "claude",
        callId: id,
        name: options.name ?? "bash",
        status: "completed",
        error: null,
        detail: options.detail ?? { type: "shell", command: "npm test" },
      },
    },
  };
}

function fold(
  items: StreamItem[],
  options: {
    provider?: string | undefined;
    activeTurnId?: string | null;
    expandedFoldIds?: ReadonlySet<string>;
    toolCallsIn?: (item: ToolCallItem) => readonly ToolCallItem[];
  } = {},
) {
  return foldTurnProcesses({
    items,
    provider: "provider" in options ? options.provider : "dsh",
    activeTurnId: options.activeTurnId ?? null,
    expandedFoldIds: options.expandedFoldIds ?? new Set<string>(),
    ...(options.toolCallsIn ? { toolCallsIn: options.toolCallsIn } : {}),
  });
}

describe("canFoldTurnProcess", () => {
  it("folds only the agents that produce a wall of process rows", () => {
    expect(canFoldTurnProcess("dsh")).toBe(true);
    expect(canFoldTurnProcess("claude")).toBe(false);
    expect(canFoldTurnProcess("codex")).toBe(false);
    expect(canFoldTurnProcess(undefined)).toBe(false);
  });
});

describe("foldTurnProcesses", () => {
  it("replaces a finished turn's process rows with one control row", () => {
    const items = [
      thought("t1", "turn-1"),
      toolCall("c1", "turn-1"),
      assistant("a1", "turn-1", "Here is the answer."),
    ];

    const result = fold(items);

    expect(result.items.map((item) => item.id)).toEqual([turnProcessFoldHostId("t1"), "a1"]);
    expect(
      result.foldsByHostId.get(turnProcessFoldHostId("t1"))?.members.map((item) => item.id),
    ).toEqual(["t1", "c1"]);
  });

  it("leaves every provider that is not folded alone", () => {
    const items = [
      thought("t1", "turn-1"),
      toolCall("c1", "turn-1"),
      assistant("a1", "turn-1", "Here is the answer."),
    ];

    const result = fold(items, { provider: "claude" });

    expect(result.items).toBe(items);
    expect(result.foldsByHostId.size).toBe(0);
  });

  // A reply is written content the reader keeps: it is never a member, and it
  // ends the block of process rows in front of the answer.
  it("keeps every reply visible", () => {
    const items = [
      thought("t1", "turn-1"),
      toolCall("c1", "turn-1"),
      assistant("a1", "turn-1", "Interim note."),
      thought("t2", "turn-1"),
      toolCall("c2", "turn-1"),
      assistant("a2", "turn-1", "Here is the answer."),
    ];

    const result = fold(items);

    expect(result.items.map((item) => item.id)).toEqual([
      "t1",
      "c1",
      "a1",
      turnProcessFoldHostId("t2"),
      "a2",
    ]);
    expect(
      result.foldsByHostId.get(turnProcessFoldHostId("t2"))?.members.map((item) => item.id),
    ).toEqual(["t2", "c2"]);
  });

  it("counts tool calls and subagent delegations", () => {
    const items = [
      thought("t1", "turn-1"),
      assistant("a1", "turn-1", "Starting."),
      toolCall("c1", "turn-1"),
      toolCall("c2", "turn-1", { detail: { type: "read", filePath: "a.ts" } }),
      toolCall("c3", "turn-1", { detail: { type: "sub_agent", log: "" }, name: "task" }),
      assistant("a2", "turn-1", "Done."),
    ];

    const result = fold(items);
    const hostId = turnProcessFoldHostId("c1");
    const foldEntry = result.foldsByHostId.get(hostId);

    expect(foldEntry?.counts).toEqual({ toolCalls: 2, subAgents: 1 });
    // The interim reply is not a member, so the run in front of the answer
    // starts after it.
    expect(foldEntry?.members.map((item) => item.id)).toEqual(["c1", "c2", "c3"]);
  });

  it("counts the calls behind a grouped row", () => {
    const grouped = toolCall("group-1", "turn-1");
    const items = [thought("t1", "turn-1"), grouped, assistant("a1", "turn-1", "Done.")];

    const result = fold(items, {
      toolCallsIn: (item) => [
        toolCall(`${item.id}-a`, "turn-1"),
        toolCall(`${item.id}-b`, "turn-1", { detail: { type: "sub_agent", log: "" } }),
      ],
    });

    expect(result.foldsByHostId.get(turnProcessFoldHostId("t1"))?.counts).toEqual({
      toolCalls: 1,
      subAgents: 1,
    });
  });

  it("never folds the turn that is still running", () => {
    const items = [thought("t1", "turn-1"), assistant("a1", "turn-1", "Partial answer.")];

    const result = fold(items, { activeTurnId: "turn-1" });

    expect(result.items).toBe(items);
    expect(result.foldsByHostId.size).toBe(0);
  });

  it("keeps every process row when the turn has no final answer", () => {
    const items = [thought("t1", "turn-1"), toolCall("c1", "turn-1")];

    const result = fold(items);

    expect(result.items).toEqual(items);
    expect(result.foldsByHostId.size).toBe(0);
  });

  it("keeps a turn whose closing step still runs tools", () => {
    const items = [
      thought("t1", "turn-1"),
      assistant("a1", "turn-1", "Interim note."),
      toolCall("c1", "turn-1"),
    ];

    const result = fold(items);

    expect(result.items).toEqual(items);
    expect(result.foldsByHostId.size).toBe(0);
  });

  it("leaves a turn that is only a final answer alone", () => {
    const items = [assistant("a1", "turn-1", "Just the answer.")];

    const result = fold(items);

    expect(result.items).toEqual(items);
    expect(result.foldsByHostId.size).toBe(0);
  });

  it("puts the members back as their own rows when the fold is expanded", () => {
    const items = [
      thought("t1", "turn-1"),
      toolCall("c1", "turn-1"),
      assistant("a1", "turn-1", "Answer."),
    ];

    const result = fold(items, {
      expandedFoldIds: new Set([turnProcessFoldHostId("t1")]),
    });

    expect(result.items.map((item) => item.id)).toEqual([
      turnProcessFoldHostId("t1"),
      "t1",
      "c1",
      "a1",
    ]);
  });

  it("folds each finished turn independently and leaves rows without a turn alone", () => {
    const loose: StreamItem = {
      kind: "thought",
      id: "loose",
      text: "no turn",
      timestamp,
      status: "ready",
    };
    const items = [
      thought("t1", "turn-1"),
      assistant("a1", "turn-1", "First answer."),
      thought("t2", "turn-2"),
      assistant("a2", "turn-2", "Second answer."),
      loose,
    ];

    const result = fold(items);

    expect(result.items.map((item) => item.id)).toEqual([
      turnProcessFoldHostId("t1"),
      "a1",
      turnProcessFoldHostId("t2"),
      "a2",
      "loose",
    ]);
    expect(result.foldsByHostId.size).toBe(2);
  });

  it("keeps the user message and other non-process rows where the reader saw them", () => {
    const prompt: StreamItem = {
      kind: "user_message",
      id: "u1",
      turnId: "turn-1",
      text: "please fix it",
      timestamp,
    };
    const items = [
      prompt,
      thought("t1", "turn-1"),
      toolCall("c1", "turn-1"),
      assistant("a1", "turn-1", "Answer."),
    ];

    const result = fold(items);

    expect(result.items.map((item) => item.id)).toEqual(["u1", turnProcessFoldHostId("t1"), "a1"]);
    expect(
      result.foldsByHostId.get(turnProcessFoldHostId("t1"))?.members.map((item) => item.id),
    ).toEqual(["t1", "c1"]);
  });

  it("returns the same list when there is nothing to fold", () => {
    const items = [assistant("a1", "turn-1", "Answer.")];

    expect(fold(items).items).toBe(items);
  });

  // The stream folds two presentation lists and merges their host maps, so a
  // control row has to resolve whichever list it came from.
  it("resolves a control row from either presentation list", () => {
    const tail = fold([
      thought("t1", "turn-1"),
      toolCall("c1", "turn-1"),
      assistant("a1", "turn-1", "Answer."),
    ]);
    const head = fold([thought("h1", "turn-2"), assistant("h2", "turn-2", "Head answer.")]);
    const foldsByHostId = new Map([...tail.foldsByHostId, ...head.foldsByHostId]);

    expect(foldsByHostId.get(turnProcessFoldHostId("t1"))?.members.map((item) => item.id)).toEqual([
      "t1",
      "c1",
    ]);
    expect(foldsByHostId.get(turnProcessFoldHostId("h1"))?.members.map((item) => item.id)).toEqual([
      "h1",
    ]);
  });
});
