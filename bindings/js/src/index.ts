// SPDX-License-Identifier: MIT
// Typed, idiomatic wrapper over the sope C ABI. See docs/abi.md for semantics.
import { toArrayBuffer, type Pointer } from "bun:ffi";
import { C } from "./ffi";

export { ABI, abiCompatible, libraryPath, useLibrary } from "./ffi";

export const ErrorCode = {
  Error: -1,
  Invalid: -2,
  NoMemory: -3,
  NotFound: -4,
  Closed: -5,
  Cancelled: -6,
  Busy: -7,
  Conflict: -8,
  Timeout: -9,
  OutputLimit: -10,
} as const;

export class SopeError extends Error {
  constructor(
    readonly code: number,
    message: string,
  ) {
    super(message);
    this.name = "SopeError";
  }
}

export type StopReason = "end_turn" | "cancelled" | "error";
export type LogLevel = "debug" | "info" | "warn" | "error";

export interface ExecutionPolicy {
  tools: string[];
  external?: string[];
  authorize?: boolean;
  /** Complete shell environment; libsope does not inherit process.env. */
  environment?: Record<string, string>;
}

export interface AcceptanceCriterion {
  id: string;
  description: string;
  cwd: string;
  argv: string[];
  exit_code: number;
  output?: { empty: true } | { contains: string };
}
export interface DelegationState {
  agent_id: number;
  state: "running" | "cancel_requested" | "completed" | "failed" | "cancelled" | "interrupted" | "not_started";
  recent_evidence_call_ids: number[];
  host_reconciled_call_ids: number[];
}
export interface DelegationLedger {
  total: number;
  states: Record<DelegationState["state"], number>;
  recent: DelegationState[];
}
export interface AcceptanceReport {
  session_id: string;
  agent_id: number;
  turn_id: number;
  scope: string;
  status: "accepted" | "rejected" | "incomplete";
  /** All native lifecycle counts and latest 32 direct delegations of this task. */
  delegations: DelegationLedger;
  /** Host-required completed direct delegations in this turn; not review quality. */
  delegation_requirement?: {
    minimum_completed: number;
    observed_completed: number;
    verdict: "satisfied" | "unverified";
  };
  criteria: Array<{
    expected: AcceptanceCriterion;
    verdict: "satisfied" | "failed" | "unverified";
    observation?: Record<string, unknown>;
    stale?: boolean;
    output_complete?: boolean;
    output_bytes?: number;
    output_excerpt?: string;
    reason?: string;
    unverified_interpretation?: string;
  }>;
}
export interface Outcome {
  turn_id: string;
  stop: number;
  final: string;
  acceptance: AcceptanceReport | null;
}

/** agentId is 0 for the agent itself, else the callId of the subagent_start that launched the subagent. */
type Origin = { turnId: number; agentId: number; sequence: number };

export type SopeEvent =
  | ({ type: "turn_start" } & Origin)
  | ({ type: "text_delta"; text: string } & Origin)
  | ({ type: "thinking_delta"; text: string } & Origin)
  /** The previous model attempt was discarded; tools have not been dispatched. */
  | ({ type: "model_retry"; round: number; attempt: number; reason: string; delayMs: number;
       compaction: boolean; discardedTextBytes: number; discardedThinkingBytes: number;
       maxTokens: number; nextMaxTokens: number } & Origin)
  /** A host tool call: answer it with toolResult(). */
  | ({ type: "tool_call"; callId: number; name: string; input: string } & Origin)
  /** A built-in tool call the library runs itself. */
  | ({ type: "tool_start"; callId: number; name: string; input: string } & Origin)
  /** Any tool call (host or built-in) finished; `result` is what the model sees. */
  | ({ type: "tool_end"; callId: number; name: string; isError: boolean; result: string } & Origin)
  /** A built-in tool waits for permit(). */
  | ({ type: "permission"; callId: number; name: string; input: string } & Origin)
  | ({ type: "turn_end"; stopReason: StopReason } & Origin)
  | ({ type: "error"; code: number; message: string } & Origin)
  | ({ type: "log"; level: LogLevel; message: string } & Origin)
  | ({ type: "usage"; inputTokens: number; outputTokens: number } & Origin)
  | ({ type: "subagent_start"; callId: number; subagentType: string; input: string } & Origin)
  | ({ type: "subagent_end"; callId: number; stopReason: StopReason; result: string } & Origin)
  /** Older history was replaced by `summary`, preserving a budgeted recent suffix. */
  | ({ type: "compact"; trigger: "auto" | "manual"; summary: string } & Origin)
  /** Synthesized when sope_poll returns SOPE_ECLOSED: no further events will arrive. */
  | { type: "closed" };

export interface SubagentDefinition {
  name: string;
  /** When the model should use this subagent. */
  description: string;
  systemPrompt: string;
  /** Tool names (built-in or host), or "*" for all (default). */
  tools?: string[] | "*";
  model?: string;
  maxRounds?: number;
}

export interface ToolSpec {
  name: string;
  description?: string;
  /** JSON Schema object, or its serialized form. */
  inputSchema?: object | string;
}

export interface RecoveryState {
  pending: boolean;
  calls: Array<{ call_id: string; agent_id: string; name: string; input: string; artifacts: string[] }>;
  delegations: Array<{ agent_id: string; unknown_calls: number; action: "reconstruct_from_journal" }>;
}

/** How full the model's context is (sope_agent_context); tokens, 0 when unknown. */
export interface ContextUsage {
  state: "idle" | "running";
  used: number;
  estimate: number;
  window: number;
  reserve: number;
  threshold: number;
  parts: { system: number; tools: number; summary: number; messages: number; tool_results: number; images: number };
  counts: { tools: number; messages: number; tool_results: number; images: number };
  largest: Array<{ name: string; input?: string; tokens: number }>;
}

/** A background shell (bash with run_in_background), as sope_agent_shells reports it. */
export interface Shell {
  id: number;
  command: string;
  running: boolean;
  /** null while it runs. */
  exit_code: number | null;
  /** stopShell() stopped it. */
  stopped: boolean;
  output_bytes: number;
  /** The end of its output, at most 512 bytes. */
  tail: string;
}

const STOP_REASONS: StopReason[] = ["end_turn", "cancelled", "error"];
const LOG_LEVELS: LogLevel[] = ["debug", "info", "warn", "error"];

// Offsets of sope_event_t on 64-bit targets (asserted in src/agent.c).
const EVENT_SIZE = 80;
const EV = { type: 4, turnId: 8, callId: 16, agentId: 24, name: 32, nameLen: 40, data: 48, dataLen: 56, code: 64, sequence: 72 } as const;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const EMPTY = new Uint8Array(1); // bun:ffi rejects zero-length buffers as pointers

const cstr = (s: string) => encoder.encode(`${s}\0`);

// sope never returns NULL strings, but bun:ffi types cstring results as nullable.
const str = (s: { toString(): string } | null) => (s ? s.toString() : "");

function check(rc: number, what: string): number {
  if (rc >= 0) return rc;
  const detail = str(C().sope_last_error()) || str(C().sope_strerror(rc));
  throw new SopeError(rc, `${what}: ${detail}`);
}

function readString(ptr: number, len: number): string {
  if (!ptr || !len) return "";
  return decoder.decode(new Uint8Array(toArrayBuffer(ptr as Pointer, 0, len)));
}

export function version(): string {
  return str(C().sope_version());
}

export function versionNumber(): number {
  return C().sope_version_number();
}

/** Sizes the shared worker pool (0 = default). Only before the first agent exists. */
export function setThreads(n: number): void {
  check(C().sope_set_threads(n), "sope_set_threads");
}

/** Stops the worker pool. Every agent must have been freed. */
export function shutdown(): void {
  check(C().sope_shutdown(), "sope_shutdown");
}

export class Agent {
  #handle: Pointer | null;
  readonly #owned: boolean;
  readonly #event = new ArrayBuffer(EVENT_SIZE);
  readonly #eventView = new DataView(this.#event);
  readonly #eventBytes = new Uint8Array(this.#event);

  private constructor(handle: Pointer, owned: boolean) {
    this.#handle = handle;
    this.#owned = owned;
  }

  static create(options: Record<string, string> = {}): Agent {
    const out = new BigUint64Array(1);
    check(C().sope_agent_new(out), "sope_agent_new");
    const agent = new Agent(Number(out[0]) as Pointer, true);
    for (const [key, value] of Object.entries(options)) agent.setOption(key, value);
    return agent;
  }

  /** Open an exclusively owned durable session. Unfinished work stays paused. */
  static open(directory: string, options: Record<string, string> = {}): Agent {
    const out = new BigUint64Array(1);
    check(C().sope_agent_open(out, cstr(directory)), "sope_agent_open");
    const agent = new Agent(Number(out[0]) as Pointer, true);
    try {
      for (const [key, value] of Object.entries(options)) agent.setOption(key, value);
      return agent;
    } catch (error) {
      agent.free();
      throw error;
    }
  }

  /** Durable terminal result. end_turn alone does not mean acceptance succeeded. */
  outcome(turnId: number | bigint): Outcome {
    const ptr = new BigUint64Array(1), len = new BigUint64Array(1);
    check(C().sope_agent_outcome(this.#ptr(), turnId, ptr, len), "sope_agent_outcome");
    return JSON.parse(readString(Number(ptr[0]), Number(len[0]))) as Outcome;
  }

  recovery(): RecoveryState {
    const ptr = new BigUint64Array(1), len = new BigUint64Array(1);
    check(C().sope_agent_recovery(this.#ptr(), ptr, len), "sope_agent_recovery");
    return JSON.parse(readString(Number(ptr[0]), Number(len[0]))) as RecoveryState;
  }

  /** Records a verified outcome. This never reruns the interrupted operation. */
  resolve(callId: number | bigint, content: string, isError = false): void {
    const bytes = encoder.encode(content);
    check(C().sope_agent_resolve(this.#ptr(), callId, isError ? 1 : 0, bytes.length ? bytes : EMPTY, bytes.length), "sope_agent_resolve");
  }

  resume(): void {
    check(C().sope_agent_resume(this.#ptr()), "sope_agent_resume");
  }

  /** Non-owning view of an agent created elsewhere, e.g. in another Worker. */
  static attach(handle: number): Agent {
    return new Agent(handle as Pointer, false);
  }

  get handle(): number {
    return this.#ptr();
  }

  setOption(key: string, value: string | null): void {
    check(C().sope_agent_set_option(this.#ptr(), cstr(key), value === null ? null : cstr(value)), "sope_agent_set_option");
  }

  /** Configure the host execution contract before sending or resuming work. */
  setPolicy(policy: ExecutionPolicy): void {
    const bytes = encoder.encode(JSON.stringify(policy));
    check(C().sope_agent_policy(this.#ptr(), bytes, bytes.length), "sope_agent_policy");
  }

  registerTool(tool: ToolSpec): void {
    const schema = typeof tool.inputSchema === "string" ? tool.inputSchema : JSON.stringify(tool.inputSchema ?? {});
    check(
      C().sope_tool_register(this.#ptr(), cstr(tool.name), cstr(tool.description ?? ""), cstr(schema)),
      "sope_tool_register",
    );
  }

  /** Queues a user message and returns its turn id. */
  send(text: string): number {
    const bytes = encoder.encode(text);
    const out = new BigUint64Array(1);
    check(C().sope_send(this.#ptr(), bytes.length ? bytes : EMPTY, bytes.length, out), "sope_send");
    return Number(out[0]);
  }

  /** Queues a compaction turn (see sope_compact) and returns its turn id. */
  compact(instructions = ""): number {
    const bytes = encoder.encode(instructions);
    const out = new BigUint64Array(1);
    check(C().sope_compact(this.#ptr(), bytes.length ? bytes : EMPTY, bytes.length, out), "sope_compact");
    return Number(out[0]);
  }

  toolResult(callId: number, content: string, isError = false): void {
    const bytes = encoder.encode(content);
    check(
      C().sope_tool_result(this.#ptr(), callId, isError ? 1 : 0, bytes.length ? bytes : EMPTY, bytes.length),
      "sope_tool_result",
    );
  }

  /** Answers a "permission" event: run the built-in tool, or refuse it (message tells the model why). */
  permit(callId: number, allow: boolean, message = ""): void {
    const bytes = encoder.encode(message);
    check(
      C().sope_permit(this.#ptr(), callId, allow ? 1 : 0, bytes.length ? bytes : EMPTY, bytes.length),
      "sope_permit",
    );
  }

  /** Registers a subagent type the model can launch through the built-in `agent` tool. */
  registerSubagent(def: SubagentDefinition): void {
    const json = encoder.encode(
      JSON.stringify({
        name: def.name,
        description: def.description,
        system_prompt: def.systemPrompt,
        tools: def.tools,
        model: def.model,
        max_rounds: def.maxRounds,
      }),
    );
    check(C().sope_subagent_register(this.#ptr(), json, json.length), "sope_subagent_register");
  }

  cancel(): void {
    check(C().sope_cancel(this.#ptr()), "sope_cancel");
  }

  /**
   * Stops one running subagent (agentId: the callId of its "subagent_start")
   * and lets the parent turn go on. The note tells the model why, or what to
   * do instead. Throws SOPE_ENOTFOUND once it is no longer running.
   */
  cancelSubagent(agentId: number, note = ""): void {
    const bytes = encoder.encode(note);
    check(C().sope_subagent_cancel(this.#ptr(), agentId, bytes.length ? bytes : EMPTY, bytes.length), "sope_subagent_cancel");
  }

  /** The background shells, oldest first; they outlive turns until stopped. */
  shells(): Shell[] {
    const ptr = new BigUint64Array(1);
    const len = new BigUint64Array(1);
    check(C().sope_agent_shells(this.#ptr(), ptr, len), "sope_agent_shells");
    return JSON.parse(readString(Number(ptr[0]), Number(len[0]))) as Shell[];
  }

  /** Stops a background shell and everything it started. */
  stopShell(id: number): void {
    check(C().sope_shell_stop(this.#ptr(), id), "sope_shell_stop");
  }

  /** Forgets the conversation history from the next turn on. */
  reset(): void {
    check(C().sope_agent_reset(this.#ptr()), "sope_agent_reset");
  }

  /**
   * The conversation history as JSON, for saving it (format: sope.h,
   * sope_agent_history). Between turns only: throws (SOPE_EBUSY) while a
   * turn runs or is queued, so call it on "turn_end".
   */
  history(): string {
    const ptr = new BigUint64Array(1);
    const len = new BigUint64Array(1);
    check(C().sope_agent_history(this.#ptr(), ptr, len), "sope_agent_history");
    return readString(Number(ptr[0]), Number(len[0]));
  }

  /**
   * How full the model's context is, measured the way compaction measures
   * it. Any time: while a turn runs, as of its last request.
   */
  context(): ContextUsage {
    const ptr = new BigUint64Array(1);
    const len = new BigUint64Array(1);
    check(C().sope_agent_context(this.#ptr(), ptr, len), "sope_agent_context");
    return JSON.parse(readString(Number(ptr[0]), Number(len[0]))) as ContextUsage;
  }

  /**
   * Attaches an image (PNG, JPEG, GIF or WebP bytes, at most 10 MiB) to the
   * next send(). mediaType ("image/png", ...) is detected from the bytes when
   * omitted. The model has to read images: see the option image_model.
   */
  attachImage(data: Uint8Array, mediaType?: string): void {
    check(C().sope_attach_image(this.#ptr(), mediaType ? cstr(mediaType) : null, data, data.length), "sope_attach_image");
  }

  /** Resumes a saved conversation: replaces the history with one from history(). Between turns only. */
  loadHistory(json: string): void {
    const bytes = encoder.encode(json);
    check(C().sope_agent_load_history(this.#ptr(), bytes.length ? bytes : EMPTY, bytes.length), "sope_agent_load_history");
  }

  /** A file descriptor readable while events are pending (for poll/epoll/kqueue loops). Owned by the agent. */
  fd(): number {
    return check(C().sope_agent_fd(this.#ptr()), "sope_agent_fd");
  }

  close(): void {
    check(C().sope_agent_close(this.#ptr()), "sope_agent_close");
  }

  /** Frees the native agent. No other call on it may be in flight, including a poll in another thread. */
  free(): void {
    if (!this.#handle) return;
    if (!this.#owned) throw new Error("sope: cannot free an attached agent");
    C().sope_agent_free(this.#handle);
    this.#handle = null;
  }

  /**
   * Waits up to timeoutMs (-1 = forever, 0 = never block) for the next event.
   * Returns null on timeout. Blocks the calling thread: call it from a Worker.
   */
  poll(timeoutMs = -1): SopeEvent | null {
    const v = this.#eventView;
    v.setUint32(0, EVENT_SIZE, true);
    const rc = C().sope_poll(this.#ptr(), this.#eventBytes, timeoutMs);
    if (rc === 0) return null;
    if (rc === ErrorCode.Closed) return { type: "closed" };
    check(rc, "sope_poll");

    const u64 = (offset: number) => Number(v.getBigUint64(offset, true));
    const origin = { turnId: u64(EV.turnId), agentId: u64(EV.agentId), sequence: u64(EV.sequence) };
    const callId = u64(EV.callId);
    const code = v.getInt32(EV.code, true);
    const data = () => readString(u64(EV.data), u64(EV.dataLen));
    const name = () => readString(u64(EV.name), u64(EV.nameLen));
    const stopReason = STOP_REASONS[code] ?? "error";

    switch (v.getUint32(EV.type, true)) {
      case 1:
        return { type: "turn_start", ...origin };
      case 2:
        return { type: "text_delta", ...origin, text: data() };
      case 3:
        return { type: "tool_call", ...origin, callId, name: name(), input: data() };
      case 4:
        return { type: "turn_end", ...origin, stopReason };
      case 5:
        return { type: "error", ...origin, code, message: data() };
      case 6:
        return { type: "log", ...origin, level: LOG_LEVELS[code] ?? "info", message: data() };
      case 7:
        return { type: "thinking_delta", ...origin, text: data() };
      case 8: {
        const usage = JSON.parse(data() || "{}") as { input_tokens?: number; output_tokens?: number };
        return { type: "usage", ...origin, inputTokens: usage.input_tokens ?? 0, outputTokens: usage.output_tokens ?? 0 };
      }
      case 9:
        return { type: "subagent_start", ...origin, callId, subagentType: name(), input: data() };
      case 10:
        return { type: "subagent_end", ...origin, callId, stopReason, result: data() };
      case 11:
        return { type: "compact", ...origin, trigger: name() === "manual" ? "manual" : "auto", summary: data() };
      case 12:
        return { type: "tool_start", ...origin, callId, name: name(), input: data() };
      case 13:
        return { type: "tool_end", ...origin, callId, name: name(), isError: code !== 0, result: data() };
      case 14:
        return { type: "permission", ...origin, callId, name: name(), input: data() };
      case 15: {
        const retry = JSON.parse(data());
        return { type: "model_retry", ...origin, round: callId, attempt: code, reason: name(),
          delayMs: retry.delay_ms, compaction: !!retry.compaction,
          maxTokens: retry.max_tokens, nextMaxTokens: retry.next_max_tokens,
          discardedTextBytes: retry.discarded_text_bytes, discardedThinkingBytes: retry.discarded_thinking_bytes };
      }
      default:
        // Unknown event type from a newer library: skip it rather than fail.
        return this.poll(timeoutMs);
    }
  }

  #ptr(): Pointer {
    if (!this.#handle) throw new Error("sope: agent has been freed");
    return this.#handle;
  }
}
