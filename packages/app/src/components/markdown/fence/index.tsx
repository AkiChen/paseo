import type { ComponentType } from "react";
import { HighlightedCodeBlock } from "@/components/highlighted-code-block";
import { type DiagramFenceLanguage, diagramFenceLanguage } from "./diagram-language";
import { getMarkdownFenceLanguage } from "./language";
import { MermaidFence } from "./mermaid";
import type { MarkdownFenceRendererProps } from "./types";

export interface MarkdownFenceBlockProps extends MarkdownFenceRendererProps {
  info: string | null | undefined;
}

/** Exhaustive on purpose: a new diagram language must be wired up here too. */
const diagramFences: Record<DiagramFenceLanguage, ComponentType<MarkdownFenceRendererProps>> = {
  mermaid: MermaidFence,
  mmd: MermaidFence,
};

export function MarkdownFenceBlock({
  code,
  info,
  phase,
  inheritedStyles,
  textStyle,
}: MarkdownFenceBlockProps) {
  const language = getMarkdownFenceLanguage(info);
  const diagramLanguage = diagramFenceLanguage(language);
  const DiagramFence = diagramLanguage === null ? undefined : diagramFences[diagramLanguage];
  if (DiagramFence) {
    return (
      <DiagramFence
        code={code}
        phase={phase}
        inheritedStyles={inheritedStyles}
        textStyle={textStyle}
      />
    );
  }
  return (
    <HighlightedCodeBlock
      code={code}
      language={language}
      inheritedStyles={inheritedStyles}
      textStyle={textStyle}
    />
  );
}
