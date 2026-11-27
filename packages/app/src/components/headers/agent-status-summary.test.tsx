/**
 * @vitest-environment jsdom
 */
import React from "react";
import { createRoot, type Root } from "react-dom/client";
import { act } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { AggregatedAgent } from "@/hooks/use-aggregated-agents";

const { theme, mocks } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4, 2: 8 },
    fontSize: { sm: 13 },
    fontWeight: { medium: "500" },
    borderRadius: { md: 6 },
    colors: {
      foreground: "#fff",
      popoverForeground: "#fff",
      surfaceSidebarHover: "#222",
      statusDotWarning: "#f90",
      statusDotDanger: "#f44",
      statusDotSuccess: "#4f4",
      statusDotRunning: "#0af",
    },
  },
  mocks: {
    agents: [],
    agentListOpen: false,
    listMode: "workspaces",
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
  withUnistyles:
    (Component: React.ComponentType<Record<string, unknown>>) =>
    ({ uniProps, ...rest }: { uniProps?: (t: unknown) => Record<string, unknown> }) => {
      const themed = uniProps ? uniProps(theme) : {};
      return React.createElement(Component, { ...rest, ...themed });
    },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => `${key}:${values?.count ?? ""}`,
  }),
}));

vi.mock("@/components/ui/tooltip", () => {
  const passThrough = ({ children }: { children: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children);
  return {
    Tooltip: passThrough,
    TooltipTrigger: passThrough,
    TooltipContent: passThrough,
  };
});

// The real primitive sources the menu engine, which needs reanimated and cannot load in
// jsdom. This test is about what the summary counts and renders, so a plain button stands in
// for the chrome, hitbox and tooltip the primitive owns.
vi.mock("@/components/ui/pane-content-toolbar", () => ({
  ToolbarButton: ({
    children,
    label,
    testID,
    onPress,
  }: {
    children: React.ReactNode;
    label: string;
    testID?: string;
    onPress?: () => void;
  }) =>
    React.createElement(
      "button",
      { type: "button", "data-testid": testID, "aria-label": label, onClick: onPress },
      children,
    ),
}));

vi.mock("lucide-react-native", () => {
  const icon = (name: string) => {
    const Icon = (props: Record<string, unknown>) =>
      React.createElement("span", { ...props, "data-icon": name });
    Icon.displayName = name;
    return Icon;
  };
  return {
    CircleCheck: icon("CircleCheck"),
    CircleDot: icon("CircleDot"),
    CircleX: icon("CircleX"),
    MessageCircleWarning: icon("MessageCircleWarning"),
  };
});

vi.mock("@/hooks/use-aggregated-agents", () => ({
  useAggregatedAgents: () => ({ agents: mocks.agents }),
}));

vi.mock("@/stores/panel-store", () => ({
  usePanelStore: (
    selector: (state: {
      desktop: { agentListOpen: boolean };
      toggleDesktopAgentList: () => void;
    }) => unknown,
  ) =>
    selector({
      desktop: { agentListOpen: mocks.agentListOpen },
      toggleDesktopAgentList: () => {
        mocks.agentListOpen = !mocks.agentListOpen;
      },
    }),
}));

vi.mock("@/stores/sidebar-list-mode-store", () => ({
  useSidebarListModeStore: (selector: (state: { setMode: (mode: string) => void }) => unknown) =>
    selector({
      setMode: (mode: string) => {
        mocks.listMode = mode;
      },
    }),
}));

vi.stubGlobal("React", React);
vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);

import { AgentStatusSummary } from "./agent-status-summary";
import { TURN_LIVENESS_IDLE } from "@/timeline/turn-liveness";

/** The hoisted state cannot carry types, so every write goes through here. */
function setAgents(next: AggregatedAgent[]): void {
  (mocks as { agents: AggregatedAgent[] }).agents = next;
}

function createAgent(overrides: Partial<AggregatedAgent> = {}): AggregatedAgent {
  return {
    id: "agent-a",
    serverId: "host-a",
    serverLabel: "Host A",
    title: "Agent",
    status: "idle",
    turn: TURN_LIVENESS_IDLE,
    lastActivityAt: new Date("2026-10-01T12:00:00.000Z"),
    cwd: "/repo",
    workspaceId: "workspace-a",
    provider: "claude",
    requiresAttention: false,
    attentionReason: null,
    attentionTimestamp: null,
    archivedAt: null,
    createdAt: new Date("2026-10-01T10:00:00.000Z"),
    labels: {},
    parentAgentId: null,
    ...overrides,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount() {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root?.render(React.createElement(AgentStatusSummary));
  });
  return container;
}

beforeEach(() => {
  setAgents([]);
  mocks.agentListOpen = false;
  mocks.listMode = "workspaces";
});

afterEach(() => {
  act(() => {
    root?.unmount();
  });
  container?.remove();
  root = null;
  container = null;
});

describe("AgentStatusSummary", () => {
  it("stays out of the way when every agent is settled", () => {
    setAgents([createAgent({ status: "idle" }), createAgent({ id: "b", status: "idle" })]);
    const view = mount();
    expect(view.querySelector('[data-testid="agent-status-summary"]')).toBeNull();
  });

  it("lists the live buckets it will not keep quiet about", () => {
    setAgents([
      createAgent({ id: "permission", pendingPermissionCount: 1 }),
      createAgent({ id: "running", status: "running" }),
    ]);
    const view = mount();

    expect(view.querySelector('[data-testid="agent-status-summary"]')).not.toBeNull();
    expect(view.querySelector('[data-testid="agent-status-summary-waiting"]')).not.toBeNull();
    expect(view.querySelector('[data-testid="agent-status-summary-running"]')).not.toBeNull();
  });

  it("opens the sidebar on its Agents list when a count is pressed", () => {
    setAgents([createAgent({ id: "running", status: "running" })]);
    const view = mount();
    const pill = view.querySelector('[data-testid="agent-status-summary-running"]');
    expect(pill).not.toBeNull();

    act(() => {
      pill?.dispatchEvent(new window.MouseEvent("click", { bubbles: true }));
    });

    expect(mocks.listMode).toBe("agents");
    expect(mocks.agentListOpen).toBe(true);
  });
});
