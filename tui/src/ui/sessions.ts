// SPDX-License-Identifier: MIT
// Every saved session of this directory, in a floating panel (⋯ on the tab
// bar, or /sessions). Newest first; typing filters by title; enter or a
// click opens the session in a tab, esc closes the panel.
//
//   ╭─ Sessions · ~/src/app ───────────────────────────── 12 ─╮
//   │  filter: gre▏                                            │
//   │ ● fix grep context                        8 msgs   3m ago │
//   │   explain the thread pool                24 msgs   2h ago │
//   ╰──────────────────────────── ↑↓ select · enter open · esc ─╯

import type { CellBuffer } from "../render/buffer";
import { palette, type Surfaces } from "../theme";
import { stringWidth, truncate } from "../unicode/width";

export interface SessionSummary {
  id: string;
  title: string;
  updated: number;
  messages: number;
  /** Already open in a tab. */
  open: boolean;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

/** "just now", "5m ago", "3h ago", "2d ago", then the date. */
export function ago(then: number, now = Date.now()): string {
  const s = Math.max(0, Math.floor((now - then) / 1000));
  if (s < 60) return "just now";
  if (s < 3600) return `${Math.floor(s / 60)}m ago`;
  if (s < 86400) return `${Math.floor(s / 3600)}h ago`;
  if (s < 7 * 86400) return `${Math.floor(s / 86400)}d ago`;
  const d = new Date(then);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
}

export class SessionList {
  #all: SessionSummary[] = [];
  #filter = "";
  #selected = 0;
  #scroll = 0;
  #rows: Array<{ y: number; index: number }> = []; // last drawn rows, for clicks
  #box: Rect | null = null;

  constructor(
    sessions: SessionSummary[],
    readonly dir: string,
  ) {
    this.#all = [...sessions].sort((a, b) => b.updated - a.updated);
  }

  get filter(): string {
    return this.#filter;
  }

  /** The sessions the filter lets through, newest first. */
  get shown(): SessionSummary[] {
    const f = this.#filter.toLowerCase();
    return f ? this.#all.filter((s) => s.title.toLowerCase().includes(f)) : this.#all;
  }

  get selected(): SessionSummary | undefined {
    return this.shown[this.#selected];
  }

  type(text: string): void {
    this.#filter += text.replace(/[\r\n\t]/g, " ");
    this.#selected = 0;
    this.#scroll = 0;
  }

  backspace(): void {
    this.#filter = [...this.#filter].slice(0, -1).join("");
    this.#selected = 0;
    this.#scroll = 0;
  }

  move(delta: number): void {
    const n = this.shown.length;
    if (n) this.#selected = Math.max(0, Math.min(n - 1, this.#selected + delta));
  }

  /** The session under a click, or undefined; a click outside the panel gives "outside". */
  hit(x: number, y: number): SessionSummary | "outside" | undefined {
    const b = this.#box;
    if (!b || x < b.x || x >= b.x + b.w || y < b.y || y >= b.y + b.h) return "outside";
    const row = this.#rows.find((r) => r.y === y);
    return row ? this.shown[row.index] : undefined;
  }

  render(buf: CellBuffer, area: Rect, colors: Surfaces, now = Date.now()): void {
    const shown = this.shown;
    const w = Math.min(area.w, 84);
    const listRows = Math.max(1, Math.min(shown.length || 1, area.h - 3));
    const h = listRows + 3; // border, filter, rows, border
    const box = { x: area.x + Math.floor((area.w - w) / 2), y: area.y + Math.max(0, Math.floor((area.h - h) / 3)), w, h };
    this.#box = box;
    const bg = colors.panel;
    const border = { fg: palette.faint, bg };
    const inner = w - 4;

    buf.fill(box.x, box.y, w, h, { bg });
    // top border with the title and the count
    const title = ` Sessions · ${this.dir} `;
    const count = ` ${shown.length}${this.#filter ? `/${this.#all.length}` : ""} `;
    buf.text(box.x, box.y, `╭─${"─".repeat(w - 3)}╮`, border);
    buf.text(box.x + 2, box.y, truncate(title, w - 6 - stringWidth(count)), { fg: palette.accent, bg, bold: true });
    buf.text(box.x + w - 2 - stringWidth(count), box.y, count, { fg: palette.muted, bg });
    for (let r = 1; r < h - 1; r++) {
      buf.text(box.x, box.y + r, "│", border);
      buf.text(box.x + w - 1, box.y + r, "│", border);
    }
    const help = " ↑↓ select · enter open · esc close ";
    buf.text(box.x, box.y + h - 1, `╰${"─".repeat(w - 2)}╯`, border);
    if (stringWidth(help) < w - 4) buf.text(box.x + w - 2 - stringWidth(help), box.y + h - 1, help, { fg: palette.muted, bg });

    // the filter line
    const fy = box.y + 1;
    if (this.#filter) {
      const x = buf.text(box.x + 2, fy, "filter: ", { fg: palette.muted, bg });
      buf.text(x, fy, truncate(this.#filter, inner - 8), { bg });
    } else {
      buf.text(box.x + 2, fy, "type to filter", { fg: palette.faint, bg });
    }

    // the rows, scrolled to keep the selection in view
    if (this.#selected < this.#scroll) this.#scroll = this.#selected;
    if (this.#selected >= this.#scroll + listRows) this.#scroll = this.#selected - listRows + 1;
    this.#rows = [];
    if (!shown.length) {
      buf.text(box.x + 2, fy + 1, this.#all.length ? "no session matches" : "no saved sessions yet", { fg: palette.faint, bg });
      return;
    }
    for (let r = 0; r < listRows; r++) {
      const i = this.#scroll + r;
      const s = shown[i];
      if (!s) break;
      const y = fy + 1 + r;
      const sel = i === this.#selected;
      const rowBg = sel ? colors.panelSelected : bg;
      buf.fill(box.x + 1, y, w - 2, 1, { bg: rowBg });
      const meta = `${s.messages} msgs  ${ago(s.updated, now).padStart(8)}`;
      buf.text(box.x + 2, y, s.open ? "●" : " ", { fg: palette.accent, bg: rowBg });
      buf.text(box.x + 4, y, truncate(s.title, inner - 4 - stringWidth(meta)), sel ? { bg: rowBg, bold: true } : { bg: rowBg });
      buf.text(box.x + w - 2 - stringWidth(meta), y, meta, { fg: palette.muted, bg: rowBg });
      this.#rows.push({ y, index: i });
    }
  }
}
