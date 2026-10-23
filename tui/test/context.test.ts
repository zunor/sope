// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { allot, contextRows, contextSummary, formatTokens, type ContextReport } from "../src/ui/context";
import { summarizeInput } from "../src/ui/chat";
import { stringWidth } from "../src/unicode/width";

const report = (over: Partial<ContextReport> = {}): ContextReport => ({
  model: "glm-5.3",
  state: "idle",
  used: 42_130,
  estimate: 41_800,
  window: 200_000,
  reserve: 4096,
  threshold: 160_000,
  parts: { system: 1210, tools: 6830, summary: 0, messages: 12_400, tool_results: 21_360, images: 0 },
  counts: { tools: 14, messages: 38, tool_results: 9, images: 0 },
  largest: [
    { name: "read", input: '{"file_path":"src/agent.c"}', tokens: 6100 },
    { name: "bash", tokens: 3200 },
  ],
  ...over,
});

const text = (rows: ReturnType<typeof contextRows>) => rows.map((spans) => spans.map((s) => s.text).join(""));

test("formats token counts compactly", () => {
  expect([812, 4000, 42_130, 99_960, 131_072, 200_000, 1_000_000, 1_048_576].map(formatTokens))
    .toEqual(["812", "4k", "42.1k", "100k", "131k", "200k", "1M", "1.05M"]);
});

test("allots every cell, and one at least to anything there", () => {
  expect(allot([1, 1000, 0, 49_000], 50)).toEqual([1, 1, 0, 48]);
  expect(allot([25, 25, 50], 10).reduce((a, b) => a + b, 0)).toBe(10);
  expect(allot([1, 1, 1, 1], 2).reduce((a, b) => a + b, 0)).toBe(2);
  expect(allot([0, 0], 10)).toEqual([0, 0]);
});

test("lays out the bar, the legend and what comes next", () => {
  const rows = text(contextRows(report(), 80, summarizeInput));
  expect(rows[0]).toBe("Context  glm-5.3 · 42.1k / 200k tokens · 21%");
  expect(stringWidth(rows[1]!)).toBe(64);
  expect(rows[1]).toMatch(/^━+─+┃─+╌+$/);
  expect(rows[1]!.indexOf("┃")).toBe(Math.round(0.8 * 64));
  expect(rows.slice(2, 9)).toEqual([
    "● System prompt      1.2k   0.6%",
    "● Tools · 14         6.8k   3.4%",
    "● Messages · 38     12.4k   6.2%",
    "● Tool results · 9  21.4k  10.7%",
    "● Other               330   0.2%", // the provider counted more than the estimate
    "○ Free               154k  76.9%",
    "◌ Output reserve     4.1k   2.0%",
  ]);
  expect(rows.some((r) => r.startsWith("● Summary"))).toBe(false); // nothing compacted yet
  expect(rows).toContain("Largest tool results");
  expect(rows.find((r) => r.startsWith("read"))).toMatch(/^read  src\/agent\.c +6\.1k$/);
  expect(stringWidth(rows.find((r) => r.startsWith("read"))!)).toBe(64);
  expect(rows.at(-1)).toBe("┃ Auto-compact at 160k · 118k to go");
});

test("without a window, shares are of what is used", () => {
  const rows = text(contextRows(report({ window: 0, threshold: 100_000, state: "running", model: "" }), 40, summarizeInput));
  expect(rows[0]).toBe("Context  42.1k tokens");
  expect(rows).toContain("A turn is running: this is its last request");
  expect(rows[1]).toMatch(/^━{40}$/);
  expect(rows.some((r) => r.startsWith("○ Free"))).toBe(false);
  expect(rows).toContain("Auto-compact at 100k · 57.9k to go");
  expect(rows.at(-1)).toContain("SOPE_CONTEXT_WINDOW");
  expect(contextSummary(report({ window: 0 }))).toBe("Context: 42.1k tokens");
  expect(contextSummary(report())).toBe("Context: 42.1k / 200k tokens (21%)");
  expect(contextSummary(report({ used: 3000, window: 1_000_000 }))).toBe("Context: 3k / 1M tokens (0.3%)");
});

test("past the threshold, or with compaction off", () => {
  expect(text(contextRows(report({ threshold: 40_000 }), 80, summarizeInput)).at(-1)).toContain("the next request compacts first");
  expect(text(contextRows(report({ threshold: 0 }), 80, summarizeInput)).at(-1)).toContain("Automatic compaction is off");
});
