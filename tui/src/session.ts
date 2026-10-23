// SPDX-License-Identifier: MIT
// One conversation: an agent, its transcript, the input draft and everything
// in flight. The TUI shows sessions as tabs; each keeps running whether or
// not its tab is the one on screen.
//
// Sessions are saved (store.ts) once they have a first message, and again
// after every turn: the transcript as shown, and the history the model
// remembers (sope_agent_history). A restored session creates its agent only
// when it is first used, then loads that history into it.

import type { SopeEvent } from "sope";
import { AgentBridge } from "./agent/bridge";
import { HostToolRunner } from "./agent/runner";
import { describeImage, type ImageFile } from "./agent/images";
import { describeCall, formatTodos, hostToolsFor, parseInput, todosOf, type HostTool } from "./agent/tools";
import { agentOptions, type Config } from "./config";
import type { SavedMessage, Store, StoredSession } from "./store";
import { palette } from "./theme";
import { ChatView, type Message, type Step } from "./ui/chat";
import { Editor } from "./ui/editor";
import { EventLog } from "./ui/eventlog";
import { TokenRate } from "./ui/status";

/** "stop" denies the call and cancels the whole turn. */
export type Decision = "once" | "always" | "deny" | "stop";

/** A built-in tool call waiting for the user (SOPE_EVENT_PERMISSION). */
export interface Approval {
  callId: number;
  turnId: number;
  name: string;
  input: Record<string, unknown>;
  /** Who asks: undefined for the agent itself, else the subagent type. */
  subagent?: string;
}

type ToolTarget = { msg: Message } | { sub: Message; step: Step };

export const UNTITLED = "New session";
const TITLE_MAX = 40;

/** A tab title from the first message: its first line without image tokens, shortened. */
export function titleFrom(text: string): string {
  const plain = text.replace(/\[Image #\d+\]/g, "").trim();
  if (!plain && text.includes("[Image #")) return "Image";
  const line = plain.split("\n")[0]!.replace(/\s+/g, " ");
  return [...line].length > TITLE_MAX ? `${[...line].slice(0, TITLE_MAX - 1).join("")}…` : line || UNTITLED;
}

/** Where a session saves itself; absent when the store could not be opened. */
export interface Persistence {
  store: Store;
  directory: string;
  /** The saved session to restore. */
  stored?: StoredSession;
}

export class Session {
  readonly chat = new ChatView();
  readonly editor = new Editor();
  readonly trace = new EventLog();
  readonly rate = new TokenRate();
  readonly hostTools: HostTool[];
  title = UNTITLED;
  provider: string;
  model: string;
  approvals: Approval[] = [];
  readonly alwaysAllowed = new Set<string>(); // "a" in the permission prompt
  /** Its tab was in the background when a turn finished. */
  unread = false;
  turnStarted = 0;
  turnCount = 0; // picks the tips shown while a turn runs
  tokens = { in: 0, out: 0 };
  context = 0; // tokens the model saw on the last call: the conversation's size
  compacting = false;

  #config: Config;
  #bridge: AgentBridge | null = null; // created on first use
  #runner: HostToolRunner | null = null;
  #onEvents: (session: Session, events: SopeEvent[]) => void;
  #persist?: Persistence;
  #id: string | null = null; // the saved row, once there is one
  #history: string | null = null; // saved history waiting to be loaded into the agent
  #saved: Array<{ id: number; version: number }> = []; // what each transcript row was when last saved
  #openTurns = new Set<number>();
  #assistant = new Map<number, Message>(); // turn id → reply being streamed
  #thinking = new Map<number, Message>(); // turn id → reasoning being streamed
  #toolCalls = new Map<number, ToolTarget>(); // call id → where its result goes
  #subagents = new Map<number, Message>(); // spawning call id (= agent id) → subagent message

  constructor(
    config: Config,
    readonly allowAll: boolean,
    onEvents: (session: Session, events: SopeEvent[]) => void,
    persist?: Persistence,
  ) {
    this.#config = config;
    this.#onEvents = onEvents;
    this.#persist = persist;
    this.provider = config.provider;
    this.model = config.model;
    this.hostTools = hostToolsFor(config.provider);
    const stored = persist?.stored;
    if (stored) {
      this.#id = stored.id;
      this.title = stored.title;
      this.#history = stored.history;
      this.tokens = { in: stored.tokensIn, out: stored.tokensOut };
      this.context = stored.context;
      for (const m of persist.store.messages(stored.id)) this.chat.add({ ...m, streaming: false });
      this.#saved = this.chat.messages.map((m) => ({ id: m.id, version: m.version }));
    }
  }

  get busy(): boolean {
    return this.#openTurns.size > 0;
  }

  /** Images in the input box, by the N of their [Image #N] token. */
  readonly images = new Map<number, ImageFile>();
  #nextImage = 1;

  /** Keeps an image for the message being written; returns its number. */
  addImage(img: ImageFile): number {
    const n = this.#nextImage++;
    this.images.set(n, img);
    return n;
  }

  /** When its tab was last on screen (performance.now()). */
  lastUsed = performance.now();

  /** Its row in the store; null until it is first saved. */
  get id(): string | null {
    return this.#id;
  }

  /** When it was last saved (ms since the epoch), 0 if never. */
  get updated(): number {
    return this.#persist?.stored?.updated ?? 0;
  }

  /** The native agent, created (and given the saved history) on first use. */
  get #agent() {
    if (!this.#bridge) {
      const bridge = new AgentBridge(agentOptions(this.#config, this.allowAll ? "allow" : "ask"), (events) => {
        this.#onAgentEvents(events);
        this.#onEvents(this, events);
      });
      for (const tool of this.hostTools) bridge.agent.registerTool(tool);
      if (this.model !== this.#config.model) bridge.agent.setOption("model", this.model || null);
      if (this.provider !== this.#config.provider) bridge.agent.setOption("provider", this.provider);
      this.#runner = new HostToolRunner(bridge.agent, this.hostTools, (fn, detail) =>
        fn === "note" ? this.trace.note(detail) : this.trace.call(fn, detail),
      );
      this.#bridge = bridge;
      if (this.#history) {
        try {
          bridge.agent.loadHistory(this.#history);
          this.trace.call("sope_agent_load_history", `${this.#history.length} bytes`);
        } catch (err) {
          this.chat.add({ role: "error", text: `could not restore what the model remembers: ${(err as Error).message}` });
        }
        this.#history = null;
      }
    }
    return this.#bridge.agent;
  }

  // ---- saving ---------------------------------------------------------

  /** Saves the session; a new one only once it has a message of its own. */
  save(): void {
    const p = this.#persist;
    if (!p) return;
    const messages = this.chat.messages;
    if (!this.#id) {
      if (!messages.some((m) => m.role === "user")) return;
      this.#id = crypto.randomUUID();
      p.store.create(this.#id, p.directory, this.title);
    }
    let history: string | undefined;
    if (this.#bridge) {
      try {
        history = this.#bridge.agent.history();
      } catch {
        // a turn is running or queued: its turn_end saves it
      }
    } else if (this.#history !== null) {
      history = this.#history; // never used here, but /clear may have changed it
    }
    const changed = new Map<number, SavedMessage>();
    messages.forEach((m, seq) => {
      const was = this.#saved[seq];
      if (was && was.id === m.id && was.version === m.version) return;
      const { id: _id, version: _version, ...entry } = m;
      changed.set(seq, entry);
    });
    try {
      p.store.save(this.#id, { title: this.title, history, tokensIn: this.tokens.in, tokensOut: this.tokens.out, context: this.context }, changed, messages.length);
      this.#saved = messages.map((m) => ({ id: m.id, version: m.version }));
    } catch (err) {
      this.trace.note(`saving the session failed: ${(err as Error).message}`);
    }
  }

  /** Closed from its tab: hidden from now on, but kept in the store. */
  delete(): void {
    if (this.#id) this.#persist?.store.delete(this.#id);
  }

  // ---- calls into libsope ---------------------------------------------

  /** Sends a message with the given [Image #N] images attached. */
  send(text: string, images: number[] = []): void {
    if (this.title === UNTITLED) this.title = titleFrom(text);
    this.chat.add({ role: "user", text });
    const attached = images.flatMap((n) => {
      const img = this.images.get(n);
      this.images.delete(n);
      return img ? [{ n, img }] : [];
    });
    if (attached.length) this.chat.add({ role: "info", text: attached.map(({ n, img }) => `[Image #${n}] ${describeImage(img)}`).join("\n") });
    try {
      for (const { img } of attached) {
        this.#agent.attachImage(img.bytes, img.mediaType);
        this.trace.call("sope_attach_image", `${img.mediaType} ${img.bytes.length} bytes`);
      }
      const turnId = this.#agent.send(text);
      this.#openTurns.add(turnId);
      this.trace.call("sope_send", `t${turnId} ${JSON.stringify(text)}`);
      this.save();
    } catch (err) {
      this.chat.add({ role: "error", text: (err as Error).message });
    }
  }

  cancel(): void {
    if (!this.#bridge) return;
    this.#bridge.agent.cancel();
    this.trace.call("sope_cancel", "");
  }

  compact(focus: string): void {
    const turnId = this.#agent.compact(focus);
    this.#openTurns.add(turnId);
    this.compacting = true;
    this.trace.call("sope_compact", `t${turnId}${focus ? ` ${JSON.stringify(focus)}` : ""}`);
  }

  reset(): void {
    this.chat.clear();
    this.context = 0;
    this.title = UNTITLED;
    if (this.#bridge) this.#bridge.agent.reset();
    else this.#history = "[]";
    this.trace.call("sope_agent_reset", "");
    this.save();
  }

  setOption(key: string, value: string | null): void {
    this.#agent.setOption(key, value);
    this.trace.call("sope_agent_set_option", `${key}=${key.includes("key") ? "***" : (value ?? "(unset)")}`);
    if (key === "provider") this.provider = value ?? "mock";
    if (key === "model") this.model = value ?? "";
  }

  /** Stops the agent (ending its turn) and saves the session one last time. */
  async shutdown(): Promise<void> {
    if (!this.#bridge) return this.save();
    await this.#bridge.shutdown(() => this.save());
  }

  // ---- permissions ----------------------------------------------------

  /** Answers the first waiting request. */
  decide(decision: Decision): void {
    const approval = this.approvals.shift();
    if (!approval) return;
    this.#permit(approval.callId, decision === "once" || decision === "always");
    if (decision === "always") {
      // Later requests for the same tool are covered too.
      this.alwaysAllowed.add(approval.name);
      for (const other of this.approvals.filter((a) => a.name === approval.name)) this.#permit(other.callId, true);
      this.approvals = this.approvals.filter((a) => a.name !== approval.name);
    }
    if (decision === "stop") {
      for (const other of this.approvals) this.#permit(other.callId, false);
      this.approvals = [];
      this.cancel();
    }
  }

  #onPermission(callId: number, turnId: number, name: string, rawInput: string, agentId = 0, subagent?: string): void {
    if (this.alwaysAllowed.has(name)) return this.#permit(callId, true);
    this.approvals.push({ callId, turnId: agentId ? -agentId : turnId, name, input: parseInput(rawInput), subagent });
    this.chat.scrollToBottom();
  }

  #permit(callId: number, allow: boolean): void {
    try {
      this.#agent.permit(callId, allow);
      this.trace.call("sope_permit", `#${callId} ${allow ? "allow" : "deny"}`);
    } catch (err) {
      this.trace.note((err as Error).message); // its turn ended meanwhile
    }
  }

  #dropApproval(callId: number): void {
    this.approvals = this.approvals.filter((a) => a.callId !== callId);
  }

  /** A turn ended: libsope dropped its pending requests. Subagent turns are keyed by -agentId. */
  #dropApprovals(turnId: number, agentId: number): void {
    const key = agentId ? -agentId : turnId;
    this.approvals = this.approvals.filter((a) => a.turnId !== key);
  }

  // ---- what the status line says --------------------------------------

  /** What the turn is doing right now, as the status line's verb. */
  activity(): { verb: string; color: number } {
    if (this.approvals.length) return { verb: "Waiting for your approval", color: palette.tool };
    if (this.compacting) return { verb: "Compacting the conversation", color: palette.accent };
    if (this.#subagents.size) return { verb: `${this.#subagents.size} subagent${this.#subagents.size > 1 ? "s" : ""} working`, color: palette.accent };
    if (this.#toolCalls.size) {
      const names = new Set([...this.#toolCalls.values()].map((t) => ("msg" in t ? t.msg.title : t.step.name)));
      const verb = names.size === 1 ? `Running ${[...names][0]}` : `Running ${this.#toolCalls.size} tools`;
      return { verb, color: palette.tool };
    }
    for (const m of this.#thinking.values()) if (m.streaming) return { verb: "Thinking", color: palette.accent };
    if (this.#assistant.size) return { verb: "Writing", color: palette.accent };
    return { verb: "Waiting for the model", color: palette.accent };
  }

  // ---- agent events ---------------------------------------------------

  #onAgentEvents(events: SopeEvent[]): void {
    for (const ev of events) {
      this.trace.event(ev);
      if (ev.type === "closed") continue;
      if (ev.type === "text_delta" || ev.type === "thinking_delta") this.rate.add(ev.text);
      if (ev.agentId) this.#onSubagentEvent(ev);
      else this.#onRootEvent(ev);
    }
  }

  #onRootEvent(ev: Exclude<SopeEvent, { type: "closed" }>): void {
    switch (ev.type) {
      case "turn_start":
        this.turnStarted = performance.now();
        this.turnCount++;
        return;
      case "thinking_delta": {
        let m = this.#thinking.get(ev.turnId);
        if (!m) {
          this.#endAssistant(ev.turnId); // a new round of reasoning starts a new block
          m = this.chat.add({ role: "thinking", text: "", streaming: true, turnId: ev.turnId, startedAt: performance.now() });
          this.#thinking.set(ev.turnId, m);
        }
        this.chat.append(m, ev.text);
        return;
      }
      case "text_delta": {
        this.#endThinking(ev.turnId);
        let m = this.#assistant.get(ev.turnId);
        if (!m) {
          m = this.chat.add({ role: "assistant", text: "", streaming: true, turnId: ev.turnId });
          this.#assistant.set(ev.turnId, m);
        }
        this.chat.append(m, ev.text);
        return;
      }
      case "tool_call": // a host tool: we run it
      case "tool_start": {
        // a built-in: libsope runs it
        this.#endRound(ev.turnId);
        const input = parseInput(ev.input);
        const todos = ev.name === "todo_write" ? todosOf(input) : null;
        const msg = this.chat.add({
          role: "tool",
          title: ev.name,
          detail: describeCall(ev.name, input),
          text: todos ? formatTodos(todos) : "",
          streaming: true,
          turnId: ev.turnId,
        });
        this.#toolCalls.set(ev.callId, { msg });
        if (ev.type === "tool_call") this.#runner!.run(ev.callId, ev.turnId, ev.name, ev.input);
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
        const msg = this.chat.add({
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
        if (m) this.chat.update(m, { streaming: false, ok: ev.stopReason === "end_turn", text: ev.result, endedAt: performance.now() });
        this.#subagents.delete(ev.callId);
        return;
      }
      case "usage":
        this.tokens.in += ev.inputTokens;
        this.tokens.out += ev.outputTokens;
        if (!this.compacting) this.context = ev.inputTokens + ev.outputTokens;
        return;
      case "compact": {
        this.compacting = false;
        this.context = Math.round(ev.summary.length / 4);
        const words = ev.summary.split(/\s+/).filter(Boolean).length;
        const why = ev.trigger === "auto" ? "the context grew past the compaction threshold, so " : "";
        this.chat.add({ role: "info", text: `✻ Conversation compacted: ${why}the model now works from a ${words}-word summary instead of the full history.` });
        return;
      }
      case "turn_end":
        this.compacting = false;
        this.#runner!.endTurn(ev.turnId);
        this.#dropApprovals(ev.turnId, 0);
        this.#endRound(ev.turnId);
        for (const [callId, target] of this.#toolCalls) {
          const m = "msg" in target ? target.msg : target.sub;
          if (m.turnId !== ev.turnId) continue;
          if ("msg" in target) this.chat.update(m, { streaming: false, ok: false, text: "cancelled" });
          this.#toolCalls.delete(callId);
        }
        this.#openTurns.delete(ev.turnId);
        if (ev.stopReason === "cancelled") this.chat.add({ role: "info", text: "turn cancelled" });
        this.save();
        return;
      case "error":
        this.chat.add({ role: "error", text: ev.message });
        return;
      case "log":
        if (ev.message.startsWith("compacting")) this.compacting = true;
        return;
    }
  }

  /** Subagent events update the subagent's message instead of the transcript. */
  #onSubagentEvent(ev: Exclude<SopeEvent, { type: "closed" }>): void {
    const sub = this.#subagents.get(ev.agentId);
    switch (ev.type) {
      case "text_delta":
        if (sub) this.chat.update(sub, { tail: ((sub.tail ?? "") + ev.text).slice(-400) });
        return;
      case "tool_call":
      case "tool_start": {
        if (!sub) {
          if (ev.type === "tool_call") this.#agent.toolResult(ev.callId, "subagent is gone", true);
          return;
        }
        const step: Step = { name: ev.name, detail: describeCall(ev.name, parseInput(ev.input)), done: false };
        this.chat.update(sub, { steps: [...(sub.steps ?? []), step], tail: "" });
        this.#toolCalls.set(ev.callId, { sub, step });
        if (ev.type === "tool_call") this.#runner!.run(ev.callId, sub.turnId ?? 0, ev.name, ev.input);
        return;
      }
      case "tool_end":
        return this.#onToolEnd(ev.callId, ev.name, ev.result, ev.isError);
      case "permission":
        return this.#onPermission(ev.callId, ev.turnId, ev.name, ev.input, ev.agentId, sub?.title ?? "subagent");
      case "turn_end":
        this.#runner!.endTurn(ev.turnId);
        this.#dropApprovals(ev.turnId, ev.agentId);
        return;
      case "usage":
        this.tokens.in += ev.inputTokens;
        this.tokens.out += ev.outputTokens;
        return;
      case "error":
        this.chat.add({ role: "error", text: `subagent ${sub?.title ?? ev.agentId}: ${ev.message}` });
        return;
      default:
        return;
    }
  }

  #endThinking(turnId: number): void {
    const m = this.#thinking.get(turnId);
    if (m) this.chat.update(m, { streaming: false, endedAt: performance.now() });
    this.#thinking.delete(turnId);
  }

  #endAssistant(turnId: number): void {
    const m = this.#assistant.get(turnId);
    if (m) this.chat.update(m, { streaming: false });
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
      this.chat.update(target.msg, keep ? { streaming: false, ok: true } : { streaming: false, ok: !isError, text: result });
    } else {
      target.step.done = true;
      target.step.ok = !isError;
      this.chat.update(target.sub, {});
    }
  }
}
