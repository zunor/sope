// SPDX-License-Identifier: MIT
import { afterEach, expect, test } from "bun:test";
import { ABI, abiCompatible, Agent, SopeError, ErrorCode, version, type SopeEvent } from "../src";

let agent: Agent | null = null;

afterEach(() => {
  agent?.free();
  agent = null;
});

function drainTurn(a: Agent, onToolCall?: (e: Extract<SopeEvent, { type: "tool_call" }>) => void) {
  const events: SopeEvent[] = [];
  for (;;) {
    const ev = a.poll(2000);
    if (!ev) throw new Error("timed out waiting for events");
    events.push(ev);
    if (ev.type === "tool_call") onToolCall?.(ev);
    if (ev.type === "turn_end" && ev.agentId === 0) return events;
  }
}

const text = (events: SopeEvent[]) =>
  events.map((e) => (e.type === "text_delta" ? e.text : "")).join("");

test("version matches the header and the package", async () => {
  const header = await Bun.file(new URL("../../../include/sope.h", import.meta.url)).text();
  expect(version()).toBe(header.match(/SOPE_VERSION_STRING "([^"]+)"/)![1]!);
  expect(version()).toBe((await Bun.file(new URL("../package.json", import.meta.url)).json()).version);
});

test("checks ABI compatibility", () => {
  const v = (major: number, minor: number, patch = 0) => (major << 16) | (minor << 8) | patch;
  const { major, minor } = ABI;
  expect(major).toBe(0); // the rules below are the 0.x ones
  expect(abiCompatible(v(major, minor, 7))).toBe(true);
  expect(abiCompatible(v(major, minor - 1))).toBe(false); // 0.x: minor versions may break the ABI
  expect(abiCompatible(v(major, minor + 1))).toBe(false);
  expect(abiCompatible(v(1, 1))).toBe(false);
});

test("compacts the history", () => {
  agent = Agent.create({ "mock.delay_ms": "0" });
  agent.send("remember the number 42");
  drainTurn(agent);
  const turnId = agent.compact("focus on numbers");
  const events = drainTurn(agent);
  const compact = events.find((e) => e.type === "compact");
  expect(compact).toMatchObject({ type: "compact", turnId, trigger: "manual" });
  expect(compact && "summary" in compact && compact.summary).toContain("remember the number 42");
  expect(text(events)).toBe("");
});

test("streams a turn, including multi-byte text", () => {
  agent = Agent.create({ "mock.delay_ms": "0" });
  const turnId = agent.send("你好 sope");
  const events = drainTurn(agent);
  expect(events[0]).toEqual({ type: "turn_start", turnId, agentId: 0, sequence: 0 });
  expect(text(events)).toContain("You said: 你好 sope");
  expect(events.at(-1)).toEqual({ type: "turn_end", turnId, agentId: 0, sequence: 0, stopReason: "end_turn" });
});

test("round-trips a tool call", () => {
  agent = Agent.create({ "mock.delay_ms": "0" });
  agent.registerTool({ name: "echo", inputSchema: { type: "object" } });
  agent.send("!echo hi");
  const events = drainTurn(agent, (call) => {
    expect(call.name).toBe("echo");
    expect(JSON.parse(call.input)).toEqual({ input: "hi" });
    agent!.toolResult(call.callId, "pong");
  });
  expect(text(events)).toContain("`echo` returned: pong");
});

test("cancels a running turn", () => {
  agent = Agent.create({ "mock.delay_ms": "50" });
  agent.send("stream this slowly please");
  let ev = agent.poll(2000);
  while (ev && ev.type !== "text_delta") ev = agent.poll(2000);
  agent.cancel();
  expect(drainTurn(agent).at(-1)).toMatchObject({ type: "turn_end", stopReason: "cancelled" });
});

test("surfaces C errors as SopeError", () => {
  agent = Agent.create();
  try {
    agent.toolResult(42, "nobody asked");
    throw new Error("expected toolResult to throw");
  } catch (e) {
    expect(e).toBeInstanceOf(SopeError);
    expect((e as SopeError).code).toBe(ErrorCode.NotFound);
  }
});

test("runs subagents and tags their events", () => {
  agent = Agent.create({ "mock.delay_ms": "0" });
  agent.registerTool({ name: "echo" });
  agent.registerSubagent({ name: "echoer", description: "Echoes.", systemPrompt: "Echo.", tools: ["echo"] });
  agent.send("!agent:echoer !echo nested");
  const events = drainTurn(agent, (call) => agent!.toolResult(call.callId, "pong"));
  const start = events.find((e) => e.type === "subagent_start");
  expect(start).toMatchObject({ type: "subagent_start", agentId: 0, subagentType: "echoer" });
  const childCall = events.find((e) => e.type === "tool_call");
  expect(childCall).toMatchObject({ agentId: (start as { callId: number }).callId, name: "echo" });
  expect(events.find((e) => e.type === "subagent_end")).toMatchObject({ stopReason: "end_turn" });
  expect(text(events)).toContain('"model_report_unverified":"`echo` returned: pong"'); // prose is explicitly separated from native evidence
});

test("stops one subagent while its sibling and the parent go on", () => {
  agent = Agent.create({ "mock.delay_ms": "0" });
  agent.registerTool({ name: "echo" });
  agent.send("!agent !echo a | !echo b");
  const calls: Array<Extract<SopeEvent, { type: "tool_call" }>> = [];
  while (calls.length < 2) {
    const ev = agent.poll(2000);
    if (!ev) throw new Error("timed out waiting for the children");
    if (ev.type === "tool_call") calls.push(ev);
  }
  agent.cancelSubagent(calls[0]!.agentId, "wrong directory");
  agent.toolResult(calls[1]!.callId, "pong");
  const events = drainTurn(agent);
  const ends = events.filter((e) => e.type === "subagent_end");
  expect(ends.map((e) => (e as { stopReason: string }).stopReason).sort()).toEqual(["cancelled", "end_turn"]);
  expect(events.at(-1)).toMatchObject({ type: "turn_end", stopReason: "end_turn" });
  expect(text(events)).toContain("The user stopped this subagent. Their note: wrong directory");
  expect(() => agent!.cancelSubagent(calls[1]!.agentId)).toThrow(SopeError);
});

test("lists and stops background shells", async () => {
  agent = Agent.create({ "mock.delay_ms": "0" });
  agent.setOption("permissions", "allow");
  agent.send('!bash {"command":"echo ready; sleep 30","run_in_background":true,"notify_on_exit":false}');
  drainTurn(agent);
  let [shell] = agent.shells();
  for (let i = 0; i < 50 && shell && !shell.output_bytes; i++, [shell] = agent.shells()) await Bun.sleep(20);
  expect(shell).toMatchObject({ id: 1, command: "echo ready; sleep 30", running: true, exit_code: null, stopped: false, tail: "ready\n" });
  agent.stopShell(1);
  for (let i = 0; i < 100 && agent.shells()[0]!.running; i++) await Bun.sleep(20);
  expect(agent.shells()[0]).toMatchObject({ running: false, stopped: true });
  expect(() => agent!.stopShell(9)).toThrow(SopeError);
});

test("exposes a pollable fd", () => {
  agent = Agent.create();
  expect(agent.fd()).toBeGreaterThan(2);
});

test("reports closed after close", () => {
  agent = Agent.create();
  agent.close();
  expect(agent.poll(1000)).toEqual({ type: "closed" });
});
