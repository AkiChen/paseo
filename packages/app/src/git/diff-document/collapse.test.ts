import { describe, expect, it } from "vitest";
import { areAllDiffFilesCollapsed, toggleCollapsedFilePath } from "./collapse";

describe("toggleCollapsedFilePath", () => {
  it("appends a path that is not collapsed yet", () => {
    expect(toggleCollapsedFilePath(["a.ts"], "b.ts")).toEqual(["a.ts", "b.ts"]);
  });

  it("removes a path that is already collapsed", () => {
    expect(toggleCollapsedFilePath(["a.ts", "b.ts"], "a.ts")).toEqual(["b.ts"]);
  });

  it("keeps the stored order of the paths that stay collapsed", () => {
    expect(toggleCollapsedFilePath(["c.ts", "a.ts", "b.ts"], "a.ts")).toEqual(["c.ts", "b.ts"]);
  });

  it("collapses a file in a diff with nothing collapsed yet", () => {
    expect(toggleCollapsedFilePath([], "a.ts")).toEqual(["a.ts"]);
  });
});

describe("areAllDiffFilesCollapsed", () => {
  it("is false for an empty diff", () => {
    expect(areAllDiffFilesCollapsed([], [])).toBe(false);
  });

  it("is false while any file is still expanded", () => {
    expect(areAllDiffFilesCollapsed([{ path: "a.ts" }, { path: "b.ts" }], ["a.ts"])).toBe(false);
  });

  it("is true when every file is collapsed", () => {
    expect(areAllDiffFilesCollapsed([{ path: "a.ts" }, { path: "b.ts" }], ["b.ts", "a.ts"])).toBe(
      true,
    );
  });

  it("ignores paths that are not in the diff", () => {
    expect(
      areAllDiffFilesCollapsed([{ path: "a.ts" }, { path: "b.ts" }], ["a.ts", "b.ts", "gone.ts"]),
    ).toBe(true);
  });
});
