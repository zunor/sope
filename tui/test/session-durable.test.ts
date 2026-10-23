import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent } from "sope";
import { Session } from "../src/session";
import { Store } from "../src/store";
import { loadConfig } from "../src/config";

const config = loadConfig({ provider: "mock" }, {}, {});

test("TUI reopens native execution state rather than overwriting it with its stale history cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sope-session-"));
  const store = new Store(join(dir, "ui.db"));
  let session: Session | undefined;
  try {
    let ended!: () => void;
    let completion = new Promise<void>((resolve) => { ended = resolve; });
    session = new Session(config, () => "full", (_session, events) => {
      if (events.some((e) => e.type === "turn_end" && !e.agentId)) ended();
    }, { store, directory: dir });
    session.setOption("mock.delay_ms", "0");
    session.send("original goal; constraint: no deployment");
    await completion;
    const id = session.id!;
    await session.shutdown();
    const saved = store.get(id)!;
    store.save(id, { ...saved, history: '[{"role":"user","content":"STALE UI CACHE"}]' }, new Map(), store.messages(id).length);
    completion = new Promise<void>((resolve) => { ended = resolve; });
    session = new Session(config, () => "full", (_session, events) => {
      if (events.some((e) => e.type === "turn_end" && !e.agentId)) ended();
    }, { store, directory: dir, stored: store.get(id)! });
    session.setOption("mock.delay_ms", "0");
    session.send("continue the original goal");
    await completion;
    await session.shutdown();
    session = undefined;
    const a = Agent.open(store.executionDirectory(id)!);
    try {
      expect(a.history()).toContain("constraint: no deployment");
      expect(a.history()).not.toContain("STALE UI CACHE");
      a.reset();
    } finally { a.free(); }
    const cleared = Agent.open(store.executionDirectory(id)!);
    try { expect(cleared.history()).toBe("[]"); } finally { cleared.free(); }
  } finally {
    await session?.shutdown();
    store.close();
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
