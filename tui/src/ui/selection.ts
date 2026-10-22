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

export class Selection {
  #anchor: Point | null = null;
  #head: Point | null = null;
  #dragging = false;

  get active(): boolean {
    return this.#anchor !== null;
  }

  get dragging(): boolean {
    return this.#dragging;
  }

  press(p: Point): void {
    this.#anchor = p;
    this.#head = null;
    this.#dragging = true;
  }

  drag(p: Point): void {
    if (this.#dragging) this.#head = p;
  }

  /** Ends a drag. Returns false for a plain click, which selects nothing. */
  release(p: Point): boolean {
    if (!this.#dragging) return false;
    this.#dragging = false;
    if (this.#head || (this.#anchor && (p.x !== this.#anchor.x || p.y !== this.#anchor.y))) this.#head = p;
    if (!this.#head) this.clear();
    return this.#head !== null;
  }

  clear(): void {
    this.#anchor = this.#head = null;
    this.#dragging = false;
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
      let x0 = y === a.y ? a.x : 0;
      let x1 = Math.min(last, y === b.y ? b.x : last);
      // Take wide characters whole.
      if (x0 > 0 && buf.chars[y * buf.width + x0] === "") x0--;
      if (x1 < last && buf.chars[y * buf.width + x1 + 1] === "") x1++;
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
