/**
 * @vitest-environment jsdom
 */
import React from "react";
import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  isSidebarPeekHotspotPoint,
  resolveSidebarPeekEnabled,
  resolveSidebarPeekTriggerWidth,
  SIDEBAR_PEEK_CLOSE_DELAY_MS,
  SIDEBAR_PEEK_EXIT_MOUNT_MS,
  SIDEBAR_PEEK_MIN_TRIGGER_WIDTH,
  SIDEBAR_PEEK_OPEN_DELAY_MS,
  SIDEBAR_PEEK_TOP_EXCLUSION_HEIGHT,
  useSidebarPeek,
} from "./use-sidebar-peek";

const TRIGGER_WIDTH = 200;

beforeEach(() => {
  vi.useFakeTimers();
  vi.stubGlobal("React", React);
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

function movePointer(clientX: number, clientY = 100): void {
  act(() => {
    window.dispatchEvent(new window.MouseEvent("pointermove", { clientX, clientY }));
  });
}

function renderPeek(enabled = true) {
  return renderHook(() => useSidebarPeek({ enabled, triggerWidth: TRIGGER_WIDTH }));
}

function openPeek(): void {
  movePointer(TRIGGER_WIDTH / 2);
  act(() => vi.advanceTimersByTime(SIDEBAR_PEEK_OPEN_DELAY_MS));
}

describe("isSidebarPeekHotspotPoint", () => {
  it("starts below the title and workspace tab rows", () => {
    expect(
      isSidebarPeekHotspotPoint({
        clientX: 0,
        clientY: SIDEBAR_PEEK_TOP_EXCLUSION_HEIGHT,
        triggerWidth: TRIGGER_WIDTH,
      }),
    ).toBe(true);
    expect(
      isSidebarPeekHotspotPoint({
        clientX: TRIGGER_WIDTH,
        clientY: 500,
        triggerWidth: TRIGGER_WIDTH,
      }),
    ).toBe(true);
    expect(
      isSidebarPeekHotspotPoint({
        clientX: TRIGGER_WIDTH + 1,
        clientY: 500,
        triggerWidth: TRIGGER_WIDTH,
      }),
    ).toBe(false);
    expect(
      isSidebarPeekHotspotPoint({
        clientX: -1,
        clientY: 500,
        triggerWidth: TRIGGER_WIDTH,
      }),
    ).toBe(false);
    expect(
      isSidebarPeekHotspotPoint({
        clientX: 50,
        clientY: SIDEBAR_PEEK_TOP_EXCLUSION_HEIGHT - 1,
        triggerWidth: TRIGGER_WIDTH,
      }),
    ).toBe(false);
  });
});

describe("resolveSidebarPeekTriggerWidth", () => {
  it("ends the hotspot at the dialog's left edge and shrinks with it", () => {
    expect(
      resolveSidebarPeekTriggerWidth({
        fallbackWidth: TRIGGER_WIDTH,
        chatColumnLeft: 180,
        panePresent: true,
      }),
    ).toBe(180);
    expect(
      resolveSidebarPeekTriggerWidth({
        fallbackWidth: TRIGGER_WIDTH,
        chatColumnLeft: 90,
        panePresent: true,
      }),
    ).toBe(90);
  });

  it("keeps a slim edge when the dialog fills the pane or the pane has no chat", () => {
    expect(
      resolveSidebarPeekTriggerWidth({
        fallbackWidth: TRIGGER_WIDTH,
        chatColumnLeft: 2,
        panePresent: true,
      }),
    ).toBe(SIDEBAR_PEEK_MIN_TRIGGER_WIDTH);
    expect(
      resolveSidebarPeekTriggerWidth({
        fallbackWidth: TRIGGER_WIDTH,
        chatColumnLeft: null,
        panePresent: true,
      }),
    ).toBe(SIDEBAR_PEEK_MIN_TRIGGER_WIDTH);
  });

  it("uses the sidebar width only when no workspace pane exists", () => {
    expect(
      resolveSidebarPeekTriggerWidth({
        fallbackWidth: TRIGGER_WIDTH,
        chatColumnLeft: null,
        panePresent: false,
      }),
    ).toBe(TRIGGER_WIDTH);
  });

  it("never grows wider than the sidebar itself", () => {
    expect(
      resolveSidebarPeekTriggerWidth({
        fallbackWidth: TRIGGER_WIDTH,
        chatColumnLeft: TRIGGER_WIDTH + 120,
        panePresent: true,
      }),
    ).toBe(TRIGGER_WIDTH);
    expect(
      resolveSidebarPeekTriggerWidth({
        fallbackWidth: TRIGGER_WIDTH,
        chatColumnLeft: TRIGGER_WIDTH,
        panePresent: true,
      }),
    ).toBe(TRIGGER_WIDTH);
  });
});

describe("resolveSidebarPeekEnabled", () => {
  const desktopHidden = {
    isWeb: true,
    isCompactLayout: false,
    mounted: true,
    active: false,
  };

  it("enables the peek only for a mounted, inactive desktop sidebar", () => {
    expect(resolveSidebarPeekEnabled(desktopHidden)).toBe(true);
    expect(resolveSidebarPeekEnabled({ ...desktopHidden, isWeb: false })).toBe(false);
    expect(resolveSidebarPeekEnabled({ ...desktopHidden, isCompactLayout: true })).toBe(false);
    expect(resolveSidebarPeekEnabled({ ...desktopHidden, mounted: false })).toBe(false);
    expect(resolveSidebarPeekEnabled({ ...desktopHidden, active: true })).toBe(false);
  });
});

describe("useSidebarPeek", () => {
  it("opens only after the pointer dwells anywhere in the sidebar footprint", () => {
    const { result } = renderPeek();

    movePointer(TRIGGER_WIDTH / 2);
    act(() => vi.advanceTimersByTime(SIDEBAR_PEEK_OPEN_DELAY_MS - 1));
    expect(result.current.open).toBe(false);

    act(() => vi.advanceTimersByTime(1));
    expect(result.current.open).toBe(true);
    expect(result.current.visible).toBe(true);
  });

  it("does not open while the pointer is over the title or tab rows", () => {
    const { result } = renderPeek();

    movePointer(TRIGGER_WIDTH / 2, SIDEBAR_PEEK_TOP_EXCLUSION_HEIGHT - 1);
    act(() => vi.advanceTimersByTime(SIDEBAR_PEEK_OPEN_DELAY_MS));

    expect(result.current.open).toBe(false);
  });

  it("cancels a pending open when the pointer crosses the footprint without stopping", () => {
    const { result } = renderPeek();

    movePointer(TRIGGER_WIDTH / 2);
    movePointer(TRIGGER_WIDTH + 1);
    act(() => vi.advanceTimersByTime(SIDEBAR_PEEK_OPEN_DELAY_MS));

    expect(result.current.open).toBe(false);
  });

  it("keeps the panel open while the pointer is on it and closes after the grace period", () => {
    const { result } = renderPeek();
    openPeek();

    act(() => result.current.onPanelLeave());
    act(() => vi.advanceTimersByTime(SIDEBAR_PEEK_CLOSE_DELAY_MS - 1));
    expect(result.current.open).toBe(true);

    act(() => result.current.onPanelEnter());
    act(() => vi.advanceTimersByTime(SIDEBAR_PEEK_CLOSE_DELAY_MS));
    expect(result.current.open).toBe(true);

    act(() => result.current.onPanelLeave());
    act(() => vi.advanceTimersByTime(SIDEBAR_PEEK_CLOSE_DELAY_MS));
    expect(result.current.open).toBe(false);
    // Still mounted for the exit animation.
    expect(result.current.visible).toBe(true);

    act(() => vi.advanceTimersByTime(SIDEBAR_PEEK_EXIT_MOUNT_MS));
    expect(result.current.visible).toBe(false);
  });

  it("closes an open peek when peeking becomes unavailable", () => {
    const { result, rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        useSidebarPeek({ enabled, triggerWidth: TRIGGER_WIDTH }),
      { initialProps: { enabled: true } },
    );
    openPeek();
    expect(result.current.open).toBe(true);

    rerender({ enabled: false });

    expect(result.current.open).toBe(false);
    expect(result.current.visible).toBe(false);
  });
});
