// SPDX-License-Identifier: MIT
// Owns the native agent on the UI thread. Calls into libsope that never block
// (send, cancel, tool results) happen here; polling happens in poller.ts.

import { Agent, libraryPath, type SopeEvent } from "sope";

export class AgentBridge {
  readonly agent: Agent;
  #worker: Worker;
  #closed: Promise<void>;

  constructor(options: Record<string, string>, onEvents: (events: SopeEvent[]) => void) {
    this.agent = Agent.create(options);
    let resolveClosed!: () => void;
    this.#closed = new Promise((resolve) => (resolveClosed = resolve));
    // From source the worker resolves relative to this file. A compiled
    // executable resolves plain specifiers against the build's --root, the
    // repo root (scripts/release.sh).
    this.#worker = import.meta.url.includes("$bunfs")
      ? new Worker("./tui/src/agent/poller.ts")
      : new Worker(new URL("./poller.ts", import.meta.url).href);
    this.#worker.onerror = (e) => {
      // Without the poller nothing would ever happen: fail loudly.
      console.error(`sope: event poller failed: ${e.message}`);
      process.exit(70);
    };
    this.#worker.onmessage = (msg: MessageEvent<SopeEvent[]>) => {
      if (msg.data.at(-1)?.type === "closed") resolveClosed();
      onEvents(msg.data);
    };
    this.#worker.postMessage({ handle: this.agent.handle, library: libraryPath() });
  }

  /** Closes the agent, waits for the poller to drain it, then frees it. */
  async shutdown(timeoutMs = 1500): Promise<void> {
    this.agent.close();
    const drained = await Promise.race([this.#closed.then(() => true), Bun.sleep(timeoutMs).then(() => false)]);
    this.#worker.terminate();
    // If the poller never saw "closed" it may still be inside sope_poll; leaking beats a use-after-free.
    if (drained) this.agent.free();
  }
}
