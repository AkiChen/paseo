import { describe, expect, it } from "vitest";
import { EditorState } from "@codemirror/state";
import { resolveTargetLines, setTargetLines, targetLineHighlight } from "./target-line.web";

const DOC = ["one", "two", "three", "four"].join("\n");

function stateAt(): EditorState {
  return EditorState.create({ doc: DOC, extensions: [targetLineHighlight] });
}

function decoratedLines(state: EditorState): number[] {
  const decorations = state.field(targetLineHighlight);
  const rows = state.doc;
  const lines: number[] = [];
  decorations.between(0, state.doc.length, (from) => {
    lines.push(rows.lineAt(from).number);
  });
  return lines;
}

describe("resolveTargetLines", () => {
  it("returns nothing when the link carried no line", () => {
    expect(resolveTargetLines({ lineCount: 4 })).toBeNull();
  });

  it("treats a single line as a one line range", () => {
    expect(resolveTargetLines({ lineCount: 4, lineStart: 2 })).toEqual({
      fromLine: 2,
      toLine: 2,
    });
  });

  it("clamps a range that runs past the document", () => {
    expect(resolveTargetLines({ lineCount: 4, lineStart: 3, lineEnd: 90 })).toEqual({
      fromLine: 3,
      toLine: 4,
    });
  });

  it("clamps a line the document no longer has", () => {
    expect(resolveTargetLines({ lineCount: 2, lineStart: 9 })).toEqual({
      fromLine: 2,
      toLine: 2,
    });
  });

  it("ignores an end before the start", () => {
    expect(resolveTargetLines({ lineCount: 4, lineStart: 3, lineEnd: 1 })).toEqual({
      fromLine: 3,
      toLine: 3,
    });
  });
});

describe("targetLineHighlight", () => {
  it("marks every line of the range", () => {
    const state = stateAt().update({
      effects: setTargetLines.of({ fromLine: 1, toLine: 3 }),
    }).state;

    expect(decoratedLines(state)).toEqual([1, 2, 3]);
  });

  it("replaces the previous range", () => {
    const first = stateAt().update({
      effects: setTargetLines.of({ fromLine: 2, toLine: 2 }),
    }).state;
    const second = first.update({ effects: setTargetLines.of({ fromLine: 4, toLine: 4 }) }).state;

    expect(decoratedLines(second)).toEqual([4]);
  });

  it("clears when the navigation carries no line", () => {
    const marked = stateAt().update({
      effects: setTargetLines.of({ fromLine: 2, toLine: 2 }),
    }).state;
    const cleared = marked.update({ effects: setTargetLines.of(null) }).state;

    expect(decoratedLines(cleared)).toEqual([]);
  });

  it("moves the mark with the document instead of pointing at the wrong line", () => {
    const marked = stateAt().update({
      effects: setTargetLines.of({ fromLine: 3, toLine: 3 }),
    }).state;
    const edited = marked.update({ changes: { from: 0, insert: "zero\n" } }).state;

    expect(decoratedLines(edited)).toEqual([4]);
  });
});
