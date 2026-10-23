// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { mix } from "../src/render/color";
import { CellBuffer } from "../src/render/buffer";
import type { CellBuffer as Buf } from "../src/render/buffer";
import { drawStatus, estimateTokens, formatElapsed, shimmerAt, tipAt, TIPS, TokenRate } from "../src/ui/status";

const row = (buf: Buf, y: number) => buf.chars.slice(y * buf.width, (y + 1) * buf.width).join("").trimEnd();

test("elapsed time counts in whole seconds", () => {
  expect(formatElapsed(0)).toBe("0s");
  expect(formatElapsed(4999)).toBe("4s");
  expect(formatElapsed(124_000)).toBe("2m 4s");
  expect(formatElapsed(3_725_000)).toBe("1h 2m");
});

test("token estimate counts CJK characters as tokens", () => {
  expect(estimateTokens("abcdefgh")).toBe(2);
  expect(estimateTokens("你好")).toBe(2);
});

test("the rate covers recent output and disappears when the stream pauses", () => {
  const r = new TokenRate();
  expect(r.rate(0)).toBeNull();
  for (let t = 0; t <= 2000; t += 100) r.add("abcd".repeat(5), t); // 5 tokens every 100 ms
  expect(r.rate(2000)!).toBeCloseTo(52.5, 0); // 21 samples over the 2 s burst
  expect(r.rate(5000)).toBeNull();
});

test("tips show for a third of each cycle and rotate", () => {
  expect(tipAt(5_000, 0)).toBeNull();
  expect(tipAt(12_000, 0)).toBe(TIPS[0]!);
  expect(tipAt(25_000, 0)).toBeNull();
  expect(tipAt(42_000, 0)).toBe(TIPS[1]!);
  expect(tipAt(12_000, 3)).toBe(TIPS[3]!);
});

test("the shimmer is a moving bright band", () => {
  const at = (now: number) => Array.from({ length: 8 }, (_, i) => shimmerAt(i, 8, now));
  const a = at(70 * 5); // centered on cell 2
  expect(a[2]).toBe(1);
  expect(a[6]).toBe(0);
  const b = at(70 * 9); // centered on cell 6
  expect(b[6]).toBe(1);
  expect(b[2]).toBe(0);
});

test("colors mix", () => {
  expect(mix(0x000000, 0xffffff, 0.5)).toBe(0x808080);
  expect(mix(0x102030, 0xffffff, 0)).toBe(0x102030);
  expect(mix(-1, 0xffffff, 0.5)).toBe(-1);
});

test("the status line reads verb, time, rate and tip", () => {
  const buf = new CellBuffer(80, 2);
  drawStatus(buf, 0, 0, 80, { verb: "Thinking", color: 0xa78bfa, elapsedMs: 64_000, rate: 37.6, tip: "esc cancels the turn" }, 250);
  expect(row(buf, 0)).toBe("⠏  Thinking… (1m 4s · 38 tok/s · tip: esc cancels the turn)");
  expect(row(buf, 1)).toBe("");
  buf.clear();
  drawStatus(buf, 0, 0, 30, { verb: "Thinking", color: 0xa78bfa, elapsedMs: 3_000, rate: null, tip: "esc cancels the turn" }, 750);
  expect(row(buf, 0)).toBe("⠉⠉ Thinking… (3s)");
  expect(row(buf, 1)).toBe("");
});

import { METEOR_ROWS, METEOR_WIDTH, meteorCells } from "../src/ui/meteor";

/** The single-row track at time `now`. */
const frame = (now: number) => {
  const g = Array.from({ length: METEOR_ROWS }, () => Array<string>(METEOR_WIDTH).fill(" "));
  for (const c of meteorCells(now)) g[c.y]![c.x] = c.glyph;
  return g.map((r) => r.join(""));
};

test("the meteor circles all four sides of a square within one terminal row", () => {
  expect([METEOR_WIDTH, METEOR_ROWS]).toEqual([2, 1]);
  expect(frame(0)).toEqual(["⡇ "]); // left edge
  expect(frame(750)).toEqual(["⠉⠉"]); // top edge
  expect(frame(1500)).toEqual([" ⢸"]); // right edge
  expect(frame(2250)).toEqual(["⣀⣀"]); // bottom edge
  expect(frame(3000)).toEqual(frame(0)); // continuous orbit
});

test("the head's cell is brighter than the tail and the orbit wraps smoothly", () => {
  const cells = meteorCells(750);
  expect(cells[1]!.glow).toBeGreaterThan(1);
  expect(cells[1]!.glow).toBeGreaterThan(cells[0]!.glow);
  expect(frame(-250)).toEqual(frame(2750));
  for (let now = 0; now < 3000; now += 250) {
    const buf = new CellBuffer(2, 1);
    for (const c of meteorCells(now)) buf.text(c.x, c.y, c.glyph);
    expect(buf.chars.join("")).toBe(frame(now)[0]!);
  }
});

import { luminance, parseOscColor } from "../src/render/color";

test("OSC color replies parse at any channel width", () => {
  expect(parseOscColor("11;rgb:1e1e/1e1e/1e1e")).toBe(0x1e1e1e);
  expect(parseOscColor("11;rgb:ff/80/00")).toBe(0xff8000);
  expect(parseOscColor("11;rgb:f/f/f")).toBe(0xffffff);
  expect(parseOscColor("11;?")).toBeNull();
  expect(luminance(0xffffff)).toBeCloseTo(1);
  expect(luminance(0)).toBe(0);
});
