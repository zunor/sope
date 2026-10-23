// SPDX-License-Identifier: MIT
// The /context report: what fills the model's context window, as a block in
// the transcript. A bar, its legend, the biggest tool results, and when
// compaction starts:
//
//   ◔ Context  glm-5.3 · 42.1k / 200k tokens · 21%
//     ━━━━━━━━━━━━━━━━━━━━━━──────────────────────────────────┃────────╌
//     ● System prompt        1.2k   0.6%
//     ● Tools · 14           6.8k   3.4%
//     ● Messages · 38       12.4k   6.2%
//     ● Tool results · 9    19.6k   9.8%
//     ○ Free                154k  76.9%
//     ◌ Output reserve       4.1k   2.0%
//
//     Largest tool results
//     read  src/agent.c                         6.1k
//
//     ┃ Auto-compact at 160k · 118k to go
//
// Shares are of the window, or of what is used while the window is unknown.
// The parts are libsope's estimates; "Other" is what the provider counted
// beyond them.

import type { ContextUsage } from "sope";
import type { Style } from "../render/buffer";
import { palette } from "../theme";
import { stringWidth, truncate } from "../unicode/width";

/** What /context saw, kept with the transcript. */
export interface ContextReport extends ContextUsage {
  model: string;
}

export interface Span {
  text: string;
  style: Style;
}

const BAR_MAX = 64;

/** 812, 42.1k, 200k, 1.05M. */
export function formatTokens(n: number): string {
  if (n < 1000) return String(Math.round(n));
  if (n < 99_950) return `${+(n / 1000).toFixed(1)}k`;
  if (n < 999_500) return `${Math.round(n / 1000)}k`;
  return `${+(n / 1_000_000).toFixed(2)}M`;
}

/** One line for the transcript's text: "Context: 42.1k / 200k tokens (21%)". */
export function contextSummary(r: ContextReport): string {
  return `Context: ${formatTokens(r.used)}${r.window ? ` / ${formatTokens(r.window)} tokens (${percent(r.used, r.window)})` : " tokens"}`;
}

/** Cells for each amount, `width` in all: proportional, and at least one for anything above zero. */
export function allot(amounts: number[], width: number): number[] {
  const total = amounts.reduce((a, b) => a + b, 0);
  if (!total || width <= 0) return amounts.map(() => 0);
  const exact = amounts.map((a) => (a / total) * width);
  const cells = exact.map((e, i) => (amounts[i]! > 0 ? Math.max(1, Math.floor(e)) : 0));
  let left = width - cells.reduce((a, b) => a + b, 0);
  const order = cells.map((_, i) => i).filter((i) => amounts[i]! > 0)
    .sort((a, b) => exact[b]! - cells[b]! - (exact[a]! - cells[a]!));
  for (let k = 0; left > 0; k = (k + 1) % order.length, left--) cells[order[k]!]!++;
  while (left < 0) {
    cells[cells.indexOf(Math.max(...cells))]!--;
    left++;
  }
  return cells;
}

/** 21% or 0.3% in a sentence; 0.6%, 76.9% in the legend, where they line up. */
function percent(n: number, of: number, digits?: number): string {
  const share = (n / of) * 100;
  return n > 0 && share < 0.1 ? "<0.1%" : `${share.toFixed(digits ?? (share < 9.95 ? 1 : 0))}%`;
}

interface Part {
  label: string;
  tokens: number;
  color: number;
  /** The bar's glyph and the legend's dot. */
  bar: string;
  dot: string;
}

function parts(r: ContextReport): { used: Part[]; rest: Part[] } {
  const p = r.parts;
  const c = r.counts;
  const part = (label: string, tokens: number, color: number): Part => ({ label, tokens, color, bar: "━", dot: "●" });
  const used = [
    part("System prompt", p.system, palette.muted),
    part(`Tools · ${c.tools}`, p.tools, palette.tool),
    ...(p.summary ? [part("Summary", p.summary, palette.accent)] : []),
    part(`Messages · ${c.messages}`, p.messages, palette.user),
    ...(c.tool_results ? [part(`Tool results · ${c.tool_results}`, p.tool_results, palette.code)] : []),
    ...(c.images ? [part(`Images · ${c.images}`, p.images, palette.ok)] : []),
    ...(r.used > r.estimate ? [part("Other", r.used - r.estimate, palette.faint)] : []),
  ];
  if (!r.window) return { used, rest: [] };
  const reserve = Math.min(r.reserve, Math.max(0, r.window - r.used));
  return {
    used,
    rest: [
      { label: "Free", tokens: Math.max(0, r.window - r.used - reserve), color: palette.faint, bar: "─", dot: "○" },
      ...(reserve ? [{ label: "Output reserve", tokens: reserve, color: palette.faint, bar: "╌", dot: "◌" }] : []),
    ],
  };
}

/**
 * The report's rows, `width` cells wide at most: a header, then the body.
 * `summarize` turns a tool's JSON input into a short description.
 */
export function contextRows(r: ContextReport, width: number, summarize: (input: string) => string): Span[][] {
  const w = Math.max(1, Math.min(width, BAR_MAX));
  const scale = r.window || r.used;
  const { used, rest } = parts(r);
  const all = [...used, ...rest];
  const rows: Span[][] = [];

  const head = [r.model, r.window ? `${formatTokens(r.used)} / ${formatTokens(r.window)} tokens · ${percent(r.used, r.window)}` : `${formatTokens(r.used)} tokens`];
  rows.push([
    { text: "Context", style: { fg: palette.accent, bold: true } },
    { text: `  ${head.filter(Boolean).join(" · ")}`, style: { fg: palette.muted } },
  ]);

  // The bar, with a tick where automatic compaction starts.
  const cells = allot(all.map((p) => p.tokens), w);
  const tick = r.window && r.threshold && r.threshold < r.window ? Math.min(w - 1, Math.round((r.threshold / r.window) * w)) : -1;
  const usedCells = cells.slice(0, used.length).reduce((a, b) => a + b, 0);
  const marked = tick >= usedCells && tick < usedCells + (cells[used.length] ?? 0);
  const bar: Span[] = [];
  let x = 0;
  all.forEach((p, i) => {
    const n = cells[i]!;
    if (marked && tick >= x && tick < x + n) {
      bar.push({ text: p.bar.repeat(tick - x), style: { fg: p.color } });
      bar.push({ text: "┃", style: { fg: palette.muted } });
      bar.push({ text: p.bar.repeat(x + n - tick - 1), style: { fg: p.color } });
    } else {
      bar.push({ text: p.bar.repeat(n), style: { fg: p.color } });
    }
    x += n;
  });
  rows.push(bar);

  // The legend: label, tokens, share.
  const labelW = Math.max(...all.map((p) => stringWidth(p.label)));
  const tokensW = Math.max(...all.map((p) => formatTokens(p.tokens).length));
  for (const p of all) {
    const faint = p.bar !== "━";
    rows.push([
      { text: `${p.dot} `, style: { fg: p.color } },
      { text: p.label + " ".repeat(labelW - stringWidth(p.label) + 2), style: faint ? { fg: palette.muted } : {} },
      { text: formatTokens(p.tokens).padStart(tokensW), style: faint ? { fg: palette.muted } : {} },
      { text: percent(p.tokens, scale, 1).padStart(7), style: { fg: palette.muted } },
    ]);
  }

  if (r.largest.length) {
    rows.push([], [{ text: "Largest tool results", style: { fg: palette.muted } }]);
    const nameW = Math.max(...r.largest.map((t) => stringWidth(t.name)));
    for (const t of r.largest) {
      const tokens = formatTokens(t.tokens);
      const room = Math.max(0, w - nameW - 4 - tokens.length);
      const what = truncate((t.input ? summarize(t.input) : "").replace(/\s+/g, " "), room);
      rows.push([
        { text: t.name + " ".repeat(nameW - stringWidth(t.name) + 2), style: { fg: palette.tool } },
        { text: what + " ".repeat(Math.max(0, room - stringWidth(what) + 2)), style: { fg: palette.muted } },
        { text: tokens, style: {} },
      ]);
    }
  }

  rows.push([]);
  const note = (text: string, glyph = ""): Span[] => [
    ...(glyph ? [{ text: `${glyph} `, style: { fg: palette.muted } }] : []),
    { text, style: { fg: palette.muted } },
  ];
  if (!r.threshold) rows.push(note("Automatic compaction is off · /compact frees context"));
  else if (r.used < r.threshold) rows.push(note(`Auto-compact at ${formatTokens(r.threshold)} · ${formatTokens(r.threshold - r.used)} to go`, marked ? "┃" : ""));
  else rows.push(note(`Past the auto-compact threshold (${formatTokens(r.threshold)}): the next request compacts first`, marked ? "┃" : ""));
  if (r.state === "running") rows.push([{ text: "A turn is running: this is its last request", style: { fg: palette.faint } }]);
  if (!r.window) rows.push([{ text: "The model's window is unknown: set SOPE_CONTEXT_WINDOW to see what is free", style: { fg: palette.faint } }]);
  return rows;
}
