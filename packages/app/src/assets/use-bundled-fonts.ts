import { useFonts } from "expo-font";
import type { BundledCodeFont } from "./bundled-fonts";

/**
 * The font files themselves. Kept apart from `bundled-fonts.ts` so the list of
 * offered families stays importable from a test: this module pulls in `.ttf`
 * assets, which the node test environment has no loader for.
 *
 * Fira Code 6.2, Regular, from https://github.com/tonsky/FiraCode, licensed under
 * the SIL Open Font License 1.1. The license text ships beside the font in
 * `assets/fonts/FiraCode-OFL.txt`, which that license requires.
 */
const BUNDLED_FONT_ASSETS: Record<BundledCodeFont, number> = {
  "Fira Code": require("../../assets/fonts/FiraCode-Regular.ttf"),
};

/** Loads the bundled code fonts. Text drawn before they land re-renders after. */
export function useBundledFonts(): ReturnType<typeof useFonts> {
  return useFonts(BUNDLED_FONT_ASSETS);
}
