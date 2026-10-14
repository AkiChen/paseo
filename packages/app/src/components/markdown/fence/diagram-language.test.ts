import { describe, expect, it } from "vitest";
import { diagramFenceLanguage } from "./diagram-language";

describe("diagramFenceLanguage", () => {
  it("resolves both spellings of a mermaid diagram", () => {
    expect(diagramFenceLanguage("mermaid")).toBe("mermaid");
    expect(diagramFenceLanguage("mmd")).toBe("mmd");
  });

  it("leaves every other language to syntax highlighting", () => {
    expect(diagramFenceLanguage("typescript")).toBeNull();
    expect(diagramFenceLanguage("markdown")).toBeNull();
    expect(diagramFenceLanguage(null)).toBeNull();
  });
});
