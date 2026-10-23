// SPDX-License-Identifier: MIT
// Native terminal glyphs cannot sit half a row down. Rasterize just the tab
// labels so one row of text can be centered inside a two-row image frame.
import { deflateSync } from "node:zlib";
import { BOLD, type CellBuffer } from "../render/buffer";
import type { PixelImage } from "../render/graphics";
import type { CellSize } from "./tab-frame";

type CanvasAPI = typeof import("@napi-rs/canvas");
let canvasAPI: CanvasAPI | null | undefined;
const cache = new Map<string, string>();
export interface LabelRegion { column: number; columns: number; text: string; bold?: boolean }

export function imageTextAvailable(): boolean {
  if (canvasAPI === undefined) {
    try { canvasAPI = require("@napi-rs/canvas") as CanvasAPI; }
    catch { canvasAPI = null; }
  }
  return canvasAPI !== null;
}

/** Capture the lower text row, then position its glyphs at the image center. */
export function tabTextImage(buf: CellBuffer, x: number, y: number, columns: number, cell: CellSize, foreground: number, regions: LabelRegion[]): PixelImage {
  const width = columns * cell.width, height = 2 * cell.height;
  const start = (y + 1) * buf.width + x;
  const chars = buf.chars.slice(start, start + columns);
  const fg = [...buf.fg.slice(start, start + columns)];
  const attrs = [...buf.attr.slice(start, start + columns)];
  const key = JSON.stringify([cell, columns, foreground, chars, fg, attrs, regions]);
  let data = cache.get(key);
  if (!data) {
    const { createCanvas, GlobalFonts } = canvasAPI!;
    const canvas = createCanvas(width, height);
    const ctx = canvas.getContext("2d");
    const family = GlobalFonts.has("Menlo") ? "Menlo" : GlobalFonts.has("DejaVu Sans Mono") ? "DejaVu Sans Mono" : "monospace";
    const font = (size: number, bold = false) => `${bold ? "bold " : ""}${size}px "${family}"`;
    ctx.font = font(cell.height);
    const size = Math.min(cell.height * 0.8, cell.height * cell.width / ctx.measureText("M").width);
    ctx.font = font(size);
    const baselines = new Float64Array(columns);
    for (const region of regions) {
      ctx.font = font(size, region.bold);
      // Measure the whole title, including its currently clipped portion, so
      // the baseline remains stable throughout a horizontal marquee.
      const metrics = ctx.measureText(region.text);
      const baseline = height / 2 + (metrics.actualBoundingBoxAscent - metrics.actualBoundingBoxDescent) / 2;
      baselines.fill(baseline, Math.max(0, region.column), Math.min(columns, region.column + region.columns));
    }
    for (let col = 0; col < chars.length; col++) {
      const text = chars[col]!;
      if (!text || text === " ") continue;
      const cells = chars[col + 1] === "" ? 2 : 1;
      ctx.save();
      ctx.beginPath();
      ctx.rect(col * cell.width, 0, cells * cell.width, height);
      ctx.clip();
      ctx.font = font(size, Boolean(attrs[col]! & BOLD));
      ctx.fillStyle = `#${(fg[col]! < 0 ? foreground : fg[col]!).toString(16).padStart(6, "0")}`;
      ctx.fillText(text, col * cell.width, baselines[col], cells * cell.width);
      ctx.restore();
    }
    data = deflateSync(ctx.getImageData(0, 0, width, height).data).toString("base64");
    if (cache.size >= 32) cache.delete(cache.keys().next().value!);
    cache.set(key, data);
  }
  return { x, y, columns, rows: 2, width, height, data, slot: 100, z: 0, compression: "zlib" };
}
