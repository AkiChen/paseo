import { renderToString } from "katex";
import React, { useMemo, type CSSProperties } from "react";

export interface MarkdownMathProps {
  tex: string;
}

const CONTAINER_STYLE: CSSProperties = {
  display: "block",
  margin: "10px 0",
  overflowX: "auto",
  overflowY: "hidden",
  textAlign: "center",
  color: "inherit",
};

const FALLBACK_STYLE: CSSProperties = {
  margin: "10px 0",
  overflowX: "auto",
  fontFamily: "monospace",
  fontSize: 13,
  textAlign: "center",
};

/**
 * Display math on web and Electron.
 *
 * KaTeX renders MathML (`output: "mathml"`), which Chromium lays out natively —
 * so the app needs neither KaTeX's stylesheet nor its web fonts. The HTML
 * output would look unstyled without them, and a Markdown transcript has no
 * place to mount a stylesheet per formula. Text color is inherited, so the
 * formula follows the chat theme on its own.
 */
export function MarkdownMath({ tex }: MarkdownMathProps) {
  const innerHtml = useMemo(() => {
    try {
      return {
        __html: renderToString(tex, {
          displayMode: true,
          throwOnError: false,
          output: "mathml",
          strict: false,
        }),
      };
    } catch {
      return null;
    }
  }, [tex]);

  if (innerHtml === null) {
    return <pre style={FALLBACK_STYLE}>{tex}</pre>;
  }

  return <div style={CONTAINER_STYLE} dangerouslySetInnerHTML={innerHtml} />;
}
