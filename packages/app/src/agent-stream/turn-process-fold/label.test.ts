import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { buildTurnProcessLabel } from "./model";

// Records the key and count it was asked for, so the assertions cover the key
// path and the plural selection rather than a translated string.
function recordingT(): { t: TFunction; calls: Array<{ key: string; count?: number }> } {
  const calls: Array<{ key: string; count?: number }> = [];
  const t = ((key: string, options?: { count?: number }) => {
    calls.push({ key, ...(options?.count !== undefined ? { count: options.count } : {}) });
    return key;
  }) as unknown as TFunction;
  return { t, calls };
}

describe("buildTurnProcessLabel", () => {
  it("says the turn thought when it ran nothing countable", () => {
    const { t, calls } = recordingT();

    expect(buildTurnProcessLabel(t, { toolCalls: 0, replies: 0, subAgents: 0 })).toBe(
      "agentStream.turnProcess.thought",
    );
    expect(calls.map((call) => call.key)).toEqual(["agentStream.turnProcess.thought"]);
  });

  it("counts a single tool call in the singular", () => {
    const { t, calls } = recordingT();

    buildTurnProcessLabel(t, { toolCalls: 1, replies: 0, subAgents: 0 });

    expect(calls).toEqual([{ key: "agentStream.turnProcess.toolCalls.one", count: 1 }]);
  });

  it("joins the work and the replies", () => {
    const { t, calls } = recordingT();

    const label = buildTurnProcessLabel(t, { toolCalls: 4, replies: 1, subAgents: 0 });

    expect(calls.map((call) => call.key)).toEqual([
      "agentStream.turnProcess.toolCalls.other",
      "agentStream.turnProcess.replies.one",
      "agentStream.turnProcess.separator",
    ]);
    expect(label).toContain("agentStream.turnProcess.toolCalls.other");
    expect(label).toContain("agentStream.turnProcess.replies.one");
  });

  it("prefers subagent delegations over tool calls", () => {
    const { t, calls } = recordingT();

    buildTurnProcessLabel(t, { toolCalls: 5, replies: 0, subAgents: 2 });

    expect(calls.map((call) => call.key)).toEqual(["agentStream.turnProcess.subAgents.other"]);
    expect(calls[0]?.count).toBe(2);
  });
});
