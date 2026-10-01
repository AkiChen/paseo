/**
 * Code fonts the app ships with the bundle.
 *
 * A device rarely has the same monospace faces available, and the code font
 * setting takes a family name, so the faces we care about travel with the app and
 * can be named in that field on any platform. `use-bundled-fonts.ts` loads the
 * same names and is typed against this list, so offering a family without an
 * asset is a type error.
 */
export const BUNDLED_CODE_FONTS = ["Fira Code"] as const;

export type BundledCodeFont = (typeof BUNDLED_CODE_FONTS)[number];
