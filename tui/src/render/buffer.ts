// A grid of terminal cells. Each cell holds one grapheme plus its colors and
// attributes. A wide grapheme occupies its cell and the next one, which
// holds "" (a continuation cell).

import { graphemeWidth, graphemes } from "../unicode/width";
import { DEFAULT_COLOR } from "./color";

export const BOLD = 1;
export const DIM = 2;
export const ITALIC = 4;
export const UNDERLINE = 8;
export const INVERSE = 16;

export interface Style {
  fg?: number;
  bg?: number;
  bold?: boolean;
  dim?: boolean;
  italic?: boolean;
  underline?: boolean;
  inverse?: boolean;
}

export function attrOf(s: Style): number {
  return (
    (s.bold ? BOLD : 0) |
    (s.dim ? DIM : 0) |
    (s.italic ? ITALIC : 0) |
    (s.underline ? UNDERLINE : 0) |
    (s.inverse ? INVERSE : 0)
  );
}

export class CellBuffer {
  width = 0;
  height = 0;
  chars: string[] = [];
  fg = new Int32Array(0);
  bg = new Int32Array(0);
  attr = new Uint8Array(0);

  constructor(width: number, height: number) {
    this.resize(width, height);
  }

  resize(width: number, height: number): void {
    this.width = width;
    this.height = height;
    const n = width * height;
    this.chars = new Array<string>(n);
    this.fg = new Int32Array(n);
    this.bg = new Int32Array(n);
    this.attr = new Uint8Array(n);
    this.clear();
  }

  clear(): void {
    this.chars.fill(" ");
    this.fg.fill(DEFAULT_COLOR);
    this.bg.fill(DEFAULT_COLOR);
    this.attr.fill(0);
  }

  /** Draws s starting at (x, y), clipped to [0, limit). Returns the column after the text. */
  text(x: number, y: number, s: string, style: Style = {}, limit = this.width): number {
    if (y < 0 || y >= this.height) return x;
    const end = Math.min(limit, this.width);
    const fg = style.fg ?? DEFAULT_COLOR;
    const bg = style.bg ?? DEFAULT_COLOR;
    const attr = attrOf(style);
    for (const g of graphemes(s)) {
      const w = graphemeWidth(g);
      if (w === 0) continue;
      if (x + w > end) {
        if (x >= 0 && x < end) this.#put(x, y, " ", 1, fg, bg, attr); // half of a wide char does not fit
        return end;
      }
      if (x >= 0) this.#put(x, y, g, w, fg, bg, attr);
      x += w;
    }
    return x;
  }

  /** Fills a rectangle with ch (a narrow grapheme) in the given style. */
  fill(x: number, y: number, w: number, h: number, style: Style = {}, ch = " "): void {
    const fg = style.fg ?? DEFAULT_COLOR;
    const bg = style.bg ?? DEFAULT_COLOR;
    const attr = attrOf(style);
    const x0 = Math.max(0, x);
    const x1 = Math.min(this.width, x + w);
    for (let row = Math.max(0, y); row < Math.min(this.height, y + h); row++)
      for (let col = x0; col < x1; col++) this.#put(col, row, ch, 1, fg, bg, attr);
  }

  #put(x: number, y: number, ch: string, w: number, fg: number, bg: number, attr: number): void {
    const W = this.width;
    const i = y * W + x;
    // Never leave half of a wide grapheme behind.
    if (this.chars[i] === "" && x > 0) this.chars[i - 1] = " ";
    if (x + 1 < W && this.chars[i + 1] === "") this.chars[i + 1] = " ";
    this.chars[i] = ch;
    this.fg[i] = fg;
    this.bg[i] = bg;
    this.attr[i] = attr;
    if (w === 2 && x + 1 < W) {
      const k = i + 1;
      if (x + 2 < W && this.chars[k + 1] === "") this.chars[k + 1] = " ";
      this.chars[k] = "";
      this.fg[k] = fg;
      this.bg[k] = bg;
      this.attr[k] = attr;
    }
  }
}
