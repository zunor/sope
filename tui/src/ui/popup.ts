// SPDX-License-Identifier: MIT
// Popups over the bottom of the screen: a thin box with a title in its top
// edge, and a list of choices moved through with ↑/↓ (or picked by number
// or with the mouse). The permission prompt, the permission modes and the
// model picker are each a Popup; the app gives one the input's place, draws
// its box, and routes keys, typing and the pointer to it.
//
//   ╭─ Permission required ─────────────────────────────╮
//   │ sope wants to run bash                             │
//   │   $ git push origin main                           │
//   │                                                    │
//   │ › 1. Yes                                           │
//   │   2. Yes, and don't ask again for bash             │
//   ╰───────────────────────── ↑↓ select · enter confirm ─╯

import type { CellBuffer } from "../render/buffer";
import { palette, type Surfaces } from "../theme";
import { stringWidth, truncate } from "../unicode/width";

/** What a popup did with a key: "ignored" leaves it to the app. */
export type Reply = "handled" | "close" | "ignored";

/** One drawn frame: what a click can pick, and where the cursor goes (hidden if absent). */
export interface PopupFrame {
  hits: ChoiceHit[];
  cursor?: { x: number; y: number };
}

export interface Popup {
  readonly title: string;
  readonly color: number;
  /** Key hints for the bottom edge. */
  readonly hints: Hints;
  /** Rows wanted inside the box when at most `room` are free. */
  height(room: number): number;
  /** Draws inside the box: `h` rows from (x, y), `w` wide. */
  render(buf: CellBuffer, x: number, y: number, w: number, h: number, colors: Surfaces): PopupFrame;
  key(id: string): Reply;
  /** Typed or pasted text. Without it, a typed character is a key. */
  type?(text: string): void;
  /** The pointer is on choice `index`; a click then presses enter. */
  select(index: number): void;
  /** The wheel turned over the popup (-1 up, 1 down). */
  wheel?(by: number): void;
}

export interface Choice {
  label: string;
  /** Faint text after the label. */
  detail?: string;
}

/** A row of the popup a click picks: the choice's index. */
export interface ChoiceHit {
  y: number;
  x0: number;
  x1: number;
  index: number;
}

/** Key hints for the bottom edge of a box: [key, what it does]. */
export type Hints = Array<[string, string]>;

/**
 * A box `w` × `h` at (x, y); the title sits in the top edge, key hints at
 * the right of the bottom one (as many as fit). Returns the inside's x and width.
 */
export function drawBox(buf: CellBuffer, x: number, y: number, w: number, h: number, color: number, title = "", hints: Hints = []): { x: number; w: number } {
  const edge = { fg: color };
  const label = title ? truncate(` ${title} `, w - 4) : "";
  buf.text(x, y, `╭─${label}${"─".repeat(Math.max(0, w - 3 - stringWidth(label)))}╮`, edge);
  if (label) buf.text(x + 2, y, label, { fg: color, bold: true });
  for (let r = 1; r < h - 1; r++) {
    buf.fill(x + 1, y + r, w - 2, 1, {}); // whatever was under it goes
    buf.text(x, y + r, "│", edge);
    buf.text(x + w - 1, y + r, "│", edge);
  }
  buf.text(x, y + h - 1, `╰${"─".repeat(w - 2)}╯`, edge);
  const shown = [...hints];
  const width = () => shown.reduce((n, [k, v]) => n + stringWidth(`${k} ${v}`), 0) + 3 * (shown.length - 1) + 2;
  while (shown.length && width() > w - 4) shown.pop();
  let hx = x + w - 2 - width();
  for (const [i, [key, what]] of shown.entries()) {
    hx = buf.text(hx, y + h - 1, i ? " · " : " ", { fg: palette.faint });
    hx = buf.text(hx, y + h - 1, key, { fg: palette.muted });
    hx = buf.text(hx, y + h - 1, ` ${what}`, { fg: palette.faint });
  }
  if (shown.length) buf.text(hx, y + h - 1, " ", {});
  return { x: x + 2, w: w - 4 };
}

/**
 * Numbered choices, one per row; the selected one is marked and bright.
 * `align` lines the details up in a column; otherwise each follows its label.
 */
export function drawChoices(buf: CellBuffer, x: number, y: number, w: number, choices: Choice[], selected: number, align = false): ChoiceHit[] {
  const labelW = Math.max(...choices.map((c) => stringWidth(c.label)));
  return choices.map((c, i) => {
    const on = i === selected;
    const end = x + w;
    let cx = buf.text(x, y + i, on ? "› " : "  ", { fg: palette.accent, bold: true });
    cx = buf.text(cx, y + i, `${i + 1}. `, { fg: on ? palette.accent : palette.faint });
    cx = buf.text(cx, y + i, truncate(c.label, end - cx), on ? { fg: palette.accent, bold: true } : {}, end);
    if (c.detail && cx < end - 4) {
      const dx = align ? Math.max(cx + 2, x + 5 + labelW + 3) : cx + 2;
      buf.text(dx, y + i, truncate(c.detail, end - dx), { fg: palette.muted }, end);
    }
    return { y: y + i, x0: x, x1: end, index: i };
  });
}

/** Moves a selection through `n` choices, wrapping around. */
export const step = (selected: number, by: number, n: number) => (((selected + by) % n) + n) % n;
