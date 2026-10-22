// SPDX-License-Identifier: MIT
// Executes the agent's tool calls (from the agent and its subagents): checks
// permission for tools that change things, runs the tool with an
// AbortSignal, and hands the result back through sope_tool_result. Shared by
// the TUI and print mode, which differ only in how they ask.

import type { Agent } from "sope";
import type { Tool } from "./tools";

/** "stop" denies the call and cancels the whole turn. */
export type Decision = "once" | "always" | "deny" | "stop";

export interface PermissionRequest {
  callId: number;
  turnId: number;
  tool: Tool;
  input: Record<string, unknown>;
  /** Who asks: undefined for the agent itself, else the subagent type. */
  subagent?: string;
}

export interface ToolOutcome {
  callId: number;
  result: string;
  isError: boolean;
  denied?: boolean;
}

export const DENIED = "The user denied permission for this tool call. Do not retry it; ask the user how to proceed.";

interface Running {
  turnId: number;
  abort: AbortController;
}

export class ToolRunner {
  /** Skip permission prompts entirely (--allow-all). */
  allowAll = false;
  readonly #allowed = new Set<string>();
  readonly #running = new Map<number, Running>();

  constructor(
    private readonly agent: Agent,
    private readonly tools: Tool[],
    private readonly ask: (req: PermissionRequest) => Promise<Decision>,
    private readonly onDone: (outcome: ToolOutcome) => void,
    private readonly onCall?: (name: string, detail: string) => void,
  ) {}

  /** Tools allowed for the rest of the session. */
  get allowed(): ReadonlySet<string> {
    return this.#allowed;
  }

  needsPermission(name: string): boolean {
    const tool = this.tools.find((t) => t.name === name);
    return !!tool && !tool.readOnly && !this.allowAll && !this.#allowed.has(name);
  }

  run(callId: number, turnId: number, name: string, rawInput: string, subagent?: string): void {
    const abort = new AbortController();
    this.#running.set(callId, { turnId, abort });
    void this.#run(callId, turnId, name, rawInput, subagent, abort.signal);
  }

  /** The turn ended: stop its tools. Their results are dropped. */
  endTurn(turnId: number): void {
    for (const [callId, r] of this.#running) {
      if (r.turnId !== turnId) continue;
      r.abort.abort();
      this.#running.delete(callId);
    }
  }

  async #run(
    callId: number,
    turnId: number,
    name: string,
    rawInput: string,
    subagent: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const tool = this.tools.find((t) => t.name === name);
    let result: string;
    let isError = false;
    let denied = false;
    try {
      if (!tool) throw new Error(`unknown tool ${name}`);
      const input = rawInput ? (JSON.parse(rawInput) as Record<string, unknown>) : {};
      if (this.needsPermission(name)) {
        const decision = await this.ask({ callId, turnId, tool, input, subagent });
        if (signal.aborted) return;
        if (decision === "always") this.#allowed.add(name);
        if (decision === "deny" || decision === "stop") {
          denied = true;
          if (decision === "stop") this.agent.cancel();
          throw new Error(DENIED);
        }
      }
      result = await tool.run(input, { signal });
    } catch (err) {
      result = err instanceof Error ? err.message : String(err);
      isError = true;
    }

    if (!this.#running.delete(callId)) return; // the turn ended while the tool ran
    this.onDone({ callId, result, isError, denied });
    try {
      this.agent.toolResult(callId, result, isError);
      this.onCall?.("sope_tool_result", `#${callId} ${JSON.stringify(result.slice(0, 200))}`);
    } catch (err) {
      this.onCall?.("note", (err as Error).message);
    }
  }
}
