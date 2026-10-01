import { memo, useCallback } from "react";
import { FileHeader } from "@/git/file-header";
import {
  documentFileHeaderPropsEqual,
  type DocumentFileHeaderProps,
} from "./document-file-header-props";

export const DocumentFileHeader = memo(function DocumentFileHeader({
  file,
  selectedPath,
  mode,
  collapsible,
  onToggleFile,
  onSelectPath,
  canvasRendered = false,
  onActiveChange,
}: DocumentFileHeaderProps) {
  const working = mode.kind === "working" ? mode : null;
  const activate = useCallback(
    (path: string) => {
      working?.onFilePress?.(path);
      onToggleFile(path);
    },
    [onToggleFile, working],
  );
  return (
    <FileHeader
      file={file.file}
      bodyVisible={!file.isCollapsed}
      isSelected={selectedPath === file.path}
      interactive={working !== null || collapsible}
      workspaceFileDragScope={working?.workspaceFileDragScope}
      onActivate={activate}
      onSelect={onSelectPath}
      onOpenFile={working?.onOpenFile}
      onOpenToSide={working?.onOpenToSide}
      onAddToChat={working?.onAddToChat}
      onCopyPath={working?.onCopyPath}
      onCopyRelativePath={working?.onCopyRelativePath}
      onReveal={working?.onReveal}
      revealTargetName={working?.revealTargetName}
      onDownload={working?.onDownload}
      onDuplicate={working?.onDuplicate}
      onRevert={working?.onRevert}
      testID={`diff-file-${file.fileIndex}`}
      canvasRendered={canvasRendered}
      onActiveChange={onActiveChange}
    />
  );
}, documentFileHeaderPropsEqual);
