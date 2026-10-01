import type { DiffDocumentProps, DiffFileSection } from "./types";

export interface DocumentFileHeaderProps {
  file: DiffFileSection;
  selectedPath: string | null;
  mode: DiffDocumentProps["mode"];
  /** Whether this header can fold its own body — see DiffSurfaceProps.collapsible. */
  collapsible: boolean;
  onToggleFile: (path: string) => void;
  onSelectPath: (path: string) => void;
  canvasRendered?: boolean;
  onActiveChange?: (active: boolean) => void;
}

type DiffMode = DiffDocumentProps["mode"];
type WorkingDiffMode = Extract<DiffMode, { kind: "working" }>;
type CommitDiffMode = Extract<DiffMode, { kind: "commit" }>;

/**
 * A commit header used to short-circuit this comparison: collapse state could
 * not reach it, so nothing about it could change while the panel was open. It
 * now folds like a Changes header, so its equality is the same question in both
 * modes — only the fields each mode reads differ.
 */
export function documentFileHeaderPropsEqual(
  previous: DocumentFileHeaderProps,
  next: DocumentFileHeaderProps,
): boolean {
  if (!documentFileHeaderIdentityMatches(previous, next)) return false;
  return modeFieldsEqual(previous.mode, next.mode);
}

function modeFieldsEqual(previous: DiffMode, next: DiffMode): boolean {
  if (previous.kind === "commit" && next.kind === "commit") {
    return commitModeFieldsEqual(previous, next);
  }
  if (previous.kind === "working" && next.kind === "working") {
    return workingModeFieldsEqual(previous, next);
  }
  // Unreachable: the identity check already compared the mode kinds.
  return false;
}

function workingModeFieldsEqual(previous: WorkingDiffMode, next: WorkingDiffMode): boolean {
  return (
    previous.onFilePress === next.onFilePress &&
    previous.workspaceFileDragScope === next.workspaceFileDragScope &&
    previous.onOpenFile === next.onOpenFile &&
    previous.onOpenToSide === next.onOpenToSide &&
    previous.onAddToChat === next.onAddToChat &&
    previous.onCopyPath === next.onCopyPath &&
    previous.onCopyRelativePath === next.onCopyRelativePath &&
    previous.onReveal === next.onReveal &&
    previous.revealTargetName === next.revealTargetName &&
    previous.onDownload === next.onDownload &&
    previous.onDuplicate === next.onDuplicate &&
    previous.onRevert === next.onRevert
  );
}

function commitModeFieldsEqual(previous: CommitDiffMode, next: CommitDiffMode): boolean {
  return (
    previous.reviewActions === next.reviewActions &&
    previous.fullContextShown === next.fullContextShown &&
    previous.onExpandContext === next.onExpandContext
  );
}

function documentFileHeaderIdentityMatches(
  previous: DocumentFileHeaderProps,
  next: DocumentFileHeaderProps,
): boolean {
  return !(
    previous.file.file !== next.file.file ||
    previous.file.fileIndex !== next.file.fileIndex ||
    previous.file.isCollapsed !== next.file.isCollapsed ||
    (previous.selectedPath === previous.file.path) !== (next.selectedPath === next.file.path) ||
    previous.onToggleFile !== next.onToggleFile ||
    previous.onSelectPath !== next.onSelectPath ||
    previous.collapsible !== next.collapsible ||
    previous.canvasRendered !== next.canvasRendered ||
    previous.onActiveChange !== next.onActiveChange ||
    previous.mode.kind !== next.mode.kind
  );
}
