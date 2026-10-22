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
      return `${who} ${JSON.stringify(ev.text)}`;
    case "tool_call":
    case "tool_start":
    case "permission":
      return `${who} #${ev.callId} ${ev.name} ${ev.input}`;
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
      return `${who} #${ev.callId} ${ev.subagentType} ${ev.input}`;
    case "subagent_end":
      return `${who} #${ev.callId} ${ev.stopReason} ${JSON.stringify(ev.result)}`;
    case "compact":
      return `${who} ${ev.trigger} ${JSON.stringify(ev.summary)}`;
  }
}

export class EventLog {
  #entries: Entry[] = [];
  readonly max = 2000;
  count = 0;

  event(ev: SopeEvent): void {
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
      const e = this.#entries[start + i]!;
      const y = r.y + 1 + i;
      const end = r.x + r.w;
      let x = buf.text(r.x, y, `${e.time} `, { fg: palette.faint }, end);
      x = buf.text(x, y, `${e.dir} `, { fg: palette.faint }, end);
      x = buf.text(x, y, e.kind.padEnd(14), { fg: e.color }, end);
      buf.text(x + 1, y, e.text.replace(/[\r\n\t]/g, " "), {}, end);
    }
  }

  #push(e: Omit<Entry, "time">): void {
    this.count++;
    this.#entries.push({ time: clock(), ...e });
    if (this.#entries.length > this.max) this.#entries.splice(0, this.#entries.length - this.max);
  }
}
