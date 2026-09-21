import { describe, expect, it } from "vitest";
import {
  documentFileHeaderPropsEqual,
  type DocumentFileHeaderProps,
} from "./document-file-header-props";
import type { DiffDocumentProps, DiffFileSection } from "./types";

// Stable identities: the memo comparison deliberately re-renders whenever a
// callback identity changes, so a factory that allocates fresh ones would make
// every case below unequal for the wrong reason.
const parsedFile: DiffFileSection["file"] = {
  path: "a.ts",
  oldPath: undefined,
  additions: 1,
  deletions: 1,
  isNew: false,
  isDeleted: false,
  hunks: [],
};
const onToggleFile = () => {};
const onSelectPath = () => {};
const onOpenFile = () => {};

function section(isCollapsed: boolean): DiffFileSection {
  return {
    file: parsedFile,
    fileIndex: 0,
    path: parsedFile.path,
    top: 0,
    headerHeight: 30,
    bodyTop: 30,
    bodyHeight: isCollapsed ? 0 : 100,
    bottom: isCollapsed ? 30 : 130,
    gutterWidth: 30,
    contentWidth: 300,
    rowStart: 0,
    rowEnd: 0,
    isCollapsed,
  };
}

function headerProps(overrides: Partial<DocumentFileHeaderProps> = {}): DocumentFileHeaderProps {
  return {
    file: section(false),
    selectedPath: null,
    mode: { kind: "commit" } satisfies DiffDocumentProps["mode"],
    collapsible: true,
    onToggleFile,
    onSelectPath,
    ...overrides,
  };
}

function workingMode(overrides: { onOpenFile?: (path: string) => void } = {}) {
  return { kind: "working", ...overrides } satisfies DiffDocumentProps["mode"];
}

describe("documentFileHeaderPropsEqual", () => {
  it("treats two commit headers that read the same fields as equal", () => {
    expect(documentFileHeaderPropsEqual(headerProps(), headerProps())).toBe(true);
  });

  // The commit header used to return "equal" without looking at the file, so a
  // folded file kept the expanded header: stale aria-expanded and no hover feedback.
  it("re-renders a commit header when its file folds", () => {
    expect(documentFileHeaderPropsEqual(headerProps(), headerProps({ file: section(true) }))).toBe(
      false,
    );
  });

  it("re-renders a commit header when full context is shown", () => {
    const expanded = headerProps({
      mode: { kind: "commit", fullContextShown: true },
    });

    expect(documentFileHeaderPropsEqual(headerProps(), expanded)).toBe(false);
  });

  it("re-renders when a header stops being collapsible", () => {
    expect(documentFileHeaderPropsEqual(headerProps(), headerProps({ collapsible: false }))).toBe(
      false,
    );
  });

  it("re-renders a working header when a file action changes", () => {
    expect(
      documentFileHeaderPropsEqual(
        headerProps({ mode: workingMode() }),
        headerProps({ mode: workingMode({ onOpenFile: () => {} }) }),
      ),
    ).toBe(false);
  });

  it("treats two working headers that read the same fields as equal", () => {
    expect(
      documentFileHeaderPropsEqual(
        headerProps({ mode: workingMode({ onOpenFile }) }),
        headerProps({ mode: workingMode({ onOpenFile }) }),
      ),
    ).toBe(true);
  });
});
