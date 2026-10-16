import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";
import { buildTurnProcessLabel, type TurnProcessCounts } from "./model";

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

function counts(options: Partial<TurnProcessCounts> = {}): TurnProcessCounts {
  return { toolCalls: 0, subAgents: 0, live: false, running: false, ...options };
}

describe("buildTurnProcessLabel", () => {
  it("says the turn thought when it ran nothing countable", () => {
    const { t, calls } = recordingT();

    expect(buildTurnProcessLabel(t, counts())).toBe("agentStream.turnProcess.thought");
    expect(calls.map((call) => call.key)).toEqual(["agentStream.turnProcess.thought"]);
  });

  it("counts a single tool call in the singular", () => {
    const { t, calls } = recordingT();

    buildTurnProcessLabel(t, counts({ toolCalls: 1 }));

    expect(calls).toEqual([{ key: "agentStream.turnProcess.toolCalls.one", count: 1 }]);
  });

  it("counts several tool calls in the plural", () => {
    const { t, calls } = recordingT();

    buildTurnProcessLabel(t, counts({ toolCalls: 4 }));

    expect(calls).toEqual([{ key: "agentStream.turnProcess.toolCalls.other", count: 4 }]);
  });

  it("prefers subagent delegations over tool calls", () => {
    const { t, calls } = recordingT();

    buildTurnProcessLabel(t, counts({ toolCalls: 5, subAgents: 2 }));

    expect(calls.map((call) => call.key)).toEqual(["agentStream.turnProcess.subAgents.other"]);
    expect(calls[0]?.count).toBe(2);
  });

  // A live control row reports activity, so the reader never reads a running
  // turn as a finished total.
  it("reports running tools while a call is still executing", () => {
    const { t, calls } = recordingT();

    expect(buildTurnProcessLabel(t, counts({ toolCalls: 3, live: true, running: true }))).toBe(
      "agentStream.turnProcess.running",
    );
    expect(calls).toEqual([{ key: "agentStream.turnProcess.running" }]);
  });

  it("reports thinking while a live run holds no executing call", () => {
    const { t, calls } = recordingT();

    expect(buildTurnProcessLabel(t, counts({ live: true }))).toBe(
      "agentStream.turnProcess.thinking",
    );
    expect(calls).toEqual([{ key: "agentStream.turnProcess.thinking" }]);
  });
});
