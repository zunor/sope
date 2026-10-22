// SPDX-License-Identifier: MIT
// Worker thread: blocks in sope_poll so the UI thread never does, and
// forwards events to the main thread in batches.

import { Agent, useLibrary, type SopeEvent } from "sope";

declare const self: Worker;

const MAX_BATCH = 512;

self.onmessage = async (msg: MessageEvent<{ handle: number; library: string }>) => {
  useLibrary(msg.data.library); // workers share no module state: open the main thread's file
  const agent = Agent.attach(msg.data.handle);
  for (;;) {
    const batch: SopeEvent[] = [];
    let ev = agent.poll(200);
    while (ev) {
      batch.push(ev);
      if (ev.type === "closed" || batch.length >= MAX_BATCH) break;
      ev = agent.poll(0);
    }
    if (batch.length) postMessage(batch);
    if (batch.at(-1)?.type === "closed") return;
    await Bun.sleep(0); // let the worker's event loop breathe
  }
};
