// SPDX-License-Identifier: MIT
// The tab bar: one row of sessions, side by side.
//
//   [ explain the thread pool ▒][ fix grep context × ▒] +      ~/src/app  ⋯
//
// Each tab is a block a shade off the terminal's background; its right edge
// darkens over two cells, a soft shadow cast on whatever follows. The active
// tab is the brighter block with bold text. Hovering a tab shows × to close
// it. ? marks a tab waiting for approval, • one that finished in the
// background. ⋯ at the far right lists every saved session. Titles shrink to
// fit; when even that is not enough the bar scrolls to keep the active tab
// in view (‹ 2 and 3 › count the hidden ones).

import type { CellBuffer } from "../render/buffer";
import { mix } from "../render/color";
import { palette, type Surfaces } from "../theme";
import { stringWidth, truncate } from "../unicode/width";

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
  index: number;
  close?: boolean;
}

interface Placed {
  index: number;
  x: number;
  width: number;
  title: string;
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

const MAX_TITLE = 28;
const READABLE_TITLE = 16; // below this the directory gives up its room first
const MIN_TITLE = 8;
const PLUS = " + ";
const MORE = " ⋯ ";
const FADE = 2; // cells of shadow at a tab's right edge

const markWidth = (state: TabState) => (state === "waiting" || state === "unread" ? 2 : 0); // "? ", "• "

/** " ? title × ░": padding, mark, title, close button, fading edge. */
const tabWidth = (t: TabInfo, titleMax: number) => 1 + markWidth(t.state) + Math.min(stringWidth(t.title), titleMax) + 2 + FADE;

/** Where everything goes on a bar `w` cells wide starting at `x`. */
export function layoutTabs(tabs: TabInfo[], active: number, x: number, w: number, dir: string): TabLayout {
  const total = (from: number, to: number, max: number) => {
    let sum = 0;
    for (let i = from; i < to; i++) sum += tabWidth(tabs[i]!, max);
    return sum;
  };
  const fixed = stringWidth(PLUS) + stringWidth(MORE);
  const dirW = stringWidth(dir) + 2;

  // Shrink titles until every tab fits: beside the directory while titles
  // stay readable, then without it, down to the minimum.
  let max = MAX_TITLE;
  let showDir = true;
  const fits = () => total(0, tabs.length, max) + fixed + (showDir ? dirW : 0) <= w;
  while (!fits() && max > READABLE_TITLE) max--;
  if (!fits()) {
    showDir = false;
    max = MAX_TITLE;
    while (!fits() && max > MIN_TITLE) max--;
  }

  // Still too many: show a window around the active tab.
  let from = 0;
  let to = tabs.length;
  if (!fits()) {
    const marker = (n: number) => (n > 0 ? stringWidth(`‹ ${n}`) + 1 : 0);
    const room = (a: number, b: number) => total(a, b, max) + fixed + marker(a) + marker(tabs.length - b) <= w;
    from = active;
    to = active + 1;
    for (let grew = true; grew; ) {
      grew = false;
      if (to < tabs.length && room(from, to + 1)) (to++, (grew = true));
      if (from > 0 && room(from - 1, to)) (from--, (grew = true));
    }
  }

  let cx = x;
  if (from > 0) cx += stringWidth(`‹ ${from}`) + 1;
  const placed: Placed[] = [];
  for (let i = from; i < to; i++) {
    const t = tabs[i]!;
    const width = tabWidth(t, max);
    placed.push({ index: i, x: cx, width, title: truncate(t.title, max) });
    cx += width;
  }
  const hiddenRight = tabs.length - to;
  if (hiddenRight > 0) cx += 1 + stringWidth(`${hiddenRight} ›`);
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
  colors: Surfaces,
): TabHit[] {
  const l = layoutTabs(tabs, active, x, w, dir);
  const hits: TabHit[] = [];

  // The scroll markers step to the nearest hidden tab.
  if (l.hiddenLeft) {
    const end = buf.text(x, y, `‹ ${l.hiddenLeft}`, { fg: palette.faint });
    hits.push({ x0: x, x1: end, index: l.hiddenLeft - 1 });
  }
  for (const p of l.tabs) {
    const t = tabs[p.index]!;
    const on = p.index === active;
    const bg = on ? colors.tabActive : colors.tab;
    const end = p.x + p.width;

    buf.fill(p.x, y, p.width - FADE, 1, { bg });
    for (let i = 0; i < FADE; i++) buf.fill(end - FADE + i, y, 1, 1, { bg: mix(bg, colors.shadow, (i + 1) / (FADE + 1)) });
    let cx = p.x + 1;
    if (t.state === "waiting") cx = buf.text(cx, y, "? ", { fg: palette.tool, bg, bold: true });
    else if (t.state === "unread") cx = buf.text(cx, y, "• ", { fg: palette.accent, bg });
    buf.text(cx, y, p.title, on ? { bg, bold: true } : { fg: palette.muted, bg });
    const closeX = end - FADE - 1;
    if (p.index === hover) buf.text(closeX, y, "×", { fg: on ? palette.muted : palette.faint, bg });

    hits.push({ x0: closeX - 1, x1: closeX + 1, index: p.index, close: true });
    hits.push({ x0: p.x, x1: end, index: p.index });
  }
  if (l.hiddenRight) {
    const mx = l.plusX - stringWidth(`${l.hiddenRight} ›`);
    const end = buf.text(mx, y, `${l.hiddenRight} ›`, { fg: palette.faint });
    hits.push({ x0: mx, x1: end, index: tabs.length - l.hiddenRight });
  }

  const button = (bx: number, label: string, index: number) => {
    const lit = hover === index;
    buf.text(bx, y, label, lit ? { fg: palette.accent, bg: colors.tab, bold: true } : { fg: palette.muted });
    hits.push({ x0: bx, x1: bx + stringWidth(label), index });
  };
  button(l.plusX, PLUS, NEW_TAB);
  if (l.dir) buf.text(l.dir.x, y, l.dir.text, { fg: palette.faint });
  button(l.moreX, MORE, ALL_SESSIONS);
  return hits;
}
