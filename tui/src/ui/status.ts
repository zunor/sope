// SPDX-License-Identifier: MIT
// The two lines above the input while a turn runs:
//
//   ⠉⠉ Thinking… (1m 4s · 38 tok/s)
//      tip: ctrl+t shows the ABI trace
//
// A meteor circles a tiny Braille square (meteor.ts), the verb shimmers (a
// highlight sweeps across it), the time counts up in seconds, the rate is
// the model's recent output speed; below the verb a tip, another every
// TIP_CYCLE_S seconds.

import type { CellBuffer } from "../render/buffer";
import { mix } from "../render/color";
import { palette } from "../theme";
import { drawMeteor, METEOR_WIDTH } from "./meteor";
import { stringWidth, truncate } from "../unicode/width";

const SHIMMER_MS_PER_CELL = 70;
const SHIMMER_BAND = 3; // cells on each side of the highlight's center

/** Output speed over this window; none is shown once the stream pauses this long. */
const RATE_WINDOW_MS = 3000;
const RATE_IDLE_MS = 1500;

const TIP_CYCLE_S = 20;
export const TIPS = [
  "esc cancels the turn",
  "ctrl+t shows the ABI trace",
  "/thinking shows the full reasoning",
  "drag to select text, it is copied on release",
  "/compact frees context when the conversation grows long",
  "/context shows what fills the context window",
  "ctrl+j inserts a newline",
  "pgup/pgdn or the wheel scroll the transcript",
  "shift+tab switches who approves edits and commands",
  "alt+m or /model picks another model",
  "↓ on an empty input shows subagents and background shells",
];

/** 4s, 2m 4s, 1h 2m. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m ${s % 60}s`;
  return `${Math.floor(s / 3600)}h ${Math.floor((s % 3600) / 60)}m`;
}

/**
 * Rough token count of streamed text: about four characters per token for
 * Latin text, about one per CJK character. Only used for the rate shown.
 */
export function estimateTokens(text: string): number {
  let wide = 0;
  let narrow = 0;
  for (const ch of text) {
    if (ch.codePointAt(0)! >= 0x2e80) wide++;
    else narrow++;
  }
  return wide + narrow / 4;
}

/** Tokens per second of the text the model streams. */
export class TokenRate {
  #samples: Array<{ at: number; tokens: number }> = [];
  #burstStart = 0;

  add(text: string, now = performance.now(), pixel = false): void {
    const last = this.#samples.at(-1);
    if (!last || now - last.at > RATE_IDLE_MS) this.#burstStart = now;
    this.#samples.push({ at: now, tokens: estimateTokens(text) });
    this.#prune(now);
  }

  /** The current rate, or null when nothing streamed lately. */
  rate(now = performance.now()): number | null {
    this.#prune(now);
    const last = this.#samples.at(-1);
    if (!last || now - last.at > RATE_IDLE_MS) return null;
    const from = Math.max(now - RATE_WINDOW_MS, this.#burstStart);
    let tokens = 0;
    for (const s of this.#samples) if (s.at >= from) tokens += s.tokens;
    return tokens / (Math.max(500, now - from) / 1000);
  }

  clear(): void {
    this.#samples = [];
  }

  #prune(now: number): void {
    const keep = this.#samples.findIndex((s) => now - s.at <= RATE_WINDOW_MS);
    this.#samples = keep < 0 ? [] : this.#samples.slice(keep);
  }
}

/** The tip to show `elapsedMs` into a turn. */
export function tipAt(elapsedMs: number, turn: number): string {
  const s = Math.floor(elapsedMs / 1000);
  return TIPS[(turn + Math.floor(s / TIP_CYCLE_S)) % TIPS.length]!;
}

export interface Status {
  /** "Thinking", "Running bash", ... (an ellipsis is added). */
  verb: string;
  color: number;
  elapsedMs: number;
  rate: number | null;
}

/** How bright cell `i` of a `len`-cell text is at time `now` (0..1). */
export function shimmerAt(i: number, len: number, now: number): number {
  const span = len + 2 * SHIMMER_BAND;
  const center = ((now / SHIMMER_MS_PER_CELL) % span) - SHIMMER_BAND;
  const d = Math.abs(i - center);
  return d >= SHIMMER_BAND ? 0 : (1 + Math.cos((Math.PI * d) / SHIMMER_BAND)) / 2;
}

/** Draws the meteor and status text together on row y. */
export function drawStatus(buf: CellBuffer, x: number, y: number, width: number, s: Status, now = performance.now(), pixel = false): void {
  const end = x + width;
  x = (pixel ? x + METEOR_WIDTH : drawMeteor(buf, x, y, s.color, now)) + 1;

  const verb = `${s.verb}…`;
  const bright = mix(s.color, 0xffffff, 0.6);
  const cells = [...verb];
  cells.forEach((ch, i) => {
    x = buf.text(x, y, ch, { fg: mix(s.color, bright, shimmerAt(i, cells.length, now)) }, end);
  });

  const parts = [formatElapsed(s.elapsedMs)];
  if (s.rate !== null) parts.push(`${Math.round(s.rate)} tok/s`);
  buf.text(x, y, truncate(` (${parts.join(" · ")})`, end - x), { fg: palette.muted }, end);
}

/** The tip under the status, lined up with its verb. */
export function drawTip(buf: CellBuffer, x: number, y: number, width: number, tip: string): void {
  const end = x + width;
  x += METEOR_WIDTH + 1;
  const text = `tip: ${tip}`;
  // A tip that does not fit is left out rather than cut off.
  if (x + stringWidth(text) <= end) buf.text(x, y, text, { fg: palette.muted }, end);
}
