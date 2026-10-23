// SPDX-License-Identifier: MIT
// The model popup (/model, alt+m): the endpoint's chat models, the ones
// picked lately first. Typing searches; ↑/↓ and enter pick one, and a name
// no listed model has can be used as typed (endpoints do not all list).
//
//   ╭─ Select model ──────────────────────────────────────────────╮
//   │ › qw▏                                                 3 / 14 │
//   │                                                              │
//   │ Recent                                                       │
//   │ › glm-5.3 ✓              1M context · images                 │
//   │   kimi-k3                1M context · images                 │
//   │ All models                                                   │
//   │   deepseek-v4-pro        1M context · images                 │
//   ╰─────────────────────────────── ↑↓ select · enter use · esc ─╯

import type { CellBuffer } from "../render/buffer";
import { palette } from "../theme";
import { stringWidth, truncate } from "../unicode/width";
import { describeModel, type ModelInfo } from "../agent/models";
import type { ChoiceHit } from "./popup";

type Choice = { model: ModelInfo; typed?: boolean };
type Row = { header: string } | Choice;

const choicesOf = (rows: Row[]) => rows.filter((r): r is Choice => "model" in r);

const MAX_NAME = 32;

export class ModelPicker {
  #models: ModelInfo[] = [];
  #state: "loading" | "ready" | string = "loading"; // or why the list could not be read
  #query = "";
  #selected = 0;
  #scroll = 0;

  constructor(
    readonly current: string,
    readonly recent: string[],
  ) {}

  /** The endpoint's list arrived; the selection starts on the current model. */
  setModels(models: ModelInfo[]): void {
    this.#models = models;
    this.#state = "ready";
    this.#selectCurrent();
  }

  /** The list could not be read: recent models and typed names still work. */
  setError(message: string): void {
    this.#state = message;
    this.#selectCurrent();
  }

  get query(): string {
    return this.#query;
  }

  /** What the rows are, headers included, for the query as it stands. */
  get rows(): Row[] {
    const known = new Map(this.#models.map((m) => [m.id, m]));
    const info = (id: string) => known.get(id) ?? { id };
    const q = this.#query.trim().toLowerCase();
    if (q) {
      const all = [...new Set([...this.recent, ...this.#models.map((m) => m.id), ...(this.current ? [this.current] : [])])];
      const hits = all.filter((id) => id.toLowerCase().includes(q));
      const loose = all.filter((id) => !hits.includes(id) && subsequence(q, id.toLowerCase()));
      const rows: Row[] = [...hits, ...loose].map((id) => ({ model: info(id) }));
      if (!all.some((id) => id.toLowerCase() === q)) rows.push({ model: { id: this.#query.trim() }, typed: true });
      return rows;
    }
    const recent = [...new Set([...(this.current ? [this.current] : []), ...this.recent])];
    const rest = this.#models.filter((m) => !recent.includes(m.id));
    return [
      ...(recent.length ? [{ header: "Recent" }, ...recent.map((id) => ({ model: info(id) }))] : []),
      ...(rest.length ? [{ header: recent.length ? "All models" : "Models" }, ...rest.map((model) => ({ model }))] : []),
    ];
  }

  /** The model rows only, in order: what the selection moves through. */
  get #choices(): Choice[] {
    return choicesOf(this.rows);
  }

  get selected(): string | undefined {
    return this.#choices[this.#selected]?.model.id;
  }

  select(index: number): void {
    this.#selected = index;
  }

  type(text: string): void {
    this.#query += text.replace(/[\r\n\t]/g, "");
    this.#selected = 0;
    this.#scroll = 0;
  }

  backspace(): void {
    this.#query = [...this.#query].slice(0, -1).join("");
    if (this.#query) this.#selected = 0;
    else this.#selectCurrent();
    this.#scroll = 0;
  }

  move(by: number): void {
    const n = this.#choices.length;
    if (n) this.#selected = Math.max(0, Math.min(n - 1, this.#selected + by));
  }

  /** Rows the popup wants: the search line, a gap, the list (at least one line for a message). */
  height(max: number): number {
    return Math.max(3, Math.min(max, 2 + this.rows.length));
  }

  /** Draws into `h` rows from (x, y), `w` wide; returns what a click can pick. */
  render(buf: CellBuffer, x: number, y: number, w: number, h: number): ChoiceHit[] {
    const rows = this.rows;
    const choices = choicesOf(rows);
    const end = x + w;

    // the search line
    const count = this.#state === "ready" ? `${choices.filter((c) => !c.typed).length} / ${this.#models.length}` : this.#state === "loading" ? "loading…" : "";
    let cx = buf.text(x, y, "› ", { fg: palette.accent, bold: true });
    if (this.#query) buf.text(cx, y, truncate(this.#query, end - cx - stringWidth(count) - 2));
    else buf.text(cx, y, "Search models, or type a name", { fg: palette.faint }, end - stringWidth(count) - 2);
    buf.text(end - stringWidth(count), y, count, { fg: palette.faint });

    const listY = y + 2;
    const listH = Math.max(1, h - 2);
    if (!rows.length) {
      const why = this.#state === "loading" ? "asking the endpoint for its models…" : this.#state === "ready" ? "the endpoint lists no chat models" : `could not list models: ${this.#state}`;
      buf.text(x, listY, truncate(`${why}; type a model name`, w), { fg: palette.muted });
      return [];
    }

    // Keep the selection (and the header above it, when it fits) in view.
    const at = rows.indexOf(choices[this.#selected]!);
    if (at < this.#scroll) this.#scroll = Math.max(0, at - 1);
    if (at >= this.#scroll + listH) this.#scroll = at - listH + 1;
    this.#scroll = Math.min(this.#scroll, Math.max(0, rows.length - listH));

    const nameW = Math.min(MAX_NAME, Math.max(...choices.map((c) => stringWidth(c.model.id))) + 2);
    const hits: ChoiceHit[] = [];
    for (let r = 0; r < listH; r++) {
      const row = rows[this.#scroll + r];
      if (!row) break;
      const ry = listY + r;
      if ("header" in row) {
        buf.text(x, ry, row.header, { fg: palette.muted, bold: true });
        continue;
      }
      const index = choices.indexOf(row);
      const on = index === this.#selected;
      cx = buf.text(x, ry, on ? "› " : "  ", { fg: palette.accent, bold: true });
      if (row.typed) {
        cx = buf.text(cx, ry, "Use ", { fg: palette.muted });
        buf.text(cx, ry, truncate(`“${row.model.id}”`, end - cx), on ? { fg: palette.accent, bold: true } : {});
      } else {
        const name = truncate(row.model.id, nameW - 2);
        cx = buf.text(cx, ry, name, on ? { fg: palette.accent, bold: true } : {});
        if (row.model.id === this.current) cx = buf.text(cx + 1, ry, "✓", { fg: palette.ok });
        const detail = describeModel(row.model);
        const dx = Math.max(cx + 2, x + 2 + nameW + 2);
        if (detail && dx < end - 4) buf.text(dx, ry, truncate(detail, end - dx), { fg: palette.faint });
      }
      hits.push({ y: ry, x0: x, x1: end, index });
    }
    return hits;
  }

  #selectCurrent(): void {
    const i = this.#choices.findIndex((c) => c.model.id === this.current);
    this.#selected = Math.max(0, i);
    this.#scroll = 0;
  }
}

/** The letters of `needle` appear in `hay` in order ("g53" finds glm-5.3). */
function subsequence(needle: string, hay: string): boolean {
  let i = 0;
  for (const ch of hay) if (ch === needle[i]) i++;
  return i === needle.length;
}
