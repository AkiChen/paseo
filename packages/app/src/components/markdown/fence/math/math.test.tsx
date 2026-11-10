// @vitest-environment jsdom
import { render } from "@testing-library/react";
import React from "react";
import { describe, expect, it } from "vitest";
import { MarkdownMath } from "./render";

describe("display math on web", () => {
  it("draws a LaTeX formula as MathML instead of source text", () => {
    const { container } = render(<MarkdownMath tex={"F_u = \\sum_{r \\in u} f_r"} />);
    expect(container.querySelector("math")).not.toBeNull();
    // KaTeX keeps the source in an annotation; the visible tree is the MathML run.
    expect(container.querySelectorAll("mi, mo, mn").length).toBeGreaterThan(0);
    expect(container.querySelector('annotation[encoding="application/x-tex"]')?.textContent).toBe(
      "F_u = \\sum_{r \\in u} f_r",
    );
  });
});
