import React from "react";
import { cleanup, fireEvent, render } from "@testing-library/react";
import { JSDOM } from "jsdom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DocumentFileHeader } from "./document-file-header";
import type { DocumentFileHeaderProps } from "./document-file-header-props";
import type { DiffFileSection } from "./types";

vi.mock("react-i18next", () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}));

vi.mock("react-native-safe-area-context", () => ({
  useSafeAreaInsets: () => ({ top: 0, right: 0, bottom: 0, left: 0 }),
}));

const parsedFile: DiffFileSection["file"] = {
  path: "src/a.ts",
  oldPath: undefined,
  additions: 2,
  deletions: 1,
  isNew: false,
  isDeleted: false,
  hunks: [],
};

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

function headerProps(
  overrides: Partial<DocumentFileHeaderProps> = {},
  handlers: {
    onToggleFile: (path: string) => void;
    onSelectPath: (path: string) => void;
  },
): DocumentFileHeaderProps {
  return {
    file: section(false),
    selectedPath: null,
    mode: { kind: "commit" },
    collapsible: true,
    ...handlers,
    ...overrides,
  };
}

function press(element: Element): void {
  fireEvent.mouseDown(element);
  fireEvent.mouseUp(element);
  fireEvent.click(element);
}

beforeEach(() => {
  const dom = new JSDOM("<!doctype html><html><body></body></html>");
  // The app's JSX transform is the classic runtime, which reads a global React.
  vi.stubGlobal("React", React);
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.stubGlobal("window", dom.window);
  vi.stubGlobal("document", dom.window.document);
  vi.stubGlobal("HTMLElement", dom.window.HTMLElement);
  vi.stubGlobal("Element", dom.window.Element);
  vi.stubGlobal("Node", dom.window.Node);
  vi.stubGlobal("navigator", dom.window.navigator);
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("DocumentFileHeader", () => {
  // A commit header used to render as a plain view: no press target at all, so
  // a long commit diff had no way to fold a file.
  it("folds the file when a commit header is pressed", () => {
    const handlers = { onToggleFile: vi.fn(), onSelectPath: vi.fn() };
    const view = render(<DocumentFileHeader {...headerProps({}, handlers)} />);

    press(view.getByTestId("diff-file-0-toggle"));

    expect(handlers.onToggleFile).toHaveBeenCalledWith(parsedFile.path);
  });

  it("reports the folded state to accessibility", () => {
    const handlers = { onToggleFile: vi.fn(), onSelectPath: vi.fn() };
    const view = render(<DocumentFileHeader {...headerProps({}, handlers)} />);

    expect(view.getByTestId("diff-file-0-toggle").getAttribute("aria-expanded")).toBe("true");
  });

  it("stays inert when the diff has no collapse state", () => {
    const handlers = { onToggleFile: vi.fn(), onSelectPath: vi.fn() };
    const view = render(<DocumentFileHeader {...headerProps({ collapsible: false }, handlers)} />);

    expect(view.queryByTestId("diff-file-0-toggle")).toBeNull();
  });

  it("keeps the working-diff file press behaviour", () => {
    const handlers = { onToggleFile: vi.fn(), onSelectPath: vi.fn() };
    const onFilePress = vi.fn();
    const view = render(
      <DocumentFileHeader {...headerProps({ mode: { kind: "working", onFilePress } }, handlers)} />,
    );

    press(view.getByTestId("diff-file-0-toggle"));

    expect(onFilePress).toHaveBeenCalledWith(parsedFile.path);
    expect(handlers.onToggleFile).toHaveBeenCalledWith(parsedFile.path);
  });
});
