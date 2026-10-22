// SPDX-License-Identifier: MIT
// Runs host tool calls (SOPE_EVENT_TOOL_CALL) and hands the results back
// through sope_tool_result. Built-in tools run inside libsope; only the
// host's own tools come through here. Shared by the TUI and print mode.

import type { Agent } from "sope";
import type { HostTool } from "./tools";

interface Running {
  turnId: number;
  abort: AbortController;
}

export class HostToolRunner {
  readonly #running = new Map<number, Running>();

  constructor(
    private readonly agent: Agent,
    private readonly tools: HostTool[],
    private readonly onCall?: (fn: string, detail: string) => void,
  ) {}

  run(callId: number, turnId: number, name: string, rawInput: string): void {
    const abort = new AbortController();
    this.#running.set(callId, { turnId, abort });
    void this.#run(callId, name, rawInput, abort.signal);
  }

  /** The turn ended: stop its tools. Their results are dropped. */
  endTurn(turnId: number): void {
    for (const [callId, r] of this.#running) {
      if (r.turnId !== turnId) continue;
      r.abort.abort();
      this.#running.delete(callId);
    }
  }

  async #run(callId: number, name: string, rawInput: string, signal: AbortSignal): Promise<void> {
    const tool = this.tools.find((t) => t.name === name);
    let result: string;
    let isError = false;
    try {
      if (!tool) throw new Error(`unknown tool ${name}`);
      result = await tool.run(rawInput ? (JSON.parse(rawInput) as Record<string, unknown>) : {}, { signal });
    } catch (err) {
      result = err instanceof Error ? err.message : String(err);
      isError = true;
    }
    if (!this.#running.delete(callId)) return; // the turn ended while the tool ran
    try {
      this.agent.toolResult(callId, result, isError);
      this.onCall?.("sope_tool_result", `#${callId} ${JSON.stringify(result.slice(0, 200))}`);
    } catch (err) {
      this.onCall?.("note", (err as Error).message);
    }
  }
}
