// SPDX-License-Identifier: MIT
// A bright head and tapered, translucent tail following a square in one row.
import type { PixelImage } from "../render/graphics";

export const METEOR_PIXEL_SIZE = 24;
export const METEOR_ORBIT_MS = 3000;
const FRAMES = 60;
const EDGE = 15;
const PERIMETER = EDGE * 4;
let cachedColor = -1;
const frames = new Map<number, string>();

function point(distance: number): [number, number] {
  const d = ((distance % PERIMETER) + PERIMETER) % PERIMETER;
  if (d < EDGE) return [4 + d, 4];
  if (d < EDGE * 2) return [19, 4 + d - EDGE];
  if (d < EDGE * 3) return [19 - (d - EDGE * 2), 19];
  return [4, 19 - (d - EDGE * 3)];
}

/** Raw RGBA pixels, also usable by a standalone preview without a terminal. */
export function meteorPixels(color: number, phase: number): Buffer {
  const size = METEOR_PIXEL_SIZE;
  const pixels = Buffer.alloc(size * size * 4);
  const head = phase * PERIMETER;
  const [headX, headY] = point(head);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let alpha = 0;
      let white = 0;
      for (let k = 0; k <= 48; k++) {
        const age = k / 48;
        const [px, py] = point(head - age * 21);
        const d2 = (x - px) ** 2 + (y - py) ** 2;
        // Thicker tapered body, with an extra rounded core at the leading tip.
        const radius = 0.6 + 0.65 * (1 - age) + 0.5 * Math.exp(-age * 16);
        const light = (1 - age) ** 1.4 * (0.8 * Math.exp(-d2 / (2 * radius ** 2)) + 0.2 * Math.exp(-d2 / 6));
        if (light > alpha) {
          alpha = light;
          white = Math.max(0, 1 - age * 5) * 0.9;
        }
      }
      // Broad white core remains distinct from the colored, tapering tail.
      const headD2 = (x - headX) ** 2 + (y - headY) ** 2;
      const core = Math.min(1, 1.8 * Math.max(0, 1 - headD2 / 12.25) ** 1.4);
      if (core >= alpha) {
        alpha = core;
        white = 1;
      }
      const i = (y * size + x) * 4;
      for (let c = 0; c < 3; c++) {
        const channel = (color >> (16 - c * 8)) & 255;
        pixels[i + c] = Math.round(channel + (255 - channel) * white);
      }
      pixels[i + 3] = Math.round(Math.min(1, alpha) * 255);
    }
  }
  return pixels;
}

export function pixelMeteor(x: number, y: number, color: number, now: number): PixelImage {
  if (color !== cachedColor) {
    cachedColor = color;
    frames.clear();
  }
  const frame = Math.floor((((now % METEOR_ORBIT_MS) + METEOR_ORBIT_MS) % METEOR_ORBIT_MS) / (METEOR_ORBIT_MS / FRAMES));
  let data = frames.get(frame);
  if (!data) {
    data = meteorPixels(color, frame / FRAMES).toString("base64");
    frames.set(frame, data);
  }
  return { x, y, columns: 2, rows: 1, width: METEOR_PIXEL_SIZE, height: METEOR_PIXEL_SIZE, data };
}
