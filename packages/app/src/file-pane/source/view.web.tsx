import { useEffect, useRef } from "react";
import { Compartment, EditorState } from "@codemirror/state";
import { foldGutter, foldKeymap } from "@codemirror/language";
import { EditorView, highlightActiveLineGutter, keymap, lineNumbers } from "@codemirror/view";
import { getLanguageForFile } from "@getpaseo/highlight";
import type { WorkspaceFileLocation } from "@/workspace/file-open";
import type { EditorVisualTheme } from "../editor/extensions.web";
import { editorTheme } from "../editor/extensions.web";
import { codeFolding } from "../editor/fold.web";
import {
  setTargetLines,
  targetLineHighlight,
  targetLinesFromLocation,
} from "../editor/target-line.web";
import { selectSourcePresentation, type SourcePresentation } from "./presentation";

interface FileSourceViewProps {
  content: string;
  filename: string;
  location: WorkspaceFileLocation;
  navigationRevision: number;
  size: number;
  theme: EditorVisualTheme;
  tooLargeMessage: string;
}

const languageCompartment = new Compartment();
const themeCompartment = new Compartment();

export function FileSourceView({
  content,
  filename,
  location,
  navigationRevision,
  size,
  theme,
  tooLargeMessage,
}: FileSourceViewProps) {
  const presentation = selectSourcePresentation({ size, platform: "web" });
  if (presentation === "unsupported") {
    return (
      <div data-testid="file-source-too-large" style={UNSUPPORTED_STYLE}>
        {tooLargeMessage}
      </div>
    );
  }
  return (
    <ReadonlyCodeMirror
      content={content}
      filename={filename}
      location={location}
      navigationRevision={navigationRevision}
      presentation={presentation}
      theme={theme}
    />
  );
}

function ReadonlyCodeMirror({
  content,
  filename,
  location,
  navigationRevision,
  presentation,
  theme,
}: Omit<FileSourceViewProps, "size" | "tooLargeMessage"> & {
  presentation: Exclude<SourcePresentation, "unsupported">;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const initial = useRef({ content, filename, presentation, theme });

  useEffect(() => {
    if (!hostRef.current) return;
    const values = initial.current;
    const view = new EditorView({
      parent: hostRef.current,
      state: EditorState.create({
        doc: values.content,
        extensions: [
          EditorState.readOnly.of(true),
          EditorView.editable.of(false),
          lineNumbers(),
          highlightActiveLineGutter(),
          foldGutter(),
          codeFolding(),
          targetLineHighlight,
          keymap.of(foldKeymap),
          languageCompartment.of(
            languageFor({ filename: values.filename, presentation: values.presentation }),
          ),
          themeCompartment.of(editorTheme(values.theme)),
        ],
      }),
    });
    viewRef.current = view;
    return () => {
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  useEffect(() => {
    const view = viewRef.current;
    if (!view || view.state.doc.toString() === content) return;
    view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content } });
  }, [content]);

  useEffect(() => {
    viewRef.current?.dispatch({
      effects: [
        languageCompartment.reconfigure(languageFor({ filename, presentation })),
        themeCompartment.reconfigure(editorTheme(theme)),
      ],
    });
  }, [filename, presentation, theme]);

  const { lineEnd, lineStart } = location;
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    const range = targetLinesFromLocation(view.state, { lineEnd, lineStart });
    if (!range) {
      view.dispatch({ effects: setTargetLines.of(null) });
      return;
    }
    const from = view.state.doc.line(range.fromLine).from;
    // The selection marks the gutter number; the decoration marks the line.
    view.dispatch({
      selection: { anchor: from },
      effects: [setTargetLines.of(range), EditorView.scrollIntoView(from, { y: "center" })],
    });
  }, [lineEnd, lineStart, navigationRevision]);

  return <div ref={hostRef} data-testid="file-source-editor" style={HOST_STYLE} />;
}

function languageFor(input: {
  filename: string;
  presentation: Exclude<SourcePresentation, "unsupported">;
}) {
  return input.presentation === "highlighted"
    ? (getLanguageForFile(input.filename)?.extension ?? [])
    : [];
}

const HOST_STYLE = { flex: 1, minHeight: 0, overflow: "hidden" } as const;
const UNSUPPORTED_STYLE = {
  alignItems: "center",
  display: "flex",
  flex: 1,
  justifyContent: "center",
} as const;
