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
  #history: string[] = [];
  #historyIndex = -1; // -1: editing the draft, not browsing history
  #draft = "";

  set(text: string, cursor = text.length): void {
    this.text = text;
    this.cursor = cursor;
  }

  clear(): void {
    this.set("");
  }

  insert(s: string): void {
    this.text = this.text.slice(0, this.cursor) + s + this.text.slice(this.cursor);
    this.cursor += s.length;
  }

  backspace(): void {
    const prev = this.#prevBoundary(this.cursor);
    this.#delete(prev, this.cursor);
  }

  deleteForward(): void {
    this.#delete(this.cursor, this.#nextBoundary(this.cursor));
  }

  left(): void {
    this.cursor = this.#prevBoundary(this.cursor);
  }

  right(): void {
    this.cursor = this.#nextBoundary(this.cursor);
  }

  lineStart(): void {
    this.cursor = this.text.lastIndexOf("\n", this.cursor - 1) + 1;
  }

  lineEnd(): void {
    const nl = this.text.indexOf("\n", this.cursor);
    this.cursor = nl < 0 ? this.text.length : nl;
  }

  wordLeft(): void {
    let target = 0;
    for (const s of words.segment(this.text)) {
      if (s.index >= this.cursor) break;
      if (s.isWordLike) target = s.index;
    }
    this.cursor = target;
  }

  wordRight(): void {
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
    const end = this.cursor;
    this.wordLeft();
    this.#delete(this.cursor, end);
  }

  killToLineStart(): void {
    const end = this.cursor;
    this.lineStart();
    this.#delete(this.cursor, end);
  }

  killToLineEnd(): void {
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
    const { rows, cursorRow, cursorCol } = this.layout(width);
    const target = rows[cursorRow + dir];
    if (!target) return false;
    let col = 0;
    let off = target.start;
    for (const [g, i] of segments(this.text.slice(target.start, target.end))) {
      const w = graphemeWidth(g);
      if (col + w > cursorCol) break;
      col += w;
      off = target.start + i + g.length;
    }
    this.cursor = off;
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

  historyPrev(): void {
    if (!this.#history.length) return;
    if (this.#historyIndex === -1) {
      this.#draft = this.text;
      this.#historyIndex = this.#history.length;
    }
    if (this.#historyIndex > 0) this.set(this.#history[--this.#historyIndex]!);
  }

  historyNext(): void {
    if (this.#historyIndex === -1) return;
    if (++this.#historyIndex >= this.#history.length) {
      this.#historyIndex = -1;
      this.set(this.#draft);
    } else {
      this.set(this.#history[this.#historyIndex]!);
    }
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
