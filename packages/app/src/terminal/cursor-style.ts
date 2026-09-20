export const TERMINAL_CURSOR_STYLES = ["block", "bar", "underline"] as const;

export type TerminalCursorStyle = (typeof TERMINAL_CURSOR_STYLES)[number];

export const DEFAULT_TERMINAL_CURSOR_STYLE: TerminalCursorStyle = "bar";

export function isTerminalCursorStyle(value: string): value is TerminalCursorStyle {
  return TERMINAL_CURSOR_STYLES.includes(value as TerminalCursorStyle);
}
