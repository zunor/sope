// SPDX-License-Identifier: MIT
// Text selection for the TUI. With mouse reporting on, the terminal no longer
// selects text itself, so we do: drag to select (highlighted in inverse
// video), and the text under it is copied to the clipboard on release.
// Coordinates are screen cells; the selection runs like a terminal's, from
// the anchor to the end of its row, whole rows between, then up to the head.

import { spawn } from "node:child_process";
import { INVERSE, type CellBuffer } from "../render/buffer";

export interface Point {
  x: number;
  y: number;
}

/** Visible text rows belonging to one message, excluding its frame and padding. */
export interface SelectionBounds {
  id: object;
  rows: Array<{ x: number; y: number; w: number }>;
}

export class Selection {
  #anchor: Point | null = null;
  #head: Point | null = null;
  #dragging = false;
  #bounds: SelectionBounds | undefined;

  get active(): boolean {
    return this.#anchor !== null;
  }

  get dragging(): boolean {
    return this.#dragging;
  }

  press(p: Point, bounds?: SelectionBounds): void {
    this.#bounds = bounds?.rows.length ? bounds : undefined;
    this.#anchor = this.#clamp(p);
    this.#head = null;
    this.#dragging = true;
  }

  drag(p: Point): void {
    if (this.#dragging) this.#head = this.#clamp(p);
  }

  /** Ends a drag. Returns false for a plain click, which selects nothing. */
  release(p: Point): boolean {
    if (!this.#dragging) return false;
    p = this.#clamp(p);
    this.#dragging = false;
    if (this.#head || (this.#anchor && (p.x !== this.#anchor.x || p.y !== this.#anchor.y))) this.#head = p;
    if (!this.#head) this.clear();
    return this.#head !== null;
  }

  clear(): void {
    this.#anchor = this.#head = null;
    this.#dragging = false;
    this.#bounds = undefined;
  }

  /** Screen coordinates expire when streaming, scrolling or overlays move a message. */
  validateBounds(resolve: (p: Point) => SelectionBounds | undefined): void {
    const old = this.#bounds;
    if (!old) return;
    const current = resolve(old.rows[0]!);
    if (!current || old.id !== current.id || old.rows.length !== current.rows.length ||
      old.rows.some((r, i) => r.x !== current.rows[i]!.x || r.y !== current.rows[i]!.y || r.w !== current.rows[i]!.w)) this.clear();
  }

  #clamp(p: Point): Point {
    const rows = this.#bounds?.rows;
    if (!rows) return p;
    const first = rows[0]!, last = rows.at(-1)!;
    if (p.y < first.y) return { x: first.x, y: first.y };
    if (p.y > last.y) return { x: last.x + last.w - 1, y: last.y };
    const row = rows.find(r => r.y === p.y) ?? first;
    return { x: Math.max(row.x, Math.min(row.x + row.w - 1, p.x)), y: row.y };
  }

  /** The selected range in reading order, or null. Both ends are inclusive. */
  range(): [Point, Point] | null {
    const a = this.#anchor;
    const b = this.#head;
    if (!a || !b) return null;
    return a.y < b.y || (a.y === b.y && a.x <= b.x) ? [a, b] : [b, a];
  }

  /** Inverts the selected cells of a drawn frame. */
  highlight(buf: CellBuffer): void {
    this.#eachRow(buf, (y, x0, x1) => {
      for (let x = x0; x <= x1; x++) buf.attr[y * buf.width + x]! ^= INVERSE;
    });
  }

  /** The selected text: rows joined by newlines, trailing blanks trimmed. */
  text(buf: CellBuffer): string {
    const rows: string[] = [];
    this.#eachRow(buf, (y, x0, x1) => {
      let row = "";
      for (let x = x0; x <= x1; x++) row += buf.chars[y * buf.width + x] ?? "";
      rows.push(row.trimEnd());
    });
    return rows.join("\n").replace(/\n+$/, "");
  }

  #eachRow(buf: CellBuffer, fn: (y: number, x0: number, x1: number) => void): void {
    const r = this.range();
    if (!r || !buf.width) return;
    const [a, b] = r;
    const last = buf.width - 1;
    for (let y = Math.max(0, a.y); y <= Math.min(buf.height - 1, b.y); y++) {
      const row = this.#bounds?.rows.find(r => r.y === y);
      if (this.#bounds && !row) continue;
      const left = Math.max(0, row?.x ?? 0);
      const right = Math.min(last, row ? row.x + row.w - 1 : last);
      let x0 = Math.max(left, y === a.y ? a.x : left);
      let x1 = Math.min(right, y === b.y ? b.x : right);
      // Take wide characters whole.
      if (x0 > left && buf.chars[y * buf.width + x0] === "") x0--;
      if (x1 < right && buf.chars[y * buf.width + x1 + 1] === "") x1++;
      if (x0 <= x1) fn(y, Math.max(0, x0), x1);
    }
  }
}

const CLIPBOARD_COMMANDS: Record<string, string[][]> = {
  darwin: [["pbcopy"]],
  linux: [["wl-copy"], ["xclip", "-selection", "clipboard"], ["xsel", "--clipboard", "--input"]],
};

/**
 * Copies text to the clipboard: OSC 52 through the terminal (works over ssh
 * where the terminal allows it), and the platform's clipboard command for
 * terminals that ignore OSC 52, such as macOS Terminal.
 */
export function copyToClipboard(text: string, write: (s: string) => void): void {
  write(`\x1b]52;c;${Buffer.from(text).toString("base64")}\x07`);
  const tryCommand = (commands: string[][]): void => {
    const [cmd, ...rest] = commands;
    if (!cmd) return;
    const child = spawn(cmd[0]!, cmd.slice(1), { stdio: ["pipe", "ignore", "ignore"] });
    child.on("error", () => tryCommand(rest)); // not installed: try the next one
    child.stdin.on("error", () => {});
    child.stdin.end(text);
  };
  tryCommand(CLIPBOARD_COMMANDS[process.platform] ?? []);
}
