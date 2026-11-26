import { MarkdownMath } from "./render";

/** A fenced `math` block: display math, drawn by the platform renderer. */
export function MathFence({ code }: { code: string }) {
  return <MarkdownMath tex={code} />;
}
