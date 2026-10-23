// SPDX-License-Identifier: MIT
// The conversation transcript: a list of messages rendered into wrapped,
// styled lines with a one-glyph gutter, scrollable from the bottom.

import type { CellBuffer, Style } from "../render/buffer";
import { palette } from "../theme";
import { stringWidth, truncate } from "../unicode/width";
import { renderMarkdown, slice } from "./markdown";
import { wrapText } from "./wrap";

export type Role = "user" | "assistant" | "thinking" | "tool" | "subagent" | "error" | "info";

/** A tool call made by a subagent, shown nested under it. */
export interface Step {
  name: string;
  detail: string;
  done: boolean;
  ok?: boolean;
}

export interface Message {
  id: number;
  role: Role;
  text: string;
  /** Tool name, or subagent type. */
  title?: string;
  /** Tool input (JSON), or subagent task description. */
  detail?: string;
  turnId?: number;
  streaming?: boolean;
  ok?: boolean;
  startedAt?: number;
  endedAt?: number;
  /** Subagents: their tool calls, and the tail of their streaming text. */
  steps?: Step[];
  tail?: string;
  version: number;
}

export interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

interface Span {
  text: string;
  style: Style;
}

interface Line {
  spans: Span[];
  fold?: "connector" | "control";
  /** First line of a message: draws the gutter glyph. */
  head?: boolean;
}

const GUTTER = 2;
const RESULT_LINES = 6;
const THINKING_TAIL = 3;
const SUBAGENT_STEPS = 5;

const blank: Span = { text: "  ", style: {} };
const marker: Span = { text: "⎿ ", style: { fg: palette.faint } };

function textLines(text: string, width: number, style: Style, prefix?: [first: Span, rest: Span]): Line[] {
  const expanded = text.replace(/\t/g, "    ").replace(/\n+$/, "");
  const inner = width - (prefix ? 2 : 0);
  return wrapText(expanded, inner).map((row, i) => {
    const spans = [{ text: expanded.slice(row.start, row.end), style }];
    if (prefix) spans.unshift(i === 0 ? prefix[0] : prefix[1]);
    return { spans };
  });
}

function markdownLines(text: string, width: number): Line[] {
  const styled = renderMarkdown(text.replace(/\t/g, "    ").replace(/\n+$/, ""));
  return wrapText(styled.text, width).map((row) => ({ spans: slice(styled, row.start, row.end, {}) }));
}

/** A tool or subagent result, with a clickable preview when longer than `max`. */
function resultLines(text: string, width: number, ok: boolean | undefined, expanded: boolean, max = RESULT_LINES): Line[] {
  const lines = textLines(text || "(empty)", width, { fg: ok === false ? palette.error : palette.muted }, [marker, blank]);
  if (lines.length <= max) return lines;
  lines[0]!.fold = "connector";
  const control: Line = {
    fold: "control",
    spans: [blank, { text: expanded ? "⌃ show fewer lines" : `… ${lines.length - max} more lines`, style: { fg: palette.faint } }],
  };
  return [
    ...lines.slice(0, max),
    control,
    ...(expanded ? [...lines.slice(max), control] : []),
  ];
}

/** One-line summary of a tool input: the lone string value if there is one, else compact JSON. */
export function summarizeInput(input: string | undefined): string {
  if (!input) return "";
  try {
    const value = JSON.parse(input) as unknown;
    if (value && typeof value === "object" && !Array.isArray(value)) {
      const values = Object.values(value as Record<string, unknown>);
      if (values.length === 1 && typeof values[0] === "string") return values[0];
      if (values.length === 0) return "";
    }
    return JSON.stringify(value);
  } catch {
    return input.replace(/\s+/g, " ");
  }
}

function seconds(m: Message): string {
  const ms = (m.endedAt ?? performance.now()) - (m.startedAt ?? performance.now());
  return `${(ms / 1000).toFixed(1)}s`;
}

function titleLine(title: string, color: number, rest: string, width: number): Line {
  const restWidth = Math.max(0, width - stringWidth(title) - 2);
  return {
    spans: [
      { text: title, style: { fg: color, bold: true } },
      { text: rest ? `  ${truncate(rest.replace(/\s+/g, " "), restWidth)}` : "", style: { fg: palette.muted } },
    ],
  };
}

function linesFor(m: Message, width: number, showThinking: boolean, expanded: boolean): Line[] {
  let lines: Line[];
  switch (m.role) {
    case "user":
      lines = textLines(m.text, width, {});
      break;
    case "assistant":
      lines = markdownLines(m.text, width);
      break;
    case "error":
      lines = textLines(m.text, width, { fg: palette.error });
      break;
    case "info":
      lines = textLines(m.text, width, { fg: palette.muted });
      break;
    case "thinking": {
      const head = m.streaming ? "Thinking…" : `Thought for ${seconds(m)}`;
      lines = [{ spans: [{ text: head, style: { fg: palette.muted, italic: true } }] }];
      const body = textLines(m.text.trim(), width, { fg: palette.faint, italic: true });
      if (showThinking) lines.push(...body);
      else if (m.streaming) lines.push(...body.slice(-THINKING_TAIL));
      break;
    }
    case "tool":
      lines = [titleLine(m.title ?? "tool", palette.tool, summarizeInput(m.detail), width)];
      if (!m.streaming) lines.push(...resultLines(m.text, width, m.ok, expanded));
      break;
    case "subagent": {
      lines = [titleLine(`agent · ${m.title ?? ""}`, palette.accent, m.detail ?? "", width)];
      const steps = m.steps ?? [];
      if (steps.length > SUBAGENT_STEPS)
        lines.push({ spans: [blank, { text: `… ${steps.length - SUBAGENT_STEPS} earlier tool calls`, style: { fg: palette.faint } }] });
      for (const s of steps.slice(-SUBAGENT_STEPS)) {
        const glyph = !s.done ? "○" : s.ok === false ? "✕" : "●";
        lines.push({
          spans: [
            blank,
            { text: `${glyph} `, style: { fg: s.ok === false ? palette.error : palette.tool } },
            { text: s.name, style: { fg: palette.tool } },
            { text: s.detail ? `  ${truncate(s.detail.replace(/\s+/g, " "), Math.max(0, width - s.name.length - 6))}` : "", style: { fg: palette.muted } },
          ],
        });
      }
      if (m.streaming) {
        const tail = (m.tail ?? "").trim().split("\n").at(-1) ?? "";
        lines.push({ spans: [blank, { text: tail ? truncate(tail, width - 2) : `working · ${seconds(m)}`, style: { fg: palette.faint, italic: true } }] });
      } else {
        lines.push(...resultLines(m.text, width, m.ok, expanded));
      }
      break;
    }
  }
  if (!lines.length) lines.push({ spans: [] });
  lines[0]!.head = true;
  return lines;
}

function gutterFor(m: Message, spin: string): Span {
  switch (m.role) {
    case "user":
      return { text: "›", style: { fg: palette.user, bold: true } };
    case "assistant":
      return { text: m.streaming ? spin : "●", style: { fg: palette.accent } };
    case "thinking":
      return { text: m.streaming ? spin : "✻", style: { fg: m.streaming ? palette.accent : palette.faint } };
    case "tool":
    case "subagent": {
      const color = m.role === "tool" ? palette.tool : palette.accent;
      if (m.streaming) return { text: spin, style: { fg: color } };
      return m.ok === false ? { text: "✕", style: { fg: palette.error } } : { text: "◆", style: { fg: color } };
    }
    case "error":
      return { text: "✕", style: { fg: palette.error, bold: true } };
    case "info":
      return { text: "·", style: { fg: palette.faint } };
  }
}

export class ChatView {
  #messages: Message[] = [];
  #nextId = 1;
  #cache = new WeakMap<Message, { key: string; lines: Line[] }>();
  #scroll = 0; // rows scrolled up from the bottom; 0 follows new output
  #maxScroll = 0;
  #height = 0;
  #lastLayout = { lines: 0, width: 0 };
  #expanded = new WeakSet<Message>();
  #foldHits: Array<{ x0: number; x1: number; y: number; row: number; msg: Message; fold: NonNullable<Line["fold"]> }> = [];
  #pointer: { x: number; y: number } | null = null;
  #foldAnchor: { msg: Message; fold: NonNullable<Line["fold"]>; row: number } | null = null;
  showThinking = false;

  /** The transcript, oldest first. */
  get messages(): readonly Message[] {
    return this.#messages;
  }

  add(m: Omit<Message, "id" | "version">): Message {
    const msg: Message = { ...m, id: this.#nextId++, version: 0 };
    this.#messages.push(msg);
    return msg;
  }

  append(m: Message, text: string): void {
    m.text += text;
    m.version++;
  }

  update(m: Message, patch: Partial<Omit<Message, "id" | "version">>): void {
    Object.assign(m, patch);
    m.version++;
  }

  clear(): void {
    this.#messages = [];
    this.#scroll = 0;
    this.#lastLayout = { lines: 0, width: 0 };
    this.#foldAnchor = null;
    this.resetInteractions();
  }

  hover(point: { x: number; y: number } | null): void {
    this.#pointer = point;
  }

  /** Forget targets when an overlay or a tiny terminal hides the transcript. */
  resetInteractions(): void {
    this.#foldHits = [];
    this.#pointer = null;
  }

  toggleAt(x: number, y: number): boolean {
    const hit = this.#foldAt(x, y);
    if (!hit) return false;
    const opening = !this.#expanded.has(hit.msg);
    if (opening) this.#expanded.add(hit.msg);
    else this.#expanded.delete(hit.msg);
    // Keep the clicked control in view. Make room for newly revealed output
    // when the control was near the bottom of the viewport.
    const row = opening ? Math.min(hit.row, Math.floor(this.#height / 2)) : hit.row;
    this.#foldAnchor = { msg: hit.msg, fold: hit.fold, row };
    this.#foldHits = []; // a second queued click must not hit the old layout
    return true;
  }

  #foldAt(x: number, y: number) {
    return this.#foldHits.find((h) => h.y === y && x >= h.x0 && x < h.x1);
  }

  scrollBy(rows: number): void {
    this.#scroll = Math.max(0, Math.min(this.#maxScroll, this.#scroll + rows));
  }

  scrollToBottom(): void {
    this.#scroll = 0;
  }

  get pageSize(): number {
    return Math.max(1, this.#height - 2);
  }

  render(buf: CellBuffer, r: Rect, spin: string): void {
    this.#foldHits = [];
    const contentWidth = Math.max(1, r.w - GUTTER);
    const all: Array<{ line: Line; msg: Message | null }> = [];
    for (const m of this.#messages) {
      if (all.length) all.push({ line: { spans: [] }, msg: null });
      for (const line of this.#linesFor(m, contentWidth)) all.push({ line, msg: m });
    }

    // Scrolled up, the view stays on the same text while new output arrives below.
    if (this.#scroll > 0 && this.#lastLayout.width === contentWidth) this.#scroll += all.length - this.#lastLayout.lines;
    this.#lastLayout = { lines: all.length, width: contentWidth };
    this.#height = r.h;
    this.#maxScroll = Math.max(0, all.length - r.h);
    if (this.#foldAnchor) {
      const anchor = this.#foldAnchor;
      const index = all.findIndex(({ line, msg }) => msg === anchor.msg && line.fold === anchor.fold);
      if (index >= 0) this.#scroll = this.#maxScroll - (index - anchor.row);
      this.#foldAnchor = null;
    }
    this.#scroll = Math.max(0, Math.min(this.#scroll, this.#maxScroll));
    const first = this.#maxScroll - this.#scroll;

    // Build only visible targets, clipped to the chat pane (including trace mode).
    const scrollLabel = this.#scroll > 0 ? ` ↓ ${this.#scroll} more ` : "";
    for (let row = 0; row < r.h && first + row < all.length; row++) {
      const { line, msg } = all[first + row]!;
      if (!line.fold || !msg) continue;
      const x0 = r.x + GUTTER + (line.fold === "control" ? 2 : 0);
      const width = line.fold === "control" ? stringWidth(line.spans[1]!.text) : 2;
      const end = r.x + r.w - (row === r.h - 1 ? scrollLabel.length : 0);
      const x1 = Math.min(end, x0 + width);
      if (x1 > x0) this.#foldHits.push({ x0, x1, y: r.y + row, row, msg, fold: line.fold });
    }
    const hovered = this.#pointer ? this.#foldAt(this.#pointer.x, this.#pointer.y)?.msg : undefined;

    for (let row = 0; row < r.h && first + row < all.length; row++) {
      const { line, msg } = all[first + row]!;
      const y = r.y + row;
      if (line.head && msg) {
        const g = gutterFor(msg, spin);
        buf.text(r.x, y, g.text, g.style);
      }
      let x = r.x + GUTTER;
      for (let i = 0; i < line.spans.length; i++) {
        const s = line.spans[i]!;
        const highlight = msg === hovered && (line.fold === "connector" ? i === 0 : line.fold === "control" && i === 1);
        x = buf.text(x, y, s.text, highlight ? { ...s.style, fg: palette.accent, bold: true } : s.style, r.x + r.w);
      }
    }

    if (this.#scroll > 0) {
      buf.text(r.x + r.w - scrollLabel.length, r.y + r.h - 1, scrollLabel, { fg: palette.muted, inverse: true });
    }
  }

  #linesFor(m: Message, width: number): Line[] {
    // Running thinking/subagent messages show a live clock, so they are never cached.
    const live = m.streaming && (m.role === "thinking" || m.role === "subagent");
    const expanded = this.#expanded.has(m);
    const key = `${width}:${m.version}:${this.showThinking ? 1 : 0}:${expanded ? 1 : 0}`;
    const hit = this.#cache.get(m);
    if (!live && hit?.key === key) return hit.lines;
    const lines = linesFor(m, width, this.showThinking, expanded);
    this.#cache.set(m, { key, lines });
    return lines;
  }
}
