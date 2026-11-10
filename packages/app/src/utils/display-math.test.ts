import { describe, expect, it } from "vitest";
import { normalizeDisplayMath } from "./display-math";
import { createMarkdownParser } from "./markdown-parser";

describe("normalizeDisplayMath", () => {
  it("turns a single-line bracketed formula into a math fence", () => {
    expect(normalizeDisplayMath("前文\n\\[ F = m a \\]\n后文")).toBe(
      "前文\n\n```math\nF = m a\n```\n\n后文",
    );
  });

  it("turns a multi-line bracketed formula into one math fence", () => {
    const markdown = ["\\[", "F_u = \\sum_{r \\in u} f_r", "\\]", "免费"].join("\n");
    expect(normalizeDisplayMath(markdown)).toBe("```math\nF_u = \\sum_{r \\in u} f_r\n```\n\n免费");
  });

  it("turns dollar display math into a math fence", () => {
    expect(normalizeDisplayMath("$$\nW_u = B \\cdot \\frac{s_u}{\\sum_v s_v}\n$$")).toBe(
      "```math\nW_u = B \\cdot \\frac{s_u}{\\sum_v s_v}\n```",
    );
  });

  it("leaves fenced code untouched", () => {
    const markdown = ["```tex", "\\[ x \\]", "```"].join("\n");
    expect(normalizeDisplayMath(markdown)).toBe(markdown);
  });

  it("leaves an unclosed formula alone while a reply streams", () => {
    expect(normalizeDisplayMath("\\[\nF = m a")).toBe("\\[\nF = m a");
  });

  it("does not touch inline dollars in prose", () => {
    expect(normalizeDisplayMath("cost $5 and $10")).toBe("cost $5 and $10");
  });

  it("lengthens the fence when the formula contains backticks", () => {
    expect(normalizeDisplayMath("\\[ a`b \\]")).toBe("```math\na`b\n```");
  });

  it("keeps text that follows a closing delimiter", () => {
    expect(normalizeDisplayMath("\\[ x \\] 其中 x 是标量")).toBe(
      "```math\nx\n```\n\n其中 x 是标量",
    );
  });

  it("parses into a math fence the transcript renderer can draw", () => {
    const parser = createMarkdownParser({ linkify: false });
    const tokens = parser.parse(normalizeDisplayMath("\\[\nF = m a\n\\]"), {});
    const fence = tokens.find((token) => token.type === "fence");
    expect(fence?.info).toBe("math");
    expect(fence?.content.trim()).toBe("F = m a");
  });
});
