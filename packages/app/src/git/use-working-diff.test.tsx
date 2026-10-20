// @vitest-environment jsdom

import { renderHook } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { WorkspaceComposerAttachment } from "@/attachments/types";
import {
  buildWorkspaceAttachmentScopeKey,
  resetWorkspaceAttachmentsStore,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import { usePublishWorkingDiffAttachment } from "./use-working-diff";

// Two review surfaces publish into one workspace scope: the working diff and the
// commit diff a reader opened. Writing comments on a commit must reach the
// session's composer, and neither surface may clear the other's comments.
type ReviewWorkspaceAttachment = Extract<WorkspaceComposerAttachment, { kind: "review" }>;

function reviewAttachment(reviewDraftKey: string): ReviewWorkspaceAttachment {
  return {
    kind: "review",
    reviewDraftKey,
    commentCount: 1,
    attachment: {
      type: "review",
      mimeType: "application/paseo-review",
      cwd: "/repo",
      mode: "base",
      baseRef: "abc123^",
      comments: [
        {
          filePath: "src/example.ts",
          side: "new",
          lineNumber: 41,
          body: reviewDraftKey,
          context: {
            hunkHeader: "@@ -40,1 +40,1 @@",
            targetLine: {
              oldLineNumber: null,
              newLineNumber: 41,
              type: "add",
              content: "const value = newValue;",
            },
            lines: [
              {
                oldLineNumber: null,
                newLineNumber: 41,
                type: "add",
                content: "const value = newValue;",
              },
            ],
          },
        },
      ],
    },
  };
}

const SCOPE_INPUT = { serverId: "local", workspaceId: "workspace-1", cwd: "/repo" };
const scopeKey = buildWorkspaceAttachmentScopeKey(SCOPE_INPUT);

function publishCommitReview(attachment: ReviewWorkspaceAttachment): void {
  useWorkspaceAttachmentsStore.getState().setWorkspaceReviewAttachment({
    scopeKey,
    reviewDraftKey: attachment.reviewDraftKey,
    attachment,
  });
}

function scopedAttachments(): readonly WorkspaceComposerAttachment[] {
  return useWorkspaceAttachmentsStore.getState().attachmentsByScope[scopeKey] ?? [];
}

describe("usePublishWorkingDiffAttachment", () => {
  it("keeps a commit review when the working diff has no comments of its own", () => {
    resetWorkspaceAttachmentsStore();
    const commitReview = reviewAttachment("review:commit:abc123");
    publishCommitReview(commitReview);

    renderHook(() =>
      usePublishWorkingDiffAttachment({
        ...SCOPE_INPUT,
        reviewDraftKey: "review:working-diff",
        attachment: null,
        enabled: true,
      }),
    );

    expect(scopedAttachments()).toEqual([commitReview]);
  });

  it("withdraws only its own review when the surface unmounts", () => {
    resetWorkspaceAttachmentsStore();
    const commitReview = reviewAttachment("review:commit:abc123");
    const workingReview = reviewAttachment("review:working-diff");
    publishCommitReview(commitReview);

    const { unmount } = renderHook(() =>
      usePublishWorkingDiffAttachment({
        ...SCOPE_INPUT,
        reviewDraftKey: "review:working-diff",
        attachment: workingReview,
        enabled: true,
      }),
    );
    expect(scopedAttachments()).toEqual([commitReview, workingReview]);

    unmount();

    expect(scopedAttachments()).toEqual([commitReview]);
  });

  it("keeps its own review while the surface stays mounted but inactive", () => {
    resetWorkspaceAttachmentsStore();
    const commitReview = reviewAttachment("review:commit:abc123");

    const { rerender } = renderHook(
      ({ enabled }: { enabled: boolean }) =>
        usePublishWorkingDiffAttachment({
          ...SCOPE_INPUT,
          reviewDraftKey: "review:commit:abc123",
          attachment: commitReview,
          enabled,
        }),
      { initialProps: { enabled: true } },
    );
    expect(scopedAttachments()).toEqual([commitReview]);

    // Switching to the session keeps the panel mounted but inactive.
    rerender({ enabled: false });

    expect(scopedAttachments()).toEqual([commitReview]);
  });
});
