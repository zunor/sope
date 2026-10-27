// SPDX-License-Identifier: MIT
// The input line: a multi-line text buffer with a grapheme-aware cursor,
// word motions (dictionary-based for CJK via Intl.Segmenter) and history.

import { graphemeWidth, segments, stringWidth } from "../unicode/width";
import { type Row, wrapText } from "./wrap";

const words = new Intl.Segmenter(undefined, { granularity: "word" });

export interface EditorLayout {
  rows: Row[];
  cursorRow: number;
  cursorCol: number;
}

export class Editor {
  text = "";
  cursor = 0; // UTF-16 offset, always on a grapheme boundary
  #anchor: number | null = null;
  #history: string[] = [];
  #historyIndex = -1; // -1: editing the draft, not browsing history
  #draft = "";

  set(text: string, cursor = text.length): void {
    this.clearSelection();
    this.text = text;
    this.cursor = cursor;
  }

  clear(): void {
    this.set("");
  }

  insert(s: string): void {
    if (!s) return;
    this.#deleteSelection();
    this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor);
    this.cursor += s.length;
  }

  backspace(): void {
    if (this.#deleteSelection()) return;
    const prev = this.#prevBoundary(this.cursor);
    this.#delete(prev, this.cursor);
  }

  deleteForward(): void {
    if (this.#deleteSelection()) return;
    this.#delete(this.cursor, this.#nextBoundary(this.cursor));
  }

  left(): void {
    this.cursor = this.selection?.[0] ?? this.#prevBoundary(this.cursor);
    this.clearSelection();
  }

  right(): void {
    this.cursor = this.selection?.[1] ?? this.#nextBoundary(this.cursor);
    this.clearSelection();
  }

  lineStart(): void {
    this.clearSelection();
    this.cursor = this.text.lastIndexOf("\n", this.cursor - 1) + 1;
  }

  lineEnd(): void {
    this.clearSelection();
    const nl = this.text.indexOf("\n", this.cursor);
    this.cursor = nl < 0 ? this.text.length : nl;
  }

  wordLeft(): void {
    this.clearSelection();
    let target = 0;
    for (const s of words.segment(this.text)) {
      if (s.index >= this.cursor) break;
      if (s.isWordLike) target = s.index;
    }
    this.cursor = target;
  }

  wordRight(): void {
    this.clearSelection();
    for (const s of words.segment(this.text)) {
      const end = s.index + s.segment.length;
      if (end > this.cursor && s.isWordLike) {
        this.cursor = end;
        return;
      }
    }
    this.cursor = this.text.length;
  }

  deleteWordLeft(): void {
    if (this.#deleteSelection()) return;
    const end = this.cursor;
    this.wordLeft();
    this.#delete(this.cursor, end);
  }

  killToLineStart(): void {
    if (this.#deleteSelection()) return;
    const end = this.cursor;
    this.lineStart();
    this.#delete(this.cursor, end);
  }

  killToLineEnd(): void {
    if (this.#deleteSelection()) return;
    const start = this.cursor;
    this.lineEnd();
    this.#delete(start, this.cursor === start ? Math.min(start + 1, this.text.length) : this.cursor);
  }

  /** Visual rows for a given width, plus where the cursor sits among them. */
  layout(width: number): EditorLayout {
    const rows = wrapText(this.text, width);
    let r = 0;
    for (let i = 0; i < rows.length; i++) if (rows[i]!.start <= this.cursor) r = i;
    const row = rows[r]!;
    let col = stringWidth(this.text.slice(row.start, Math.min(this.cursor, row.end)));
    if (col >= width && r === rows.length - 1) {
      // Cursor sits just past a full last row: show it at the start of a new one.
      rows.push({ start: this.cursor, end: this.cursor, width: 0 });
      r++;
      col = 0;
    }
    return { rows, cursorRow: r, cursorCol: Math.min(col, width - 1) };
  }

  /** Moves the cursor one visual row up (-1) or down (+1). Returns false at the edge. */
  moveVertical(dir: -1 | 1, width: number): boolean {
    this.clearSelection();
    const { rows, cursorRow, cursorCol } = this.layout(width);
    const target = rows[cursorRow + dir];
    if (!target) return false;
    this.moveToCell(target, cursorCol);
    return true;
  }

  /** Places the cursor at a display column of a rendered row, keeping graphemes whole. */
  moveToCell(target: Row, column: number, extend = false): void {
    if (extend) this.#anchor ??= this.cursor;
    else this.clearSelection();
    let col = 0;
    let off = target.start;
    for (const [g, i] of segments(this.text.slice(target.start, target.end))) {
      const w = graphemeWidth(g);
      if (col + w > Math.max(0, column)) break;
      col += w;
      off = target.start + i + g.length;
    }
    this.cursor = off;
  }

  /** Half-open UTF-16 range, independent of wrapping and screen coordinates. */
  get selection(): [number, number] | null {
    if (this.#anchor === null || this.#anchor === this.cursor) return null;
    return [Math.min(this.#anchor, this.cursor), Math.max(this.#anchor, this.cursor)];
  }

  clearSelection(): void {
    this.#anchor = null;
  }

  /**
   * The editing keys (emacs-style, as in a shell). `width` is the input's,
   * for moving between visual rows. Returns false for keys it does not use.
   */
  key(id: string, width: number): boolean {
    switch (id) {
      case "ctrl+j":
      case "alt+enter":
      case "shift+enter":
        this.insert("\n");
        break;
      case "backspace":
        this.backspace();
        break;
      case "delete":
        this.deleteForward();
        break;
      case "left":
      case "ctrl+b":
        this.left();
        break;
      case "right":
        this.right();
        break;
      case "home":
      case "ctrl+a":
        this.lineStart();
        break;
      case "end":
      case "ctrl+e":
        this.lineEnd();
        break;
      case "alt+left":
      case "ctrl+left":
      case "alt+b":
        this.wordLeft();
        break;
      case "alt+right":
      case "ctrl+right":
      case "alt+f":
        this.wordRight();
        break;
      case "ctrl+w":
      case "alt+backspace":
        this.deleteWordLeft();
        break;
      case "ctrl+u":
        this.killToLineStart();
        break;
      case "ctrl+k":
        this.killToLineEnd();
        break;
      case "up":
      case "ctrl+p":
        if (!this.moveVertical(-1, width)) this.historyPrev();
        break;
      case "down":
      case "ctrl+n":
        if (!this.moveVertical(1, width)) this.historyNext();
        break;
      default:
        return false;
    }
    return true;
  }

  /** Clears the buffer and records the submitted text in history. */
  submit(): string {
    const text = this.text;
    if (text.trim() && this.#history.at(-1) !== text) this.#history.push(text);
    this.#historyIndex = -1;
    this.#draft = "";
    this.clear();
    return text;
  }

  /** Whether ↑/↓ are walking through earlier messages. */
  get browsingHistory(): boolean {
    return this.#historyIndex !== -1;
  }

  historyPrev(): void {
    this.clearSelection();
    if (!this.#history.length) return;
    if (this.#historyIndex === -1) {
      this.#draft = this.text;
      this.#historyIndex = this.#history.length;
    }
    if (this.#historyIndex > 0) this.set(this.#history[--this.#historyIndex]!);
  }

  historyNext(): void {
    this.clearSelection();
    if (this.#historyIndex === -1) return;
    if (++this.#historyIndex >= this.#history.length) {
      this.#historyIndex = -1;
      this.set(this.#draft);
    } else {
      this.set(this.#history[this.#historyIndex]!);
    }
  }

  #deleteSelection(): boolean {
    const range = this.selection;
    this.clearSelection();
    if (!range) return false;
    this.#delete(...range);
    return true;
  }

  #delete(start: number, end: number): void {
    if (end <= start) return;
    this.text = this.text.slice(0, start) + this.text.slice(end);
    this.cursor = start;
  }

  #prevBoundary(pos: number): number {
    let prev = 0;
    for (const [, i] of segments(this.text)) {
      if (i >= pos) break;
      prev = i;
    }
    return prev;
  }

  #nextBoundary(pos: number): number {
    for (const [g, i] of segments(this.text)) if (i >= pos) return i + g.length;
    return this.text.length;
  }
}
