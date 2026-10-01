/**
 * Collapse follows one rule across every diff surface: a file header toggles its
 * own path, "collapse all" writes every path, "expand all" writes none. The
 * commit panel and the Changes pane share these so the same click folds the same
 * file in both.
 */
export function toggleCollapsedFilePath(paths: readonly string[], path: string): string[] {
  return paths.includes(path) ? paths.filter((entry) => entry !== path) : [...paths, path];
}

/**
 * An empty diff is never "all collapsed", otherwise a diff with nothing in it
 * would offer "Expand all files".
 */
export function areAllDiffFilesCollapsed(
  files: readonly { path: string }[],
  collapsedPaths: readonly string[],
): boolean {
  if (files.length === 0) return false;
  const collapsed = new Set(collapsedPaths);
  return files.every((file) => collapsed.has(file.path));
}
