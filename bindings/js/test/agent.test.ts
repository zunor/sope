import { afterEach, expect, test } from "bun:test";
import { Agent, SopeError, ErrorCode, version, type SopeEvent } from "../src";

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

test("version matches the header", () => {
  expect(version()).toBe("0.2.0");
});

test("streams a turn, including multi-byte text", () => {
  agent = Agent.create({ "mock.delay_ms": "0" });
  const turnId = agent.send("你好 sope");
  const events = drainTurn(agent);
  expect(events[0]).toEqual({ type: "turn_start", turnId, agentId: 0 });
  expect(text(events)).toContain("You said: 你好 sope");
  expect(events.at(-1)).toEqual({ type: "turn_end", turnId, agentId: 0, stopReason: "end_turn" });
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
  expect(text(events)).toContain("`agent` returned: `echo` returned: pong"); // the final message only
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
