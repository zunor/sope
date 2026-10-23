// SPDX-License-Identifier: MIT
// Transparent, antialiased rounded outlines centered within two tab rows.
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
