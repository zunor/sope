// SPDX-License-Identifier: MIT
// The reasoning effort popup (/effort): a slider over the levels, moved
// with ←/→, a number or the mouse.
//
//   ╭─ Reasoning effort · glm-5.3 ─────────────────────────────╮
//   │                                                          │
//   │   Default     Low     Medium     High    Extra high      │
//   │      ○─────────○─────────○─────────●─────────○           │
//   │                                                          │
//   │   Thinks longer before answering: better on hard tasks,  │
//   │   slower, and uses more tokens.                          │
//   ╰─────────────────── ←→ adjust · enter choose · esc close ─╯
//
// The track is lit up to the selected stop; the level in force has a ✓.

import { LEVELS, type Effort } from "../agent/effort";
import type { CellBuffer } from "../render/buffer";
import { palette } from "../theme";
import { stringWidth, truncate } from "../unicode/width";
import type { ChoiceHit, Hints, Popup, PopupFrame, Reply } from "./popup";
import { wrapText } from "./wrap";

const ROWS = 6; // blank, labels, track, blank, two rows of description
const GAP_MAX = 12;
const GAP_LABELS = 9; // closer stops show only the selected label

export class EffortPicker implements Popup {
  readonly color = palette.accent;
  readonly hints: Hints = [["←→", "adjust"], ["enter", "choose"], ["esc", "close"]];
  #selected: number;

  constructor(
    /** The level in force for the session on screen. */
    readonly current: Effort,
    readonly model: string,
    readonly choose: (effort: Effort) => void,
  ) {
    this.#selected = Math.max(0, LEVELS.findIndex((l) => l.id === current));
  }

  get title(): string {
    return this.model ? `Reasoning effort · ${this.model}` : "Reasoning effort";
  }

  get selected(): Effort {
    return LEVELS[this.#selected]!.id;
  }

  height(room: number): number {
    return Math.max(3, Math.min(ROWS, room));
  }

  key(id: string): Reply {
    const last = LEVELS.length - 1;
    switch (id) {
      case "left":
      case "h":
      case "down":
        this.#selected = Math.max(0, this.#selected - 1);
        return "handled";
      case "right":
      case "l":
      case "up":
      case "tab":
        this.#selected = Math.min(last, this.#selected + 1);
        return "handled";
      case "home":
        this.#selected = 0;
        return "handled";
      case "end":
        this.#selected = last;
        return "handled";
      case "escape":
      case "ctrl+c":
        return "close";
      case "enter":
        this.choose(this.selected);
        return "close";
    }
    const picked = LEVELS[Number(id) - 1];
    if (!picked) return "handled";
    this.choose(picked.id);
    return "close";
  }

  select(index: number): void {
    this.#selected = index;
  }

  wheel(by: number): void {
    this.#selected = Math.max(0, Math.min(LEVELS.length - 1, this.#selected - by));
  }

  render(buf: CellBuffer, x: number, y: number, w: number, h: number): PopupFrame {
    const n = LEVELS.length;
    const gap = Math.max(2, Math.min(GAP_MAX, Math.floor((w - 12) / (n - 1))));
    const trackW = gap * (n - 1) + 1;
    const x0 = x + Math.max(0, Math.floor((w - trackW) / 2));
    const stop = (i: number) => x0 + i * gap;
    const end = x + w;
    const labelY = y + (h > 3 ? 1 : 0); // a blank row above, when there is room
    const trackY = labelY + 1;

    // Labels, centered over their stops.
    LEVELS.forEach((level, i) => {
      if (gap < GAP_LABELS && i !== this.#selected) return;
      const on = i === this.#selected;
      const text = level.id === this.current ? `${level.label} ✓` : level.label;
      const lx = Math.max(x, Math.min(end - stringWidth(text), stop(i) - Math.floor(stringWidth(level.label) / 2)));
      buf.text(lx, labelY, text, on ? { fg: palette.accent, bold: true } : { fg: palette.muted }, end);
    });

    // The track: lit up to the selected stop.
    for (let i = 0; i < n; i++) {
      const lit = i <= this.#selected;
      buf.text(stop(i), trackY, i === this.#selected ? "●" : "○", { fg: lit ? palette.accent : palette.faint, bold: i === this.#selected });
      if (i < n - 1) buf.text(stop(i) + 1, trackY, "─".repeat(gap - 1), { fg: i < this.#selected ? palette.accent : palette.faint }, end);
    }

    // What the selected level does.
    const description = LEVELS[this.#selected]!.description;
    const rows = Math.max(0, h - (trackY - y) - 2);
    const lines = wrapText(description, Math.max(1, Math.min(w, trackW + 8) - 2)).slice(0, rows);
    lines.forEach((row, i) => {
      const text = description.slice(row.start, row.end).trim();
      buf.text(x0 - Math.min(3, x0 - x), trackY + 2 + i, i === rows - 1 && row.end < description.length ? truncate(`${text}…`, w) : text, { fg: palette.muted }, end);
    });

    // A click on a label or the track around a stop picks it.
    const hits: ChoiceHit[] = [];
    for (let i = 0; i < n; i++) {
      const x0i = i === 0 ? x : stop(i) - Math.floor(gap / 2);
      const x1i = i === n - 1 ? end : stop(i) + Math.ceil(gap / 2);
      for (const hy of [labelY, trackY]) hits.push({ y: hy, x0: x0i, x1: x1i, index: i });
    }
    return { hits };
  }
}
