// SPDX-License-Identifier: MIT
// Saving and resuming a conversation: history() and loadHistory().
import { afterEach, expect, test } from "bun:test";
import { Agent, SopeError, type SopeEvent } from "../src/index";

const agents: Agent[] = [];

afterEach(() => {
  for (const a of agents.splice(0)) a.free();
});

function create(): Agent {
  const a = Agent.create({ "mock.delay_ms": "0", permissions: "allow" });
  agents.push(a);
  return a;
}

function run(a: Agent, text: string): string {
  a.send(text);
  let reply = "";
  for (;;) {
    const ev: SopeEvent | null = a.poll(10000);
    if (!ev) throw new Error("timed out waiting for the turn");
    if (ev.type === "text_delta" && !ev.agentId) reply += ev.text;
    if (ev.type === "turn_end" && !ev.agentId) return reply;
  }
}

test("a conversation saved from one agent resumes in another", () => {
  const a = create();
  expect(JSON.parse(a.history())).toEqual([]);
  run(a, "remember the number 42 ✓");
  const saved = a.history();
  const messages = JSON.parse(saved) as Array<{ role: string; content: string }>;
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant"]);
  expect(messages[0]!.content).toBe("remember the number 42 ✓");

  const b = create();
  b.loadHistory(saved);
  expect(b.history()).toBe(saved);
  expect(run(b, "!history")).toContain("history: 3 messages");
});

test("tool uses survive the round trip", () => {
  const a = create();
  run(a, '!glob {"pattern":"*.json"}');
  const messages = JSON.parse(a.history()) as Array<{ role: string; tool_uses?: Array<{ name: string; input: string }> }>;
  expect(messages.map((m) => m.role)).toEqual(["user", "assistant", "tool", "assistant"]);
  expect(messages[1]!.tool_uses![0]).toMatchObject({ name: "glob", input: '{"pattern":"*.json"}' });
});

test("only between turns, and only valid histories", () => {
  const a = create();
  a.setOption("mock.delay_ms", "20");
  a.send("slow");
  expect(() => a.history()).toThrow(SopeError);
  expect(() => a.loadHistory("[]")).toThrow(/turn is running or queued/);
  while (a.poll(10000)?.type !== "turn_end");
  expect(() => a.loadHistory("not json")).toThrow(/expected a JSON array/);
  expect(() => a.loadHistory('[{"role":"robot"}]')).toThrow(/unknown role/);
  expect(JSON.parse(a.history())).toHaveLength(2); // untouched
});

test("context() reports what the next request holds, by part", () => {
  const a = create();
  a.setOption("context.window", "200000");
  const empty = a.context();
  expect(empty).toMatchObject({ state: "idle", window: 200000, reserve: 4096, threshold: 0, largest: [] });
  expect(empty.parts.messages).toBe(0);
  expect(empty.counts.tools).toBeGreaterThan(5);

  run(a, '!glob {"pattern":"*.json"}');
  const after = a.context();
  const parts = Object.values(after.parts).reduce((sum, n) => sum + n, 0);
  expect(parts).toBe(after.estimate);
  expect(after.used).toBeGreaterThanOrEqual(after.estimate);
  expect(after.counts).toMatchObject({ messages: 3, tool_results: 1 });
  expect(after.largest[0]).toMatchObject({ name: "glob", input: '{"pattern":"*.json"}' });

  a.reset();
  expect(a.context().parts.messages).toBe(0);
});
