// SPDX-License-Identifier: MIT
// Transparent, antialiased rounded outlines centered within two rows (the
// change summary), and browser-style tab shapes for the tab bar.
import type { PixelImage } from "../render/graphics";

export interface CellSize { width: number; height: number }
const cache = new Map<string, string>();

export function tabFrame(x: number, y: number, columns: number, slot: number, color: number, cell: CellSize): PixelImage {
  const width = columns * cell.width;
  const height = 2 * cell.height;
  const key = `${width}:${height}:${color}`;
  let data = cache.get(key);
  if (!data) {
    const pixels = Buffer.alloc(width * height * 4);
    const stroke = Math.max(1, cell.height / 26);
    const left = stroke;
    const right = width - stroke;
    // Inset both edges equally: a compact 1.5-row outline around the
    // unchanged text center, within the terminal's two-row placement.
    const top = cell.height * 0.25 + stroke;
    const bottom = height - top;
    const radius = Math.min(cell.height * 0.12, (right - left) / 2, (bottom - top) / 2);
    const cx = (left + right) / 2, cy = (top + bottom) / 2;
    const hx = (right - left) / 2 - radius, hy = (bottom - top) / 2 - radius;
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const dx = Math.abs(px + 0.5 - cx) - hx;
        const dy = Math.abs(py + 0.5 - cy) - hy;
        const distance = Math.hypot(Math.max(dx, 0), Math.max(dy, 0)) + Math.min(Math.max(dx, dy), 0) - radius;
        const alpha = Math.max(0, Math.min(1, stroke / 2 + 0.5 - Math.abs(distance)));
        const i = (py * width + px) * 4;
        pixels[i] = (color >> 16) & 255;
        pixels[i + 1] = (color >> 8) & 255;
        pixels[i + 2] = color & 255;
        pixels[i + 3] = Math.round(alpha * 255);
      }
    }
    data = pixels.toString("base64");
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(key, data);
  }
  return { x, y, columns, rows: 2, width, height, data, slot, z: -1 };
}

// Browser-style tabs fit two rows: the top edge 0.3 rows down, the baseline
// 0.2 rows above the bottom, so the bar stays clear of what follows it.
const TAB_TOP = 0.3;
const TAB_BASE = 1.8;

/** The radius of a tab's corners, and of the curves its active foot flares out with. */
const tabRadius = (columns: number, cell: CellSize) => Math.min(cell.height * 0.35, (columns * cell.width) / 4);
const strokeOf = (cell: CellSize) => Math.max(1, cell.height / 26);

export interface ChromeTab {
  /** A hovered tab's ground. */
  fill: number | null;
  /** The active tab's outline, open at the bottom where its feet flare into the baseline. */
  outline: number | null;
  /** The separator in the tab's last column, if shown. */
  divider: number | null;
}

/** Distance from (px, py) to the arc of radius r around (cx, cy) between angles a0 and a1 (y down). */
function arcDistance(px: number, py: number, cx: number, cy: number, r: number, a0: number, a1: number): number {
  let a = Math.atan2(py - cy, px - cx);
  if (a < 0) a += 2 * Math.PI;
  if (a >= a0 && a <= a1) return Math.abs(Math.hypot(px - cx, py - cy) - r);
  const end = (t: number) => Math.hypot(px - cx - r * Math.cos(t), py - cy - r * Math.sin(t));
  return Math.min(end(a0), end(a1));
}

/** Distance from (px, py) to the segment (x0, y0)–(x1, y1), axis-aligned. */
function segmentDistance(px: number, py: number, x0: number, y0: number, x1: number, y1: number): number {
  const qx = Math.max(Math.min(x0, x1), Math.min(Math.max(x0, x1), px));
  const qy = Math.max(Math.min(y0, y1), Math.min(Math.max(y0, y1), py));
  return Math.hypot(px - qx, py - qy);
}

/**
 * A browser-style tab over two rows and `columns` cells. The active tab is
 * an outline, stroked along its path: from the baseline (tabBaseline) a
 * foot curves up into each side, rounded corners join the top. A hovered
 * tab is a filled rounded ground. A thin separator stands in the last
 * column of the others.
 */
export function chromeTab(x: number, y: number, columns: number, slot: number, tab: ChromeTab, cell: CellSize): PixelImage {
  const width = columns * cell.width;
  const height = 2 * cell.height;
  const key = `chrome:${columns}:${cell.width}:${cell.height}:${tab.fill}:${tab.outline}:${tab.divider}`;
  let data = cache.get(key);
  if (!data) {
    const pixels = Buffer.alloc(width * height * 4);
    const r = tabRadius(columns, cell);
    const top = cell.height * TAB_TOP;
    const base = cell.height * TAB_BASE;
    const stroke = strokeOf(cell);
    const W = width;
    // The outline's path, as distances: feet, sides, top corners, top.
    const outline = (px: number, py: number) =>
      Math.min(
        arcDistance(px, py, 0, base - r, r, 0, Math.PI / 2),
        arcDistance(px, py, W, base - r, r, Math.PI / 2, Math.PI),
        segmentDistance(px, py, r, base - r, r, top + r),
        segmentDistance(px, py, W - r, base - r, W - r, top + r),
        arcDistance(px, py, 2 * r, top + r, r, Math.PI, 1.5 * Math.PI),
        arcDistance(px, py, W - 2 * r, top + r, r, 1.5 * Math.PI, 2 * Math.PI),
        segmentDistance(px, py, 2 * r, top, W - 2 * r, top),
      );
    // A hovered tab's ground: a rounded rectangle inset from the cells.
    const inset = r * 0.5;
    const bottom = height - top;
    const ground = (px: number, py: number) => {
      const dx = Math.max(inset + r - px, px - (W - inset - r), 0);
      const dy = Math.max(top + r - py, py - (bottom - r), 0);
      return px >= inset && px <= W - inset && py >= top && py <= bottom && Math.hypot(dx, dy) <= r;
    };
    const dividerX = W - cell.width / 2;
    const put = (i: number, color: number, alpha: number) => {
      pixels[i] = (color >> 16) & 255;
      pixels[i + 1] = (color >> 8) & 255;
      pixels[i + 2] = color & 255;
      pixels[i + 3] = Math.round(alpha * 255);
    };
    for (let py = 0; py < height; py++) {
      for (let px = 0; px < width; px++) {
        const i = (py * width + px) * 4;
        const cx = px + 0.5, cy = py + 0.5;
        if (tab.outline !== null) {
          const a = Math.max(0, Math.min(1, stroke / 2 + 0.5 - outline(cx, cy)));
          if (a) put(i, tab.outline, a);
        } else if (tab.fill !== null) {
          let n = 0;
          for (let sy = 0; sy < 3; sy++) for (let sx = 0; sx < 3; sx++) if (ground(px + (sx + 0.5) / 3, py + (sy + 0.5) / 3)) n++;
          if (n) put(i, tab.fill, n / 9);
        } else if (tab.divider !== null && py >= cell.height * 0.55 && py < cell.height * 1.45) {
          const a = Math.max(0, Math.min(1, stroke / 2 + 0.5 - Math.abs(cx - dividerX)));
          if (a) put(i, tab.divider, a);
        }
      }
    }
    data = pixels.toString("base64");
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(key, data);
  }
  return { x, y, columns, rows: 2, width, height, data, slot, z: -1 };
}

/**
 * The line along the bottom of the tab bar, `columns` wide, that the active
 * tab's feet flare into; open between them, under the tab (`gap`: its first
 * column and width, from x).
 */
export function tabBaseline(x: number, y: number, columns: number, slot: number, color: number, gap: { column: number; columns: number } | null, cell: CellSize): PixelImage {
  const width = columns * cell.width;
  const height = 2 * cell.height;
  const key = `base:${columns}:${cell.width}:${cell.height}:${color}:${gap?.column}:${gap?.columns}`;
  let data = cache.get(key);
  if (!data) {
    const pixels = Buffer.alloc(width * height * 4);
    const stroke = strokeOf(cell);
    const base = cell.height * TAB_BASE;
    // Centered on the height where the feet end, as their stroke is, and open from one foot's end to the other's.
    const from = gap ? gap.column * cell.width : Infinity;
    const to = gap ? (gap.column + gap.columns) * cell.width : -Infinity;
    for (let py = Math.floor(base - stroke / 2); py < Math.ceil(base + stroke / 2); py++) {
      const alpha = Math.min(py + 1, base + stroke / 2) - Math.max(py, base - stroke / 2); // of the row the line covers
      if (alpha <= 0) continue;
      for (let px = 0; px < width; px++) {
        if (px >= from && px < to) continue;
        const i = (py * width + px) * 4;
        pixels[i] = (color >> 16) & 255;
        pixels[i + 1] = (color >> 8) & 255;
        pixels[i + 2] = color & 255;
        pixels[i + 3] = Math.round(alpha * 255);
      }
    }
    data = pixels.toString("base64");
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(key, data);
  }
  return { x, y, columns, rows: 2, width, height, data, slot, z: -1 };
}
