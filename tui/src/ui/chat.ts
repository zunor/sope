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

/** Up to `max` lines of a tool or subagent result, behind a ⎿ marker. */
function resultLines(text: string, width: number, ok: boolean | undefined, max = RESULT_LINES): Line[] {
  const lines = textLines(text || "(empty)", width, { fg: ok === false ? palette.error : palette.muted }, [marker, blank]);
  if (lines.length <= max) return lines;
  return [
    ...lines.slice(0, max),
    { spans: [blank, { text: `… ${lines.length - max} more lines`, style: { fg: palette.faint } }] },
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

function linesFor(m: Message, width: number, showThinking: boolean): Line[] {
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
      if (!m.streaming) lines.push(...resultLines(m.text, width, m.ok));
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
        lines.push(...resultLines(m.text, width, m.ok, RESULT_LINES));
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
  showThinking = false;

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
    this.#scroll = Math.min(this.#scroll, this.#maxScroll);
    const first = this.#maxScroll - this.#scroll;

    for (let row = 0; row < r.h && first + row < all.length; row++) {
      const { line, msg } = all[first + row]!;
      const y = r.y + row;
      if (line.head && msg) {
        const g = gutterFor(msg, spin);
        buf.text(r.x, y, g.text, g.style);
      }
      let x = r.x + GUTTER;
      for (const s of line.spans) x = buf.text(x, y, s.text, s.style, r.x + r.w);
    }

    if (this.#scroll > 0) {
      const label = ` ↓ ${this.#scroll} more `;
      buf.text(r.x + r.w - label.length, r.y + r.h - 1, label, { fg: palette.muted, inverse: true });
    }
  }

  #linesFor(m: Message, width: number): Line[] {
    // Running thinking/subagent messages show a live clock, so they are never cached.
    const live = m.streaming && (m.role === "thinking" || m.role === "subagent");
    const key = `${width}:${m.version}:${this.showThinking ? 1 : 0}`;
    const hit = this.#cache.get(m);
    if (!live && hit?.key === key) return hit.lines;
    const lines = linesFor(m, width, this.showThinking);
    this.#cache.set(m, { key, lines });
    return lines;
  }
}
