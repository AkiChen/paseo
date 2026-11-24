/**
 * @vitest-environment jsdom
 */
import React from "react";
import { render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { formatEstimatedCost, SidebarAgentUsage } from "@/components/sidebar/sidebar-agent-usage";

const { theme } = vi.hoisted(() => ({
  theme: {
    spacing: { 1: 4 },
    fontSize: { sm: 13 },
    borderRadius: { sm: 2 },
    colors: {
      foreground: "#fff",
      foregroundMuted: "#aaa",
      foregroundExtraMuted: "#666",
      surface2: "#222",
    },
  },
}));

vi.mock("react-native-unistyles", () => ({
  StyleSheet: {
    create: (factory: unknown) => (typeof factory === "function" ? factory(theme) : factory),
  },
}));

vi.mock("react-i18next", () => ({
  useTranslation: () => ({
    t: (key: string, values?: Record<string, unknown>) => `${key}:${JSON.stringify(values)}`,
  }),
}));

const USAGE = {
  sessionUncachedInputTokens: 1_000,
  sessionCacheReadTokens: 9_000_000,
  sessionCacheWriteTokens: 0,
  sessionOutputTokens: 500,
  sessionUsageByModel: {
    "kimi-k3-1-pro-261024": {
      uncachedInputTokens: 1_000,
      cacheReadTokens: 9_000_000,
      cacheWriteTokens: 0,
      outputTokens: 500,
    },
  },
};

const TURN_ONLY_USAGE = { inputTokens: 10, outputTokens: 2 };
/** Session totals on a model the price table does not cover. */
const UNPRICED_USAGE = {
  sessionUncachedInputTokens: 1_000,
  sessionCacheReadTokens: 0,
  sessionOutputTokens: 500,
};

describe("formatEstimatedCost", () => {
  it("prints the figure bare, never repeating the dollar sign", () => {
    expect(formatEstimatedCost(0.72).display).toBe("0.72");
    expect(formatEstimatedCost(0.72).spoken).toBe("≈ $0.72");
  });

  it("collapses a sub-cent estimate instead of printing zero", () => {
    expect(formatEstimatedCost(0.003).display).toBe("<0.01");
    expect(formatEstimatedCost(0.003).spoken).toBe("≈ <$0.01");
  });

  it("drops a decimal once the figure is a dollar or more", () => {
    expect(formatEstimatedCost(1.44).display).toBe("1.4");
    expect(formatEstimatedCost(132.4).display).toBe("132");
  });
});

describe("SidebarAgentUsage", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("leads with money, then the token count", () => {
    const { getByTestId } = render(
      <SidebarAgentUsage
        usage={USAGE}
        model='["morphic-kimi","kimi-k3-1-pro-261024"]'
        testID="pill"
      />,
    );
    const text = getByTestId("pill").textContent;
    expect(text).toContain("💲");
    expect(text).toContain("/");
    expect(text.indexOf("💲")).toBeLessThan(text.indexOf("🔹"));
    expect(text).not.toContain("$");
  });

  it("prints only the token count when no model price applies", () => {
    const { getByTestId } = render(
      <SidebarAgentUsage usage={UNPRICED_USAGE} model='["morphic","gpt-6-sol"]' testID="pill" />,
    );
    const text = getByTestId("pill").textContent;
    expect(text).toContain("🔹");
    expect(text).not.toContain("💲");
  });

  it("renders nothing for a provider without session totals", () => {
    const { container } = render(
      <SidebarAgentUsage usage={TURN_ONLY_USAGE} model="claude-x" testID="pill" />,
    );
    expect(container.querySelector('[data-testid="pill"]')).toBeNull();
  });
});
