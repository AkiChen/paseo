import { foldService, syntaxTree } from "@codemirror/language";
import type { EditorState, Extension } from "@codemirror/state";
import type { SyntaxNode } from "@lezer/common";

/**
 * Folding for the file viewer.
 *
 * `foldGutter` was wired up long before anything could fold: it reads its ranges
 * from a `foldService` or from the language's fold props, and the languages in
 * `@getpaseo/highlight` are built from raw lezer parsers that carry neither. The
 * gutter therefore rendered no markers and `foldKeymap` did nothing.
 *
 * This module supplies the ranges, in two steps:
 *
 * 1. A node that starts on the line with a bracket and ends on a later line is a
 *    block. Reading the tree keeps braces inside strings and comments out of it,
 *    which a text scan cannot do.
 * 2. Languages that never start a block with a bracket (Python, YAML) fold the
 *    run of following lines indented deeper than this one.
 *
 * Either way the opening line and the closing line stay visible: the hidden
 * range is what sits between them.
 */

export interface FoldLineRange {
  fromLine: number;
  toLine: number;
}

export interface FoldRange {
  from: number;
  to: number;
}

const BRACKET_OPENER_PATTERN = /^[{[()]$/;

/** How far the indentation scan reads before giving up on a block. */
const INDENT_SCAN_LINES = 500;

/**
 * The indented block under `startIndex`, as line indices. Blank lines inside the
 * block are skipped rather than ending it; the first line indented no deeper
 * than the start line ends it.
 */
export function findIndentFoldLines(
  lines: readonly string[],
  startIndex: number,
): FoldLineRange | null {
  const baseIndent = indentWidth(lines[startIndex] ?? "");
  let lastIndentedLine = -1;
  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.trim().length === 0) {
      continue;
    }
    if (indentWidth(line) <= baseIndent) {
      break;
    }
    lastIndentedLine = index;
  }
  return lastIndentedLine < 0 ? null : { fromLine: startIndex, toLine: lastIndentedLine };
}

export function indentWidth(line: string): number {
  let width = 0;
  for (const character of line) {
    if (character === " ") {
      width += 1;
      continue;
    }
    if (character === "\t") {
      width += 4;
      continue;
    }
    break;
  }
  return width;
}

/**
 * The largest node that still starts on this line and ends after it. Folding
 * that node's bracket pair is what the gutter offers for a function body, an
 * object literal, or a CSS block.
 */
export function findBlockNode(state: EditorState, lineStart: number, lineEnd: number) {
  const tree = syntaxTree(state);
  if (tree.length === 0) {
    return null;
  }
  let node: SyntaxNode | null = tree.resolveInner(lineEnd, -1);
  let candidate: SyntaxNode | null = null;
  while (node) {
    if (node.from >= lineStart && node.to > lineEnd) {
      candidate = node;
    }
    if (node.from < lineStart) {
      break;
    }
    node = node.parent;
  }
  if (!candidate) {
    return null;
  }
  const firstCharacter = state.doc.sliceString(candidate.from, candidate.from + 1);
  return BRACKET_OPENER_PATTERN.test(firstCharacter) ? candidate : null;
}

function foldBlockNode(state: EditorState, node: SyntaxNode, lineEnd: number): FoldRange | null {
  const to = state.doc.lineAt(node.to).from;
  return to > lineEnd ? { from: lineEnd, to } : null;
}

function foldIndentedBlock(
  state: EditorState,
  lineStart: number,
  lineEnd: number,
): FoldRange | null {
  const startLine = state.doc.lineAt(lineStart).number;
  const lastLine = Math.min(state.doc.lines, startLine + INDENT_SCAN_LINES);
  const lines: string[] = [];
  for (let number = startLine; number <= lastLine; number += 1) {
    lines.push(state.doc.line(number).text);
  }
  const range = findIndentFoldLines(lines, 0);
  if (!range) {
    return null;
  }
  const to = state.doc.line(startLine + range.toLine).to;
  return to > lineEnd ? { from: lineEnd, to } : null;
}

export function codeFolding(): Extension {
  return foldService.of((state, lineStart, lineEnd) => {
    const block = findBlockNode(state, lineStart, lineEnd);
    if (block) {
      return foldBlockNode(state, block, lineEnd);
    }
    return foldIndentedBlock(state, lineStart, lineEnd);
  });
}
