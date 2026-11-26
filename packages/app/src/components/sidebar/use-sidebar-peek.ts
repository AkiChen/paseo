import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { HEADER_INNER_HEIGHT, WORKSPACE_SECONDARY_HEADER_HEIGHT } from "@/constants/layout";
import { getTopOverlayLayer } from "@/keyboard";

// Dwell before the hidden sidebar floats out, and the grace period that keeps
// it from blinking when the pointer crosses the panel edge.
export const SIDEBAR_PEEK_OPEN_DELAY_MS = 250;
export const SIDEBAR_PEEK_CLOSE_DELAY_MS = 120;
// The panel stays mounted for the exit animation; these two durations are
// shared with the desktop sidebar's Reanimated style.
export const SIDEBAR_PEEK_ENTER_MS = 240;
export const SIDEBAR_PEEK_EXIT_MS = 150;
export const SIDEBAR_PEEK_EXIT_MOUNT_MS = 180;
// When the dialog fills its pane there is no gutter left; keep a slim edge so
// the sidebar is still discoverable.
export const SIDEBAR_PEEK_MIN_TRIGGER_WIDTH = 8;
// The title row and the workspace tab row own the pointer; the peek must not
// open while the pointer is over either of them.
export const SIDEBAR_PEEK_TOP_EXCLUSION_HEIGHT =
  HEADER_INNER_HEIGHT + WORKSPACE_SECONDARY_HEADER_HEIGHT.md;

export interface SidebarPeekControls {
  /** False on compact layouts and while the sidebar is pinned open. */
  enabled: boolean;
  /** True while the panel is interactive (opening, open, or waiting to close). */
  open: boolean;
  /** True while the panel is mounted, including its exit animation. */
  visible: boolean;
  onPanelEnter: () => void;
  onPanelLeave: () => void;
}

/** Hover needs a pointer device, and the edge affordance only exists on desktop. */
export function resolveSidebarPeekEnabled(input: {
  isWeb: boolean;
  isCompactLayout: boolean;
  mounted: boolean;
  active: boolean;
}): boolean {
  return input.isWeb && !input.isCompactLayout && input.mounted && !input.active;
}

/**
 * The hidden sidebar's hover target ends at the dialog's left edge. On a chat
 * workspace that is the measured left edge of the leftmost pane's composer
 * column, so narrowing the dialog narrows the hotspot with it.
 */
export function isSidebarPeekHotspotPoint(input: {
  clientX: number;
  clientY: number;
  triggerWidth: number;
}): boolean {
  return (
    input.clientX >= 0 &&
    input.clientX <= input.triggerWidth &&
    input.clientY >= SIDEBAR_PEEK_TOP_EXCLUSION_HEIGHT
  );
}

export function resolveSidebarPeekTriggerWidth(input: {
  fallbackWidth: number;
  chatColumnLeft: number | null;
  panePresent: boolean;
}): number {
  if (input.chatColumnLeft !== null) {
    // Follow the dialog inward, but never grow past the sidebar's own width.
    return Math.max(
      0,
      Math.min(input.fallbackWidth, Math.max(SIDEBAR_PEEK_MIN_TRIGGER_WIDTH, input.chatColumnLeft)),
    );
  }
  // A non-chat pane fills its frame, so only a slim edge remains. Screens with
  // no workspace panes keep the sidebar-width fallback.
  if (input.panePresent) {
    return Math.max(0, Math.min(input.fallbackWidth, SIDEBAR_PEEK_MIN_TRIGGER_WIDTH));
  }
  return Math.max(0, input.fallbackWidth);
}

function measureSidebarPeekTrigger(): {
  chatColumnLeft: number | null;
  panePresent: boolean;
} | null {
  if (typeof document === "undefined" || typeof window === "undefined") return null;

  const panes = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid^="workspace-pane-"]'),
  )
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter(
      ({ rect }) =>
        rect.width > 0 && rect.height > 0 && rect.left < window.innerWidth && rect.right > 0,
    );
  if (panes.length === 0) {
    return { chatColumnLeft: null, panePresent: false };
  }
  const leftPane = panes.reduce((left, pane) => (pane.rect.left < left.rect.left ? pane : left));
  const columnRects = Array.from(
    leftPane.element.querySelectorAll<HTMLElement>('[data-testid="agent-chat-column"]'),
  )
    .map((element) => element.getBoundingClientRect())
    .filter((rect) => rect.width > 0);
  if (columnRects.length === 0) {
    return { chatColumnLeft: null, panePresent: true };
  }
  return {
    chatColumnLeft: Math.min(...columnRects.map((rect) => rect.left)),
    panePresent: true,
  };
}

/**
 * Hover state machine for the hidden left sidebar.
 *
 * Pointer movement is tracked at the window instead of through an invisible
 * overlay: the hotspot can be hundreds of pixels wide, and a View that wide
 * would swallow clicks in the chat and composer under it. The panel itself
 * owns the close side through pointerenter/pointerleave.
 */
export function useSidebarPeek({
  enabled,
  triggerWidth,
}: {
  enabled: boolean;
  /** Used on screens without workspace panes, and until the first measurement. */
  triggerWidth: number;
}): SidebarPeekControls {
  const [open, setOpen] = useState(false);
  const [visible, setVisible] = useState(false);
  const openRef = useRef(open);
  openRef.current = open;
  const fallbackTriggerWidthRef = useRef(triggerWidth);
  fallbackTriggerWidthRef.current = triggerWidth;
  // Effective width: the sidebar-width fallback until a pane is measured.
  const triggerWidthRef = useRef(triggerWidth);
  const insideHotspotRef = useRef(false);
  const openTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const closeTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const exitTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearOpenTimer = useCallback(() => {
    if (openTimerRef.current !== null) {
      clearTimeout(openTimerRef.current);
      openTimerRef.current = null;
    }
  }, []);

  const clearCloseTimer = useCallback(() => {
    if (closeTimerRef.current !== null) {
      clearTimeout(closeTimerRef.current);
      closeTimerRef.current = null;
    }
  }, []);

  const clearExitTimer = useCallback(() => {
    if (exitTimerRef.current !== null) {
      clearTimeout(exitTimerRef.current);
      exitTimerRef.current = null;
    }
  }, []);

  const closePeek = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    clearExitTimer();
    setOpen(false);
    setVisible(false);
  }, [clearCloseTimer, clearExitTimer, clearOpenTimer]);

  // Keep the panel mounted while its exit animation runs. `open` already went
  // false, so the panel is inert but still painted.
  const beginClose = useCallback(() => {
    clearOpenTimer();
    clearCloseTimer();
    clearExitTimer();
    setOpen(false);
    exitTimerRef.current = setTimeout(() => {
      exitTimerRef.current = null;
      setVisible(false);
    }, SIDEBAR_PEEK_EXIT_MOUNT_MS);
  }, [clearCloseTimer, clearExitTimer, clearOpenTimer]);

  const scheduleOpen = useCallback(() => {
    if (!enabled || openRef.current) return;
    clearOpenTimer();
    clearCloseTimer();
    clearExitTimer();
    openTimerRef.current = setTimeout(() => {
      openTimerRef.current = null;
      setVisible(true);
      setOpen(true);
    }, SIDEBAR_PEEK_OPEN_DELAY_MS);
  }, [clearCloseTimer, clearExitTimer, clearOpenTimer, enabled]);

  const onPanelEnter = useCallback(() => {
    clearCloseTimer();
  }, [clearCloseTimer]);

  const onPanelLeave = useCallback(() => {
    if (!enabled) return;
    clearOpenTimer();
    clearCloseTimer();
    closeTimerRef.current = setTimeout(() => {
      closeTimerRef.current = null;
      beginClose();
    }, SIDEBAR_PEEK_CLOSE_DELAY_MS);
  }, [beginClose, clearCloseTimer, clearOpenTimer, enabled]);

  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof document === "undefined") {
      insideHotspotRef.current = false;
      return () => {};
    }

    const handlePointerMove = (event: PointerEvent) => {
      if (openRef.current) return;
      // A menu or modal owns the pointer; do not open the sidebar behind it.
      // A dialog above the workspace owns the pointer; peeking out from under it would fight it.
      if (getTopOverlayLayer() > 0) {
        insideHotspotRef.current = false;
        clearOpenTimer();
        return;
      }
      const inside = isSidebarPeekHotspotPoint({
        clientX: event.clientX,
        clientY: event.clientY,
        triggerWidth: triggerWidthRef.current,
      });
      if (inside === insideHotspotRef.current) return;
      insideHotspotRef.current = inside;
      if (inside) {
        scheduleOpen();
      } else {
        clearOpenTimer();
      }
    };

    const handlePointerLeave = () => {
      insideHotspotRef.current = false;
      clearOpenTimer();
    };

    // Capture phase so a pane that stops pointer propagation cannot hide the
    // pointer from the hotspot tracker.
    window.addEventListener("pointermove", handlePointerMove, { capture: true, passive: true });
    document.addEventListener("pointerleave", handlePointerLeave, {
      capture: true,
      passive: true,
    });
    return () => {
      window.removeEventListener("pointermove", handlePointerMove, { capture: true });
      document.removeEventListener("pointerleave", handlePointerLeave, { capture: true });
      insideHotspotRef.current = false;
    };
  }, [clearOpenTimer, enabled, scheduleOpen]);

  // Follow the docked content column: pane splits, the Explorer sidebar, and
  // window resizes all move the chat's left edge. A lightweight poll beats
  // forcing a layout read on every pointer move.
  useEffect(() => {
    if (!enabled || typeof window === "undefined" || typeof document === "undefined") return;

    const update = () => {
      const measurement = measureSidebarPeekTrigger();
      if (!measurement) return;
      triggerWidthRef.current = resolveSidebarPeekTriggerWidth({
        fallbackWidth: fallbackTriggerWidthRef.current,
        ...measurement,
      });
    };

    update();
    const interval = setInterval(update, 250);
    window.addEventListener("resize", update);
    return () => {
      clearInterval(interval);
      window.removeEventListener("resize", update);
    };
  }, [enabled]);

  useEffect(() => {
    if (!enabled) {
      closePeek();
    }
  }, [closePeek, enabled]);

  useEffect(() => {
    return () => {
      clearOpenTimer();
      clearCloseTimer();
      clearExitTimer();
    };
  }, [clearCloseTimer, clearExitTimer, clearOpenTimer]);

  // A window that loses focus mid-hover never gets the matching pointerleave,
  // so dismiss instead of leaving the panel floating over another app.
  useEffect(() => {
    if (!open || typeof window === "undefined") return;
    const handleWindowBlur = () => closePeek();
    window.addEventListener("blur", handleWindowBlur);
    return () => window.removeEventListener("blur", handleWindowBlur);
  }, [closePeek, open]);

  return useMemo(
    () => ({
      enabled,
      open: enabled && open,
      visible: enabled && visible,
      onPanelEnter,
      onPanelLeave,
    }),
    [enabled, onPanelEnter, onPanelLeave, open, visible],
  );
}
