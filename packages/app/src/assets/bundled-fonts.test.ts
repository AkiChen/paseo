import { describe, expect, it } from "vitest";
import { BUNDLED_CODE_FONTS } from "./bundled-fonts";

describe("bundled code fonts", () => {
  it("offers Fira Code by the family name the code font setting takes", () => {
    expect(BUNDLED_CODE_FONTS).toContain("Fira Code");
  });

  it("keeps a non-empty family name to offer for every entry", () => {
    // The asset map in `use-bundled-fonts.ts` is typed against this list, so
    // offering a family without an asset is a type error rather than a test
    // failure. What is worth pinning here is that each entry is a name the code
    // font field can actually take.
    expect(BUNDLED_CODE_FONTS.length).toBeGreaterThan(0);
    for (const family of BUNDLED_CODE_FONTS) {
      expect(family.trim()).toBe(family);
      expect(family.length).toBeGreaterThan(0);
    }
  });
});
