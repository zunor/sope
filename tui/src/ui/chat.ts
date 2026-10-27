// SPDX-License-Identifier: MIT
// The conversation transcript: a list of messages rendered into wrapped,
// styled lines with a one-glyph gutter, scrollable from the bottom.

import type { ChangeSet } from "../agent/changes";
import type { CellBuffer, Style } from "../render/buffer";
import { mix } from "../render/color";
import { palette, surfaces, type Surfaces } from "../theme";
import { stringWidth, truncate } from "../unicode/width";
import { drawSummary, summaryWidth, TRANSCRIPT_SLOT, type Graphics } from "./changes";
import { contextRows, formatTokens, type ContextReport } from "./context";
import { renderMarkdown, slice } from "./markdown";
import { formatElapsed } from "./status";
import { wrapText } from "./wrap";

export type Role = "user" | "assistant" | "thinking" | "tool" | "subagent" | "error" | "info" | "context" | "changes";

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
  /** Subagents: their tool calls. */
  steps?: Step[];
  /** Subagents: the agent id their events carry, the tokens they spent, whether the user stopped them. */
  agentId?: number;
  tokens?: number;
  stopped?: boolean;
  /** /context: what it measured; laid out again at each width. */
  context?: ContextReport;
  /** The files a turn changed, shown when it ends; a click shows their diffs. */
  changes?: ChangeSet;
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

/** Where a line shows part of one of its message's searchable strings. */
interface Source {
  /** Which string of the message: numbered in the order its lines are built. */
  part: number;
  text: string;
  /** The [start, end) of `text` on this line, starting at column `x` of it. */
  start: number;
  end: number;
  x: number;
}

/** A search hit: [start, end) of one searchable string, first shown on `line` of its message. */
export interface Hit {
  msg: Message;
  part: number;
  start: number;
  end: number;
  line: number;
}

interface Line {
  spans: Span[];
  /** The text it shows that a search can find. */
  src?: Source[];
  /** Horizontal inset within the transcript content area. */
  offset?: number;
  fold?: "connector" | "control" | "body";
  /** Output row used to preserve the viewport when this block changes size. */
  foldRow?: number;
  /** First line of a message: draws the gutter glyph. */
  head?: boolean;
  /** One of a change summary's two rows, `card` cells from its offset: drawn by ui/changes.ts, a click target. */
  card?: number;
  cardRow?: number;
}

const GUTTER = 2;
const RESULT_LINES = 6;
const THINKING_TAIL = 3;
const USER_BORDER_BREATH_MS = 6000;

const blank: Span = { text: "  ", style: {} };
const marker: Span = { text: "⎿ ", style: { fg: palette.faint } };

function textLines(text: string, width: number, style: Style, part: number, prefix?: [first: Span, rest: Span]): Line[] {
  const expanded = text.replace(/\t/g, "    ").replace(/\n+$/, "");
  const inner = width - (prefix ? 2 : 0);
  return wrapText(expanded, inner).map((row, i) => {
    const spans = [{ text: expanded.slice(row.start, row.end), style }];
    if (prefix) spans.unshift(i === 0 ? prefix[0] : prefix[1]);
    return { spans, src: [{ part, text: expanded, start: row.start, end: row.end, x: prefix ? 2 : 0 }] };
  });
}

function markdownLines(text: string, width: number, part: number): Line[] {
  const styled = renderMarkdown(text.replace(/\t/g, "    ").replace(/\n+$/, ""));
  return wrapText(styled.text, width).map((row) => ({
    spans: slice(styled, row.start, row.end, {}),
    src: [{ part, text: styled.text, start: row.start, end: row.end, x: 0 }],
  }));
}

/** Right-aligned user bubbles, with ordinary text and rounded character borders. */
function userLines(text: string, width: number, part: number): Line[] {
  if (width < 6) return textLines(text, width, {}, part);
  const maxWidth = Math.min(width, Math.max(6, Math.floor(width * 0.75)));
  const expanded = text.replace(/\t/g, "    ").replace(/\n+$/, "");
  const rows = wrapText(expanded, maxWidth - 4)
    .map((row) => ({ row, text: truncate(expanded.slice(row.start, row.end).trimEnd(), maxWidth - 4) }));
  const inner = Math.max(1, ...rows.map((r) => stringWidth(r.text)));
  const offset = width - inner - 4;
  const edge = (text: string): Span => ({ text, style: { fg: palette.faint }, userBorder: true });
  return [
    { offset, spans: [edge(`╭${"─".repeat(inner + 2)}╮`)] },
    ...rows.map(({ row, text }): Line => ({
      offset,
      spans: [edge("│ "), { text: text + " ".repeat(inner - stringWidth(text)), style: {} }, edge(" │")],
      src: [{ part, text: expanded, start: row.start, end: row.start + text.length, x: 2 }],
    })),
    { offset, spans: [edge(`╰${"─".repeat(inner + 2)}╯`)] },
  ];
}

/** One-row text with its whitespace collapsed, cut to `width`: the span, and the part of it shown. */
function rowText(text: string, width: number, style: Style, part: number, x: number, lead = ""): { span: Span; src: Source } {
  const flat = text.replace(/\s+/g, " ");
  const shown = truncate(flat, width);
  const end = shown === flat ? flat.length : shown.endsWith("…") ? shown.length - 1 : shown.length;
  return { span: { text: lead + shown, style }, src: { part, text: flat, start: 0, end, x: x + stringWidth(lead) } };
}

/** A tool or subagent result whose entire block toggles its long preview. */
function resultLines(text: string, width: number, ok: boolean | undefined, expanded: boolean, part: number, max = RESULT_LINES): Line[] {
  const lines = textLines(text || "(empty)", width, { fg: ok === false ? palette.error : palette.muted }, part, [marker, blank]);
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

/** The first foldRow a folded block hides: a search hit there unfolds it. */
const hiddenFrom = (m: Message) => (m.role === "subagent" ? 1 : RESULT_LINES);
/** The foldRow of the row that unfolds a folded block: its "more lines" label, or a subagent's title. */
const controlRow = (m: Message) => (m.role === "subagent" ? 0 : RESULT_LINES);

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

/** What a subagent block says at the right of its title: 12s · 7 tools · 3.1k tok · stopped. */
export function agentMeta(m: Message, now = performance.now()): string {
  const parts = [formatElapsed((m.endedAt ?? now) - (m.startedAt ?? now))];
  const n = m.steps?.length ?? 0;
  if (n) parts.push(`${n} tool${n === 1 ? "" : "s"}`);
  if (m.tokens) parts.push(`${formatTokens(m.tokens)} tok`);
  if (m.stopped) parts.push("stopped");
  else if (!m.streaming && m.ok === false) parts.push("failed");
  return parts.join(" · ");
}

/** A subagent's title and task, with agentMeta at the right edge when there is room. */
function agentTitle(m: Message, width: number, part: number): Line {
  const title = `agent · ${m.title ?? ""}`;
  const meta = agentMeta(m);
  const metaWidth = stringWidth(meta);
  const fits = width - stringWidth(title) - metaWidth - 4 >= 8;
  const line = titleLine(title, palette.accent, m.detail ?? "", fits ? width - metaWidth - 2 : width, part);
  if (fits) {
    const used = line.spans.reduce((n, span) => n + stringWidth(span.text), 0);
    line.spans.push({ text: " ".repeat(Math.max(2, width - used - metaWidth)), style: {} }, { text: meta, style: { fg: m.stopped || m.ok === false ? palette.error : palette.faint } });
  }
  return line;
}

/** One tool call of a subagent: ○ while it runs, ● once done, ✕ if it failed; `part` and `part + 1` are searchable. */
function stepLine(s: Step, width: number, part: number): Line {
  const glyph = !s.done ? "○" : s.ok === false ? "✕" : "●";
  const line: Line = {
    spans: [
      blank,
      { text: `${glyph} `, style: { fg: s.ok === false ? palette.error : palette.tool } },
      { text: s.name, style: { fg: palette.tool } },
    ],
    src: [{ part, text: s.name, start: 0, end: s.name.length, x: 4 }],
  };
  if (s.detail) {
    const { span, src } = rowText(s.detail, Math.max(0, width - s.name.length - 6), { fg: palette.muted }, part + 1, 4 + stringWidth(s.name), "  ");
    line.spans.push(span);
    line.src!.push(src);
  }
  return line;
}

/** A finished subagent, unfolded: every tool call it made, then its report. */
function agentDetailLines(m: Message, width: number, stepsPart: number, part: number): Line[] {
  const calls = (m.steps ?? []).map((s, i) => stepLine(s, width, stepsPart + 2 * i));
  const body = textLines(m.text || "(no output)", width, { fg: m.ok === false ? palette.error : palette.muted }, part, [marker, blank]);
  return [...calls, ...body].map((line, i) => ({ ...line, fold: "body", foldRow: 1 + i }));
}

function seconds(m: Message): string {
  const ms = (m.endedAt ?? performance.now()) - (m.startedAt ?? performance.now());
  return `${(ms / 1000).toFixed(1)}s`;
}

/** The title of a tool or subagent, then its input on the rest of the row; `part` and `part + 1` are searchable. */
function titleLine(title: string, color: number, rest: string, width: number, part: number): Line {
  const line: Line = { spans: [{ text: title, style: { fg: color, bold: true } }], src: [{ part, text: title, start: 0, end: title.length, x: 0 }] };
  if (rest) {
    const { span, src } = rowText(rest, Math.max(0, width - stringWidth(title) - 2), { fg: palette.muted }, part + 1, stringWidth(title), "  ");
    line.spans.push(span);
    line.src!.push(src);
  }
  return line;
}

/** A turn's change summary: two right-aligned rows, drawn at render time (ui/changes.ts). */
function changeLines(changes: ChangeSet, width: number): Line[] {
  const card = summaryWidth(changes);
  const offset = Math.max(0, width - card);
  return [0, 1].map((cardRow) => ({ offset, card, cardRow, spans: [] }));
}

function linesFor(m: Message, width: number, showThinking: boolean, expanded: boolean): Line[] {
  // Searchable strings are numbered the same way whatever is folded, so a hit
  // found in the unfolded layout names the same text in the one on screen.
  let part = 0;
  let lines: Line[];
  switch (m.role) {
    case "user":
      return userLines(m.text, width, part);
    case "changes":
      return m.changes ? changeLines(m.changes, width) : [];
    case "assistant":
      lines = markdownLines(m.text, width, part);
      break;
    case "error":
      lines = textLines(m.text, width, { fg: palette.error }, part);
      break;
    case "info":
      lines = textLines(m.text, width, { fg: palette.muted }, part);
      break;
    case "context":
      lines = m.context ? contextRows(m.context, width, summarizeInput).map((spans) => ({ spans })) : textLines(m.text, width, { fg: palette.muted }, part);
      break;
    case "thinking": {
      const head = m.streaming ? "Thinking…" : `Thought for ${seconds(m)}`;
      lines = [{ spans: [{ text: head, style: { fg: palette.muted, italic: true } }] }];
      const body = textLines(m.text.trim(), width, { fg: palette.faint, italic: true }, part);
      if (showThinking) lines.push(...body);
      else if (m.streaming) lines.push(...body.slice(-THINKING_TAIL));
      break;
    }
    case "tool":
      lines = [titleLine(m.title ?? "tool", palette.tool, summarizeInput(m.detail), width, part)];
      part += 2;
      if (!m.streaming) lines.push(...resultLines(m.text, width, m.ok, expanded, part));
      break;
    case "subagent": {
      // One row: what it does and how far it got (the task panel shows more).
      // A finished one unfolds into its tool calls and report on a click.
      const title = agentTitle(m, width, part);
      lines = [title];
      part += 2;
      const stepsPart = part;
      part += 2 * (m.steps?.length ?? 0); // searchable whether shown or not
      if (!m.streaming) {
        Object.assign(title, { fold: "control", foldRow: 0 });
        if (expanded) lines.push(...agentDetailLines(m, width, stepsPart, part));
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
    case "context":
      return { text: "◔", style: { fg: palette.accent } };
    case "changes":
      return { text: "", style: {} };
  }
}

/** The hits of `pattern` in a message's lines, in reading order; only text a line shows counts. */
function findHits(msg: Message, lines: Line[], pattern: RegExp): Hit[] {
  const parts = new Map<number, { text: string; rows: Array<{ start: number; end: number; line: number }> }>();
  lines.forEach((line, i) => {
    for (const s of line.src ?? []) {
      if (s.end <= s.start) continue;
      let p = parts.get(s.part);
      if (!p) parts.set(s.part, (p = { text: s.text, rows: [] }));
      p.rows.push({ start: s.start, end: s.end, line: i });
    }
  });
  const hits: Hit[] = [];
  for (const [part, { text, rows }] of parts) {
    let r = 0;
    for (const m of text.matchAll(pattern)) {
      const start = m.index;
      const end = start + m[0].length;
      while (r < rows.length && rows[r]!.end <= start) r++;
      if (r < rows.length && rows[r]!.start < end) hits.push({ msg, part, start, end, line: rows[r]!.line });
    }
  }
  return hits.sort((a, b) => a.line - b.line || a.start - b.start);
}

/** What a search looks for: smart case, so a capital letter makes it case-sensitive. */
function searchPattern(query: string): RegExp | null {
  if (!query) return null;
  return new RegExp(query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), /\p{Lu}/u.test(query) ? "gu" : "giu");
}

const sameHit = (a: Pick<Hit, "msg" | "part" | "start">, b: Pick<Hit, "msg" | "part" | "start">) =>
  a.msg === b.msg && a.part === b.part && a.start === b.start;

/** A row of the transcript to come back to: a line of a message, or null for the bottom. */
type Anchor = { msg: Message; row: number } | null;

interface Search {
  query: string;
  pattern: RegExp | null;
  /** The hit shown as current, found again by where it is as the transcript changes. */
  current: Pick<Hit, "msg" | "part" | "start"> | null;
  /** Bring the current hit into view at the next render. */
  reveal: boolean;
  /** Where the view was when the search began. */
  home: Anchor;
}

const CURRENT_HIT: Style = { bg: palette.tool, fg: 0x16181d };
const DEFAULT_SURFACES = surfaces(null);

export class ChatView {
  #messages: Message[] = [];
  #nextId = 1;
  #cache = new WeakMap<Message, { key: string; lines: Line[] }>();
  #foldWidths = new WeakMap<Line[], number>();
  #scroll = 0; // rows scrolled up from the bottom; 0 follows new output
  #maxScroll = 0;
  #height = 0;
  #lastLayout = { lines: 0, width: 0 };
  #expanded = new WeakSet<Message>();
  #foldHits: Array<{ x0: number; x1: number; y: number; row: number; msg: Message; outputRow: number }> = [];
  #cardHits: Array<{ x0: number; x1: number; y: number; msg: Message }> = []; // change summaries on screen
  #pointer: { x: number; y: number } | null = null;
  #foldAnchor: { msg: Message; outputRow: number; row: number } | null = null;
  #breathingMessage: Message | null = null;
  #breathStarted = 0;
  #search: Search | null = null;
  // Each message laid out unfolded, where a search looks, and its hits.
  #searchCache = new WeakMap<Message, { key: string; lines: Line[]; pattern: RegExp | null; hits: Hit[] }>();
  #restore: Anchor | undefined; // where a search that ended goes back to, at the next render
  #width = 0; // of the content at the last render
  #view: { all: Array<{ line: Line; msg: Message | null }>; first: number; height: number } | null = null;
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
    this.#view = null;
    this.#restore = undefined;
    if (this.#search) this.#search = { ...this.#search, current: null, home: null };
    this.resetInteractions();
  }

  hover(point: { x: number; y: number } | null): void {
    this.#pointer = point;
  }

  /** Forget targets when an overlay or a tiny terminal hides the transcript. */
  resetInteractions(): void {
    this.#foldHits = [];
    this.#cardHits = [];
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
    this.#foldAnchor = { msg: hit.msg, outputRow: opening ? hit.outputRow : Math.min(hit.outputRow, controlRow(hit.msg)), row };
    this.#foldHits = []; // a second queued click must not hit the old layout
    return true;
  }

  /** The change summary at a point: the turn's changes. */
  changesAt(x: number, y: number): ChangeSet | undefined {
    return this.#cardHits.find((h) => h.y === y && x >= h.x0 && x < h.x1)?.msg.changes;
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

  // ---- search (ctrl+f) --------------------------------------------------

  get searching(): boolean {
    return this.#search !== null;
  }

  /** Starts a search; endSearch(true) brings the view back to where it is now. */
  startSearch(): void {
    this.#search = { query: "", pattern: null, current: null, reveal: false, home: this.#anchor() };
  }

  /** Searches for `query` as typed; the current hit becomes the one nearest the view. */
  setQuery(query: string): void {
    const s = this.#search;
    if (!s || query === s.query) return;
    Object.assign(s, { query, pattern: searchPattern(query), current: null, reveal: false });
  }

  /** Moves to the next hit up (by = 1, older) or down (by = -1, newer), wrapping around. */
  moveHit(by: 1 | -1): void {
    const { hits, index } = this.#hits();
    if (index >= 0) this.#select(hits[(((index - by) % hits.length) + hits.length) % hits.length]!);
  }

  /** Which hit is current, numbered from the newest (1), and how many there are. */
  get searchStatus(): { index: number; total: number } {
    const { hits, index } = this.#hits();
    return { index: index < 0 ? 0 : hits.length - index, total: hits.length };
  }

  /** Folds or unfolds the long output the current hit is in. */
  toggleHit(): void {
    const { hits, index } = this.#hits();
    const msg = hits[index]?.msg;
    if (!msg || !this.#searchCache.get(msg)?.lines.some((l) => l.fold)) return;
    if (this.#expanded.has(msg)) this.#expanded.delete(msg);
    else this.#expanded.add(msg);
    this.#search!.reveal = true;
  }

  /** Ends the search: the view stays on the current hit, or goes back to where it began. */
  endSearch(goBack: boolean): void {
    if (!this.#search) return;
    if (goBack) this.#restore = this.#search.home;
    this.#search = null;
  }

  /** The top row of the view, or null while it follows the bottom. */
  #anchor(): Anchor {
    const view = this.#view;
    if (!view || this.#scroll === 0) return null;
    let i = view.first;
    while (i < view.all.length && !view.all[i]!.msg) i++;
    const msg = view.all[i]?.msg;
    if (!msg) return null;
    return { msg, row: i - view.all.findIndex((e) => e.msg === msg) };
  }

  /** Every hit, oldest first, and the current one (-1 when there are none). */
  #hits(): { hits: Hit[]; index: number } {
    const s = this.#search;
    const hits: Hit[] = [];
    if (!s?.pattern || !this.#width) return { hits, index: -1 };
    for (const m of this.#messages) for (const h of this.#hitsIn(m, s.pattern)) hits.push(h);
    if (!hits.length) return { hits, index: -1 };
    const current = s.current;
    let index = current ? hits.findIndex((h) => sameHit(h, current)) : -1;
    if (index < 0) {
      // A new query starts at the hit nearest the view; one whose text went away moves there quietly.
      index = this.#nearest(hits);
      if (current) s.current = hits[index]!;
      else this.#select(hits[index]!);
    }
    return { hits, index };
  }

  #hitsIn(m: Message, pattern: RegExp): Hit[] {
    const key = `${this.#width}:${m.version}:${this.showThinking ? 1 : 0}`;
    let entry = this.#searchCache.get(m);
    if (entry?.key !== key) {
      entry = { key, lines: linesFor(m, this.#width, this.showThinking, true), pattern: null, hits: [] };
      this.#searchCache.set(m, entry);
    }
    if (entry.pattern !== pattern) {
      entry.hits = findHits(m, entry.lines, pattern);
      entry.pattern = pattern;
    }
    return entry.hits;
  }

  /** The newest hit not below the view, else the oldest one (all of them are below). */
  #nearest(hits: Hit[]): number {
    const view = this.#view;
    if (!view) return hits.length - 1;
    const heads = new Map<Message, number>();
    view.all.forEach(({ msg }, i) => {
      if (msg && !heads.has(msg)) heads.set(msg, i);
    });
    const bottom = view.first + view.height - 1;
    for (let i = hits.length - 1; i >= 0; i--) {
      const head = heads.get(hits[i]!.msg);
      if (head !== undefined && head + hits[i]!.line <= bottom) return i;
    }
    return 0;
  }

  /** Makes `hit` current, unfolding the output that hides it, and brings it into view. */
  #select(hit: Hit): void {
    const s = this.#search!;
    s.current = hit;
    s.reveal = true;
    const line = this.#searchCache.get(hit.msg)?.lines[hit.line];
    if (line?.foldRow !== undefined && line.foldRow >= hiddenFrom(hit.msg)) this.#expanded.add(hit.msg);
  }

  /**
   * `open`: the changes whose diffs are shown; their summary stays lit.
   * `graphics`: where the change summaries' pixel outlines go, when shown.
   */
  render(buf: CellBuffer, r: Rect, spin: string, now = performance.now(), colors: Surfaces = DEFAULT_SURFACES, open?: ChangeSet, graphics?: Graphics): void {
    this.#foldHits = [];
    this.#cardHits = [];
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
    // Before the layout: making a hit current can unfold the output it is in.
    this.#width = contentWidth;
    const found = this.#search ? this.#hits() : null;
    const current = found?.hits[found.index] ?? null;
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
    if (this.#search?.reveal && current) {
      // Scroll only when the hit is off screen (or at its edge), then put it a third of the way down.
      this.#search.reveal = false;
      let at = all.findIndex(({ line, msg }) => msg === current.msg && line.src?.some((s) => s.part === current.part && s.start < current.end && current.start < s.end));
      if (at < 0) at = all.findIndex(({ msg }) => msg === current.msg); // folded away again
      const top = this.#maxScroll - this.#scroll;
      const margin = Math.min(2, Math.floor(r.h / 4));
      if (at >= 0 && (at < top + margin || at > top + r.h - 1 - margin)) this.#scroll = this.#maxScroll - (at - Math.floor(r.h / 3));
    }
    if (this.#restore !== undefined) {
      const home = this.#restore;
      this.#restore = undefined;
      const head = home ? all.findIndex(({ msg }) => msg === home.msg) : -1;
      this.#scroll = head < 0 ? 0 : this.#maxScroll - (head + home!.row);
    }
    this.#scroll = Math.max(0, Math.min(this.#scroll, this.#maxScroll));
    const first = this.#maxScroll - this.#scroll;
    this.#view = { all, first, height: r.h };

    // Build only visible targets, clipped to the chat pane (including trace mode).
    const scrollLabel = this.#scroll > 0 ? ` ↓ ${this.#scroll} more ` : "";
    const blockWidths = new Map<Message, number>();
    for (let row = 0; row < r.h && first + row < all.length; row++) {
      const { line, msg } = all[first + row]!;
      if (!line.fold || !msg) continue;
      const x0 = r.x + GUTTER;
      let width = blockWidths.get(msg);
      if (width === undefined) {
        const lines = this.#cache.get(msg)!.lines;
        width = this.#foldWidths.get(lines);
        if (width === undefined) {
          width = 0;
          for (const l of lines) if (l.fold)
            width = Math.max(width, l.spans.reduce((n, span) => n + stringWidth(span.text), 0));
          this.#foldWidths.set(lines, width);
        }
        blockWidths.set(msg, width);
      }
      const end = r.x + r.w - (row === r.h - 1 ? scrollLabel.length : 0);
      const x1 = Math.min(end, x0 + width);
      if (x1 > x0) this.#foldHits.push({ x0, x1, y: r.y + row, row, msg, outputRow: line.foldRow! });
    }
    const hovered = this.#pointer ? this.#foldAt(this.#pointer.x, this.#pointer.y)?.msg : undefined;
    for (let row = 0; row < r.h && first + row < all.length; row++) {
      const { line, msg } = all[first + row]!;
      if (!line.card || !msg) continue;
      const x0 = r.x + GUTTER + (line.offset ?? 0);
      this.#cardHits.push({ x0, x1: Math.min(r.x + r.w, x0 + line.card), y: r.y + row, msg });
    }

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
      if (found && msg && line.src) this.#paintHits(buf, line, msg, r.x + GUTTER + (line.offset ?? 0), y, r.x + r.w, current, colors);
    }

    // Change summaries: in pixels when both rows are on screen, else the text of the lower row.
    const pointed = this.#pointer ? this.changesAt(this.#pointer.x, this.#pointer.y) : undefined;
    let slot = TRANSCRIPT_SLOT;
    for (const [i, h] of this.#cardHits.entries()) {
      const row = all[first + h.y - r.y]!.line.cardRow;
      const next = this.#cardHits[i + 1];
      const whole = row === 0 && next?.msg === h.msg;
      if (row === 1 && this.#cardHits[i - 1]?.msg === h.msg) continue; // drawn with its first row
      if (row === 0 && !whole) continue; // the lower row, which holds the text, is off screen
      const changes = h.msg.changes!;
      const lit = changes === pointed || changes === open;
      const y = row === 0 ? h.y : h.y - 1;
      drawSummary(buf, h.x0, y, changes, lit, colors, whole ? graphics : undefined, slot, 1);
      slot += 2;
    }

    if (this.#scroll > 0) {
      buf.text(r.x + r.w - scrollLabel.length, r.y + r.h - 1, scrollLabel, { fg: palette.muted, inverse: true });
    }
  }

  /** Tints the search hits on one drawn line; the current one stands out. */
  #paintHits(buf: CellBuffer, line: Line, msg: Message, x: number, y: number, limit: number, current: Hit | null, colors: Surfaces): void {
    const entry = this.#searchCache.get(msg);
    if (!entry?.pattern || entry.pattern !== this.#search?.pattern) return; // hits of an earlier query
    const hits = entry.hits;
    for (const s of line.src!) {
      for (const h of hits) {
        if (h.part !== s.part || h.end <= s.start || h.start >= s.end) continue;
        const from = Math.max(h.start, s.start);
        const x0 = x + s.x + stringWidth(s.text.slice(s.start, from));
        const x1 = Math.min(limit, buf.width, x0 + stringWidth(s.text.slice(from, Math.min(h.end, s.end))));
        const style = h === current ? CURRENT_HIT : { bg: colors.match };
        for (let col = Math.max(0, x0); col < x1; col++) {
          const i = y * buf.width + col;
          buf.bg[i] = style.bg!;
          if (style.fg !== undefined) buf.fg[i] = style.fg;
        }
      }
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
