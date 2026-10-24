// SPDX-License-Identifier: MIT
// Background work at a glance: a summary in the footer, after the
// permission mode, while subagents or shells run, and the task panel that
// takes the input's place (↓ on an empty input, /tasks, or a click on the
// summary).
//
//   ◈ Approve for me · ⠋ 2 agents · ✓ 1 · ◑ 1 shell          glm-5.3 · 42.1k
//
//   ╭─ Tasks ─────────────────────────────────────────────────────────╮
//   │ ● sope  Running 2 tools                                    1m 32s │
//   │ ├ ⠋ explore  find the callers of verifyToken   12s · 7 tools     │
//   │ │   ├ ● read  src/auth/token.ts                                   │
//   │ │   └ ○ grep  "verifyToken" src/                                  │
//   │ ├ ✕ general  update the changelog            48s · stopped       │
//   │ └ ◑ shell 1  bun run dev                     5m · 2.1 KB         │
//   ╰─────────────────────────── ↑↓ select · x stop · esc close ───────╯
//
// The tree has three levels at most: libsope's subagents never launch
// their own. Only the selected task shows what is under it.

import type { CellBuffer } from "../render/buffer";
import type { Session, ShellTask } from "../session";
import { palette, SPINNER, SPINNER_MS, type Surfaces } from "../theme";
import { stringWidth, truncate } from "../unicode/width";
import { agentMeta, type Message } from "./chat";
import { step, type ChoiceHit, type Hints, type Popup, type PopupFrame, type Reply } from "./popup";
import { formatElapsed } from "./status";

/** Tool calls shown under the selected subagent, newest last. */
const PANEL_STEPS = 6;
/** Output lines shown under the selected shell. */
const SHELL_LINES = 3;

/** Keys that still reach the app while the panel is up: scrolling, the trace, tabs. */
const PASS = new Set(["pageup", "pagedown", "ctrl+t", "f2", "ctrl+l", "alt+n", "alt+w", "shift+tab"]);

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** 512 B, 2.1 KB, 3.4 MB. */
export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

const agentGlyph = (m: Message, spin: string) => (m.streaming ? spin : m.stopped || m.ok === false ? "✕" : "●");
const agentColor = (m: Message) => (m.streaming ? palette.accent : m.stopped || m.ok === false ? palette.error : palette.ok);
const shellGlyph = (sh: ShellTask) => (sh.running ? "◑" : sh.stopped || sh.exit_code !== 0 ? "✕" : "●");
const shellColor = (sh: ShellTask) => (sh.running ? palette.tool : sh.stopped || sh.exit_code !== 0 ? palette.error : palette.ok);

function shellMeta(sh: ShellTask, now: number): string {
  const state = sh.running ? formatElapsed(now - sh.seenAt) : sh.stopped ? "stopped" : `exit ${sh.exit_code}`;
  return sh.output_bytes ? `${state} · ${formatBytes(sh.output_bytes)}` : state;
}

/** The last non-empty lines of a shell's output, most recent last. */
const shellTail = (sh: ShellTask, n: number) => sh.tail.split("\n").map((l) => l.trimEnd()).filter(Boolean).slice(-n);

/**
 * Draws the summary from column x on row y, stopping before `end`; returns
 * the columns a click on it covers, or null when nothing runs.
 */
export function drawTaskSummary(buf: CellBuffer, x: number, y: number, end: number, s: Session, spin: string, now = performance.now()): { x0: number; x1: number } | null {
  const agents = s.agents;
  const running = agents.filter((m) => m.streaming).length;
  const done = agents.filter((m) => !m.streaming && m.ok !== false && !m.stopped).length;
  const failed = agents.length - running - done;
  const shells = s.shells(now).filter((sh) => sh.running).length;
  if (!running && !shells) return null;
  const x0 = x;
  const put = (text: string, fg: number) => (x = buf.text(x, y, text, { fg }, end));
  if (running) {
    put(" · ", palette.faint);
    put(`${spin} `, palette.accent);
    put(plural(running, "agent"), palette.muted);
    if (done) put(` · ✓ ${done}`, palette.faint);
    if (failed) put(` · ✕ ${failed}`, palette.faint);
  }
  if (shells) {
    put(" · ", palette.faint);
    put("◑ ", palette.tool);
    put(plural(shells, "shell"), palette.muted);
  }
  return { x0, x1: x };
}

type Row = { key: string; agent: Message } | { key: string; shell: ShellTask };

export class TaskPanel implements Popup {
  readonly title = "Tasks";
  readonly color = palette.accent;
  #selected = ""; // the key of the selected row; "" picks one
  #stopping: { key: string; note: string } | null = null; // asking for a note before stopping a subagent
  #spin = "⠋";
  #scroll = 0;

  /** `session`: the session on screen; `flash` shows a short notice. */
  constructor(readonly session: () => Session, private readonly flash: (text: string) => void = () => {}) {}

  get hints(): Hints {
    if (this.#stopping) return [["enter", "stop"], ["esc", "keep running"]];
    const row = this.#row();
    const stoppable = row && ("agent" in row ? row.agent.streaming : row.shell.running);
    return stoppable ? [["↑↓", "select"], ["x", "stop"], ["esc", "close"]] : [["↑↓", "select"], ["esc", "close"]];
  }

  #rows(now = performance.now()): Row[] {
    const s = this.session();
    return [
      ...s.agents.map((agent) => ({ key: `a${agent.agentId ?? agent.id}`, agent })),
      ...s.shells(now).map((shell) => ({ key: `s${shell.id}`, shell })),
    ];
  }

  /** The selected row: the one picked, else the first running subagent, else the first. */
  #row(rows = this.#rows()): Row | undefined {
    const picked = rows.find((r) => r.key === this.#selected);
    if (picked) return picked;
    const row = rows.find((r) => "agent" in r && r.agent.streaming) ?? rows[0];
    this.#selected = row?.key ?? "";
    return row;
  }

  /** The panel's lines: [what to draw, the row it belongs to (-1 for none)]. */
  #lines(w: number, now: number): Array<{ draw: (buf: CellBuffer, x: number, y: number) => void; row: number }> {
    const s = this.session();
    const rows = this.#rows(now);
    const selected = this.#row(rows);
    const out: Array<{ draw: (buf: CellBuffer, x: number, y: number) => void; row: number }> = [];
    const spin = this.#spin;

    // The agent itself, as the root.
    const verb = s.busy ? s.activity().verb : "idle";
    const elapsed = s.busy ? formatElapsed(now - s.turnStarted) : "";
    out.push({
      row: -1,
      draw: (buf, x, y) => {
        let cx = buf.text(x, y, s.busy ? `${spin} ` : "● ", { fg: palette.accent });
        cx = buf.text(cx, y, "sope", { fg: palette.accent, bold: true });
        buf.text(cx, y, `  ${truncate(verb, x + w - cx - stringWidth(elapsed) - 4)}`, { fg: palette.muted });
        if (elapsed) buf.text(x + w - stringWidth(elapsed), y, elapsed, { fg: palette.faint });
      },
    });
    if (!rows.length) {
      out.push({ row: -1, draw: (buf, x, y) => void buf.text(x, y, "└ no subagents or background shells yet", { fg: palette.faint }) });
      return out;
    }

    rows.forEach((r, i) => {
      const last = i === rows.length - 1;
      const on = r === selected;
      const branch = last ? "└ " : "├ ";
      const under = last ? "    " : "│   ";
      const [glyph, color, name, detail, meta, metaColor] =
        "agent" in r
          ? [agentGlyph(r.agent, spin), agentColor(r.agent), r.agent.title ?? "agent", r.agent.detail ?? "", agentMeta(r.agent, now), r.agent.stopped || r.agent.ok === false ? palette.error : palette.faint]
          : [shellGlyph(r.shell), shellColor(r.shell), `shell ${r.shell.id}`, r.shell.command, shellMeta(r.shell, now), palette.faint];
      out.push({
        row: i,
        draw: (buf, x, y) => {
          const end = x + w;
          let cx = buf.text(x, y, branch, { fg: palette.faint });
          cx = buf.text(cx, y, `${glyph} `, { fg: color });
          cx = buf.text(cx, y, name, on ? { fg: palette.accent, bold: true } : { bold: true }, end);
          const metaWidth = stringWidth(meta);
          const room = end - cx - metaWidth - 4;
          if (room > 4) buf.text(cx + 2, y, truncate(detail.replace(/\s+/g, " "), room), { fg: on ? undefined : palette.muted });
          if (end - metaWidth > cx + 2) buf.text(end - metaWidth, y, meta, { fg: metaColor });
        },
      });
      if (!on) return;
      // What is under the selected task: a subagent's latest tool calls, a shell's latest output.
      const children: Array<{ glyph: string; color: number; name: string; detail: string }> = [];
      if ("agent" in r) {
        const steps = r.agent.steps ?? [];
        if (steps.length > PANEL_STEPS) children.push({ glyph: "…", color: palette.faint, name: "", detail: `${steps.length - PANEL_STEPS} earlier tool calls` });
        for (const st of steps.slice(-PANEL_STEPS))
          children.push({ glyph: !st.done ? "○" : st.ok === false ? "✕" : "●", color: st.ok === false ? palette.error : palette.tool, name: st.name, detail: st.detail });
        if (!steps.length) children.push({ glyph: "…", color: palette.faint, name: "", detail: r.agent.streaming ? "no tool calls yet" : "no tool calls" });
      } else {
        const tail = shellTail(r.shell, SHELL_LINES);
        for (const line of tail) children.push({ glyph: "│", color: palette.faint, name: "", detail: line });
        if (!tail.length) children.push({ glyph: "…", color: palette.faint, name: "", detail: "no output yet" });
      }
      children.forEach((c, j) => {
        out.push({
          row: i,
          draw: (buf, x, y) => {
            const end = x + w;
            let cx = buf.text(x, y, `${under}${j === children.length - 1 ? "└ " : "├ "}`, { fg: palette.faint });
            cx = buf.text(cx, y, `${c.glyph} `, { fg: c.color });
            if (c.name) cx = buf.text(cx, y, `${c.name}  `, { fg: palette.tool }, end);
            buf.text(cx, y, truncate(c.detail.replace(/\s+/g, " "), end - cx), { fg: palette.muted });
          },
        });
      });
    });
    return out;
  }

  height(room: number): number {
    const lines = this.#lines(room, performance.now()).length + (this.#stopping ? 2 : 0); // the count does not depend on the width
    return Math.max(1, Math.min(room, lines));
  }

  render(buf: CellBuffer, x: number, y: number, w: number, h: number, _colors: Surfaces): PopupFrame {
    const now = performance.now();
    this.#spin = SPINNER[Math.floor(now / SPINNER_MS) % SPINNER.length]!;
    const ask = this.#stopping ? 2 : 0;
    const lines = this.#lines(w, now);
    const rows = Math.max(0, h - ask);
    // Keep the selected task's first line in view, with what is under it when it fits.
    const first = lines.findIndex((l) => l.row >= 0 && this.#rowKey(l.row) === this.#selected);
    const lastOfSelected = lines.findLastIndex((l) => l.row >= 0 && this.#rowKey(l.row) === this.#selected);
    if (first >= 0) {
      if (lastOfSelected >= this.#scroll + rows) this.#scroll = Math.min(first, lastOfSelected - rows + 1);
      if (first < this.#scroll) this.#scroll = first;
    }
    this.#scroll = Math.max(0, Math.min(this.#scroll, lines.length - rows));
    const hits: ChoiceHit[] = [];
    for (let i = 0; i < rows && this.#scroll + i < lines.length; i++) {
      const line = lines[this.#scroll + i]!;
      line.draw(buf, x, y + i);
      if (line.row >= 0) hits.push({ y: y + i, x0: x, x1: x + w, index: line.row });
    }
    if (!this.#stopping) return { hits };

    const row = this.#rows(now).find((r) => r.key === this.#stopping!.key);
    const name = row && "agent" in row ? row.agent.title ?? "the subagent" : "the subagent";
    const qy = y + h - 2;
    buf.text(x, qy, truncate(`Stop ${name}? Tell sope why, or what to do instead (optional):`, w), { fg: palette.tool });
    const prompt = "› ";
    const room = w - stringWidth(prompt) - 1;
    const note = this.#stopping.note;
    const shown = stringWidth(note) > room ? `…${[...note].slice(-(room - 1)).join("")}` : note;
    let cx = buf.text(x, qy + 1, prompt, { fg: palette.accent, bold: true });
    cx = buf.text(cx, qy + 1, shown);
    return { hits, cursor: { x: cx, y: qy + 1 } };
  }

  #rowKey(index: number): string {
    return this.#rows()[index]?.key ?? "";
  }

  key(id: string): Reply {
    if (this.#stopping) return this.#noteKey(id);
    const rows = this.#rows();
    const index = rows.indexOf(this.#row(rows)!);
    switch (id) {
      case "up":
      case "ctrl+p":
      case "k":
        if (rows.length) this.#selected = rows[step(index, -1, rows.length)]!.key;
        return "handled";
      case "down":
      case "ctrl+n":
      case "j":
      case "tab":
        if (rows.length) this.#selected = rows[step(index, 1, rows.length)]!.key;
        return "handled";
      case "x":
        return this.#stop(rows[index]);
      case "escape":
      case "q":
      case "ctrl+c":
        return "close";
    }
    return PASS.has(id) || /^alt\+[1-9]$/.test(id) ? "ignored" : "handled";
  }

  type(text: string): Reply | void {
    if (this.#stopping) {
      this.#stopping.note += text.replace(/[\r\n]+/g, " ");
      return "handled";
    }
    if ([...text].length === 1) return this.key(text);
  }

  #stop(row: Row | undefined): Reply {
    if (!row) return "handled";
    if ("shell" in row) {
      if (!row.shell.running) this.flash(`shell ${row.shell.id} is not running`);
      else if (this.session().stopShell(row.shell.id)) this.flash(`stopped shell ${row.shell.id}`);
      return "handled";
    }
    if (!row.agent.streaming) this.flash(`${row.agent.title ?? "the subagent"} already finished`);
    else this.#stopping = { key: row.key, note: "" };
    return "handled";
  }

  #noteKey(id: string): Reply {
    const stopping = this.#stopping!;
    switch (id) {
      case "enter": {
        const row = this.#rows().find((r) => r.key === stopping.key);
        this.#stopping = null;
        if (row && "agent" in row && row.agent.agentId !== undefined && this.session().stopSubagent(row.agent.agentId, stopping.note.trim()))
          this.flash(`stopped ${row.agent.title ?? "the subagent"}; sope carries on`);
        else this.flash("it finished before it could be stopped");
        return "handled";
      }
      case "escape":
      case "ctrl+c":
        this.#stopping = null;
        return "handled";
      case "backspace":
        stopping.note = [...stopping.note].slice(0, -1).join("");
        return "handled";
      case "ctrl+u":
        stopping.note = "";
        return "handled";
    }
    return "handled";
  }

  /** A click picks a task. */
  click(index: number): void {
    if (this.#stopping) return;
    this.#selected = this.#rows()[index]?.key ?? this.#selected;
  }

  select(index: number): void {
    this.click(index);
  }

  wheel(by: number): void {
    if (!this.#stopping) this.key(by < 0 ? "up" : "down");
  }
}
