// SPDX-License-Identifier: MIT
// Owns the native agent on the UI thread. Calls into libsope that never block
// (send, cancel, tool results) happen here; polling happens in poller.ts.

import { Agent, libraryPath, type SopeEvent } from "sope";
import { executionPolicy } from "./environment";
import { ExecutionTrace } from "./trace";

export class AgentBridge {
  readonly agent: Agent;
  #worker: Worker;
  #closed: Promise<void>;
  readonly trace: ExecutionTrace | undefined;

  constructor(options: Record<string, string>, onEvents: (events: SopeEvent[]) => void, directory?: string) {
    this.agent = directory ? Agent.open(directory, options) : Agent.create(options);
    try {
      this.agent.setPolicy(executionPolicy(options.provider ?? "mock"));
    } catch (error) {
      this.agent.free();
      throw error;
    }
    let resolveClosed!: () => void;
    this.#closed = new Promise((resolve) => (resolveClosed = resolve));
    // From source the worker resolves relative to this file. A compiled
    // executable resolves plain specifiers against the build's --root, the
    // repo root (scripts/release.sh).
    this.#worker = import.meta.url.includes("$bunfs")
      ? new Worker("./tui/src/agent/poller.ts")
      : new Worker(new URL("./poller.ts", import.meta.url).href);
    this.trace = ExecutionTrace.fromEnvironment();
    this.#worker.onerror = (e) => {
      // Without the poller nothing would ever happen: fail loudly.
      console.error(`sope: event poller failed: ${e.message}`);
      process.exit(70);
    };
    this.#worker.onmessage = (msg: MessageEvent<SopeEvent[]>) => {
      if (msg.data.at(-1)?.type === "closed") resolveClosed();
      if (this.trace) for (const event of msg.data) this.trace.event(event);
      onEvents(msg.data);
    };
    this.#worker.postMessage({ handle: this.agent.handle, library: libraryPath() });
  }

  /**
   * Closes the agent, waits for the poller to drain it, then frees it.
   * `beforeFree` runs once the turns have ended, while the agent is still
   * there to ask (e.g. for its history).
   */
  async shutdown(beforeFree?: () => void, timeoutMs = 1500): Promise<void> {
    this.agent.close();
    const drained = await Promise.race([this.#closed.then(() => true), Bun.sleep(timeoutMs).then(() => false)]);
    this.#worker.terminate();
    beforeFree?.();
    // If the poller never saw "closed" it may still be inside sope_poll; leaking beats a use-after-free.
    if (drained) this.agent.free();
    this.trace?.record("bridge.shutdown", { drained });
    await this.trace?.close();
  }
}
