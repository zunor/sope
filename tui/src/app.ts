// The sope TUI: wires the terminal, input decoding, the agent bridge and the
// views together, and lays out each frame.
//
//   ◆ sope 0.2.0                          openai · glm-5.3 · 1.2k tok · ● ready
//
//   › user message
//
//   ✻ Thought for 2.1s
//   ● assistant reply …
//   ◆ agent · general-purpose  explain thread pools
//     ● read_file  src/pool.c
//     ⎿ report …
//
//   ─────────────────────────────────────── ⠋ thinking · 1.2s ─
//   › input
//   ───────────────────────────────────────────────────────────
//   enter send · ctrl+j newline · esc cancel · ctrl+t trace · ctrl+c quit

import { version, type SopeEvent } from "sope";
import { AgentBridge } from "./agent/bridge";
import { tools } from "./agent/tools";
import { agentOptions, loadConfig } from "./config";
import type { CellBuffer } from "./render/buffer";
import { Renderer } from "./render/renderer";
import { InputParser, keyId, type InputEvent } from "./term/input";
import { Terminal } from "./term/terminal";
import { palette, SPINNER } from "./theme";
import { ChatView, summarizeInput, type Message, type Step } from "./ui/chat";
import { Editor } from "./ui/editor";
import { EventLog } from "./ui/eventlog";
import { stringWidth, truncate } from "./unicode/width";

const PAD = 1;
const PROMPT = "› ";
const MAX_INPUT_ROWS = 8;
const ESC_TIMEOUT_MS = 25;
const HINTS: Array<[string, string]> = [
  ["enter", "send"],
  ["ctrl+j", "newline"],
  ["esc", "cancel"],
  ["ctrl+t", "trace"],
  ["pgup/pgdn", "scroll"],
  ["ctrl+c", "quit"],
];
const HELP = [
  "Commands:",
  "  /help              show this help",
  "  /clear             clear the transcript and the conversation history",
  "  /model <name>      switch model (next turn)",
  "  /thinking          show or hide the model's full reasoning",
  "  /trace             toggle the ABI trace panel (ctrl+t)",
  "  /mouse             toggle mouse wheel scrolling (disables text selection)",
  "  /set <key> [val]   sope_agent_set_option; omit val to unset",
  "  /quit              exit",
  `Tools offered to the model: ${tools.map((t) => t.name).join(", ")}, plus \`agent\` for subagents.`,
  "Mock provider: plain text streams a reply; !echo <x>, !clock, !sleep <s> call tools; !agent t1 | t2 runs subagents; !panic fails.",
].join("\n");

type ToolTarget = { msg: Message } | { sub: Message; step: Step };

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

export class App {
  #term = new Terminal();
  #renderer = new Renderer((s) => this.#term.write(s), this.#term.truecolor);
  #parser = new InputParser();
  #chat = new ChatView();
  #editor = new Editor();
  #trace = new EventLog();
  #bridge: AgentBridge;
  #provider: string;
  #model: string;
  #hasKey: boolean;

  #openTurns = new Set<number>();
  #assistant = new Map<number, Message>(); // turn id → reply being streamed
  #thinking = new Map<number, Message>(); // turn id → reasoning being streamed
  #toolCalls = new Map<number, ToolTarget>(); // call id → where its result goes
  #subagents = new Map<number, Message>(); // spawning call id (= agent id) → subagent message
  #turnStarted = 0;
  #tokens = { in: 0, out: 0 };

  #showTrace = false;
  #inputWidth = 40;
  #spinner = 0;
  #spinTimer: ReturnType<typeof setInterval> | null = null;
  #escTimer: ReturnType<typeof setTimeout> | null = null;
  #renderQueued = false;
  #frame = { ms: 0, bytes: 0 };
  #quitting = false;

  constructor() {
    const config = loadConfig();
    this.#provider = config.provider;
    this.#model = config.model;
    this.#hasKey = !!config.apiKey;
    this.#bridge = new AgentBridge(agentOptions(config), (events) => this.#onAgentEvents(events));
    for (const tool of tools) this.#bridge.agent.registerTool(tool);
  }

  start(): void {
    this.#term.enter();
    this.#term.onInput((data) => this.#onInput(data));
    this.#term.onResize(() => {
      this.#renderer.invalidate();
      this.#render();
    });
    const hint =
      this.#provider === "mock" && !this.#hasKey ? " · set SOPE_API_KEY (or .env) to talk to a real model" : "";
    this.#chat.add({ role: "info", text: `sope ${version()} · ${this.#provider}${this.#model ? ` · ${this.#model}` : ""} · /help for commands${hint}` });
    this.#render();
  }

  /** Puts the terminal back to normal; safe to call from crash handlers. */
  restoreTerminal(): void {
    this.#term.leave();
  }

  async quit(): Promise<void> {
    if (this.#quitting) return;
    this.#quitting = true;
    this.#setSpinning(false);
    await this.#bridge.shutdown();
    this.#term.leave();
    process.exit(0);
  }

  // ---- input ----------------------------------------------------------

  #onInput(data: Uint8Array): void {
    if (this.#escTimer) clearTimeout(this.#escTimer);
    this.#escTimer = null;
    for (const ev of this.#parser.feed(data)) this.#handle(ev);
    if (this.#parser.hasPending) {
      this.#escTimer = setTimeout(() => {
        this.#escTimer = null;
        for (const ev of this.#parser.flush()) this.#handle(ev);
        this.#scheduleRender();
      }, ESC_TIMEOUT_MS);
    }
    this.#scheduleRender();
  }

  #handle(ev: InputEvent): void {
    switch (ev.type) {
      case "text":
      case "paste":
        this.#editor.insert(ev.text);
        return;
      case "mouse":
        if (ev.action === "wheel-up") this.#chat.scrollBy(3);
        if (ev.action === "wheel-down") this.#chat.scrollBy(-3);
        return;
      case "key":
        this.#handleKey(keyId(ev));
    }
  }

  #handleKey(id: string): void {
    const e = this.#editor;
    switch (id) {
      case "enter":
        return this.#submit();
      case "ctrl+j":
      case "alt+enter":
      case "shift+enter":
        return e.insert("\n");
      case "ctrl+c":
        if (this.#busy) return this.#cancel();
        if (e.text) return e.clear();
        void this.quit();
        return;
      case "ctrl+d":
        if (!e.text) void this.quit();
        else e.deleteForward();
        return;
      case "escape":
        if (this.#busy) this.#cancel();
        return;
      case "ctrl+t":
      case "f2":
        this.#showTrace = !this.#showTrace;
        return;
      case "ctrl+l":
        return this.#renderer.invalidate();
      case "pageup":
        return this.#chat.scrollBy(this.#chat.pageSize);
      case "pagedown":
        return this.#chat.scrollBy(-this.#chat.pageSize);
      case "backspace":
        return e.backspace();
      case "delete":
        return e.deleteForward();
      case "left":
      case "ctrl+b":
        return e.left();
      case "right":
      case "ctrl+f":
        return e.right();
      case "home":
      case "ctrl+a":
        return e.lineStart();
      case "end":
      case "ctrl+e":
        return e.lineEnd();
      case "alt+left":
      case "ctrl+left":
      case "alt+b":
        return e.wordLeft();
      case "alt+right":
      case "ctrl+right":
      case "alt+f":
        return e.wordRight();
      case "ctrl+w":
      case "alt+backspace":
        return e.deleteWordLeft();
      case "ctrl+u":
        return e.killToLineStart();
      case "ctrl+k":
        return e.killToLineEnd();
      case "up":
      case "ctrl+p":
        if (!e.moveVertical(-1, this.#inputWidth)) e.historyPrev();
        return;
      case "down":
      case "ctrl+n":
        if (!e.moveVertical(1, this.#inputWidth)) e.historyNext();
        return;
    }
  }

  #submit(): void {
    const text = this.#editor.text.trim();
    if (!text) return;
    this.#editor.submit();
    this.#chat.scrollToBottom();
    if (text.startsWith("/")) return this.#command(text);

    this.#chat.add({ role: "user", text });
    try {
      const turnId = this.#bridge.agent.send(text);
      this.#openTurns.add(turnId);
      this.#trace.call("sope_send", `t${turnId} ${JSON.stringify(text)}`);
    } catch (err) {
      this.#chat.add({ role: "error", text: (err as Error).message });
    }
    this.#setSpinning(this.#busy);
  }

  #cancel(): void {
    this.#bridge.agent.cancel();
    this.#trace.call("sope_cancel", "");
  }

  #setOption(key: string, value: string | null): void {
    this.#bridge.agent.setOption(key, value);
    this.#trace.call("sope_agent_set_option", `${key}=${key.includes("key") ? "***" : (value ?? "(unset)")}`);
    if (key === "provider") this.#provider = value ?? "mock";
    if (key === "model") this.#model = value ?? "";
  }

  #command(line: string): void {
    const [cmd = "", ...args] = line.slice(1).split(/\s+/);
    const info = (text: string) => this.#chat.add({ role: "info", text });
    try {
      switch (cmd) {
        case "help":
          return void info(HELP);
        case "clear":
          this.#chat.clear();
          this.#bridge.agent.reset();
          this.#trace.call("sope_agent_reset", "");
          return;
        case "model":
          if (!args[0]) return void info(`model: ${this.#model || "(provider default)"}`);
          this.#setOption("model", args[0]);
          return void info(`model = ${args[0]} (from the next turn)`);
        case "thinking":
          this.#chat.showThinking = !this.#chat.showThinking;
          return void info(`full reasoning ${this.#chat.showThinking ? "shown" : "collapsed"}`);
        case "trace":
          this.#showTrace = !this.#showTrace;
          return;
        case "mouse":
          this.#term.setMouse(!this.#term.mouse);
          return void info(`mouse reporting ${this.#term.mouse ? "on" : "off"}`);
        case "set": {
          const [key, ...rest] = args;
          if (!key) return void this.#chat.add({ role: "error", text: "usage: /set <key> [value]" });
          const value = rest.length ? rest.join(" ") : null;
          this.#setOption(key, value);
          return void info(value === null ? `unset ${key}` : `${key} = ${key.includes("key") ? "***" : value}`);
        }
        case "quit":
        case "exit":
          void this.quit();
          return;
        default:
          this.#chat.add({ role: "error", text: `unknown command /${cmd} (try /help)` });
      }
    } catch (err) {
      this.#chat.add({ role: "error", text: (err as Error).message });
    }
  }

  // ---- agent events ---------------------------------------------------

  get #busy(): boolean {
    return this.#openTurns.size > 0;
  }

  #onAgentEvents(events: SopeEvent[]): void {
    for (const ev of events) {
      this.#trace.event(ev);
      if (ev.type === "closed") continue;
      if (ev.agentId) this.#onSubagentEvent(ev);
      else this.#onRootEvent(ev);
    }
    this.#setSpinning(this.#busy);
    this.#scheduleRender();
  }

  #onRootEvent(ev: Exclude<SopeEvent, { type: "closed" }>): void {
    switch (ev.type) {
      case "turn_start":
        this.#turnStarted = performance.now();
        return;
      case "thinking_delta": {
        let m = this.#thinking.get(ev.turnId);
        if (!m) {
          this.#endAssistant(ev.turnId); // a new round of reasoning starts a new block
          m = this.#chat.add({ role: "thinking", text: "", streaming: true, turnId: ev.turnId, startedAt: performance.now() });
          this.#thinking.set(ev.turnId, m);
        }
        this.#chat.append(m, ev.text);
        return;
      }
      case "text_delta": {
        this.#endThinking(ev.turnId);
        let m = this.#assistant.get(ev.turnId);
        if (!m) {
          m = this.#chat.add({ role: "assistant", text: "", streaming: true, turnId: ev.turnId });
          this.#assistant.set(ev.turnId, m);
        }
        this.#chat.append(m, ev.text);
        return;
      }
      case "tool_call": {
        this.#endRound(ev.turnId);
        const msg = this.#chat.add({ role: "tool", title: ev.name, detail: ev.input, text: "", streaming: true, turnId: ev.turnId });
        this.#toolCalls.set(ev.callId, { msg });
        void this.#runTool(ev.callId, ev.name, ev.input);
        return;
      }
      case "subagent_start": {
        this.#endRound(ev.turnId);
        let description = "";
        try {
          description = String((JSON.parse(ev.input) as { description?: unknown }).description ?? "");
        } catch {
          // keep it empty
        }
        const msg = this.#chat.add({
          role: "subagent",
          title: ev.subagentType,
          detail: description,
          text: "",
          streaming: true,
          turnId: ev.turnId,
          startedAt: performance.now(),
          steps: [],
          tail: "",
        });
        this.#subagents.set(ev.callId, msg);
        return;
      }
      case "subagent_end": {
        const m = this.#subagents.get(ev.callId);
        if (m) this.#chat.update(m, { streaming: false, ok: ev.stopReason === "end_turn", text: ev.result, endedAt: performance.now() });
        this.#subagents.delete(ev.callId);
        return;
      }
      case "usage":
        this.#tokens.in += ev.inputTokens;
        this.#tokens.out += ev.outputTokens;
        return;
      case "turn_end":
        this.#endRound(ev.turnId);
        for (const [callId, target] of this.#toolCalls) {
          const m = "msg" in target ? target.msg : target.sub;
          if (m.turnId !== ev.turnId) continue;
          if ("msg" in target) this.#chat.update(m, { streaming: false, ok: false, text: "cancelled" });
          this.#toolCalls.delete(callId);
        }
        this.#openTurns.delete(ev.turnId);
        if (ev.stopReason === "cancelled") this.#chat.add({ role: "info", text: "turn cancelled" });
        return;
      case "error":
        this.#chat.add({ role: "error", text: ev.message });
        return;
      case "log":
        return;
    }
  }

  /** Subagent events update the subagent's message instead of the transcript. */
  #onSubagentEvent(ev: Exclude<SopeEvent, { type: "closed" }>): void {
    const sub = this.#subagents.get(ev.agentId);
    switch (ev.type) {
      case "text_delta":
        if (sub) this.#chat.update(sub, { tail: ((sub.tail ?? "") + ev.text).slice(-400) });
        return;
      case "tool_call": {
        if (!sub) return void this.#bridge.agent.toolResult(ev.callId, "subagent is gone", true);
        const step: Step = { name: ev.name, detail: summarizeInput(ev.input), done: false };
        this.#chat.update(sub, { steps: [...(sub.steps ?? []), step], tail: "" });
        this.#toolCalls.set(ev.callId, { sub, step });
        void this.#runTool(ev.callId, ev.name, ev.input);
        return;
      }
      case "usage":
        this.#tokens.in += ev.inputTokens;
        this.#tokens.out += ev.outputTokens;
        return;
      case "error":
        this.#chat.add({ role: "error", text: `subagent ${sub?.title ?? ev.agentId}: ${ev.message}` });
        return;
      default:
        return;
    }
  }

  #endThinking(turnId: number): void {
    const m = this.#thinking.get(turnId);
    if (m) this.#chat.update(m, { streaming: false, endedAt: performance.now() });
    this.#thinking.delete(turnId);
  }

  #endAssistant(turnId: number): void {
    const m = this.#assistant.get(turnId);
    if (m) this.#chat.update(m, { streaming: false });
    this.#assistant.delete(turnId);
  }

  /** A model round ended (tool calls follow): later text starts new blocks. */
  #endRound(turnId: number): void {
    this.#endThinking(turnId);
    this.#endAssistant(turnId);
  }

  async #runTool(callId: number, name: string, input: string): Promise<void> {
    const tool = tools.find((t) => t.name === name);
    let result: string;
    let isError = false;
    try {
      if (!tool) throw new Error(`unknown tool ${name}`);
      result = await tool.run(input ? (JSON.parse(input) as Record<string, unknown>) : {});
    } catch (err) {
      result = err instanceof Error ? err.message : String(err);
      isError = true;
    }

    const target = this.#toolCalls.get(callId);
    if (!target) return; // the turn ended while the tool ran
    this.#toolCalls.delete(callId);
    if ("msg" in target) {
      this.#chat.update(target.msg, { streaming: false, ok: !isError, text: result });
    } else {
      target.step.done = true;
      target.step.ok = !isError;
      this.#chat.update(target.sub, {});
    }
    try {
      this.#bridge.agent.toolResult(callId, result, isError);
      this.#trace.call("sope_tool_result", `#${callId} ${JSON.stringify(truncate(result, 200))}`);
    } catch (err) {
      this.#trace.note((err as Error).message);
    }
    this.#scheduleRender();
  }

  // ---- rendering ------------------------------------------------------

  #setSpinning(on: boolean): void {
    if (on && !this.#spinTimer) {
      this.#spinTimer = setInterval(() => {
        this.#spinner = (this.#spinner + 1) % SPINNER.length;
        this.#scheduleRender();
      }, 80);
    } else if (!on && this.#spinTimer) {
      clearInterval(this.#spinTimer);
      this.#spinTimer = null;
    }
  }

  #scheduleRender(): void {
    if (this.#renderQueued || this.#quitting) return;
    this.#renderQueued = true;
    setTimeout(() => {
      this.#renderQueued = false;
      this.#render();
    }, 8);
  }

  #render(): void {
    const t0 = performance.now();
    const W = this.#term.cols;
    const H = this.#term.rows;
    const buf = this.#renderer.begin(W, H);
    const spin = SPINNER[this.#spinner]!;

    if (W < 24 || H < 8) {
      buf.text(0, 0, "terminal too small", { fg: palette.muted });
      this.#renderer.end();
      return;
    }

    const inner = W - PAD * 2;
    const promptWidth = stringWidth(PROMPT);
    this.#inputWidth = inner - promptWidth;
    const layout = this.#editor.layout(this.#inputWidth);
    const inputRows = Math.min(MAX_INPUT_ROWS, layout.rows.length);

    const footerY = H - 1;
    const ruleBottomY = footerY - 1;
    const inputY = ruleBottomY - inputRows;
    const ruleTopY = inputY - 1;
    const bodyY = 2;
    const bodyH = Math.max(1, ruleTopY - 1 - bodyY);

    this.#drawHeader(buf, inner);
    this.#drawBody(buf, { x: PAD, y: bodyY, w: inner, h: bodyH }, spin);
    this.#drawStatusRule(buf, ruleTopY, inner, spin);
    this.#drawInput(buf, inputY, inputRows, layout, promptWidth);
    buf.text(PAD, ruleBottomY, "─".repeat(inner), { fg: palette.faint });
    this.#drawHints(buf, footerY, inner);

    const bytes = this.#renderer.end();
    this.#frame = { ms: performance.now() - t0, bytes };
  }

  #drawHeader(buf: CellBuffer, inner: number): void {
    let x = buf.text(PAD, 0, "◆ sope", { fg: palette.accent, bold: true });
    buf.text(x + 1, 0, version(), { fg: palette.faint });

    const busy = this.#busy;
    const parts = [this.#provider, this.#model].filter(Boolean);
    const total = this.#tokens.in + this.#tokens.out;
    if (total) parts.push(`${formatTokens(total)} tok`);
    const right = parts.join(" · ");
    const state = busy ? "running" : "ready";
    x = PAD + inner - (stringWidth(right) + 3 + 2 + state.length);
    x = buf.text(x, 0, right, { fg: palette.muted });
    x = buf.text(x, 0, " · ", { fg: palette.faint });
    x = buf.text(x, 0, "● ", { fg: busy ? palette.accent : palette.ok });
    buf.text(x, 0, state, { fg: palette.muted });
  }

  #drawBody(buf: CellBuffer, r: { x: number; y: number; w: number; h: number }, spin: string): void {
    if (!this.#showTrace) return this.#chat.render(buf, r, spin);

    const stats = `${this.#trace.count} · ${this.#frame.ms.toFixed(1)}ms ${this.#frame.bytes}B`;
    if (r.w >= 100) {
      const traceW = Math.min(64, Math.floor(r.w * 0.42));
      const chatW = r.w - traceW - 3;
      this.#chat.render(buf, { ...r, w: chatW }, spin);
      for (let y = r.y; y < r.y + r.h; y++) buf.text(r.x + chatW + 1, y, "│", { fg: palette.faint });
      this.#trace.render(buf, { x: r.x + chatW + 3, y: r.y, w: traceW, h: r.h }, stats);
    } else {
      const traceH = Math.max(3, Math.floor(r.h * 0.45));
      const chatH = r.h - traceH - 1;
      this.#chat.render(buf, { ...r, h: chatH }, spin);
      buf.text(r.x, r.y + chatH, "┄".repeat(r.w), { fg: palette.faint });
      this.#trace.render(buf, { x: r.x, y: r.y + chatH + 1, w: r.w, h: traceH }, stats);
    }
  }

  #statusLabel(): { text: string; color: number } {
    if (this.#subagents.size) return { text: `${this.#subagents.size} subagent${this.#subagents.size > 1 ? "s" : ""} working`, color: palette.accent };
    if (this.#toolCalls.size) return { text: "running tools", color: palette.tool };
    for (const m of this.#thinking.values()) if (m.streaming) return { text: "thinking", color: palette.accent };
    if (this.#assistant.size) return { text: "writing", color: palette.accent };
    return { text: "waiting for the model", color: palette.muted };
  }

  #drawStatusRule(buf: CellBuffer, y: number, inner: number, spin: string): void {
    buf.text(PAD, y, "─".repeat(inner), { fg: palette.faint });
    if (!this.#busy) return;
    const status = this.#statusLabel();
    const elapsed = ((performance.now() - this.#turnStarted) / 1000).toFixed(1);
    const label = ` ${status.text} · ${elapsed}s `;
    const x = PAD + inner - stringWidth(label) - 4;
    buf.text(x, y, ` ${spin}`, { fg: status.color });
    buf.text(x + 2, y, label, { fg: palette.muted });
  }

  #drawInput(
    buf: CellBuffer,
    y: number,
    rows: number,
    layout: ReturnType<Editor["layout"]>,
    promptWidth: number,
  ): void {
    const x = PAD + promptWidth;
    buf.text(PAD, y, PROMPT, { fg: palette.accent, bold: true });

    if (!this.#editor.text) {
      const placeholder = this.#provider === "mock" ? "Message sope…  try !echo hi, !agent a | b, or /help" : "Message sope…  /help for commands";
      buf.text(x, y, placeholder, { fg: palette.faint });
    } else {
      const scroll = Math.max(0, layout.cursorRow - rows + 1);
      for (let i = 0; i < rows; i++) {
        const row = layout.rows[scroll + i];
        if (row) buf.text(x, y + i, this.#editor.text.slice(row.start, row.end), {}, x + this.#inputWidth);
      }
      layout.cursorRow -= scroll;
    }
    // The real cursor sits in the input so IME candidate windows appear in the right place.
    this.#renderer.cursor = { x: x + layout.cursorCol, y: y + layout.cursorRow, visible: true };
  }

  #drawHints(buf: CellBuffer, y: number, inner: number): void {
    let x = PAD;
    const end = PAD + inner;
    HINTS.forEach(([key, what], i) => {
      if (x >= end) return;
      if (i > 0) x = buf.text(x, y, "  ", {}, end);
      const piece = `${key} ${what}`;
      if (x + stringWidth(piece) > end) {
        buf.text(x, y, truncate(piece, end - x), { fg: palette.faint }, end);
        x = end;
        return;
      }
      x = buf.text(x, y, key, { fg: palette.muted }, end);
      x = buf.text(x + 1, y, what, { fg: palette.faint }, end);
    });
  }
}
