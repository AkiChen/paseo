import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { foldable, foldGutter } from "@codemirror/language";
import { getLanguageForFile } from "@getpaseo/highlight";
import { codeFolding, findIndentFoldLines, indentWidth } from "./fold.web";

function stateFor(content: string, filename: string): EditorState {
  return EditorState.create({
    doc: content,
    extensions: [getLanguageForFile(filename)?.extension ?? [], codeFolding(), foldGutter()],
  });
}

/** The range the gutter would offer for a 1-based line. */
function foldAtLine(state: EditorState, lineNumber: number) {
  const line = state.doc.line(lineNumber);
  return foldable(state, line.from, line.to);
}

function foldedText(state: EditorState, range: { from: number; to: number }): string {
  return state.sliceDoc(range.from, range.to);
}

describe("findIndentFoldLines", () => {
  it("folds the run of deeper lines and stops at the first dedent", () => {
    const lines = ["def run():", "    first()", "    second()", "next()"];

    expect(findIndentFoldLines(lines, 0)).toEqual({ fromLine: 0, toLine: 2 });
  });

  it("keeps blank lines inside the block without extending it", () => {
    const lines = ["def run():", "    first()", "", "    second()", "", "next()"];

    expect(findIndentFoldLines(lines, 0)).toEqual({ fromLine: 0, toLine: 3 });
  });

  it("offers nothing when the next line is not deeper", () => {
    expect(findIndentFoldLines(["a()", "b()"], 0)).toBeNull();
  });

  it("offers nothing for the last line", () => {
    expect(findIndentFoldLines(["a()"], 0)).toBeNull();
  });
});

describe("indentWidth", () => {
  it("counts a tab as one indent step", () => {
    expect(indentWidth("\tif x:")).toBe(4);
    expect(indentWidth("    if x:")).toBe(4);
    expect(indentWidth("if x:")).toBe(0);
  });
});

describe("codeFolding", () => {
  it("folds a TypeScript function body but keeps its opening and closing lines", () => {
    const content = ["function run() {", "  first();", "  second();", "}", ""].join("\n");
    const state = stateFor(content, "a.ts");

    const range = foldAtLine(state, 1);

    expect(range).not.toBeNull();
    expect(foldedText(state, range!)).toBe("\n  first();\n  second();");
  });

  it("folds an object literal that spans lines", () => {
    const content = ["const config = {", "  a: 1,", "  b: 2,", "};", ""].join("\n");
    const state = stateFor(content, "a.ts");

    const range = foldAtLine(state, 1);

    expect(range).not.toBeNull();
    expect(foldedText(state, range!)).toBe("\n  a: 1,\n  b: 2,");
  });

  it("does not treat a brace inside a string as a block", () => {
    const content = ['const text = "{ not a block";', ""].join("\n");
    const state = stateFor(content, "a.ts");

    expect(foldAtLine(state, 1)).toBeNull();
  });

  it("does not fold a line whose block closes on the same line", () => {
    const content = ["const config = { a: 1 };", ""].join("\n");
    const state = stateFor(content, "a.ts");

    expect(foldAtLine(state, 1)).toBeNull();
  });

  it("folds a Python function body through indentation", () => {
    const content = ["def run():", "    first()", "    second()", "", "next()"].join("\n");
    const state = stateFor(content, "a.py");

    const range = foldAtLine(state, 1);

    expect(range).not.toBeNull();
    expect(foldedText(state, range!)).toBe("\n    first()\n    second()");
  });

  it("still folds a plain presentation, which has no parser", () => {
    const content = ["def run():", "    first()", "next()"].join("\n");
    const state = EditorState.create({ doc: content, extensions: [codeFolding(), foldGutter()] });

    const range = foldAtLine(state, 1);

    expect(range).not.toBeNull();
    expect(foldedText(state, range!)).toBe("\n    first()");
  });
});
