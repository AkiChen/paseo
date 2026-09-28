import { describe, expect, it } from "vitest";
import { resolveCloseAgentTabPolicy } from "./close-tab-policy";

describe("resolveCloseAgentTabPolicy", () => {
  // Closing a tab is layout only, so nothing about the agent changes the
  // outcome, and closing one never archives the session.
  it("reports a layout-only close for a top-level agent", () => {
    expect(resolveCloseAgentTabPolicy({ parentAgentId: null })).toEqual({ kind: "layout-only" });
  });

  it("reports a layout-only close for a child agent", () => {
    expect(resolveCloseAgentTabPolicy({ parentAgentId: "parent-agent" })).toEqual({
      kind: "layout-only",
    });
  });

  it("reports a layout-only close when the agent is not loaded", () => {
    expect(resolveCloseAgentTabPolicy(null)).toEqual({ kind: "layout-only" });
    expect(resolveCloseAgentTabPolicy(undefined)).toEqual({ kind: "layout-only" });
  });
});
