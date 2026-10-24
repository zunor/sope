// SPDX-License-Identifier: MIT
// Metadata-only diagnostics. Journals, not traces, own recoverable state.
import { createWriteStream, mkdirSync, openSync, type WriteStream } from "node:fs";
import { join, resolve } from "node:path";
import { createHmac, randomBytes } from "node:crypto";
import type { SopeEvent } from "sope";

type Fields = Record<string, string | number | boolean>;
const PROVIDER_EVENTS = new Set(["provider.start", "provider.first_byte", "provider.retry", "provider.progress", "provider.timeout", "provider.end"]);
const PROVIDER_FIELDS = ["round", "compaction", "attempt", "status", "elapsed_ms", "request_bytes", "received_bytes", "complete", "failed"];
const RETRY_FIELDS = ["failure_kind", "delay_ms", "remaining_ms", "logical_ms", "text_bytes", "thinking_bytes", "tool_calls", "tool_argument_bytes"];

export class ExecutionTrace {
  readonly id = crypto.randomUUID();
  readonly path: string;
  readonly #stream: WriteStream;
  readonly #start = performance.now();
  readonly #active = new Map<string, number>();
  readonly #timer: ReturnType<typeof setInterval>;
  #bytes = 0;
  #dropped = 0;
  #events = 0;
  #textBytes = 0;
  #thinkingBytes = 0;
  #lastEvent = this.#start;
  #disabled = false;
  #closing?: Promise<void>;
  #seq = 0;
  readonly #salt = randomBytes(32);
  readonly #cwd = process.cwd();
  readonly #reads = new Map<string, { callId: number; count: number }>();

  constructor(directory: string, private readonly limit = 64 * 1024 * 1024,
    private readonly warn: () => void = () => console.error("sope: diagnostic trace incomplete (storage error or size limit)")) {
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    this.path = join(directory, `${this.id}.jsonl`);
    const fd = openSync(this.path, "wx", 0o600);
    this.#stream = createWriteStream(this.path, { fd, autoClose: true });
    this.#stream.on("error", () => { if (!this.#disabled) { this.#disabled = true; this.warn(); } });
    this.record("trace.start", { pid: process.pid });
    this.#timer = setInterval(() => this.record("heartbeat", {
      events: this.#events, textBytes: this.#textBytes, thinkingBytes: this.#thinkingBytes,
      activeSpans: this.#active.size, idleMs: Math.round(performance.now() - this.#lastEvent),
      rssBytes: process.memoryUsage.rss(),
    }), 15000);
    this.#timer.unref();
  }

  static fromEnvironment(): ExecutionTrace | undefined {
    const directory = process.env.SOPE_TRACE_DIR;
    if (!directory) return;
    try { return new ExecutionTrace(directory); }
    catch { console.error("sope: could not open diagnostic trace directory"); return; }
  }

  record(type: string, fields: Fields = {}): void {
    if (this.#disabled || this.#closing) return;
    if (this.#stream.writableLength >= 256 * 1024) { this.#dropped++; return; }
    if (this.#dropped) {
      const count = this.#dropped;
      this.#dropped = 0;
      this.#write("trace.gap", { count });
    }
    this.#write(type, fields);
  }

  #write(type: string, fields: Fields): void {
    if (this.#disabled) return;
    const line = JSON.stringify({ schema: 1, trace: this.id, seq: ++this.#seq,
      time: new Date().toISOString(), elapsedMs: Math.round(performance.now() - this.#start), type, ...fields }) + "\n";
    const bytes = Buffer.byteLength(line);
    if (bytes > 4096 || this.#stream.writableLength + bytes > 256 * 1024) { this.#dropped++; return; }
    if (this.#bytes + bytes > this.limit - 512) {
      this.#stream.write(JSON.stringify({ schema: 1, trace: this.id, seq: this.#seq, type: "trace.limit", limitBytes: this.limit }) + "\n");
      this.#disabled = true;
      this.warn();
      return;
    }
    this.#stream.write(line);
    this.#bytes += bytes;
  }

  event(ev: SopeEvent): void {
    this.#events++;
    this.#lastEvent = performance.now();
    if (ev.type === "closed") { this.record("agent.closed"); return; }
    if (ev.type === "text_delta") { this.#textBytes += Buffer.byteLength(ev.text); return; }
    if (ev.type === "thinking_delta") { this.#thinkingBytes += Buffer.byteLength(ev.text); return; }
    const origin = { nativeSequence: ev.sequence, agentId: ev.agentId, turnId: ev.turnId };
    const fields: Fields = { ...origin };
    let type: string = ev.type;
    switch (ev.type) {
      case "log": {
        // Only the native numeric schema is allowed. Never serialize arbitrary logs.
        if (ev.message === '{"event":"work.closure","outstanding":1}') {
          type = "work.closure"; fields.outstanding = 1; break;
        }
        if (!ev.message.startsWith('{"event":"provider.')) return;
        let value;
        try { value = JSON.parse(ev.message); } catch { return; }
        if (!PROVIDER_EVENTS.has(value.event)) return;
        type = value.event;
        for (const key of PROVIDER_FIELDS) {
          if (typeof value[key] !== "number" || !Number.isFinite(value[key])) return;
          fields[key] = value[key];
        }
        for (const key of RETRY_FIELDS) {
          if (typeof value[key] === "number" && Number.isFinite(value[key])) fields[key] = value[key];
        }
        break;
      }
      case "model_retry":
        fields.round = ev.round; fields.attempt = ev.attempt; fields.delayMs = ev.delayMs;
        fields.compaction = ev.compaction;
        fields.discardedTextBytes = ev.discardedTextBytes;
        fields.discardedThinkingBytes = ev.discardedThinkingBytes;
        break;
      case "tool_call": case "tool_start": case "permission":
        fields.callId = ev.callId; fields.name = ev.name.slice(0, 128);
        fields.inputBytes = Buffer.byteLength(ev.input);
        if (ev.type !== "permission" && ev.name === "read" && fields.inputBytes <= 65536) {
          try {
            const args = JSON.parse(ev.input);
            if (typeof args.file_path === "string") {
              // Per-trace keyed fingerprints cannot be used to dictionary-match
              // sensitive paths. Exact requests only: no claim of stale output.
              const key = createHmac("sha256", this.#salt).update(JSON.stringify([
                ev.agentId, ev.turnId, resolve(this.#cwd, args.file_path),
                args.offset ?? 1, args.limit ?? 2000,
              ])).digest("hex");
              const prior = this.#reads.get(key);
              fields.readFingerprint = key;
              fields.readCount = (prior?.count ?? 0) + 1;
              if (prior) fields.previousReadCallId = prior.callId;
              if (!prior && this.#reads.size >= 1024) this.#reads.delete(this.#reads.keys().next().value!);
              this.#reads.set(key, { callId: ev.callId, count: Number(fields.readCount) });
            }
          } catch { /* Invalid arguments remain observable through tool errors. */ }
        }
        break;
      case "tool_end":
        fields.callId = ev.callId; fields.name = ev.name.slice(0, 128);
        fields.isError = ev.isError; fields.resultBytes = Buffer.byteLength(ev.result);
        break;
      case "subagent_start":
        fields.callId = ev.callId; fields.subagentType = ev.subagentType.slice(0, 128); break;
      case "subagent_end": fields.callId = ev.callId; fields.stopReason = ev.stopReason; break;
      case "turn_end": fields.stopReason = ev.stopReason; break;
      case "error": fields.code = ev.code; break;
      case "usage": fields.inputTokens = ev.inputTokens; fields.outputTokens = ev.outputTokens; break;
      case "compact":
        fields.trigger = ev.trigger; fields.summaryBytes = Buffer.byteLength(ev.summary);
        fields.summaryFingerprint = createHmac("sha256", this.#salt).update(ev.summary).digest("hex"); break;
    }
    const group = ev.type.startsWith("subagent_") ? "subagent" : ev.type.startsWith("turn_") ? "turn" : "tool";
    const key = `${ev.agentId}:${ev.turnId}:${group}:${"callId" in ev ? ev.callId : 0}`;
    if (["turn_start", "tool_start", "tool_call", "subagent_start"].includes(ev.type)) {
      if (this.#active.size < 4096) this.#active.set(key, performance.now());
      else fields.spanOverflow = true;
    } else if (["turn_end", "tool_end", "subagent_end"].includes(ev.type)) {
      const started = this.#active.get(key);
      if (started === undefined) fields.unmatched = true;
      else fields.durationMs = Math.round(performance.now() - started);
      this.#active.delete(key);
    }
    this.record(type, fields);
  }

  close(): Promise<void> {
    if (this.#closing) return this.#closing;
    clearInterval(this.#timer);
    this.#closing = this.#finish();
    return this.#closing;
  }

  async #finish(): Promise<void> {
    // A flush barrier makes space for the gap and terminal records even if the
    // last event batch filled the queue. No timer/sleep or unbounded JS queue.
    await new Promise<void>((resolve) => {
      if (this.#stream.destroyed) { resolve(); return; }
      const done = () => { this.#stream.off("close", done); resolve(); };
      this.#stream.once("close", done);
      this.#stream.write("", done);
    });
    if (this.#dropped) this.#write("trace.gap", { count: this.#dropped });
    this.#write("trace.end", { events: this.#events, textBytes: this.#textBytes,
      thinkingBytes: this.#thinkingBytes, activeSpans: this.#active.size });
    this.#active.clear();
    await new Promise<void>((resolve) => {
      if (this.#stream.closed) { resolve(); return; }
      this.#stream.once("close", resolve);
      this.#stream.end();
    });
  }
}
