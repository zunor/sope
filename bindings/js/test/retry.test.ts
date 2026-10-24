// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { Agent, type SopeEvent } from "../src";

const chunk = (delta: object, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`;
const success = () => new Response(chunk({ content: "recovered" }, "stop") + "data: [DONE]\n\n");

async function run(reply: (attempt: number) => Response, options: Record<string, string> = {}) {
  let attempts = 0;
  const times: number[] = [];
  const server = Bun.serve({ port: 0, fetch() { times.push(performance.now()); return reply(++attempts); } });
  const agent = Agent.create({ provider: "openai", model: "fixture",
    "openai.base_url": `http://127.0.0.1:${server.port}`, "openai.retry_delay_ms": "10",
    "openai.request_timeout_ms": "3000", ...options });
  const events: SopeEvent[] = [];
  try {
    agent.send("test recovery");
    const deadline = performance.now() + 4500;
    while (performance.now() < deadline) {
      const ev = agent.poll(0);
      if (!ev) { await Bun.sleep(2); continue; }
      events.push(ev);
      if (ev.type === "turn_end") return { attempts, events, times, history: agent.history() };
      if (ev.type === "tool_call" || ev.type === "tool_start") throw new Error("failed attempt dispatched a tool");
    }
    throw new Error("fixture timed out");
  } finally { agent.free(); server.stop(true); }
}

test("HTTP 200 transient SSE errors recover without ending the turn", async () => {
  const r = await run(n => n === 1
    ? new Response('data: {"error":{"code":"server_error","message":"temporary"}}\n\n') : success());
  expect(r.attempts).toBe(2);
  expect(r.events.at(-1)).toMatchObject({ type: "turn_end", stopReason: "end_turn" });
  expect(r.events.some(e => e.type === "error")).toBe(false);
});

test("a disconnected tool fragment is discarded before retry", async () => {
  const r = await run(n => n === 1 ? new Response(chunk({ tool_calls: [
    { index: 0, id: "abandoned", type: "function", function: { name: "bash", arguments: '{"command":"touch bad"}' } },
  ] })) : success());
  expect(r.attempts).toBe(2);
  expect(r.history).not.toContain("abandoned");
  expect(r.history).toContain("recovered");
});

test("Retry-After sets the earliest retry time", async () => {
  const r = await run(n => n === 1 ? new Response("busy", { status: 429, headers: { "Retry-After": "2" } }) : success());
  expect(r.attempts).toBe(2);
  expect(r.times[1]! - r.times[0]!).toBeGreaterThanOrEqual(1950);
  expect(r.events.at(-1)).toMatchObject({ stopReason: "end_turn" });
});

test("an idle attempt without output is retried inside the request budget", async () => {
  const r = await run(n => n === 1 ? new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": waiting\n\n")); } })) : success(),
    { "openai.idle_timeout_ms": "80" });
  expect(r.attempts).toBe(2);
  expect(r.events.at(-1)).toMatchObject({ stopReason: "end_turn" });
});

for (const [name, response] of [
  ["HTTP auth", () => new Response("bad credential", { status: 401 })],
  ["HTTP request", () => new Response("invalid request", { status: 400 })],
  ["SSE auth", () => new Response('data: {"error":{"code":"invalid_api_key"}}\n\n')],
  ["JSON auth with status 200", () => Response.json({ error: { code: "invalid_api_key" } })],
  ["context overflow", () => Response.json({ error: { code: "context_length_exceeded" } }, { status: 500 })],
  ["output limit", () => new Response(chunk({ content: "limited" }, "length") + "data: [DONE]\n\n")],
  ["malformed data", () => new Response("data: {bad json}\n\n")],
] as const) test(`${name} is terminal, not transient`, async () => {
  const r = await run(response);
  expect(r.attempts).toBe(1);
  expect(r.events.at(-1)).toMatchObject({ stopReason: "error" });
  expect(r.events.some(e => e.type === "model_retry")).toBe(false);
});

test("partial text and reasoning have an explicit discard boundary and never enter history", async () => {
  const r = await run(n => n === 1 ? new Response(chunk({ reasoning_content: "abandoned reasoning" }) + chunk({ content: "abandoned text" })) : success());
  expect(r.attempts).toBe(2);
  const marker = r.events.findIndex(e => e.type === "model_retry");
  expect(marker).toBeGreaterThan(0);
  expect(r.events[marker]).toMatchObject({ type: "model_retry", round: 1, attempt: 2,
    reason: "incomplete_stream", discardedTextBytes: 14, discardedThinkingBytes: 19, compaction: false });
  expect(r.events.slice(marker + 1).find(e => e.type === "text_delta")).toMatchObject({ text: "recovered" });
  expect(r.history).not.toContain("abandoned");
  expect(r.history).toContain("recovered");
  expect(r.events.some(e => e.type === "error")).toBe(false);
});

test("repeated server errors exhaust a bounded attempt allowance", async () => {
  const r = await run(() => new Response("busy", { status: 503 }), { "openai.max_retries": "2" });
  expect(r.attempts).toBe(3);
  expect(r.events.filter(e => e.type === "model_retry")).toHaveLength(2);
  expect(r.events.at(-1)).toMatchObject({ stopReason: "error" });
});

test("Retry-After cannot outlive the logical request budget", async () => {
  const r = await run(() => new Response("busy", { status: 429, headers: { "Retry-After": "999999999999999999999999999" } }),
    { "openai.request_timeout_ms": "120" });
  expect(r.attempts).toBe(1);
  expect(r.events.find(e => e.type === "error")).toMatchObject({ code: -9 });
  expect(r.events.at(-1)).toMatchObject({ stopReason: "error" });
});

test("only three timeout retries are admitted even with a larger general allowance", async () => {
  const r = await run(() => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(": wait\n\n")); } })),
    { "openai.idle_timeout_ms": "30", "openai.max_retries": "10" });
  expect(r.attempts).toBe(4);
  expect(r.events.at(-1)).toMatchObject({ stopReason: "error" });
});

test("Responses API structured transient errors also retry", async () => {
  const r = await run(n => n === 1 ? new Response('data: {"type":"response.failed","response":{"error":{"code":"server_error"}}}\n\n')
    : new Response('data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"recovered"}]}]}}\n\n'),
    { "openai.wire_api": "responses" });
  expect(r.attempts).toBe(2);
  expect(r.events.at(-1)).toMatchObject({ stopReason: "end_turn" });
  expect(r.history).toContain("recovered");
});

test("EOF inside an SSE JSON fragment retries without treating it as a complete malformed message", async () => {
  const r = await run(n => n === 1 ? new Response('data: {"choices":[{"delta":{"content":"cut') : success());
  expect(r.attempts).toBe(2);
  expect(r.events.at(-1)).toMatchObject({ stopReason: "end_turn" });
  expect(r.history).not.toContain("cut");
});

for (const cancel of [false, true]) test(cancel ? "cancellation interrupts backoff without another request" : "a queued input cannot wake a retry before Retry-After", async () => {
  const requests: { at: number; body: unknown }[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    requests.push({ at: performance.now(), body: await req.json() });
    return requests.length === 1 ? new Response("busy", { status: 429, headers: { "Retry-After": "1" } }) : success();
  } });
  const agent = Agent.create({ provider: "openai", model: "fixture", "openai.base_url": `http://127.0.0.1:${server.port}`,
    "openai.retry_delay_ms": "10", "openai.request_timeout_ms": "3000" });
  try {
    agent.send("first input");
    let turns = 0, injected = false;
    const end = performance.now() + 4000;
    while (turns < (cancel ? 1 : 2) && performance.now() < end) {
      const e = agent.poll(0);
      if (!e) { await Bun.sleep(2); continue; }
      if (e.type === "model_retry" && !injected) {
        injected = true;
        if (cancel) agent.cancel(); else agent.send("queued input");
      }
      if (e.type === "turn_end") { turns++; expect(e.stopReason).toBe(cancel ? "cancelled" : "end_turn"); }
    }
    expect(injected).toBe(true);
    expect(turns).toBe(cancel ? 1 : 2);
    expect(requests).toHaveLength(cancel ? 1 : 3);
    if (!cancel) {
      expect(requests[1]!.at - requests[0]!.at).toBeGreaterThanOrEqual(950);
      expect(requests[1]!.body).toEqual(requests[0]!.body);
      expect(JSON.stringify(requests[2]!.body)).toContain("queued input");
    }
  } finally { agent.free(); server.stop(true); }
});

test("retry after a committed tool does not replay it, and durable history excludes the abandoned attempt", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sope-retry-durable-"));
  const bodies: unknown[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    bodies.push(await req.json());
    if (bodies.length === 1) return new Response(chunk({ tool_calls: [{ index: 0, id: "once", type: "function", function: { name: "effect", arguments: "{}" } }] }, "tool_calls") + "data: [DONE]\n\n");
    if (bodies.length === 2) return new Response(chunk({ content: "abandoned" }));
    return success();
  } });
  let agent = Agent.open(dir, { provider: "openai", model: "fixture", "openai.base_url": `http://127.0.0.1:${server.port}`, "openai.retry_delay_ms": "10" });
  try {
    agent.registerTool({ name: "effect", inputSchema: { type: "object" } });
    agent.send("execute once");
    let effects = 0, ended = false;
    const end = performance.now() + 3000;
    while (!ended && performance.now() < end) {
      const e = agent.poll(0);
      if (!e) { await Bun.sleep(2); continue; }
      if (e.type === "tool_call") { effects++; agent.toolResult(e.callId, "committed result"); }
      if (e.type === "turn_end") { ended = true; expect(e.stopReason).toBe("end_turn"); }
    }
    expect(ended).toBe(true);
    expect(effects).toBe(1);
    expect(bodies).toHaveLength(3);
    expect(bodies[1]).toEqual(bodies[2]);
    agent.free();
    agent = Agent.open(dir);
    expect(agent.history()).toContain("committed result");
    expect(agent.history()).toContain("recovered");
    expect(agent.history()).not.toContain("abandoned");
    expect(agent.recovery().pending).toBe(false);
    const db = new Database(join(dir, "execution.sqlite"), { readonly: true });
    try {
      expect(db.query("SELECT count(*) AS n FROM stream WHERE type = 15").get()).toEqual({ n: 1 });
      expect(db.query("SELECT count(*) AS n FROM stream WHERE type = 13").get()).toEqual({ n: 1 });
    } finally { db.close(); }
  } finally { agent.free(); server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});

test("compaction discards an incomplete summary and installs only the successful retry", async () => {
  const server = Bun.serve({ port: 0, fetch() { return ++attempts === 1 ? new Response(chunk({ content: "abandoned summary" })) : success(); } });
  let attempts = 0;
  const agent = Agent.create({ provider: "openai", model: "fixture", "openai.base_url": `http://127.0.0.1:${server.port}`, "openai.retry_delay_ms": "10" });
  try {
    agent.loadHistory(JSON.stringify([{ role: "user", content: "original task" }, { role: "assistant", content: "old detail ".repeat(5000) }]));
    agent.compact();
    let ended = false, compacted = false;
    const end = performance.now() + 3000;
    while (!ended && performance.now() < end) {
      const e = agent.poll(0);
      if (!e) { await Bun.sleep(2); continue; }
      expect(e.type).not.toBe("text_delta");
      if (e.type === "model_retry") expect(e.compaction).toBe(true);
      if (e.type === "compact") { compacted = true; expect(e.summary).toContain("recovered"); }
      if (e.type === "turn_end") { ended = true; expect(e.stopReason).toBe("end_turn"); }
    }
    expect(attempts).toBe(2);
    expect(ended && compacted).toBe(true);
    expect(agent.history()).not.toContain("abandoned");
  } finally { agent.free(); server.stop(true); }
});

for (const [name, hint, minimum] of [
  ["HTTP date", () => new Date(Date.now() + 2000).toUTCString(), 900],
  ["invalid", () => "nonsense", 0],
  ["negative", () => "-100", 0],
] as const) test(`Retry-After ${name} has bounded interpretation`, async () => {
  const r = await run(n => n === 1 ? new Response("busy", { status: 429, headers: { "Retry-After": hint() } }) : success());
  expect(r.attempts).toBe(2);
  expect(r.times[1]! - r.times[0]!).toBeGreaterThanOrEqual(minimum);
  expect(r.times[1]! - r.times[0]!).toBeLessThan(minimum ? 2200 : 500);
});

test("a permanent HTTP error does not become retryable when its body stalls", async () => {
  const r = await run(() => new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode("invalid credential")); } }), { status: 401 }),
    { "openai.idle_timeout_ms": "30" });
  expect(r.attempts).toBe(1);
  expect(r.events.at(-1)).toMatchObject({ stopReason: "error" });
});

test("Retry-After is honored for a transient error inside HTTP 200", async () => {
  const r = await run(n => n === 1 ? new Response('data: {"error":{"code":"server_error"}}\n\n', { headers: { "Retry-After": "1" } }) : success());
  expect(r.attempts).toBe(2);
  expect(r.times[1]! - r.times[0]!).toBeGreaterThanOrEqual(950);
  expect(r.events.at(-1)).toMatchObject({ stopReason: "end_turn" });
});
