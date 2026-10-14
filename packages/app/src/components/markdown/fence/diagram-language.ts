/**
 * Fence languages that render as a diagram instead of as source.
 *
 * `mmd` is the DeepSeek Harness `mermaid-diagram` skill's own file extension, and
 * an agent that wrote `.mmd` commonly tags the fence the same way. Both spellings
 * reach the same renderer; anything else falls through to syntax highlighting.
 */
export type DiagramFenceLanguage = "mermaid" | "mmd";

export function diagramFenceLanguage(language: string | null): DiagramFenceLanguage | null {
  return language === "mermaid" || language === "mmd" ? language : null;
}
