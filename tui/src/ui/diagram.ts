// SPDX-License-Identifier: MIT
// Diagram presentation is derived from message text; it never edits history.
import { graphemeWidth, segments, stringWidth } from "../unicode/width";

const MAX_ROWS = 256;
const MAX_COLS = 512;
const TOP = /^\s*(?:[┌╭][─]{2,}|╔═{2,}|\+-{2,})/u;
const DRAWING = /[│─┌┐└┘╭╮╰╯╔╗╚╝║═┬┴├┤┼▲▼►◄→←↑↓]|[|+].*[-|+]/u;

/** Expand tabs at cell-based tab stops, retaining grapheme clusters. */
export function expandDiagramTabs(text: string): string {
  return text.split("\n").map((line) => {
    let col = 0;
    return segments(line).map(([g]) => {
      if (g === "\t") g = " ".repeat(4 - col % 4);
      col += stringWidth(g);
      return g;
    }).join("");
  }).join("\n");
}

export interface DiagramBlock {
  first: number;
  last: number; // exclusive source line index, including fences
  text: string;
  complete: boolean;
}

function looksLikeDiagram(lines: string[]): boolean {
  return lines.some((line) => TOP.test(line)) && lines.filter((line) => DRAWING.test(line)).length >= 2;
}

/** Recognize fenced diagrams and standalone runs beginning with a box top. */
export function diagramBlocks(lines: string[], streaming: boolean): DiagramBlock[] {
  const blocks: DiagramBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(lines[i]!);
    if (fence) {
      const close = new RegExp(`^ {0,3}${fence[1]![0]}{${fence[1]!.length},}\\s*$`);
      let end = i + 1;
      while (end < lines.length && !close.test(lines[end]!)) end++;
      const body = lines.slice(i + 1, end);
      const complete = end < lines.length || !streaming;
      // Plain diagram fences only: source code containing drawings stays code.
      if (/^(?:text|plaintext|ascii|diagram)?\s*$/i.test(fence[2]!.trim()) && looksLikeDiagram(body)) {
        if (!complete) body.pop(); // retain complete rows while tokens arrive
        blocks.push({ first: i, last: Math.min(end + 1, lines.length), text: expandDiagramTabs(body.join("\n")), complete });
      }
      i = end;
      continue;
    }
    if (!TOP.test(lines[i]!)) continue;
    let end = i + 1;
    while (end < lines.length && lines[end]!.trim() && DRAWING.test(lines[end]!)) end++;
    // A final label directly below a vertical arrow belongs to the same grid.
    if (end < lines.length && /^\s+[\w][\w /()-]*$/.test(lines[end]!) && /[▼↓v]\s*$/.test(lines[end - 1]!)) end++;
    const complete = !streaming || end < lines.length - 1 || (end < lines.length && lines[end]!.trim() !== "");
    const body = lines.slice(i, end);
    if (!complete && end === lines.length) body.pop();
    if (looksLikeDiagram(body)) blocks.push({ first: i, last: end, text: expandDiagramTabs(body.join("\n")), complete });
    i = end - 1;
  }
  return blocks;
}

/** One array entry per terminal cell; a wide glyph's trailing cell is empty. */
function cells(line: string): string[] {
  const out: string[] = [];
  for (const [g] of segments(line)) {
    const w = graphemeWidth(g);
    if (!w) { if (out.length) out[out.length - 1] += g; continue; }
    out.push(g);
    for (let n = 1; n < w; n++) out.push("");
  }
  return out;
}

const STYLES = [
  { tl: "┌", tr: "┐", bl: "└", br: "┘", h: "─", v: "│", top: "┬", bottom: "┴" },
  { tl: "╭", tr: "╮", bl: "╰", br: "╯", h: "─", v: "│", top: "┬", bottom: "┴" },
  { tl: "╔", tr: "╗", bl: "╚", br: "╝", h: "═", v: "║", top: "╦", bottom: "╩" },
  { tl: "+", tr: "+", bl: "+", br: "+", h: "-", v: "|", top: "+", bottom: "+" },
];

/** Repair rectangles with agreeing left corners and right corners within two cells. Labels never move.
 * Each box is transactional: conflicting walls or occupied destinations reject it.
 * Only expand to an existing corner column; never infer arrow routing. */
function repairOnce(text: string): string {
  const lines = text.split("\n");
  if (/[\x00-\x1f]/.test(text.replaceAll("\n", "")) || lines.length > MAX_ROWS || text.length > MAX_ROWS * MAX_COLS || lines.some((l) => stringWidth(l) > MAX_COLS)) return text;
  const grid = lines.map(cells);
  if (grid.map((row) => row.join("")).join("\n") !== text) return text;
  for (const s of STYLES) for (let y = 0; y < grid.length - 2; y++) {
    const row = grid[y]!;
    for (let left = 0; left < row.length; left++) {
      if (row[left] !== s.tl || row[left + 1] !== s.h) continue;
      const topRight = row.indexOf(s.tr, left + 3);
      if (topRight < 0) continue;
      // Interior titles are allowed, but not another box or a vertical crossing.
      const top = row.slice(left + 1, topRight);
      if (top.some((c) => [s.tl, s.bl, s.br, s.v].includes(c))) continue;
      let bottom = y + 2;
      let bottomRight = -1;
      for (; bottom < grid.length; bottom++) {
        if (grid[bottom]![left] !== s.bl) continue;
        const candidates: number[] = [];
        for (let x = Math.max(left + 3, topRight - 2); x <= topRight + 2; x++) if (grid[bottom]![x] === s.br) candidates.push(x);
        if (candidates.length === 1) bottomRight = candidates[0]!;
        break; // never match past another lower-left corner
      }
      if (bottomRight < 0) continue;
      const base = grid[bottom]!.slice(left + 1, bottomRight);
      if (base.some((c) => c !== s.h && c !== s.bottom && c !== s.top && c !== " ")) continue;
      const right = Math.max(topRight, bottomRight);
      const edits: Array<[number, number, string]> = [];
      const shorterRow = topRight < right ? y : bottom;
      const shorterCol = Math.min(topRight, bottomRight);
      if (shorterCol < right) {
        const adjacent = grid[shorterRow === y ? y - 1 : bottom + 1]?.[shorterCol] ?? " ";
        if (/[│║|▲▼↑↓^v]/u.test(adjacent)) continue;
        if (grid[shorterRow]!.slice(shorterCol + 1, right + 1).some((c) => c !== " ")) continue;
        for (let x = shorterCol; x < right; x++) edits.push([shorterRow, x, s.h]);
        edits.push([shorterRow, right, shorterRow === y ? s.tr : s.br]);
      }
      let valid = true;
      const moved = new Set<string>();
      for (const x of [left, right]) for (let r = y + 1; r < bottom; r++) {
        const line = grid[r]!;
        if (line[x] === s.v) continue;
        if ((line[x] ?? " ") !== " ") { valid = false; break; }
        const near: number[] = [];
        for (let dx = -2; dx <= 2; dx++) if (dx && line[x + dx] === s.v) near.push(x + dx);
        if (near.length !== 1) { valid = false; break; }
        const from = near[0]!;
        const cell = `${r}:${from}`;
        if (moved.has(cell) || from === left || from === right) { valid = false; break; }
        moved.add(cell);
        const above = grid[r - 1]?.[from] ?? " ";
        const below = grid[r + 1]?.[from] ?? " ";
        if ((r - 1 !== y && /[┌┐└┘╭╮╰╯╔╗╚╝+]/u.test(above)) ||
          (r + 1 !== bottom && /[┌┐└┘╭╮╰╯╔╗╚╝+]/u.test(below))) { valid = false; break; }
        if (/[─═\-+<>◄►←→┬┴├┤┼]/u.test((line[from - 1] ?? " ") + (line[from + 1] ?? " "))) { valid = false; break; }
        // Only whitespace may be crossed. Wide-character continuation cells are occupied.
        if (line.slice(Math.min(from, x) + 1, Math.max(from, x)).some((c) => c !== " ")) { valid = false; break; }
        edits.push([r, from, " "], [r, x, s.v]);
      }
      if (!valid) continue;
      // Fill a single horizontal gap only when both immediate neighbors are edges.
      for (const r of [y, bottom]) for (let x = left + 2; x < right - 1; x++) {
        if (grid[r]![x] === " " && grid[r]![x - 1] === s.h && grid[r]![x + 1] === s.h) edits.push([r, x, s.h]);
      }
      for (const [r, x, ch] of edits) {
        while (grid[r]!.length <= x) grid[r]!.push(" ");
        grid[r]![x] = ch;
      }
    }
  }
  return grid.map((row) => row.join("")).join("\n");
}

/** Reject unstable proposals instead of repeatedly moving a diagram on repaint. */
export function repairDiagram(text: string): string {
  const repaired = repairOnce(text);
  return repaired === text || repairOnce(repaired) === repaired ? repaired : text;
}

export class DiagramFrame {
  source = "";
  original: string[] = [];
  repaired: string[] = [];
  width = 0;
  offset = 0;
  showOriginal = false;
  complete = false;
  update(text: string, complete: boolean): void {
    if (this.source === text && this.complete === complete) return;
    if (!text.startsWith(this.source)) this.offset = 0;
    this.source = text;
    this.complete = complete;
    this.original = text.split("\n");
    this.repaired = (complete ? repairDiagram(text) : text).split("\n");
    this.width = [...this.original, ...this.repaired].reduce((width, row) => Math.max(width, stringWidth(row)), 0);
  }
  get changed(): boolean { return this.repaired.join("\n") !== this.source; }
  get rows(): string[] { return this.showOriginal ? this.original : this.repaired; }
}

/** Clip in display cells without splitting wide or combined graphemes. */
export function diagramSlice(text: string, start: number, width: number): string {
  let col = 0;
  let out = "";
  for (const [g] of segments(text)) {
    const w = graphemeWidth(g);
    if (col >= start + width) break;
    if (col + w > start) out += col < start || col + w > start + width ? " ".repeat(Math.min(col + w, start + width) - Math.max(col, start)) : g;
    col += w;
  }
  return out;
}
