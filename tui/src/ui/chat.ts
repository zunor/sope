// SPDX-License-Identifier: MIT
// The conversation transcript: a list of messages rendered into wrapped,
// styled lines with a one-glyph gutter, scrollable from the bottom.

import type { CellBuffer, Style } from "../render/buffer";
import { mix } from "../render/color";
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
  userBorder?: boolean;
}

interface Line {
  spans: Span[];
  /** Horizontal inset within the transcript content area. */
  offset?: number;
  fold?: "connector" | "control" | "body";
  /** Output row used to preserve the viewport when this block changes size. */
  foldRow?: number;
  /** First line of a message: draws the gutter glyph. */
  head?: boolean;
}

const GUTTER = 2;
const RESULT_LINES = 6;
const THINKING_TAIL = 3;
const SUBAGENT_STEPS = 5;
const USER_BORDER_BREATH_MS = 6000;

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

/** Right-aligned user bubbles, with ordinary text and rounded character borders. */
function userLines(text: string, width: number): Line[] {
  if (width < 6) return textLines(text, width, {});
  const maxWidth = Math.min(width, Math.max(6, Math.floor(width * 0.75)));
  const expanded = text.replace(/\t/g, "    ").replace(/\n+$/, "");
  const rows = wrapText(expanded, maxWidth - 4)
    .map((row) => truncate(expanded.slice(row.start, row.end).trimEnd(), maxWidth - 4));
  const inner = Math.max(1, ...rows.map(stringWidth));
  const offset = width - inner - 4;
  const edge = (text: string): Span => ({ text, style: { fg: palette.faint }, userBorder: true });
  return [
    { offset, spans: [edge(`╭${"─".repeat(inner + 2)}╮`)] },
    ...rows.map((text): Line => ({ offset, spans: [
      edge("│ "), { text: text + " ".repeat(inner - stringWidth(text)), style: {} }, edge(" │"),
    ] })),
    { offset, spans: [edge(`╰${"─".repeat(inner + 2)}╯`)] },
  ];
}

/** A tool or subagent result whose entire block toggles its long preview. */
function resultLines(text: string, width: number, ok: boolean | undefined, expanded: boolean, max = RESULT_LINES): Line[] {
  const lines = textLines(text || "(empty)", width, { fg: ok === false ? palette.error : palette.muted }, [marker, blank]);
  if (lines.length <= max) return lines;
  lines.forEach((line, i) => { line.fold = i === 0 ? "connector" : "body"; line.foldRow = i; });
  if (expanded) return lines;
  const control: Line = {
    fold: "control",
    foldRow: max,
    spans: [blank, { text: `… ${lines.length - max} more lines`, style: { fg: palette.faint } }],
  };
  return [
    ...lines.slice(0, max),
    control,
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
      return userLines(m.text, width);
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
  #foldHits: Array<{ x0: number; x1: number; y: number; row: number; msg: Message; outputRow: number }> = [];
  #pointer: { x: number; y: number } | null = null;
  #foldAnchor: { msg: Message; outputRow: number; row: number } | null = null;
  #breathingMessage: Message | null = null;
  #breathStarted = 0;
  hasVisibleAnimation = false;
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
    this.#breathingMessage = null;
    this.resetInteractions();
  }

  hover(point: { x: number; y: number } | null): void {
    this.#pointer = point;
  }

  /** Forget targets when an overlay or a tiny terminal hides the transcript. */
  resetInteractions(): void {
    this.#foldHits = [];
    this.#pointer = null;
    this.hasVisibleAnimation = false;
  }

  toggleAt(x: number, y: number): boolean {
    const hit = this.#foldAt(x, y);
    if (!hit) return false;
    const opening = !this.#expanded.has(hit.msg);
    if (opening) this.#expanded.add(hit.msg);
    else this.#expanded.delete(hit.msg);
    // Keep the clicked output near the pointer. A row hidden by collapsing
    // maps to the more-lines label instead; opening makes room below it.
    const row = opening ? Math.min(hit.row, Math.floor(this.#height / 2)) : hit.row;
    this.#foldAnchor = { msg: hit.msg, outputRow: opening ? hit.outputRow : Math.min(hit.outputRow, RESULT_LINES), row };
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

  render(buf: CellBuffer, r: Rect, spin: string, now = performance.now()): void {
    this.#foldHits = [];
    this.hasVisibleAnimation = false;
    const latestUser = this.#messages.findLast((m) => m.role === "user") ?? null;
    if (latestUser !== this.#breathingMessage) {
      this.#breathingMessage = latestUser;
      this.#breathStarted = now;
    }
    // Quantize to 10 fps even when other animations repaint more often.
    const elapsed = Math.floor(Math.max(0, now - this.#breathStarted) / 100) * 100;
    const breath = (1 - Math.cos(2 * Math.PI * elapsed / USER_BORDER_BREATH_MS)) / 2;
    const borderColor = mix(palette.faint, 0xffffff, breath);
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
      const index = all.findIndex(({ line, msg }) => msg === anchor.msg && line.foldRow === anchor.outputRow);
      if (index >= 0) this.#scroll = this.#maxScroll - (index - anchor.row);
      this.#foldAnchor = null;
    }
    this.#scroll = Math.max(0, Math.min(this.#scroll, this.#maxScroll));
    const first = this.#maxScroll - this.#scroll;

    // Build only visible targets, clipped to the chat pane (including trace mode).
    const scrollLabel = this.#scroll > 0 ? ` ↓ ${this.#scroll} more ` : "";
    const blockWidths = new Map<Message, number>();
    for (const { line, msg } of all) {
      if (line.fold && msg) blockWidths.set(msg, Math.max(blockWidths.get(msg) ?? 0,
        line.spans.reduce((width, span) => width + stringWidth(span.text), 0)));
    }
    for (let row = 0; row < r.h && first + row < all.length; row++) {
      const { line, msg } = all[first + row]!;
      if (!line.fold || !msg) continue;
      const x0 = r.x + GUTTER;
      const width = blockWidths.get(msg)!;
      const end = r.x + r.w - (row === r.h - 1 ? scrollLabel.length : 0);
      const x1 = Math.min(end, x0 + width);
      if (x1 > x0) this.#foldHits.push({ x0, x1, y: r.y + row, row, msg, outputRow: line.foldRow! });
    }
    const hovered = this.#pointer ? this.#foldAt(this.#pointer.x, this.#pointer.y)?.msg : undefined;

    for (let row = 0; row < r.h && first + row < all.length; row++) {
      const { line, msg } = all[first + row]!;
      const y = r.y + row;
      if (line.head && msg) {
        const g = gutterFor(msg, spin);
        buf.text(r.x, y, g.text, g.style);
      }
      let x = r.x + GUTTER + (line.offset ?? 0);
      for (let i = 0; i < line.spans.length; i++) {
        const s = line.spans[i]!;
        const highlight = msg === hovered && (line.fold === "connector" ? i === 0 : line.fold === "control" && i === 1);
        const breathing = msg === latestUser && s.userBorder;
        if (breathing) this.hasVisibleAnimation = true;
        const style = breathing ? { ...s.style, fg: borderColor } : highlight ? { ...s.style, fg: 0xffffff } : s.style;
        x = buf.text(x, y, s.text, style, r.x + r.w);
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
