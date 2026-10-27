// SPDX-License-Identifier: MIT
// What sope changed in a turn (agent/changes.ts): a summary right of the
// status while the turn runs, then in the transcript once it ends
// (ui/chat.ts). Like a tab, it is a rounded pixel outline around one row of
// text centered between two rows (beside the status and its tip), with a
// text fallback; grey until the pointer is on it. A click on it (or /diff)
// opens that turn's diffs in a panel, which takes the right of the screen
// and squeezes the rest to the left.
//
//   ⠉⠉ Thinking… (12s)                       ╭─────────────────────────╮
//      tip: esc cancels the turn             ╰ 2 files changed +42 -7 ─╯
//                                              (the text half a row down)
//
//   tabs, transcript, input … │ Changes · 2 files +42 -7               ✕
//                             │ ▾ src/retry.ts                     +3 -1
//                             │ ▸ src/retry.test.ts               +39 -6
//                             │ ──────────────────────────────────────
//                             │  1   /** Exponential backoff …
//                             │  2 -   return 250 * 2 ** attempt;
//                             │  2 +   return Math.min(2000, …);
//
// A click opens a file; clicking the open file toggles its diff. The wheel
// scrolls the list or the diff under the pointer; esc (or the summary again)
// closes the panel.

import type { ChangeSet } from "../agent/changes";
import type { PreviewLine } from "../agent/tools";
import type { CellBuffer } from "../render/buffer";
import type { PixelImage } from "../render/graphics";
import { palette, type Surfaces } from "../theme";
import { stringWidth, truncate } from "../unicode/width";
import { drawPreviewLines } from "./approval";
import type { Rect } from "./sessions";
import { tabFrame, type CellSize } from "./tab-frame";
import { imageTextAvailable, tabTextImage } from "./tab-text";

/** Where pixel images go, when the terminal shows them. */
export interface Graphics {
  cell: CellSize;
  images: PixelImage[];
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Rows the summary takes, as a tab does. */
export const SUMMARY_ROWS = 2;
/** The live summary's image slots; the transcript's take two each from TRANSCRIPT_SLOT. */
const LIVE_SLOT = 190;
export const TRANSCRIPT_SLOT = 200;

/** The summary's text: "2 files changed ", "+42", "-7". */
export function summaryParts(changes: ChangeSet): { label: string; added: string; removed: string; width: number } {
  const label = `${plural(changes.files.length, "file")} changed `;
  const added = `+${changes.added}`;
  const removed = `-${changes.removed}`;
  return { label, added, removed, width: stringWidth(label) + added.length + 1 + removed.length };
}

export const summaryWidth = (changes: ChangeSet) => summaryParts(changes).width + 4;

/**
 * Draws the summary over rows y and y + 1 from x. With graphics, a rounded
 * pixel outline like a tab's, its text centered between the rows (images in
 * `slot` and `slot + 1`); else its text on row y + `textRow`, on a tinted
 * ground. Grey; white when `lit`.
 */
export function drawSummary(buf: CellBuffer, x: number, y: number, changes: ChangeSet, lit: boolean, colors: Surfaces, graphics?: Graphics, slot = LIVE_SLOT, textRow = 0): void {
  const { label, added, removed } = summaryParts(changes);
  const w = summaryWidth(changes);
  const pixels = graphics && imageTextAvailable() ? graphics : undefined;
  const ty = pixels ? y + 1 : y + textRow; // the text image is taken from the lower row
  const bg = pixels ? undefined : lit ? colors.tabHover : colors.tab;
  if (bg !== undefined) buf.fill(x, ty, w, 1, { bg });
  let cx = buf.text(x + 2, ty, label, { fg: lit ? 0xffffff : palette.muted, bg });
  cx = buf.text(cx, ty, added, { fg: palette.ok, bg });
  buf.text(cx + 1, ty, removed, { fg: palette.error, bg });
  if (!pixels) return;
  pixels.images.push(tabFrame(x, y, w, slot, lit ? 0xffffff : palette.faint, pixels.cell));
  pixels.images.push(tabTextImage(buf, x, y, w, pixels.cell, palette.muted, [{ column: 2, columns: w - 4, text: `${label}${added} ${removed}` }], slot + 1));
  buf.fill(x, y, w, SUMMARY_ROWS, {}); // the image shows the text, half a row down
}

/**
 * The running turn's summary from row y (the status's), ending at `end`;
 * null (nothing drawn) without changes or room. Returns the cells it
 * covers, for the pointer.
 */
export function drawChangeSummary(buf: CellBuffer, start: number, end: number, y: number, changes: ChangeSet, lit: boolean, colors: Surfaces, graphics?: Graphics): { x0: number; x1: number; y0: number; y1: number } | null {
  if (!changes.files.length) return null;
  const x0 = end - summaryWidth(changes);
  if (x0 < start) return null;
  drawSummary(buf, x0, y, changes, lit, colors, graphics);
  return { x0, x1: end, y0: y, y1: y + SUMMARY_ROWS };
}

export class ChangesPanel {
  #selected = 0;
  #selectedPath: string | null = null;
  #expanded = true;
  #listScroll = 0;
  #scroll = 0; // first diff line shown
  // Where the last frame put things, for the pointer.
  #area: Rect | null = null;
  #close = { x0: 0, x1: 0, y: -1 };
  #list = { y: 0, h: 0 };
  #diff = { y: 0, h: 0, lines: 0 };

  /** `changes` is read at each frame: the running turn's grow. */
  constructor(readonly changes: () => ChangeSet) {}

  contains(x: number, y: number): boolean {
    const a = this.#area;
    return !!a && x >= a.x && x < a.x + a.w && y >= a.y && y < a.y + a.h;
  }

  /** A press inside the panel: "close" on ✕, "handled" on a file, null elsewhere (the diff: text to select). */
  click(x: number, y: number): "close" | "handled" | null {
    if (!this.contains(x, y)) return null;
    if (y === this.#close.y && x >= this.#close.x0 && x < this.#close.x1) return "close";
    if (y < this.#list.y || y >= this.#list.y + this.#list.h) return null;
    const index = this.#listScroll + y - this.#list.y;
    if (index === this.#selected) this.#expanded = !this.#expanded;
    else this.#pick(index);
    return "handled";
  }

  /** The wheel inside the panel: over the list it moves the pick, elsewhere it scrolls the diff. */
  wheel(y: number, by: number, speed = 1): void {
    if (y >= this.#list.y && y < this.#list.y + this.#list.h) return this.#pick(this.#selected + by);
    if (!this.#expanded) return;
    this.#scroll = Math.max(0, Math.min(this.#scroll + speed * by, this.#diff.lines - this.#diff.h));
  }

  #pick(index: number): void {
    const n = this.changes().files.length;
    const next = Math.max(0, Math.min(n - 1, index));
    if (next !== this.#selected) {
      this.#scroll = 0;
      this.#expanded = true;
    }
    this.#selected = next;
    this.#selectedPath = this.changes().files[next]?.path ?? null;
  }

  render(buf: CellBuffer, area: Rect, colors: Surfaces): void {
    this.#area = area;
    const { x, w } = area;
    const end = x + w;
    let y = area.y;
    const bottom = area.y + area.h;
    const changes = this.changes();
    const files = changes.files;
    this.#list = { y, h: 0 };
    this.#diff = { y, h: 0, lines: 0 };

    // Title row, ✕ on the right.
    let tx = buf.text(x, y, "Changes", { bold: true }, end - 2);
    if (files.length) {
      tx = buf.text(tx, y, ` · ${plural(files.length, "file")} `, { fg: palette.muted }, end - 2);
      tx = buf.text(tx, y, `+${changes.added}`, { fg: palette.ok }, end - 2);
      buf.text(tx + 1, y, `-${changes.removed}`, { fg: palette.error }, end - 2);
    }
    buf.text(end - 1, y, "✕", { fg: palette.muted });
    this.#close = { x0: end - 2, x1: end, y };
    y++;

    if (!files.length) {
      this.#selected = 0;
      this.#selectedPath = null;
      this.#expanded = true;
      this.#scroll = 0;
      if (y < bottom) buf.text(x, y + 1, truncate("No files changed yet.", w), { fg: palette.muted });
      return;
    }
    // Live changes can insert files before the current one. Keep the open or
    // collapsed state attached to the same path, rather than its list index.
    const kept = files.findIndex((f) => f.path === this.#selectedPath);
    if (kept >= 0) this.#selected = kept;
    else {
      this.#selected = Math.min(this.#selected, files.length - 1);
      this.#expanded = true;
      this.#scroll = 0;
    }
    this.#selectedPath = files[this.#selected]!.path;
    if (y >= bottom) return;

    // The files: a third of the panel at most, scrolled to keep the pick in view.
    const listH = Math.max(1, Math.min(files.length, Math.floor((bottom - y) / 3)));
    this.#listScroll = Math.max(0, Math.min(this.#listScroll, this.#selected, files.length - listH));
    if (this.#selected >= this.#listScroll + listH) this.#listScroll = this.#selected - listH + 1;
    this.#list = { y, h: listH };
    for (let i = 0; i < listH; i++) {
      const index = this.#listScroll + i;
      const f = files[index]!;
      const sel = index === this.#selected;
      const bg = sel ? colors.panelSelected : undefined;
      if (sel) buf.fill(x, y, w, 1, { bg });
      const stats = `+${f.added} -${f.removed}`;
      const sx = end - stats.length;
      buf.text(x, y, sel && this.#expanded ? "▾" : "▸", { fg: palette.accent, bg, bold: true });
      buf.text(x + 2, y, truncate(f.path, Math.max(0, sx - x - 4)), { bg, bold: sel }, sx - 1);
      const ax = buf.text(sx, y, `+${f.added}`, { fg: palette.ok, bg });
      buf.text(ax + 1, y, `-${f.removed}`, { fg: palette.error, bg });
      y++;
    }
    if (y >= bottom || !this.#expanded) return;
    buf.text(x, y++, "─".repeat(w), { fg: palette.faint });

    // The picked file's diff.
    const file = files[this.#selected]!;
    const lines: PreviewLine[] = file.lines.map((l) =>
      l.kind === "gap" ? { text: `⋯ ${plural(l.skipped, "unchanged line")}`, kind: "gap" } : { text: l.text, kind: l.kind, no: l.no, lang: file.lang },
    );
    const h = bottom - y;
    this.#scroll = Math.max(0, Math.min(this.#scroll, lines.length - h));
    this.#diff = { y, h, lines: lines.length };
    drawPreviewLines(buf, x, y, end, lines.slice(this.#scroll, this.#scroll + h), colors);
  }
}
