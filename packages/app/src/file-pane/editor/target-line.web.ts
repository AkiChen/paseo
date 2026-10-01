import { RangeSet, StateEffect, StateField, type EditorState } from "@codemirror/state";
import { Decoration, EditorView, type DecorationSet } from "@codemirror/view";

/**
 * The lines a link in the transcript pointed at. Opening the file is not enough:
 * the reader has to see which line the message meant.
 */
export interface TargetLineRange {
  fromLine: number;
  toLine: number;
}

export const setTargetLines = StateEffect.define<TargetLineRange | null>();

/** A message may name a line that no longer exists, so clamp instead of failing. */
export function resolveTargetLines(input: {
  lineCount: number;
  lineStart?: number | undefined;
  lineEnd?: number | undefined;
}): TargetLineRange | null {
  if (input.lineStart === undefined) {
    return null;
  }
  const fromLine = Math.min(Math.max(1, Math.trunc(input.lineStart)), input.lineCount);
  const requestedEnd = input.lineEnd === undefined ? fromLine : Math.trunc(input.lineEnd);
  return { fromLine, toLine: Math.min(Math.max(fromLine, requestedEnd), input.lineCount) };
}

export function targetLinesFromLocation(
  state: EditorState,
  location: { lineStart?: number | undefined; lineEnd?: number | undefined },
): TargetLineRange | null {
  return resolveTargetLines({
    lineCount: state.doc.lines,
    lineStart: location.lineStart,
    lineEnd: location.lineEnd,
  });
}

const targetLine = Decoration.line({ class: "cm-targetLine" });

function buildDecorations(state: EditorState, range: TargetLineRange | null): DecorationSet {
  if (!range) {
    return Decoration.none;
  }
  const decorations = [];
  for (let line = range.fromLine; line <= range.toLine; line += 1) {
    decorations.push(targetLine.range(state.doc.line(line).from));
  }
  return RangeSet.of(decorations, true);
}

/**
 * Marks the line a navigation target names. Add it as an extension and drive it
 * with `setTargetLines`. The gutter number follows the selection instead: a line
 * decoration cannot reach the gutter, but CodeMirror marks active gutter numbers
 * from the selection, so navigation sets both.
 */
export const targetLineHighlight: StateField<DecorationSet> = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update: (value, transaction) => {
    const effect = transaction.effects.find((candidate) => candidate.is(setTargetLines));
    if (effect) {
      return buildDecorations(transaction.state, effect.value);
    }
    return transaction.docChanged ? value.map(transaction.changes) : value;
  },
  provide: (field) => EditorView.decorations.from(field),
});
