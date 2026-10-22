// SPDX-License-Identifier: MIT
// The sope TUI: wires the terminal, input decoding, the agent bridge and the
// views together, and lays out each frame.
//
//   ◆ sope 0.1.0                openai · glm-5.3 · ctx 8.1k · 1.2k tok · ● ready
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
//   › input                         (or a permission prompt for
//   ───────────────────────────────  write_file / edit_file / bash)
//   enter send · ctrl+j newline · esc cancel · ctrl+t trace · ctrl+c quit

import { homedir } from "node:os";
import { version, type SopeEvent } from "sope";
import { AgentBridge } from "./agent/bridge";
import { HostToolRunner } from "./agent/runner";
import {
  ASKING_TOOLS,
  describeCall,
  formatTodos,
  hostToolsFor,
  parseInput,
  previewFor,
  READ_TOOLS,
  todosOf,
  type HostTool,
  type PreviewLine,
} from "./agent/tools";
import { agentOptions, configPath, type Config } from "./config";
import type { CellBuffer } from "./render/buffer";
import { Renderer } from "./render/renderer";
import { InputParser, keyId, type InputEvent, type MouseEvent as MouseInput } from "./term/input";
import { Terminal } from "./term/terminal";
import { palette, SPINNER } from "./theme";
import { ChatView, type Message, type Step } from "./ui/chat";
import { Editor } from "./ui/editor";
import { EventLog } from "./ui/eventlog";
import { copyToClipboard, Selection } from "./ui/selection";
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
const HELP = (hostTools: HostTool[]) => [
  "Commands:",
  "  /help              show this help",
  "  /clear             clear the transcript and the conversation history",
  "  /compact [focus]   summarize the conversation to free context (also automatic)",
  "  /model <name>      switch model (next turn)",
  "  /thinking          show or hide the model's full reasoning",
  "  /trace             toggle the ABI trace panel (ctrl+t)",
  "  /mouse             toggle mouse capture (wheel scroll, drag to copy); off gives selection back to the terminal",
  "  /set <key> [val]   sope_agent_set_option; omit val to unset",
  "  /permissions       show which tools run without asking",
  "  /quit              exit",
  `Tools (built into libsope): ${[...READ_TOOLS, ...ASKING_TOOLS.map((t) => `${t}*`)].join(", ")}, plus \`agent\` for subagents (* asks first).`,
  ...(hostTools.length ? [`Host tools (this TUI): ${hostTools.map((t) => t.name).join(", ")}.`] : []),
  `Config: ${configPath()} or environment variables (SOPE_API_KEY, SOPE_MODEL, SOPE_BASE_URL, ...).`,
  "Mock provider: plain text streams a reply; !echo <x>, !clock, !sleep <s> call host tools; !read {\"file_path\":\"README.md\"} (any tool, JSON input); !agent t1 | t2 runs subagents; !panic fails.",
].join("\n");

const MAX_PREVIEW_ROWS = 12;

export interface AppOptions {
  config: Config;
  /** Run edits and commands without asking. */
  allowAll?: boolean;
  /** Sent as the first message. */
  prompt?: string;
}

/** "stop" denies the call and cancels the whole turn. */
type Decision = "once" | "always" | "deny" | "stop";

/** A built-in tool call waiting for the user (SOPE_EVENT_PERMISSION). */
interface Approval {
  callId: number;
  turnId: number;
  name: string;
  input: Record<string, unknown>;
  /** Who asks: undefined for the agent itself, else the subagent type. */
  subagent?: string;
}

type ToolTarget = { msg: Message } | { sub: Message; step: Step };

const previewColor = (kind: PreviewLine["kind"]) =>
  kind === "add" ? palette.ok : kind === "remove" ? palette.error : kind === "command" ? palette.tool : palette.muted;

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
  #selection = new Selection();
  #notice: string | null = null;
  #noticeTimer: ReturnType<typeof setTimeout> | null = null;
  #bridge: AgentBridge;
  #hostTools: HostTool[];
  #runner: HostToolRunner;
  #approvals: Approval[] = [];
  #allowAll: boolean;
  #alwaysAllowed = new Set<string>(); // "a" in the permission prompt
  #provider: string;
  #model: string;
  #hasKey: boolean;
  #initialPrompt?: string;

  #openTurns = new Set<number>();
  #assistant = new Map<number, Message>(); // turn id → reply being streamed
  #thinking = new Map<number, Message>(); // turn id → reasoning being streamed
  #toolCalls = new Map<number, ToolTarget>(); // call id → where its result goes
  #subagents = new Map<number, Message>(); // spawning call id (= agent id) → subagent message
  #turnStarted = 0;
  #tokens = { in: 0, out: 0 };
  #context = 0; // tokens the model saw on the last call: the conversation's size
  #compacting = false;

  #showTrace = false;
  #inputWidth = 40;
  #spinner = 0;
  #spinTimer: ReturnType<typeof setInterval> | null = null;
  #escTimer: ReturnType<typeof setTimeout> | null = null;
  #renderQueued = false;
  #frame = { ms: 0, bytes: 0 };
  #quitting = false;

  constructor({ config, allowAll = false, prompt }: AppOptions) {
    this.#provider = config.provider;
    this.#model = config.model;
    this.#hasKey = !!config.apiKey;
    this.#initialPrompt = prompt;
    this.#allowAll = allowAll;
    this.#hostTools = hostToolsFor(config.provider);
    this.#bridge = new AgentBridge(agentOptions(config, allowAll ? "allow" : "ask"), (events) => this.#onAgentEvents(events));
    for (const tool of this.#hostTools) this.#bridge.agent.registerTool(tool);
    this.#runner = new HostToolRunner(this.#bridge.agent, this.#hostTools, (fn, detail) =>
      fn === "note" ? this.#trace.note(detail) : this.#trace.call(fn, detail),
    );
    this.#term.setMouse(config.mouse);
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
    const yolo = this.#allowAll ? " · --allow-all: edits and commands run without asking" : "";
    this.#chat.add({ role: "info", text: `sope ${version()} · ${this.#provider}${this.#model ? ` · ${this.#model}` : ""} · ${process.cwd().replace(homedir(), "~")} · /help for commands${hint}${yolo}` });
    if (this.#initialPrompt) this.#sendMessage(this.#initialPrompt);
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
    if (ev.type === "mouse") return this.#handleMouse(ev);
    this.#selection.clear();
    if (this.#approvals.length && (ev.type === "text" || ev.type === "paste")) {
      if (ev.type === "text" && [...ev.text].length === 1) this.#handleApprovalKey(ev.text);
      return; // the input box is hidden while a permission prompt is up
    }
    switch (ev.type) {
      case "text":
      case "paste":
        this.#editor.insert(ev.text);
        return;
      case "key":
        this.#handleKey(keyId(ev));
    }
  }

  #handleMouse(ev: MouseInput): void {
    const p = { x: ev.x, y: ev.y };
    switch (ev.action) {
      case "wheel-up":
      case "wheel-down":
        this.#selection.clear(); // it is in screen cells: the text under it is about to move
        return this.#chat.scrollBy(ev.action === "wheel-up" ? 3 : -3);
      case "press":
        if (ev.button === 0) this.#selection.press(p);
        return;
      case "drag":
        return this.#selection.drag(p);
      case "release":
        if (this.#selection.release(p)) this.#copySelection();
    }
  }

  #copySelection(): void {
    const screen = this.#renderer.screen;
    const text = screen ? this.#selection.text(screen) : "";
    if (!text.trim()) return;
    copyToClipboard(text, (s) => this.#term.write(s));
    this.#flash(`copied ${[...text].length} characters`);
  }

  /** Shows a short message in place of the key hints. */
  #flash(text: string): void {
    this.#notice = text;
    if (this.#noticeTimer) clearTimeout(this.#noticeTimer);
    this.#noticeTimer = setTimeout(() => {
      this.#notice = null;
      this.#scheduleRender();
    }, 2000);
  }

  #handleKey(id: string): void {
    if (this.#approvals.length && this.#handleApprovalKey(id)) return;
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
    this.#sendMessage(text);
  }

  #sendMessage(text: string): void {
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
          return void info(HELP(this.#hostTools));
        case "compact": {
          const focus = args.join(" ");
          const turnId = this.#bridge.agent.compact(focus);
          this.#openTurns.add(turnId);
          this.#compacting = true;
          this.#trace.call("sope_compact", `t${turnId}${focus ? ` ${JSON.stringify(focus)}` : ""}`);
          this.#setSpinning(true);
          return;
        }
        case "permissions": {
          if (this.#allowAll) return void info("--allow-all: every tool runs without asking");
          const allowed = [...this.#alwaysAllowed];
          return void info(
            `Ask before: ${ASKING_TOOLS.filter((n) => !allowed.includes(n)).join(", ") || "(nothing)"}\n` +
              `Allowed for this session: ${allowed.join(", ") || "(nothing)"}\n` +
              `Never ask: ${READ_TOOLS.join(", ")}.`,
          );
        }
        case "clear":
          this.#chat.clear();
          this.#context = 0;
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
      case "tool_call": // a host tool: we run it
      case "tool_start": {
        // a built-in: libsope runs it
        this.#endRound(ev.turnId);
        const input = parseInput(ev.input);
        const todos = ev.name === "todo_write" ? todosOf(input) : null;
        const msg = this.#chat.add({
          role: "tool",
          title: ev.name,
          detail: describeCall(ev.name, input),
          text: todos ? formatTodos(todos) : "",
          streaming: true,
          turnId: ev.turnId,
        });
        this.#toolCalls.set(ev.callId, { msg });
        if (ev.type === "tool_call") this.#runner.run(ev.callId, ev.turnId, ev.name, ev.input);
        return;
      }
      case "tool_end":
        return this.#onToolEnd(ev.callId, ev.name, ev.result, ev.isError);
      case "permission":
        return this.#onPermission(ev.callId, ev.turnId, ev.name, ev.input);
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
        if (!this.#compacting) this.#context = ev.inputTokens + ev.outputTokens;
        return;
      case "compact": {
        this.#compacting = false;
        this.#context = Math.round(ev.summary.length / 4);
        const words = ev.summary.split(/\s+/).filter(Boolean).length;
        const why = ev.trigger === "auto" ? "the context grew past the compaction threshold, so " : "";
        this.#chat.add({ role: "info", text: `✻ Conversation compacted: ${why}the model now works from a ${words}-word summary instead of the full history.` });
        return;
      }
      case "turn_end":
        this.#compacting = false;
        this.#runner.endTurn(ev.turnId);
        this.#dropApprovals(ev.turnId, 0);
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
        if (ev.message.startsWith("compacting")) this.#compacting = true;
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
      case "tool_call":
      case "tool_start": {
        if (!sub) {
          if (ev.type === "tool_call") this.#bridge.agent.toolResult(ev.callId, "subagent is gone", true);
          return;
        }
        const step: Step = { name: ev.name, detail: describeCall(ev.name, parseInput(ev.input)), done: false };
        this.#chat.update(sub, { steps: [...(sub.steps ?? []), step], tail: "" });
        this.#toolCalls.set(ev.callId, { sub, step });
        if (ev.type === "tool_call") this.#runner.run(ev.callId, sub.turnId ?? 0, ev.name, ev.input);
        return;
      }
      case "tool_end":
        return this.#onToolEnd(ev.callId, ev.name, ev.result, ev.isError);
      case "permission":
        return this.#onPermission(ev.callId, ev.turnId, ev.name, ev.input, ev.agentId, sub?.title ?? "subagent");
      case "turn_end":
        this.#runner.endTurn(ev.turnId);
        this.#dropApprovals(ev.turnId, ev.agentId);
        return;
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

  #onToolEnd(callId: number, name: string, result: string, isError: boolean): void {
    const target = this.#toolCalls.get(callId);
    this.#dropApproval(callId);
    if (!target) return;
    this.#toolCalls.delete(callId);
    if ("msg" in target) {
      // todo_write keeps showing the list it set, not the confirmation the model gets
      const keep = name === "todo_write" && !isError;
      this.#chat.update(target.msg, keep ? { streaming: false, ok: true } : { streaming: false, ok: !isError, text: result });
    } else {
      target.step.done = true;
      target.step.ok = !isError;
      this.#chat.update(target.sub, {});
    }
    this.#scheduleRender();
  }

  // ---- permissions ----------------------------------------------------

  #onPermission(callId: number, turnId: number, name: string, rawInput: string, agentId = 0, subagent?: string): void {
    if (this.#alwaysAllowed.has(name)) return this.#permit(callId, true);
    this.#approvals.push({ callId, turnId: agentId ? -agentId : turnId, name, input: parseInput(rawInput), subagent });
    this.#chat.scrollToBottom();
  }

  #permit(callId: number, allow: boolean): void {
    try {
      this.#bridge.agent.permit(callId, allow);
      this.#trace.call("sope_permit", `#${callId} ${allow ? "allow" : "deny"}`);
    } catch (err) {
      this.#trace.note((err as Error).message); // its turn ended meanwhile
    }
  }

  #handleApprovalKey(id: string): boolean {
    const decision: Decision | undefined = (
      { y: "once", enter: "once", a: "always", n: "deny", escape: "stop", "ctrl+c": "stop" } as Record<string, Decision>
    )[id.toLowerCase()];
    if (!decision) return !["pageup", "pagedown", "ctrl+t", "f2", "ctrl+l"].includes(id); // swallow everything else
    const approval = this.#approvals.shift()!;
    this.#permit(approval.callId, decision === "once" || decision === "always");
    if (decision === "always") {
      // Later requests for the same tool are covered too.
      this.#alwaysAllowed.add(approval.name);
      for (const other of this.#approvals.filter((a) => a.name === approval.name)) this.#permit(other.callId, true);
      this.#approvals = this.#approvals.filter((a) => a.name !== approval.name);
    }
    if (decision === "stop") {
      for (const other of this.#approvals) this.#permit(other.callId, false);
      this.#approvals = [];
      this.#cancel();
    }
    return true;
  }

  #dropApproval(callId: number): void {
    this.#approvals = this.#approvals.filter((a) => a.callId !== callId);
  }

  /** A turn ended: libsope dropped its pending requests. Subagent turns are keyed by -agentId. */
  #dropApprovals(turnId: number, agentId: number): void {
    const key = agentId ? -agentId : turnId;
    this.#approvals = this.#approvals.filter((a) => a.turnId !== key);
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
    const approval = this.#approvals[0];
    const preview = approval ? this.#previewRows(approval, Math.min(MAX_PREVIEW_ROWS, H - 10)) : [];
    const inputRows = approval ? preview.length + 2 : Math.min(MAX_INPUT_ROWS, layout.rows.length);

    const footerY = H - 1;
    const ruleBottomY = footerY - 1;
    const inputY = ruleBottomY - inputRows;
    const ruleTopY = inputY - 1;
    const bodyY = 2;
    const bodyH = Math.max(1, ruleTopY - 1 - bodyY);

    this.#drawHeader(buf, inner);
    this.#drawBody(buf, { x: PAD, y: bodyY, w: inner, h: bodyH }, spin);
    this.#drawStatusRule(buf, ruleTopY, inner, spin);
    if (approval) this.#drawApproval(buf, inputY, inner, approval, preview);
    else this.#drawInput(buf, inputY, inputRows, layout, promptWidth);
    buf.text(PAD, ruleBottomY, "─".repeat(inner), { fg: palette.faint });
    this.#drawHints(buf, footerY, inner);
    this.#selection.highlight(buf);

    const bytes = this.#renderer.end();
    this.#frame = { ms: performance.now() - t0, bytes };
  }

  #previewRows(a: Approval, max: number): PreviewLine[] {
    const rows = previewFor(a.name, a.input);
    return rows.length > max ? [...rows.slice(0, max - 1), { text: `… ${rows.length - max + 1} more lines`, kind: "plain" }] : rows;
  }

  #drawApproval(buf: CellBuffer, y: number, inner: number, a: Approval, preview: PreviewLine[]): void {
    const who = a.subagent ? `subagent ${a.subagent} wants` : "sope wants";
    let x = buf.text(PAD, y, "? ", { fg: palette.tool, bold: true });
    x = buf.text(x, y, `${who} to run `, { fg: palette.muted });
    x = buf.text(x, y, a.name, { fg: palette.tool, bold: true });
    if (this.#approvals.length > 1) buf.text(x, y, `  (+${this.#approvals.length - 1} more waiting)`, { fg: palette.faint });

    const marks = { add: "+ ", remove: "- ", command: "$ ", plain: "  " } as const;
    preview.forEach((line, i) => {
      const mark = marks[line.kind ?? "plain"];
      const style = { fg: previewColor(line.kind) };
      buf.text(PAD + 2, y + 1 + i, mark, style);
      buf.text(PAD + 4, y + 1 + i, truncate(line.text.replace(/\t/g, "  "), inner - 4), line.kind === "plain" ? { fg: palette.muted } : {});
    });

    const options: Array<[string, string]> = [
      ["y", "allow once"],
      ["a", `always allow ${a.name}`],
      ["n", "deny"],
      ["esc", "deny and stop"],
    ];
    x = PAD + 2;
    const optY = y + 1 + preview.length;
    for (const [key, what] of options) {
      x = buf.text(x, optY, key, { fg: palette.accent, bold: true });
      x = buf.text(x + 1, optY, what, { fg: palette.muted });
      x += 3;
    }
    this.#renderer.cursor = { x: 0, y: 0, visible: false };
  }

  #drawHeader(buf: CellBuffer, inner: number): void {
    let x = buf.text(PAD, 0, "◆ sope", { fg: palette.accent, bold: true });
    buf.text(x + 1, 0, version(), { fg: palette.faint });

    const busy = this.#busy;
    const parts = [this.#provider, this.#model].filter(Boolean);
    const total = this.#tokens.in + this.#tokens.out;
    if (this.#context) parts.push(`ctx ${formatTokens(this.#context)}`);
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
    if (this.#approvals.length) return { text: "waiting for your approval", color: palette.tool };
    if (this.#compacting) return { text: "compacting the conversation", color: palette.accent };
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
    if (this.#notice) return void buf.text(PAD, y, truncate(this.#notice, inner), { fg: palette.ok });
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
