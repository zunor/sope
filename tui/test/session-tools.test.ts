import { expect, test } from "bun:test";
import { loadConfig } from "../src/config";
import { Session } from "../src/session";

test("finishing one child does not cancel its sibling's host tool", async () => {
  let finish!: () => void;
  const done = new Promise<void>((resolve) => { finish = resolve; });
  const session = new Session(loadConfig({ provider: "mock" }, {}, {}), () => "full", (_s, events) => {
    if (events.some((e) => e.type === "turn_end" && !e.agentId)) finish();
  });
  try {
    session.setOption("mock.delay_ms", "0");
    session.send("!agent !sleep 0.05 | !sleep 0.2");
    const finished = await Promise.race([done.then(() => true), Bun.sleep(1500).then(() => false)]);
    expect(finished).toBe(true);
    expect(session.chat.messages.filter((m) => m.role === "subagent").map((m) => m.ok)).toEqual([true, true]);
    expect(session.chat.messages.some((m) => m.text.includes("slept 0.2s"))).toBe(true);
  } finally {
    await session.shutdown();
  }
}, 5000);
