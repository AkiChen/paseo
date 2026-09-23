import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import {
  bracketMatching,
  foldGutter,
  foldKeymap,
  defaultHighlightStyle,
  indentOnInput,
  syntaxHighlighting,
} from "@codemirror/language";
import { searchKeymap } from "@codemirror/search";
import {
  EditorView,
  drawSelection,
  highlightActiveLine,
  keymap,
  lineNumbers,
} from "@codemirror/view";
import { createCodeMirrorHighlightStyle, type HighlightStyle } from "@getpaseo/highlight";
import { codeFolding } from "./fold.web";

export interface EditorVisualTheme {
  colorScheme: "light" | "dark";
  background: string;
  foreground: string;
  cursor: string;
  foregroundMuted: string;
  border: string;
  selection: string;
  monoFont: string;
  codeFontSize: number;
  syntax: Record<HighlightStyle, string>;
}

export function editorBaseExtensions(onSave: () => void) {
  return [
    lineNumbers(),
    foldGutter(),
    codeFolding(),
    history(),
    drawSelection(),
    indentOnInput(),
    bracketMatching(),
    highlightActiveLine(),
    syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
    keymap.of([
      { key: "Mod-s", preventDefault: true, run: () => (onSave(), true) },
      indentWithTab,
      ...defaultKeymap,
      ...historyKeymap,
      ...foldKeymap,
      ...searchKeymap,
    ]),
  ];
}

export function editorTheme(theme: EditorVisualTheme) {
  return [
    EditorView.theme(
      {
        "&": {
          height: "100%",
          backgroundColor: theme.background,
          color: theme.foreground,
          fontFamily: theme.monoFont,
          fontSize: `${theme.codeFontSize}px`,
        },
        ".cm-scroller": {
          overflow: "auto",
          fontFamily: theme.monoFont,
          lineHeight: "1.45",
        },
        ".cm-content": { caretColor: theme.foreground, padding: "16px 0" },
        ".cm-cursor, .cm-dropCursor": { borderLeftColor: theme.cursor },
        ".cm-gutters": {
          backgroundColor: theme.background,
          color: theme.foregroundMuted,
          borderRight: `1px solid ${theme.border}`,
        },
        ".cm-activeLine": { backgroundColor: "transparent" },
        ".cm-activeLineGutter": { backgroundColor: "transparent", color: theme.foreground },
        // The line a transcript link named. It stays marked after the reader
        // clicks elsewhere, so the target is still visible on return.
        ".cm-targetLine": { backgroundColor: theme.selection },
        ".cm-foldPlaceholder": {
          backgroundColor: theme.background,
          border: `1px solid ${theme.border}`,
          color: theme.foregroundMuted,
        },
        "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground": {
          backgroundColor: theme.selection,
        },
        ".cm-selectionBackground, ::selection": {
          backgroundColor: theme.selection,
        },
        "&.cm-focused": { outline: "none" },
      },
      { dark: theme.colorScheme === "dark" },
    ),
    syntaxHighlighting(createCodeMirrorHighlightStyle(theme.syntax)),
  ];
}
