// SPDX-License-Identifier: MIT
// Double-buffered renderer: the app draws a full frame into the back buffer,
// and end() writes only the cells that changed since the previous frame,
// wrapped in synchronized-output markers so the terminal never shows a
// half-drawn frame.

import { BOLD, CellBuffer, DIM, INVERSE, ITALIC, UNDERLINE } from "./buffer";
import type { KittyGraphics, PixelImage } from "./graphics";
import { to256 } from "./color";

export interface Cursor {
  x: number;
  y: number;
  visible: boolean;
}

export class Renderer {
  #front: CellBuffer | null = null;
  image: PixelImage | null = null;
  images: PixelImage[] = [];
  #back: CellBuffer;
  cursor: Cursor = { x: 0, y: 0, visible: false };

  constructor(
    private readonly write: (s: string) => void,
    private readonly truecolor: boolean,
    private readonly graphics?: KittyGraphics,
  ) {
    this.#back = new CellBuffer(0, 0);
  }

  /** Starts a frame and returns the cleared back buffer to draw into. */
  begin(width: number, height: number): CellBuffer {
    if (this.#back.width !== width || this.#back.height !== height) this.#back.resize(width, height);
    else this.#back.clear();
    this.cursor = { x: 0, y: 0, visible: false };
    this.image = null;
    this.images = [];
    return this.#back;
  }

  /** The frame on screen, as last flushed by end(). */
  get screen(): CellBuffer | null {
    return this.#front;
  }

  /** Forces the next frame to repaint everything (after resize, or when the screen was disturbed). */
  invalidate(): void {
    this.#front = null;
  }

  /** Flushes the frame. Returns the number of bytes written. */
  end(): number {
    const b = this.#back;
    const f = this.#front;
    const full = !f || f.width !== b.width || f.height !== b.height;
    const W = b.width;

    let out = "\x1b[?2026h\x1b[?25l";
    if (full) out += "\x1b[0m\x1b[H\x1b[2J";

    let cx = -1;
    let cy = -1;
    let sgr = "";
    for (let y = 0; y < b.height; y++) {
      for (let x = 0; x < W; ) {
        const i = y * W + x;
        const ch = b.chars[i]!;
        if (ch === "") {
          x++;
          continue;
        }
        const wide = x + 1 < W && b.chars[i + 1] === "";
        const fg = b.fg[i]!;
        const bg = b.bg[i]!;
        const attr = b.attr[i]!;
        const unchanged = full
          ? ch === " " && fg < 0 && bg < 0 && attr === 0 // the screen was just cleared
          : f!.chars[i] === ch &&
            f!.fg[i] === fg &&
            f!.bg[i] === bg &&
            f!.attr[i] === attr &&
            (!wide || f!.chars[i + 1] === "");
        if (!unchanged) {
          if (cy !== y || cx !== x) out += `\x1b[${y + 1};${x + 1}H`;
          const s = this.#sgr(fg, bg, attr);
          if (s !== sgr) {
            out += s;
            sgr = s;
          }
          out += ch;
          cx = x + (wide ? 2 : 1);
          cy = y;
        }
        x += wide ? 2 : 1;
      }
    }

    out += this.graphics?.render([...this.images, ...(this.image ? [this.image] : [])], full) ?? "";
    out += "\x1b[0m";
    if (this.cursor.visible) out += `\x1b[${this.cursor.y + 1};${this.cursor.x + 1}H\x1b[?25h`;
    out += "\x1b[?2026l";
    this.write(out);

    // Swap buffers; the old front becomes the next back buffer.
    const old = this.#front;
    this.#front = b;
    this.#back = old && old.width === W && old.height === b.height ? old : new CellBuffer(W, b.height);
    return Buffer.byteLength(out);
  }

  #sgr(fg: number, bg: number, attr: number): string {
    let s = "\x1b[0";
    if (attr & BOLD) s += ";1";
    if (attr & DIM) s += ";2";
    if (attr & ITALIC) s += ";3";
    if (attr & UNDERLINE) s += ";4";
    if (attr & INVERSE) s += ";7";
    if (fg >= 0) s += this.truecolor ? `;38;2;${(fg >> 16) & 255};${(fg >> 8) & 255};${fg & 255}` : `;38;5;${to256(fg)}`;
    if (bg >= 0) s += this.truecolor ? `;48;2;${(bg >> 16) & 255};${(bg >> 8) & 255};${bg & 255}` : `;48;5;${to256(bg)}`;
    return `${s}m`;
  }
}
