import { useCallback, useMemo, useRef, useState } from "react";
import { withUnistyles } from "react-native-unistyles";
import { RenderProfile } from "@/utils/render-profiler";
import { toggleCollapsedFilePath } from "./collapse";
import { createDiffPalette, retainDiffPalette } from "./palette";
import { DiffSurface } from "./surface";
import type { DiffDocumentProps, DiffHeaderTypography, DiffPalette } from "./types";

export type { DiffDocumentProps, WorkingDiffMode } from "./types";

type ThemedDiffDocumentProps = DiffDocumentProps & {
  palette: DiffPalette;
  headerTypography: DiffHeaderTypography;
};

const EMPTY_PATHS: string[] = [];

function ThemedDiffDocument(props: ThemedDiffDocumentProps) {
  const [selectedPath, setSelectedPath] = useState<string | null>(null);
  const paletteRef = useRef(props.palette);
  paletteRef.current = retainDiffPalette(paletteRef.current, props.palette);
  const palette = paletteRef.current;
  // A commit diff folds the same way a Changes diff does; only the mode that
  // stores the paths differs.
  const collapseState = props.collapseState ?? null;
  const paths = collapseState?.paths ?? EMPTY_PATHS;
  const collapsedFilePaths = useMemo(() => new Set(paths), [paths]);
  const toggleFile = useCallback(
    (path: string) => {
      if (!collapseState) return;
      collapseState.onChange(toggleCollapsedFilePath(paths, path));
    },
    [collapseState, paths],
  );
  return (
    <DiffSurface
      {...props}
      palette={palette}
      collapsedFilePaths={collapsedFilePaths}
      collapsible={collapseState !== null}
      onToggleFile={toggleFile}
      selectedPath={selectedPath}
      onSelectPath={setSelectedPath}
    />
  );
}

const StyledDiffDocument = withUnistyles(ThemedDiffDocument, (theme) => ({
  palette: createDiffPalette(theme),
  headerTypography: {
    family: theme.fontFamily.ui,
    size: theme.fontSize.base,
    statSize: theme.fontSize.sm,
  },
}));

export function DiffDocument(props: DiffDocumentProps) {
  return (
    <RenderProfile id="DiffDocument">
      <StyledDiffDocument {...props} />
    </RenderProfile>
  );
}
