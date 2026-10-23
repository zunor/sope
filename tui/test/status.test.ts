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
  const buf = new CellBuffer(80, 1);
  drawStatus(buf, 0, 0, 80, { verb: "Thinking", color: 0xa78bfa, elapsedMs: 64_000, rate: 37.6, tip: "esc cancels the turn" }, 0);
  expect(row(buf, 0)).toBe("✦       Thinking… (1m 4s · 38 tok/s · tip: esc cancels the turn)");
  buf.clear();
  drawStatus(buf, 0, 0, 30, { verb: "Thinking", color: 0xa78bfa, elapsedMs: 3_000, rate: null, tip: "esc cancels the turn" }, 0);
  expect(row(buf, 0)).toBe("✦       Thinking… (3s)");
});

import { METEOR_WIDTH, meteorCell } from "../src/ui/meteor";

const sky = (now: number) => Array.from({ length: METEOR_WIDTH }, (_, i) => meteorCell(i, now).glyph).join("");

test("the meteor streaks across with a thinning tail, then the sky is empty", () => {
  expect(sky(0)).toBe("✦      ");
  expect(sky(55 * 3)).toBe("─━━✦   ");
  expect(sky(55 * 6)).toBe("··──━━✦");
  expect(sky(55 * 9)).toBe("   ··──"); // the head has left; the tail follows
  expect(sky(55 * 13)).toBe("       "); // gone
  expect(sky(55 * 13 + 650)).toBe("✦      "); // and again
});

test("the head glows brighter than the tail, which fades", () => {
  const glow = (i: number) => meteorCell(i, 55 * 6).glow;
  expect(glow(6)).toBeGreaterThan(1);
  expect(glow(5)).toBe(1);
  expect(glow(4)).toBeGreaterThan(glow(3));
  expect(glow(1)).toBeGreaterThan(0);
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
