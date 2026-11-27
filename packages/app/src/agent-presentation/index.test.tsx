// @vitest-environment jsdom
import { act, cleanup, renderHook } from "@testing-library/react";
import { Bot } from "lucide-react-native";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { I18nextProvider } from "react-i18next";
import { ChatGptIcon } from "@/components/icons/chatgpt-icon";
import { DeepSeekIcon } from "@/components/icons/deepseek-icon";
import { MoonshotIcon } from "@/components/icons/moonshot-icon";
import { CodexIcon } from "@/components/icons/codex-icon";
import { i18n } from "@/i18n/i18next";
import { useSessionStore, type Agent } from "@/stores/session-store";
import { useAgentDescriptor } from "./index";

const SERVER = "server-a";

function makeAgent(overrides: Partial<Agent> = {}): Agent {
  return {
    serverId: SERVER,
    id: "agent-1",
    provider: "dsh",
    status: "idle",
    createdAt: new Date("2026-04-01T03:00:00.000Z"),
    updatedAt: new Date("2026-04-01T03:00:00.000Z"),
    lastUserMessageAt: null,
    lastActivityAt: new Date("2026-04-01T03:00:00.000Z"),
    capabilities: {
      supportsStreaming: true,
      supportsSessionPersistence: true,
      supportsDynamicModes: true,
      supportsMcpServers: true,
      supportsReasoningStream: true,
      supportsToolInvocations: true,
    },
    currentModeId: null,
    availableModes: [],
    pendingPermissions: [],
    persistence: null,
    title: "Adapt Genrobot",
    cwd: "/repo",
    model: null,
    parentAgentId: null,
    labels: {},
    archivedAt: null,
    ...overrides,
    turn: overrides.turn ?? { phase: "idle", cancellationRequestId: null },
  };
}

function seedAgent(agent: Agent) {
  act(() => {
    const store = useSessionStore.getState();
    store.initializeSession(SERVER, null, 0);
    store.setAgents(SERVER, new Map([[agent.id, agent]]));
  });
}

/** What a `model_changed` event does to the store: runtimeInfo carries the live model. */
function switchModel(agentId: string, model: string) {
  useSessionStore.getState().setAgents(SERVER, (agents) => {
    const next = new Map(agents);
    const agent = agents.get(agentId) as Agent;
    next.set(agentId, {
      ...agent,
      runtimeInfo: { provider: agent.provider, sessionId: null, model },
    });
    return next;
  });
}

function renderDescriptor(agentId = "agent-1") {
  return renderHook(() => useAgentDescriptor({ kind: "agent", agentId }, { serverId: SERVER }), {
    wrapper: ({ children }) => <I18nextProvider i18n={i18n}>{children}</I18nextProvider>,
  });
}

beforeEach(() => {
  useSessionStore.setState((state) => ({ ...state, sessions: {} }));
});

afterEach(cleanup);

describe("useAgentDescriptor", () => {
  it("draws the glyph of the model the agent runs, not its harness", () => {
    seedAgent(makeAgent({ model: "deepseek-chat" }));
    expect(renderDescriptor().result.current.icon).toBe(DeepSeekIcon);
  });

  it("prefers the live runtime model over the snapshot field", () => {
    seedAgent(
      makeAgent({
        model: "deepseek-chat",
        runtimeInfo: { provider: "dsh", sessionId: null, model: "morphic/kimi-k3" },
      }),
    );
    expect(renderDescriptor().result.current.icon).toBe(MoonshotIcon);
  });

  it("follows the model when the agent switches it", () => {
    seedAgent(makeAgent({ model: "deepseek-chat" }));
    const { result } = renderDescriptor();
    expect(result.current.icon).toBe(DeepSeekIcon);

    act(() => switchModel("agent-1", "gpt-6.1-sol"));

    expect(result.current.icon).toBe(ChatGptIcon);
  });

  it("keeps the registered provider mark for a provider that brands its own models", () => {
    seedAgent(makeAgent({ provider: "codex", model: "gpt-5-codex" }));
    expect(renderDescriptor().result.current.icon).toBe(CodexIcon);
  });

  it("falls back to the robot for a model no family names", () => {
    seedAgent(makeAgent({ model: "router-model-261024" }));
    expect(renderDescriptor().result.current.icon).toBe(Bot);
  });
});
