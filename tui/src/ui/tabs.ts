// SPDX-License-Identifier: MIT
// The tab bar: fixed-width, single-row sessions on subtle background tiles.
//
//    explain the thread pool     fix grep context ×    +    ~/src/app  ⋯
//
// The active tab is bold in the normal text color, the others muted.
// Hovering a tab shows × to close it. ? marks a tab waiting for approval,
// • one that finished in the background. ⋯ at the far right lists every
// saved session. Fixed-width tabs truncate long titles; hovering scrolls the
// title. Overflow keeps the active tab in view (‹ 2 and 3 › count hidden tabs).

import type { CellBuffer } from "../render/buffer";
import { palette, surfaces, type Surfaces } from "../theme";
import { graphemes, graphemeWidth, stringWidth, truncate } from "../unicode/width";

export type TabState = "idle" | "busy" | "waiting" | "unread";

export interface TabInfo {
  title: string;
  state: TabState;
}

/** Hit targets besides tabs (their index). */
export const NEW_TAB = -1;
export const ALL_SESSIONS = -2;

/** A clickable span of the bar: a tab, its close button, + or ⋯. */
export interface TabHit {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
  index: number;
  close?: boolean;
}

interface Placed {
  index: number;
  x: number;
  width: number;
  title: string;
  titleWidth: number;
}

export interface TabLayout {
  tabs: Placed[];
  hiddenLeft: number;
  hiddenRight: number;
  plusX: number;
  moreX: number;
  /** The directory, when it fits. */
  dir: { x: number; text: string } | null;
}

export const TAB_WIDTH = 24;
const PLUS = " + ";
const MORE = " ⋯ ";

/** Rows the bar takes. */
export const TAB_ROWS = 1;
const TAB_GAP = 1;
const overflowLabel = (n: number, left: boolean, w: number) =>
  w < 30 ? (left ? "‹" : "›") : left ? `‹ ${n}` : `${n} ›`;

const markWidth = (state: TabState) => (state === "waiting" || state === "unread" ? 2 : 0); // "? ", "• "

/** Fixed-width boxes; only a terminal too narrow for one box reduces the width. */
export function layoutTabs(tabs: TabInfo[], active: number, x: number, w: number, dir: string): TabLayout {
  const fixed = stringWidth(PLUS) + stringWidth(MORE);
  const marker = (n: number) => n > 0 ? stringWidth(overflowLabel(n, true, w)) + 1 : 0;
  const width = Math.min(TAB_WIDTH, Math.max(8, w - fixed - marker(active) - marker(tabs.length - active - 1)));
  const total = (from: number, to: number) => (to - from) * width + Math.max(0, to - from - 1) * TAB_GAP;
  const dirW = stringWidth(dir) + 2;
  const showDir = total(0, tabs.length) + fixed + dirW <= w;
  let from = 0;
  let to = tabs.length;
  if (total(from, to) + fixed > w) {
    const fits = (a: number, b: number) => total(a, b) + fixed + marker(a) + marker(tabs.length - b) <= w;
    from = active;
    to = active + 1;
    for (let grew = true; grew; ) {
      grew = false;
      if (to < tabs.length && fits(from, to + 1)) (to++, (grew = true));
      if (from > 0 && fits(from - 1, to)) (from--, (grew = true));
    }
  }

  let cx = x + marker(from);
  const placed: Placed[] = [];
  for (let i = from; i < to; i++) {
    const t = tabs[i]!;
    const titleWidth = width - 6 - markWidth(t.state);
    placed.push({ index: i, x: cx, width, title: truncate(t.title, titleWidth), titleWidth });
    cx += width + (i + 1 < to ? TAB_GAP : 0);
  }
  const hiddenRight = tabs.length - to;
  cx += marker(hiddenRight);
  const moreX = x + w - stringWidth(MORE);
  return {
    tabs: placed,
    hiddenLeft: from,
    hiddenRight,
    plusX: cx,
    moreX,
    dir: showDir ? { x: moreX - 1 - stringWidth(dir), text: dir } : null,
  };
}

/** Pause at each end and scroll slowly back and forth, without splitting graphemes. */
export function tabTitle(title: string, width: number, hoverElapsed?: number): string {
  const overflow = stringWidth(title) - width;
  if (overflow <= 0) return title;
  const pause = 800;
  if (hoverElapsed === undefined || hoverElapsed < pause) return truncate(title, width);
  const travel = overflow * 240;
  const phase = (hoverElapsed - pause) % (travel * 2 + pause * 2);
  const offset = Math.floor(phase < travel ? phase / 240
    : phase < travel + pause ? overflow
    : phase < travel * 2 + pause ? overflow - (phase - travel - pause) / 240 : 0);
  let column = 0;
  let text = "";
  for (const g of graphemes(title)) {
    const size = graphemeWidth(g);
    const next = column + size;
    if (column >= offset + width) break;
    if (next > offset) {
      const visible = Math.min(next, offset + width) - Math.max(column, offset);
      text += visible === size ? g : " ".repeat(visible);
    }
    column = next;
  }
  return text;
}

/**
 * Draws the bar on row y. `hover` is what the pointer is over (a tab index,
 * NEW_TAB, ALL_SESSIONS, or null). Returns what a click can hit; a tab's
 * close button comes before the tab itself.
 */
export function drawTabs(
  buf: CellBuffer,
  x: number,
  y: number,
  w: number,
  tabs: TabInfo[],
  active: number,
  dir: string,
  hover: number | null,
  hoverElapsed = 0,
  colors: Surfaces = surfaces(null),
): TabHit[] {
  const l = layoutTabs(tabs, active, x, w, dir);
  const hits: TabHit[] = [];
  const textY = y;

  // The scroll markers step to the nearest hidden tab.
  if (l.hiddenLeft) {
    const end = buf.text(x, textY, overflowLabel(l.hiddenLeft, true, w), { fg: palette.faint });
    hits.push({ x0: x, x1: end, y0: textY, y1: textY + 1, index: l.hiddenLeft - 1 });
  }
  for (const p of l.tabs) {
    const t = tabs[p.index]!;
    const on = p.index === active;
    const end = p.x + p.width - 1;
    const bg = on ? colors.tabSelected : p.index === hover ? colors.tabHover : colors.tab;
    buf.fill(p.x, y, p.width, 1, { bg });
    let cx = p.x + 2;
    if (t.state === "waiting") cx = buf.text(cx, textY, "? ", { fg: palette.tool, bg, bold: true });
    else if (t.state === "unread") cx = buf.text(cx, textY, "• ", { fg: palette.accent, bg });
    const title = tabTitle(t.title, p.titleWidth, p.index === hover ? hoverElapsed : undefined);
    buf.text(cx, textY, title, on ? { bg, bold: true } : p.index === hover ? { bg } : { bg, fg: palette.muted }, cx + p.titleWidth);
    const closeX = end - 2;
    if (p.index === hover) buf.text(closeX, textY, "×", { fg: palette.muted, bg });

    hits.push({ x0: closeX - 1, x1: closeX + 2, y0: textY, y1: textY + 1, index: p.index, close: true });
    hits.push({ x0: p.x, x1: end + 1, y0: y, y1: y + TAB_ROWS, index: p.index });
  }
  if (l.hiddenRight) {
    const mx = l.plusX - stringWidth(overflowLabel(l.hiddenRight, false, w));
    const end = buf.text(mx, textY, overflowLabel(l.hiddenRight, false, w), { fg: palette.faint });
    hits.push({ x0: mx, x1: end, y0: textY, y1: textY + 1, index: tabs.length - l.hiddenRight });
  }

  const button = (bx: number, label: string, index: number) => {
    const lit = hover === index;
    buf.text(bx, textY, label, lit ? { fg: palette.accent, bold: true } : { fg: palette.muted });
    hits.push({ x0: bx, x1: bx + stringWidth(label), y0: textY, y1: textY + 1, index });
  };
  button(l.plusX, PLUS, NEW_TAB);
  if (l.dir) buf.text(l.dir.x, textY, l.dir.text, { fg: palette.faint });
  button(l.moreX, MORE, ALL_SESSIONS);
  return hits;
}
