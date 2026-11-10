/**
 * Rewrites LaTeX display math into a fenced `math` block the fence renderer
 * draws with KaTeX.
 *
 * Agents write display math the way LaTeX does — `\[ ... \]` or `$$ ... $$`,
 * often across several lines. Markdown has no math rule, so `\[` is just an
 * escaped bracket and the formula reaches the transcript as literal source.
 * Fenced blocks already have a first-class renderer, so the least invasive fix
 * is to hand the formula to that path instead of teaching the parser a new
 * inline node.
 *
 * Only a delimiter at the start of a line is treated as display math; that is
 * the convention the agents follow, and it keeps `$5` in prose untouched.
 * Fenced code is skipped so a formula shown as source stays source, and an
 * unclosed delimiter is left alone: while a reply streams, the closing line
 * arrives after the opening one.
 */

const CODE_FENCE = /^\s{0,3}(```|~~~)/;
const DISPLAY_MATH_OPEN = /^\s{0,3}(\\\[|\$\$)/;

const MATH_FENCE = "math";

export function normalizeDisplayMath(markdown: string): string {
  if (!markdown.includes("\\[") && !markdown.includes("$$")) {
    return markdown;
  }

  const lines = markdown.split("\n");
  const output: string[] = [];
  let codeFence: string | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];

    const fence = line.match(CODE_FENCE);
    if (fence) {
      if (codeFence === null) {
        codeFence = fence[1];
      } else if (line.trimStart().startsWith(codeFence)) {
        codeFence = null;
      }
      output.push(line);
      continue;
    }
    if (codeFence !== null) {
      output.push(line);
      continue;
    }

    const opening = line.match(DISPLAY_MATH_OPEN);
    if (!opening) {
      output.push(line);
      continue;
    }

    const delimiter = opening[1];
    const closingDelimiter = delimiter === "\\[" ? "\\]" : "$$";
    const afterOpening = line.slice(line.indexOf(delimiter) + delimiter.length);

    const inlineClose = afterOpening.indexOf(closingDelimiter);
    if (inlineClose >= 0) {
      const tex = afterOpening.slice(0, inlineClose).trim();
      const trailing = afterOpening.slice(inlineClose + closingDelimiter.length).trim();
      if (tex) {
        output.push("", fenceFor(tex, MATH_FENCE), "");
        if (trailing) {
          output.push(trailing);
        }
      } else {
        output.push(line);
      }
      continue;
    }

    const texLines: string[] = [];
    let closingLine = -1;
    let trailing = "";
    for (let next = index + 1; next < lines.length; next += 1) {
      const close = lines[next].indexOf(closingDelimiter);
      if (close >= 0) {
        texLines.push(lines[next].slice(0, close));
        trailing = lines[next].slice(close + closingDelimiter.length).trim();
        closingLine = next;
        break;
      }
      texLines.push(lines[next]);
    }

    if (closingLine < 0) {
      output.push(line);
      continue;
    }

    const tex = [afterOpening, ...texLines].join("\n").trim();
    if (tex) {
      output.push("", fenceFor(tex, MATH_FENCE), "");
      if (trailing) {
        output.push(trailing);
      }
    } else {
      output.push(line);
    }
    index = closingLine;
  }

  return output.join("\n").replace(/^\n+/, "").replace(/\n+$/, "");
}

function fenceFor(tex: string, language: string): string {
  // A fence long enough to survive backticks in the formula itself.
  const longestRun = Math.max(0, ...(tex.match(/`+/g) ?? []).map((run) => run.length));
  const fence = "`".repeat(Math.max(3, longestRun + 1));
  return `${fence}${language}\n${tex}\n${fence}`;
}
