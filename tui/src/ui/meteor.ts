// SPDX-License-Identifier: MIT
// A meteor circles a square inside two Braille characters. Each character
// holds 2×4 dots, giving us a 4×4 track without using a second terminal row.

import type { CellBuffer } from "../render/buffer";
import { mix } from "../render/color";
import { palette } from "../theme";

export const METEOR_WIDTH = 2;
export const METEOR_ROWS = 1;

// Clockwise around a 4×4 dot square, starting at the top left.
const TRACK: ReadonlyArray<readonly [number, number]> = [
  [0, 0], [1, 0], [2, 0], [3, 0],
  [3, 1], [3, 2], [3, 3],
  [2, 3], [1, 3], [0, 3],
  [0, 2], [0, 1],
];
// Braille bit positions by row, left then right dot.
const DOT_BITS = [[0, 3], [1, 4], [2, 5], [6, 7]] as const;
const TAIL = 3;
const STEP_MS = 250; // three seconds per orbit, matching the pixel animation
const PERIOD_MS = TRACK.length * STEP_MS;

export interface MeteorCell {
  x: number;
  y: number;
  glyph: string;
  /** 0 = faint, 1 = the meteor's color, above 1 = brighter (the head). */
  glow: number;
}

/** Pack the moving head and trailing dots into single-row terminal cells. */
export function meteorCells(now: number): MeteorCell[] {
  const t = ((now % PERIOD_MS) + PERIOD_MS) % PERIOD_MS;
  const head = Math.floor(t / STEP_MS);
  const masks = [0, 0];
  const glows = [0, 0];
  for (let k = 0; k <= TAIL; k++) {
    const [dotX, dotY] = TRACK[(head - k + TRACK.length) % TRACK.length]!;
    const x = Math.floor(dotX / 2);
    masks[x] = masks[x]! | (1 << DOT_BITS[dotY]![dotX % 2]!);
    // A terminal colors whole characters, so each cell uses its brightest dot.
    glows[x] = Math.max(glows[x]!, k === 0 ? 1.5 : 1 - (k - 1) / TAIL);
  }
  return masks.flatMap((mask, x) => mask ? [{
    x, y: 0, glyph: String.fromCodePoint(0x2800 + mask), glow: glows[x]!,
  }] : []);
}

/** Draws the meteor on row y in shades of `color`; returns the x after it. */
export function drawMeteor(buf: CellBuffer, x: number, y: number, color: number, now = performance.now()): number {
  for (const c of meteorCells(now)) {
    const fg = c.glow > 1 ? mix(color, 0xffffff, (c.glow - 1) * 1.2) : mix(palette.faint, color, 0.15 + 0.85 * c.glow);
    buf.text(x + c.x, y + c.y, c.glyph, { fg });
  }
  return x + METEOR_WIDTH;
}
