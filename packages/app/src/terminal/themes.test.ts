import { describe, expect, it } from "vitest";
import { TERMINAL_THEME_OPTIONS, isTerminalThemeId, resolveTerminalTheme } from "./themes";

describe("terminal themes", () => {
  it("resolves every built-in preset to a complete ANSI palette", () => {
    const appTheme = { background: "app-background", foreground: "app-foreground" };

    for (const option of TERMINAL_THEME_OPTIONS) {
      const theme = resolveTerminalTheme(option.id, appTheme);
      expect(theme.background).toBeTruthy();
      expect(theme.foreground).toBeTruthy();
      if (option.id !== "app") {
        expect(theme.black).toBeTruthy();
        expect(theme.brightWhite).toBeTruthy();
      }
    }
  });

  it("recognizes only selectable theme ids", () => {
    expect(isTerminalThemeId("tokyo-night")).toBe(true);
    expect(isTerminalThemeId("missing")).toBe(false);
  });
});
