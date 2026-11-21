import { describe, expect, it } from "vitest";
import { toggleFavoriteAgentKey } from "./sidebar-favorite-agents-store";

describe("toggleFavoriteAgentKey", () => {
  it("stars a row to the front so the most recent star leads the section", () => {
    expect(toggleFavoriteAgentKey([], "srv:a")).toEqual(["srv:a"]);
    expect(toggleFavoriteAgentKey(["srv:a"], "srv:b")).toEqual(["srv:b", "srv:a"]);
  });

  it("unstars a row without disturbing the rest of the order", () => {
    expect(toggleFavoriteAgentKey(["srv:c", "srv:b", "srv:a"], "srv:b")).toEqual([
      "srv:c",
      "srv:a",
    ]);
  });

  it("ignores a blank key rather than starring an empty row", () => {
    const keys = ["srv:a"];
    expect(toggleFavoriteAgentKey(keys, "   ")).toBe(keys);
  });
});
