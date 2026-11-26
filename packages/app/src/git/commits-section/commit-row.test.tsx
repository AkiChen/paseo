/**
 * @vitest-environment jsdom
 */
import React from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ClassifiedCheckoutCommit } from "@/git/use-commits-query";
import { CommitRow } from "./commit-row";

// The tooltip portals a reanimated surface; jsdom has no layout engine, and
// reanimated's web exit animation runs MutationObserver work after teardown.
vi.mock("react-native-reanimated", async () => {
  const { View } = await import("react-native");
  return {
    __esModule: true,
    default: { View },
    FadeIn: { duration: () => ({}) },
    FadeOut: { duration: () => ({}) },
  };
});

const SUBJECT = "[Refactor] Rename only the workspace-local commit title rendering path";

const commit: ClassifiedCheckoutCommit = {
  sha: "5d94eab70d0d4a6f9f0ae6f0b7a1b0c3d4e5f607",
  shortSha: "5d94eab7",
  subject: SUBJECT,
  message: SUBJECT,
  authorName: "Joey Chen",
  authorEmail: "joey@example.com",
  authorDate: "2026-11-10T09:00:00.000Z",
  isOnRemote: true,
  isOnBase: false,
  files: [],
};

function renderRow(onCommitPress: (sha: string) => void = vi.fn()): void {
  render(<CommitRow commit={commit} isFirst isLast onCommitPress={onCommitPress} />);
}

beforeEach(() => {
  vi.stubGlobal("React", React);
});

afterEach(() => {
  cleanup();
  document.getElementById("overlay-root")?.remove();
});

describe("CommitRow", () => {
  it("reveals the full subject in a tooltip when the row is hovered", async () => {
    renderRow();
    expect(screen.queryByTestId("commit-row-tooltip-5d94eab7")).toBeNull();

    fireEvent.pointerEnter(screen.getByTestId("commit-row-5d94eab7"));

    await waitFor(
      () => {
        const tooltip = screen.getByTestId("commit-row-tooltip-5d94eab7");
        expect(tooltip.textContent).toContain(SUBJECT);
      },
      { timeout: 3000 },
    );
  });

  it("still opens the commit when the row is pressed", () => {
    const onCommitPress = vi.fn();
    renderRow(onCommitPress);

    fireEvent.click(screen.getByTestId("commit-row-5d94eab7"));

    expect(onCommitPress).toHaveBeenCalledWith(commit.sha);
  });
});
