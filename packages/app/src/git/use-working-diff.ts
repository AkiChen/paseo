import { useCallback, useEffect, useMemo, useState } from "react";
import {
  buildWorkspaceAttachmentScopeKey,
  useWorkspaceAttachmentsStore,
} from "@/attachments/workspace-attachments-store";
import {
  buildReviewDraftKey,
  useInlineReviewController,
  useReviewAttachmentSnapshot,
} from "@/review";
import { useCheckoutDiffQuery } from "@/git/use-diff-query";
import { useCheckoutStatusQuery } from "@/git/use-status-query";
import { useWorkingDiffComparison } from "@/git/working-diff-comparison";

interface UseWorkingDiffOptions {
  serverId: string;
  workspaceId?: string;
  cwd: string;
  ignoreWhitespace: boolean;
  enabled: boolean;
  queryScope?: string;
}

export function useWorkingDiff({
  serverId,
  workspaceId,
  cwd,
  ignoreWhitespace,
  enabled,
  queryScope,
}: UseWorkingDiffOptions) {
  const [showFullContext, setShowFullContext] = useState(false);
  const {
    status,
    isLoading: isStatusLoading,
    isError: isStatusError,
    error: statusError,
  } = useCheckoutStatusQuery({ serverId, cwd });
  const gitStatus = status && status.isGit ? status : null;
  const isGit = Boolean(gitStatus);
  const notGit = status !== null && !status.isGit && !status.error;
  const statusErrorMessage =
    status?.error?.message ??
    (isStatusError && statusError instanceof Error ? statusError.message : null);
  const defaultBaseRef = gitStatus?.baseRef ?? undefined;
  const hasUncommittedChanges = Boolean(gitStatus?.isDirty);
  const currentBranchName =
    gitStatus?.currentBranch && gitStatus.currentBranch !== "HEAD" ? gitStatus.currentBranch : null;

  const {
    comparison: diffMode,
    baseRef,
    selectComparison,
    selectBaseRef: selectComparisonBaseRef,
  } = useWorkingDiffComparison({
    serverId,
    workspaceId,
    cwd,
    isDirty: hasUncommittedChanges,
    defaultBaseRef,
  });
  useEffect(() => setShowFullContext(false), [baseRef, cwd, diffMode, ignoreWhitespace, serverId]);
  const expandFullContext = useCallback(() => setShowFullContext(true), []);
  const selectUncommitted = useCallback(() => selectComparison("uncommitted"), [selectComparison]);
  const selectBase = useCallback(() => selectComparison("base"), [selectComparison]);
  const selectBaseRef = useCallback(
    (nextBaseRef: string) => {
      selectComparisonBaseRef(nextBaseRef);
      selectComparison("base");
    },
    [selectComparison, selectComparisonBaseRef],
  );

  const {
    files,
    payloadError: diffPayloadError,
    diffTooLarge,
    isLoading: isDiffLoading,
  } = useCheckoutDiffQuery({
    serverId,
    cwd,
    mode: diffMode,
    baseRef,
    ignoreWhitespace,
    contextLines: showFullContext ? 100000 : undefined,
    enabled: enabled && isGit,
    queryScope,
  });
  const reviewDraftKey = useMemo(
    () =>
      buildReviewDraftKey({
        serverId,
        workspaceId,
        cwd,
        mode: diffMode,
        baseRef,
        ignoreWhitespace,
      }),
    [baseRef, cwd, diffMode, ignoreWhitespace, serverId, workspaceId],
  );
  const reviewActions = useInlineReviewController({ reviewDraftKey });
  const reviewAttachment = useReviewAttachmentSnapshot({
    key: reviewDraftKey,
    diffFiles: files,
    cwd,
    mode: diffMode,
    baseRef,
  });

  return {
    status,
    isStatusLoading,
    isGit,
    notGit,
    statusErrorMessage,
    baseRef,
    currentBranchName,
    diffMode,
    selectUncommitted,
    selectBase,
    selectBaseRef,
    files,
    diffPayloadError,
    diffTooLarge,
    isDiffLoading,
    reviewActions,
    reviewAttachment,
    reviewDraftKey,
    showFullContext,
    expandFullContext,
  };
}

export function usePublishWorkingDiffAttachment({
  serverId,
  workspaceId,
  cwd,
  reviewDraftKey,
  attachment,
  enabled,
}: {
  serverId: string;
  workspaceId?: string;
  cwd: string;
  reviewDraftKey: string;
  attachment: ReturnType<typeof useWorkingDiff>["reviewAttachment"];
  enabled: boolean;
}) {
  const scopeKey = useMemo(
    () => buildWorkspaceAttachmentScopeKey({ serverId, workspaceId, cwd }),
    [cwd, serverId, workspaceId],
  );
  const setWorkspaceReviewAttachment = useWorkspaceAttachmentsStore(
    (state) => state.setWorkspaceReviewAttachment,
  );

  useEffect(() => {
    if (!enabled) {
      return;
    }
    setWorkspaceReviewAttachment({ scopeKey, reviewDraftKey, attachment });
  }, [attachment, enabled, reviewDraftKey, scopeKey, setWorkspaceReviewAttachment]);

  // Withdraw on unmount only. Going inactive must keep the comments in the
  // composer: the reader switches to the session to send them.
  useEffect(() => {
    return () => {
      setWorkspaceReviewAttachment({ scopeKey, reviewDraftKey, attachment: null });
    };
  }, [reviewDraftKey, scopeKey, setWorkspaceReviewAttachment]);
}
