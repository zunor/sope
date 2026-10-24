// SPDX-License-Identifier: MIT
// A live trace of everything crossing the C ABI: calls from the TUI into
// libsope (→) and events coming back out of sope_poll (←).

import type { SopeEvent } from "sope";
import type { CellBuffer } from "../render/buffer";
import { palette } from "../theme";
import type { Rect } from "./chat";

interface Entry {
  time: string;
  dir: "→" | "←" | "·";
  kind: string;
  text: string;
  color: number;
  stream?: { who: string; bytes: number; chunks: number };
}

const KIND_COLORS: Record<string, number> = {
  turn_start: palette.accent,
  text_delta: palette.muted,
  thinking_delta: palette.faint,
  usage: palette.faint,
  subagent_start: palette.accent,
  subagent_end: palette.accent,
  compact: palette.accent,
  tool_call: palette.tool,
  tool_start: palette.tool,
  tool_end: palette.tool,
  permission: palette.tool,
  turn_end: palette.accent,
  error: palette.error,
  log: palette.faint,
  closed: palette.faint,
};

function clock(): string {
  const d = new Date();
  const p = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}.${p(d.getMilliseconds(), 3)}`;
}

function describe(ev: SopeEvent): string {
  if (ev.type === "closed") return "";
  const who = `${ev.agentId ? `a${ev.agentId}/` : ""}t${ev.turnId}`;
  switch (ev.type) {
    case "turn_start":
      return who;
    case "text_delta":
    case "thinking_delta":
      return `${who} ${`[${Buffer.byteLength(ev.text)} bytes]`}`;
    case "tool_call":
    case "tool_start":
    case "permission":
      return `${who} #${ev.callId} ${ev.name} ${ev.input.slice(0, 600)}`;
    case "tool_end":
      return `${who} #${ev.callId} ${ev.name}${ev.isError ? " failed" : ""} ${JSON.stringify(ev.result.slice(0, 300))}`;
    case "turn_end":
      return `${who} ${ev.stopReason}`;
    case "error":
      return `${who} ${ev.code} ${ev.message}`;
    case "log":
      return `${who} ${ev.level} ${ev.message}`;
    case "usage":
      return `${who} in=${ev.inputTokens} out=${ev.outputTokens}`;
    case "subagent_start":
      return `${who} #${ev.callId} ${ev.subagentType} ${ev.input.slice(0, 600)}`;
    case "subagent_end":
      return `${who} #${ev.callId} ${ev.stopReason} ${JSON.stringify(ev.result.slice(0, 300))}`;
    case "compact":
      return `${who} ${ev.trigger} ${JSON.stringify(ev.summary.slice(0, 300))}`;
  }
}

export class EventLog {
  #entries: Entry[] = [];
  #next = 0;
  #stream?: { key: string; entry: Entry };
  readonly max = 2000;
  count = 0;

  event(ev: SopeEvent): void {
    if (ev.type === "text_delta" || ev.type === "thinking_delta") {
      const who = `${ev.agentId ? `a${ev.agentId}/` : ""}t${ev.turnId}`;
      const key = `${who}/${ev.type}`;
      if (this.#stream?.key === key) {
        this.count++;
        this.#stream.entry.stream!.bytes += Buffer.byteLength(ev.text);
        this.#stream.entry.stream!.chunks++;
      } else {
        const entry = this.#push({dir: "←", kind: ev.type, text: "", color: KIND_COLORS[ev.type]!,
          stream: { who, bytes: Buffer.byteLength(ev.text), chunks: 1 }});
        this.#stream = { key, entry };
      }
      return;
    }
    this.#push({ dir: "←", kind: ev.type, text: describe(ev), color: KIND_COLORS[ev.type] ?? palette.muted });
  }

  call(fn: string, text: string): void {
    this.#push({ dir: "→", kind: fn, text, color: palette.user });
  }

  note(text: string): void {
    this.#push({ dir: "·", kind: "note", text, color: palette.muted });
  }

  render(buf: CellBuffer, r: Rect, stats: string): void {
    buf.text(r.x, r.y, "ABI trace", { fg: palette.muted, bold: true });
    buf.text(r.x + r.w - stats.length, r.y, stats, { fg: palette.faint });
    const rows = r.h - 1;
    const start = Math.max(0, this.#entries.length - rows);
    for (let i = 0; i < rows && start + i < this.#entries.length; i++) {
      const e = this.#entries[(this.#next + start + i) % this.#entries.length]!;
      const y = r.y + 1 + i;
      const end = r.x + r.w;
      let x = buf.text(r.x, y, `${e.time} `, { fg: palette.faint }, end);
      x = buf.text(x, y, `${e.dir} `, { fg: palette.faint }, end);
      x = buf.text(x, y, e.kind.padEnd(14), { fg: e.color }, end);
      const text = e.stream ? `${e.stream.who} ${e.stream.bytes} bytes · ${e.stream.chunks} chunks` : e.text;
      buf.text(x + 1, y, text.replace(/[\r\n\t]/g, " "), {}, end);
    }
  }

  #push(e: Omit<Entry, "time">): Entry {
    this.count++;
    this.#stream = undefined;
    const entry = { time: clock(), ...e, text: e.text.slice(0, 1200) };
    if (this.#entries.length < this.max) this.#entries.push(entry);
    else {
      this.#entries[this.#next] = entry;
      this.#next = (this.#next + 1) % this.max;
    }
    return entry;
  }
}
