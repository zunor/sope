// Soft wrapping by display width. Lines break after spaces, and anywhere
// around wide (CJK) characters; a word longer than the width is split.

import { graphemeWidth, segments } from "../unicode/width";

/** One visual row: text.slice(start, end), `width` columns wide. Newlines are never part of a row. */
export interface Row {
  start: number;
  end: number;
  width: number;
}

function wrapLine(line: string, offset: number, width: number, rows: Row[]): void {
  let start = 0;
  let col = 0;
  let breakAt = -1; // offset just after the last break opportunity in this row
  let breakCol = 0;

  for (const [g, i] of segments(line)) {
    const w = graphemeWidth(g);
    while (col > 0 && col + w > width) {
      if (g === " ") break; // a space may overhang the edge; it is invisible
      if (w === 2 || breakAt <= start) {
        rows.push({ start: offset + start, end: offset + i, width: col });
        start = i;
        col = 0;
      } else {
        rows.push({ start: offset + start, end: offset + breakAt, width: breakCol });
        col -= breakCol;
        start = breakAt;
      }
      breakAt = -1;
    }
    col += w;
    if (g === " " || w === 2) {
      breakAt = i + g.length;
      breakCol = col;
    }
    if (g === " " && col > width) {
      rows.push({ start: offset + start, end: offset + i + 1, width: col - 1 });
      start = i + 1;
      col = 0;
      breakAt = -1;
    }
  }
  rows.push({ start: offset + start, end: offset + line.length, width: col });
}

export function wrapText(text: string, width: number): Row[] {
  const rows: Row[] = [];
  const w = Math.max(1, width);
  let offset = 0;
  for (const line of text.split("\n")) {
    wrapLine(line, offset, w, rows);
    offset += line.length + 1;
  }
  return rows;
}
