// SPDX-License-Identifier: MIT
// Coalesce input into the next 60 Hz frame, keeping only the latest state
// while the terminal is backpressured. No queued animation or scroll inertia.

export interface FrameClock {
  now(): number;
  schedule(callback: () => void, delay: number): () => void;
}

const systemClock: FrameClock = {
  now: () => performance.now(),
  schedule(callback, delay) {
    const timer = setTimeout(callback, delay);
    return () => clearTimeout(timer);
  },
};

export class FrameScheduler {
  #cancel: (() => void) | null = null;
  #dirty = false;
  #stopped = false;
  #last = -Infinity;

  constructor(
    private readonly render: () => void,
    private readonly ready: () => boolean = () => true,
    private readonly clock: FrameClock = systemClock,
  ) {}

  request(): void {
    if (this.#stopped) return;
    this.#dirty = true;
    this.#schedule();
  }

  /** Called on stdout drain: resume a pending frame, without repainting an idle UI. */
  resume(): void {
    this.#schedule();
  }

  stop(): void {
    this.#stopped = true;
    this.#cancel?.();
    this.#cancel = null;
    this.#dirty = false;
  }

  #schedule(): void {
    if (this.#stopped || !this.#dirty || this.#cancel || !this.ready()) return;
    const delay = Math.max(0, this.#last + 1000 / 60 - this.clock.now());
    this.#cancel = this.clock.schedule(() => {
      this.#cancel = null;
      if (!this.ready()) return; // drain will reschedule; input keeps updating state
      this.#dirty = false;
      this.#last = this.clock.now();
      this.render();
      this.#schedule();
    }, Math.ceil(delay));
  }
}
