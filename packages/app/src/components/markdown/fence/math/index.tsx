import type { MarkdownFenceRendererProps } from "../types";
import { MarkdownMath } from "./render";

/** A fenced `math` block: display math, drawn by the platform renderer. */
export function MathFence({ code }: MarkdownFenceRendererProps) {
  return <MarkdownMath tex={code} />;
}
