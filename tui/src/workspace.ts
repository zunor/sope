// SPDX-License-Identifier: MIT
// The sessions open as tabs, for one directory: which one is on screen, the
// most recent few restored on start, and the least recently used idle one
// put away (saved and stopped, still listed) when one more would be too
// many. The app reacts to the tab on screen changing; this only keeps the
// list.

import type { Session } from "./session";
import type { Store, StoredSession } from "./store";
import type { SessionSummary } from "./ui/sessions";

export class Workspace {
  readonly sessions: Session[] = [];
  #active = 0;

  constructor(
    readonly store: Store | null,
    /** The key sessions are saved under. */
    readonly directory: string,
    readonly maxTabs: number,
    /** Makes a session: a new one, or one restored from the store. */
    readonly create: (stored?: StoredSession) => Session,
  ) {}

  get active(): number {
    return this.#active;
  }

  get current(): Session {
    return this.sessions[this.#active]!;
  }

  /** Brings back the most recent `n` saved sessions, in the order they were started; the newest is on screen. */
  restore(n: number): number {
    const recent = (this.store?.summaries(this.directory) ?? []).slice(0, n);
    for (const summary of [...recent].reverse()) {
      const stored = this.store!.get(summary.id);
      if (stored) this.sessions.push(this.create(stored));
    }
    if (this.sessions.length) this.switchTo(this.sessions.length - 1);
    return this.sessions.length;
  }

  /** A new session in a new tab, on screen. */
  add(): Session {
    this.#makeRoom();
    this.sessions.push(this.create());
    this.switchTo(this.sessions.length - 1);
    return this.current;
  }

  /** Puts a saved session on screen: its tab if open, else restored into a new one. False if it is gone. */
  open(id: string): boolean {
    const open = this.sessions.findIndex((s) => s.id === id);
    if (open >= 0) return this.switchTo(open);
    const stored = this.store?.get(id);
    if (!stored) return false;
    this.#makeRoom();
    this.sessions.push(this.create(stored));
    return this.switchTo(this.sessions.length - 1);
  }

  /** Closes a tab: the session stops and is no longer listed, but stays in the store. */
  close(index = this.#active): boolean {
    const s = this.sessions[index];
    if (!s) return false;
    void s.shutdown().then(() => s.delete());
    this.sessions.splice(index, 1);
    if (index < this.#active || this.#active >= this.sessions.length) this.#active--;
    if (this.sessions.length) this.switchTo(Math.max(0, this.#active));
    else this.#active = 0;
    return true;
  }

  switchTo(index: number): boolean {
    const s = this.sessions[index];
    if (!s) return false;
    this.#active = index;
    s.unread = false;
    s.lastUsed = performance.now();
    return true;
  }

  /** Every saved session of the directory, for the session list. */
  summaries(): SessionSummary[] {
    const open = new Set(this.sessions.map((s) => s.id));
    return (this.store?.summaries(this.directory) ?? []).map((s) => ({ ...s, open: open.has(s.id) }));
  }

  #makeRoom(): void {
    if (this.sessions.length < this.maxTabs) return;
    const idle = this.sessions.filter((s, i) => i !== this.#active && !s.busy && !s.approvals.length);
    const victim = idle.sort((a, b) => a.lastUsed - b.lastUsed)[0];
    if (!victim) return; // all busy: let the bar grow (it scrolls)
    const index = this.sessions.indexOf(victim);
    void victim.shutdown();
    this.sessions.splice(index, 1);
    if (index < this.#active) this.#active--;
  }
}
