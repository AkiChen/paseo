import { describe, expect, it } from "vitest";
import { resolveSidebarPeekEnabled } from "./use-sidebar-peek";

/**
 * The hover peek slides the hidden app sidebar in from the window edge, so it has to
 * exist wherever the sidebar could otherwise be shown and nowhere else.
 *
 * `_layout` passes `mounted: mounted && routeAllowsSidebar`, which separates the two
 * ways a sidebar can be absent:
 *
 * - the user collapsed it on a normal route → peek must work
 * - the route renders no sidebar chrome (settings, welcome) → peek must not
 */
describe("resolveSidebarPeekEnabled route gating", () => {
  const desktop = { isWeb: true, isCompactLayout: false };

  it("enables the peek for a sidebar the user collapsed on a normal route", () => {
    // A collapsed sidebar: `visible` is false but the route allows one.
    expect(resolveSidebarPeekEnabled({ ...desktop, mounted: true, active: false })).toBe(true);
  });

  it("disables the peek on a route that renders no sidebar chrome", () => {
    // Settings and welcome: `routeAllowsSidebar` is false, so `mounted` reaches here
    // false even though the latch kept the sidebar's DOM around.
    expect(resolveSidebarPeekEnabled({ ...desktop, mounted: false, active: false })).toBe(false);
  });

  it("is disabled while the sidebar is pinned open", () => {
    expect(resolveSidebarPeekEnabled({ ...desktop, mounted: true, active: true })).toBe(false);
  });
});
