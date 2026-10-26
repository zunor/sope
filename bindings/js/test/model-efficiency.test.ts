// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type SopeEvent } from "../src";

type Message = { role: string; content: string; reasoning_content?: string };
type Request = { model: string; max_tokens: number; messages: Message[] };
const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ delta, finish_reason: finish }] })}\n\n`;
const reply = (text = "done") => new Response(chunk({ content: text }, "stop") + "data: [DONE]\n\n");
const length = () => new Response(chunk({ reasoning_content: "discarded unfinished thought" }, "length") + "data: [DONE]\n\n");

async function drain(agent: Agent, hook?: (event: SopeEvent) => void) {
  const events: SopeEvent[] = [];
  const deadline = performance.now() + 5000;
  while (performance.now() < deadline) {
    const e = agent.poll(0);
    if (!e) { await Bun.sleep(1); continue; }
    events.push(e);
    hook?.(e);
    if (e.type === "tool_call") agent.toolResult(e.callId, "observed");
    if (e.type === "turn_end" && !e.agentId) return events;
  }
  throw new Error("fixture timed out");
}

test("default output targets are fitted to context and summaries have an independent budget", async () => {
  const requests: Request[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) { requests.push(await req.json() as Request); return reply(); } });
  const agent = Agent.create({ provider: "openai", model: "fixture", "openai.base_url": server.url.origin });
  try {
    agent.send("small task");
    expect((await drain(agent)).at(-1)).toMatchObject({ stopReason: "end_turn" });
    expect(requests[0]!.max_tokens).toBe(32000);
    agent.compact();
    expect((await drain(agent)).at(-1)).toMatchObject({ stopReason: "end_turn" });
    expect(requests[1]!.max_tokens).toBe(8192);
    agent.setOption("context.window", "12000");
    agent.send("continue in a smaller model window");
    expect((await drain(agent)).at(-1)).toMatchObject({ stopReason: "end_turn" });
    expect(requests[2]!.max_tokens).toBeGreaterThan(4096);
    expect(requests[2]!.max_tokens).toBeLessThan(12000);
    const small = Agent.create({ provider: "openai", model: "fixture", system: "Be brief.",
      "openai.base_url": server.url.origin, "context.window": "6000" });
    try {
      small.setPolicy({ tools: [] });
      small.send("a small window with a small tool catalog");
      expect((await drain(small)).at(-1)).toMatchObject({ stopReason: "end_turn" });
      small.compact();
      expect((await drain(small)).at(-1)).toMatchObject({ stopReason: "end_turn" });
      expect(requests.at(-1)!.max_tokens).toBe(1904);
    } finally { small.free(); }
  } finally { agent.free(); server.stop(true); }
});

test("grown budget survives cancellation and durable reopen, respects ceilings and model changes", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sope-budget-"));
  const requests: Request[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    requests.push(await req.json() as Request);
    return requests.length === 1 ? length() : reply();
  } });
  const options = { provider: "openai", model: "fixture", "openai.base_url": server.url.origin,
    "openai.max_tokens": "4096", "openai.retry_delay_ms": "1000" };
  let agent = Agent.open(dir, options);
  try {
    agent.send("learn, then interrupt");
    expect((await drain(agent, e => { if (e.type === "model_retry" && e.reason === "output_limit") agent.cancel(); })).at(-1)).toMatchObject({ stopReason: "cancelled" });
    expect(requests).toHaveLength(1);
    agent.free();
    agent = Agent.open(dir, options);
    agent.send("continue after worker restart");
    await drain(agent);
    expect(requests.at(-1)!.max_tokens).toBe(8192);
    expect(agent.history()).not.toContain("discarded unfinished thought");
    agent.setOption("openai.max_tokens_ceiling", "6000");
    agent.send("respect the host ceiling");
    await drain(agent);
    expect(requests.at(-1)!.max_tokens).toBe(6000);
    agent.setOption("model", "other-model");
    agent.send("another model has no learned budget");
    await drain(agent);
    expect(requests.at(-1)!.max_tokens).toBe(4096);
    agent.setOption("model", "fixture");
    agent.setOption("reasoning.effort", "low");
    agent.send("another reasoning effort also starts independently");
    await drain(agent);
    expect(requests.at(-1)!.max_tokens).toBe(4096);
  } finally { agent.free(); server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("completed Chat reasoning survives tool rounds, history export and durable reopen but not route/model switches", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sope-reasoning-"));
  const requests: Request[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    requests.push(await req.json() as Request);
    if (requests.length !== 1) return reply();
    return new Response(chunk({ reasoning_content: "Keep this tested hypothesis. " }) +
      chunk({ reasoning_content: "Next inspect the tool evidence." }) +
      chunk({ tool_calls: [{ index: 0, id: "evidence", type: "function", function: { name: "probe", arguments: "{}" } }] }, "tool_calls") + "data: [DONE]\n\n");
  } });
  const options = { provider: "openai", model: "fixture", "openai.base_url": server.url.origin };
  let agent = Agent.open(dir, options);
  try {
    agent.registerTool({ name: "probe", inputSchema: { type: "object" } });
    agent.send("investigate");
    expect((await drain(agent)).at(-1)).toMatchObject({ stopReason: "end_turn" });
    const thought = "Keep this tested hypothesis. Next inspect the tool evidence.";
    expect(requests[1]!.messages.find(m => m.role === "assistant")?.reasoning_content).toBe(thought);
    const saved = agent.history();
    expect(saved).toContain(thought);
    agent.free();
    agent = Agent.open(dir, options);
    agent.send("resume");
    await drain(agent);
    expect(requests.at(-1)!.messages.some(m => m.reasoning_content === thought)).toBe(true);
    agent.setOption("model", "other-model");
    agent.send("switch model");
    await drain(agent);
    expect(requests.at(-1)!.messages.every(m => m.reasoning_content === undefined)).toBe(true);
    agent.setOption("model", "fixture");
    agent.setOption("openai.base_url", server.url.origin + "/other");
    agent.send("switch route");
    await drain(agent);
    expect(requests.at(-1)!.messages.every(m => m.reasoning_content === undefined)).toBe(true);
    const restored = Agent.create(options);
    try {
      restored.loadHistory(saved);
      restored.send("restored exported history");
      await drain(restored);
      expect(requests.at(-1)!.messages.some(m => m.reasoning_content === thought)).toBe(true);
    } finally { restored.free(); }
  } finally { agent.free(); server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("reasoning from a failed attempt never enters the retry or committed history", async () => {
  const requests: Request[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    requests.push(await req.json() as Request);
    if (requests.length === 1) return length();
    return new Response(chunk({ reasoning_content: "completed thought" }) + chunk({ content: "answer" }, "stop") + "data: [DONE]\n\n");
  } });
  const agent = Agent.create({ provider: "openai", model: "fixture", "openai.base_url": server.url.origin, "openai.retry_delay_ms": "1" });
  try {
    agent.send("investigate");
    expect((await drain(agent)).at(-1)).toMatchObject({ stopReason: "end_turn" });
    expect(requests.map(r => r.max_tokens)).toEqual([32000, 64000]);
    expect(JSON.stringify(requests[1])).not.toContain("discarded unfinished thought");
    expect(agent.history()).not.toContain("discarded unfinished thought");
    expect(agent.history()).toContain("completed thought");
  } finally { agent.free(); server.stop(true); }
});
