// SPDX-License-Identifier: MIT
// The activity indicator in front of the status line: a meteor streaking
// across a short track, its tail thinning and fading behind the head.
//
//   ✦·······   ━✦──────   ─━━✦    ·─━━✦   ···─━━✦   (gone, a pause, again)
//
// The head is a bright spark. The tail is drawn thick to thin (━ ─ ·) and
// fades from the head's color into the faint rule color, so the streak reads
// as one glowing line in motion. Between passes the track stays empty for a
// moment, the way meteors come and go.

import type { CellBuffer } from "../render/buffer";
import { mix } from "../render/color";
import { palette } from "../theme";

export const METEOR_WIDTH = 7;
const TAIL = ["━", "━", "─", "─", "·", "·"]; // nearest the head first
const STEP_MS = 55; // one cell of travel
const PAUSE_MS = 650; // empty sky between passes
const TRAVEL = METEOR_WIDTH + TAIL.length; // until the tail has left the track
const PERIOD_MS = TRAVEL * STEP_MS + PAUSE_MS;

export interface MeteorCell {
  glyph: string;
  /** 0 = faint, 1 = the meteor's color, above 1 = brighter (the head). */
  glow: number;
}

/** What cell `i` of the track shows at time `now`. */
export function meteorCell(i: number, now: number): MeteorCell {
  const t = ((now % PERIOD_MS) + PERIOD_MS) % PERIOD_MS;
  const head = Math.floor(t / STEP_MS); // past the end during the pause
  const behind = head - i;
  if (head >= TRAVEL || behind < 0 || behind > TAIL.length) return { glyph: " ", glow: 0 };
  if (behind === 0) return { glyph: "✦", glow: 1.5 };
  return { glyph: TAIL[behind - 1]!, glow: 1 - (behind - 1) / TAIL.length };
}

/** Draws the track in shades of `color`; returns the x after it. */
export function drawMeteor(buf: CellBuffer, x: number, y: number, color: number, now = performance.now()): number {
  for (let i = 0; i < METEOR_WIDTH; i++) {
    const { glyph, glow } = meteorCell(i, now);
    const fg = glow > 1 ? mix(color, 0xffffff, (glow - 1) * 1.2) : mix(palette.faint, color, 0.15 + 0.85 * glow);
    x = buf.text(x, y, glyph, { fg });
  }
  return x;
}
