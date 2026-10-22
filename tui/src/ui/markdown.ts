// A small Markdown subset for assistant text, rendered to plain text plus
// style runs so it can be wrapped like any other text: headings, bullet and
// quote lines, fenced code blocks, **bold** and `inline code`. Anything else
// (including unclosed markers while a reply is still streaming) shows as is.

import type { Style } from "../render/buffer";
import { palette } from "../theme";

export interface Run {
  start: number;
  end: number;
  style: Style;
}

export interface Styled {
  text: string;
  runs: Run[]; // sorted, non-overlapping; uncovered text uses the base style
}

const HEADING: Style = { bold: true, fg: palette.accent };
const CODE: Style = { fg: palette.code };
const QUOTE: Style = { fg: palette.muted, italic: true };
const MARK: Style = { fg: palette.faint };

/** Appends `line` with **bold** and `code` spans resolved. */
function inline(out: Styled, line: string, base: Style | null): void {
  let i = 0;
  const push = (text: string, style: Style | null) => {
    if (!text) return;
    const start = out.text.length;
    out.text += text;
    if (style) out.runs.push({ start, end: out.text.length, style });
  };
  while (i < line.length) {
    if (line[i] === "`") {
      const close = line.indexOf("`", i + 1);
      if (close > i + 1) {
        push(line.slice(i + 1, close), { ...base, ...CODE });
        i = close + 1;
        continue;
      }
    } else if (line.startsWith("**", i)) {
      const close = line.indexOf("**", i + 2);
      if (close > i + 2) {
        push(line.slice(i + 2, close), { ...base, bold: true });
        i = close + 2;
        continue;
      }
    }
    let j = i + 1;
    while (j < line.length && line[j] !== "`" && !line.startsWith("**", j)) j++;
    push(line.slice(i, j), base);
    i = j;
  }
}

export function renderMarkdown(src: string): Styled {
  const out: Styled = { text: "", runs: [] };
  let inFence = false;
  const lines = src.split("\n");

  lines.forEach((line, n) => {
    const fence = /^\s*```/.test(line);
    if (fence) {
      inFence = !inFence;
      return; // fence lines themselves are not shown
    }
    if (n > 0 && out.text.length > 0) out.text += "\n";
    const start = out.text.length;

    if (inFence) {
      out.text += line;
      out.runs.push({ start, end: out.text.length, style: CODE });
      return;
    }
    let m: RegExpMatchArray | null;
    if ((m = line.match(/^(#{1,6})\s+(.*)$/))) {
      inline(out, m[2]!, HEADING);
    } else if ((m = line.match(/^(\s*)[-*+]\s+(.*)$/))) {
      out.text += `${m[1]}• `;
      out.runs.push({ start: start + m[1]!.length, end: out.text.length, style: MARK });
      inline(out, m[2]!, null);
    } else if ((m = line.match(/^>\s?(.*)$/))) {
      out.text += "│ ";
      out.runs.push({ start, end: out.text.length, style: MARK });
      inline(out, m[1]!, QUOTE);
    } else if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.text += "─".repeat(24);
      out.runs.push({ start, end: out.text.length, style: MARK });
    } else {
      inline(out, line, null);
    }
  });
  return out;
}

/** Splits [start, end) of a styled text into spans with their styles. */
export function slice(s: Styled, start: number, end: number, base: Style): Array<{ text: string; style: Style }> {
  const spans: Array<{ text: string; style: Style }> = [];
  let pos = start;
  for (const run of s.runs) {
    if (run.end <= pos) continue;
    if (run.start >= end) break;
    if (run.start > pos) spans.push({ text: s.text.slice(pos, run.start), style: base });
    const from = Math.max(pos, run.start);
    const to = Math.min(end, run.end);
    spans.push({ text: s.text.slice(from, to), style: { ...base, ...run.style } });
    pos = to;
  }
  if (pos < end) spans.push({ text: s.text.slice(pos, end), style: base });
  return spans;
}
