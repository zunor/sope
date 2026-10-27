// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
  const bodies: Record<string, unknown>[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) { bodies.push(await req.json() as Record<string, unknown>); times.push(performance.now()); return reply(++attempts); } });
  const agent = Agent.create({ provider: "openai", model: "fixture", "openai.max_tokens": "4096",
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
      if (ev.type === "turn_end") return { attempts, events, times, bodies, history: agent.history() };
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

const aborted = () => new Response(chunk({ content: "abandoned text", reasoning_content: "abandoned reasoning",
  tool_calls: [{ index: 0, id: "abandoned", type: "function", function: { name: "bash", arguments: '{"command":"touch bad"}' } }],
}) + chunk({}, "abort") + "data: [DONE]\n\n");

test("provider abort discards partial output and tools and retries the same request", async () => {
  const r = await run(n => n === 1 ? aborted() : success());
  expect(r.attempts).toBe(2);
  expect(r.bodies[1]).toEqual(r.bodies[0]);
  expect(r.events.find(e => e.type === "model_retry")).toMatchObject({ reason: "aborted_response",
    attempt: 2, discardedTextBytes: 14, discardedThinkingBytes: 19 });
  expect(r.history).not.toContain("abandoned");
  expect(r.history).toContain("recovered");
  expect(r.events.some(e => e.type === "error")).toBe(false);
  expect(r.events.at(-1)).toMatchObject({ stopReason: "end_turn" });
});

for (const retries of [0, 2]) test(`provider abort obeys max_retries=${retries}`, async () => {
  const r = await run(aborted, { "openai.max_retries": String(retries) });
  expect(r.attempts).toBe(retries + 1);
  expect(r.events.filter(e => e.type === "model_retry")).toHaveLength(retries);
  expect(r.events.at(-1)).toMatchObject({ stopReason: "error" });
  expect(r.history).not.toContain("abandoned");
});

test("provider abort backoff cannot outlive the request deadline", async () => {
  const r = await run(aborted, { "openai.retry_delay_ms": "1000", "openai.request_timeout_ms": "120" });
  expect(r.attempts).toBe(1);
  expect(r.events.find(e => e.type === "error")).toMatchObject({ code: -9 });
  expect(r.events.at(-1)).toMatchObject({ stopReason: "error" });
});

test("user cancellation during provider abort recovery prevents another request", async () => {
  let requests = 0;
  const server = Bun.serve({ port: 0, fetch() { requests++; return aborted(); } });
  const agent = Agent.create({ provider: "openai", model: "fixture", "openai.base_url": `http://127.0.0.1:${server.port}`,
    "openai.retry_delay_ms": "1000" });
  try {
    agent.send("cancel recovery");
    let ended = false, cancelled = false;
    const deadline = performance.now() + 2000;
    while (!ended && performance.now() < deadline) {
      const ev = agent.poll(0);
      if (!ev) { await Bun.sleep(2); continue; }
      if (ev.type === "model_retry") { cancelled = true; agent.cancel(); }
      if (ev.type === "turn_end") { ended = true; expect(ev.stopReason).toBe("cancelled"); }
    }
    expect(ended && cancelled).toBe(true);
    expect(requests).toBe(1);
  } finally { agent.free(); server.stop(true); }
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
  ["malformed data", () => new Response("data: {bad json}\n\n")],
  ["content filter", () => new Response(chunk({}, "content_filter"))],
  ["unknown finish reason", () => new Response(chunk({}, "unknown"))],
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
  const agent = Agent.create({ provider: "openai", model: "fixture", "openai.max_tokens": "4096", "openai.base_url": `http://127.0.0.1:${server.port}`,
    "openai.retry_delay_ms": "10", "openai.request_timeout_ms": "3000" });
  try {
    agent.send("first input");
    let turns = 0, injected = false;
    const end = performance.now() + 4000;
    while (turns < (cancel ? 1 : 2) && performance.now() < end) {
      const e = agent.poll(0);
      if (!e) { await Bun.sleep(2); continue; }
      // Exercise the fixture's Retry-After, not an earlier transport retry
      // that may happen before the mock server receives its first request.
      if (e.type === "model_retry" && e.reason === "rate_limit" && !injected) {
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

for (const finish of [null, "length", "abort"]) test(`retry after a committed tool preserves durable evidence (${finish ?? "EOF"})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sope-retry-durable-"));
  const bodies: unknown[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    bodies.push(await req.json());
    if (bodies.length === 1) return new Response(chunk({ tool_calls: [{ index: 0, id: "once", type: "function", function: { name: "effect", arguments: "{}" } }] }, "tool_calls") + "data: [DONE]\n\n");
    if (bodies.length === 2) return new Response(chunk({ content: "abandoned" }) + (finish ? chunk({}, finish) + "data: [DONE]\n\n" : ""));
    return success();
  } });
  let agent = Agent.open(dir, { provider: "openai", model: "fixture", "openai.max_tokens": "4096", "openai.base_url": `http://127.0.0.1:${server.port}`, "openai.retry_delay_ms": "10" });
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
    expect(bodies[2]).toEqual(finish === "length" ? { ...bodies[1] as object, max_tokens: 8192 } : bodies[1]);
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

for (const finish of [null, "abort"]) test(`compaction discards an incomplete summary and installs only the successful retry (${finish ?? "EOF"})`, async () => {
  const server = Bun.serve({ port: 0, fetch() { return ++attempts === 1 ? new Response(chunk({ content: "abandoned summary" }) + (finish ? chunk({}, finish) : "")) : success(); } });
  let attempts = 0;
  const agent = Agent.create({ provider: "openai", model: "fixture", "openai.max_tokens": "4096", "openai.base_url": `http://127.0.0.1:${server.port}`, "openai.retry_delay_ms": "10" });
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

const limited = () => new Response(chunk({ reasoning_content: "unfinished reasoning" }) +
  chunk({ content: "discard me", tool_calls: [{ index: 0, id: "abandoned", type: "function",
    function: { name: "bash", arguments: '{"command":"never execute"}' } }] }, "length") +
  'data: {"choices":[],"usage":{"prompt_tokens":100,"completion_tokens":4096}}\n\n' + 'data: [DONE]\n\n');

test("output truncation raises only the output budget and preserves usage and the discard boundary", async () => {
  const r = await run(n => n === 1 ? limited() : success());
  expect(r.bodies.map(b => b.max_tokens)).toEqual([4096, 8192]);
  expect(r.bodies[1]).toEqual({ ...r.bodies[0], max_tokens: 8192 });
  expect(r.events.find(e => e.type === "model_retry")).toMatchObject({ reason: "output_limit", maxTokens: 4096,
    nextMaxTokens: 8192, discardedTextBytes: 10, discardedThinkingBytes: 20 });
  expect(r.events.find(e => e.type === "usage")).toMatchObject({ inputTokens: 100, outputTokens: 4096 });
  expect(r.events.some(e => e.type === "error")).toBe(false);
  expect(r.events.at(-1)).toMatchObject({ stopReason: "end_turn" });
  expect(r.history).not.toContain("discard me");
  expect(r.history).not.toContain("abandoned");
});

test("output recovery stops at the configured ceiling and accounts for its final rejected attempt", async () => {
  const r = await run(limited, { "openai.max_tokens_ceiling": "10000" });
  expect(r.bodies.map(b => b.max_tokens)).toEqual([4096, 8192, 10000]);
  expect(r.events.filter(e => e.type === "usage")).toHaveLength(3);
  expect(r.events.at(-1)).toMatchObject({ stopReason: "error" });
  expect(r.events.find(e => e.type === "error")).toMatchObject({ code: -10, message: expect.stringContaining("output_limit exhausted") });
  expect(r.history).not.toContain("discard me");
});

test("output recovery shares the general attempt limit", async () => {
  const r = await run(limited, { "openai.max_retries": "1" });
  expect(r.bodies.map(b => b.max_tokens)).toEqual([4096, 8192]);
  expect(r.events.at(-1)).toMatchObject({ stopReason: "error" });
});

test("output recovery can be disabled without dropping usage", async () => {
  const r = await run(limited, { "openai.max_tokens_ceiling": "4096" });
  expect(r.attempts).toBe(1);
  expect(r.events.filter(e => e.type === "usage")).toHaveLength(1);
  expect(r.events.some(e => e.type === "model_retry")).toBe(false);
});

test("output recovery is bounded by the model window and the reported input size", async () => {
  const r = await run(() => new Response(chunk({}, "length") +
    'data: {"choices":[],"usage":{"prompt_tokens":85000,"completion_tokens":4096}}\n\n' + 'data: [DONE]\n\n'),
    { "context.window": "100000" });
  expect(r.bodies.map(b => b.max_tokens)).toEqual([4096, 8192, 15000]);
  expect(r.events.at(-1)).toMatchObject({ stopReason: "error" });
});

test("invalid output ceilings fail before contacting the provider", async () => {
  const r = await run(success, { "openai.max_tokens_ceiling": "2048" });
  expect(r.attempts).toBe(0);
  expect(r.events.find(e => e.type === "error")).toMatchObject({ code: -2 });
});

test("Responses max_output_tokens truncation uses the same bounded recovery", async () => {
  const r = await run(n => n === 1 ? new Response('data: {"type":"response.incomplete","response":{"status":"incomplete","incomplete_details":{"reason":"max_output_tokens"},"usage":{"input_tokens":100,"output_tokens":4096}}}\n\n')
    : new Response('data: {"type":"response.completed","response":{"status":"completed","output":[{"type":"message","content":[{"type":"output_text","text":"recovered"}]}]}}\n\n'),
    { "openai.wire_api": "responses" });
  expect(r.bodies.map(b => b.max_output_tokens)).toEqual([4096, 8192]);
  expect(r.events.find(e => e.type === "model_retry")).toMatchObject({ reason: "output_limit" });
  expect(r.events.find(e => e.type === "usage")).toMatchObject({ inputTokens: 100, outputTokens: 4096 });
  expect(r.events.at(-1)).toMatchObject({ stopReason: "end_turn" });
});

test("output-budget backoff cannot extend the logical request deadline", async () => {
  const r = await run(limited, { "openai.retry_delay_ms": "1000", "openai.request_timeout_ms": "80" });
  expect(r.attempts).toBe(1);
  expect(r.events.find(e => e.type === "model_retry")).toMatchObject({ reason: "output_limit" });
  expect(r.events.find(e => e.type === "error")).toMatchObject({ code: -9 });
});

test("cancel during output-budget recovery prevents another request", async () => {
  let attempts = 0;
  const server = Bun.serve({ port: 0, fetch() { attempts++; return limited(); } });
  const agent = Agent.create({ provider: "openai", model: "fixture", "openai.max_tokens": "4096", "openai.base_url": `http://127.0.0.1:${server.port}` });
  try {
    agent.send("test cancellation");
    let ended = false;
    const end = performance.now() + 3000;
    while (!ended && performance.now() < end) {
      const e = agent.poll(0);
      if (!e) { await Bun.sleep(2); continue; }
      if (e.type === "model_retry") agent.cancel();
      if (e.type === "turn_end") { ended = true; expect(e.stopReason).toBe("cancelled"); }
    }
    expect(ended).toBe(true);
    expect(attempts).toBe(1);
    expect(agent.history()).not.toContain("discard me");
  } finally { agent.free(); server.stop(true); }
});

test("learned output budget survives later tool rounds and transient retries", async () => {
  const bodies: Record<string, unknown>[] = [];
  const server = Bun.serve({ port: 0, async fetch(req) {
    bodies.push(await req.json() as Record<string, unknown>);
    if (bodies.length === 1) return limited();
    if (bodies.length === 2) return new Response(chunk({ tool_calls: [{ index: 0, id: "once", type: "function",
      function: { name: "effect", arguments: "{}" } }] }, "tool_calls") + 'data: [DONE]\n\n');
    if (bodies.length === 3) return new Response("busy", { status: 503 });
    return success();
  } });
  const agent = Agent.create({ provider: "openai", model: "fixture", "openai.max_tokens": "4096", "openai.base_url": `http://127.0.0.1:${server.port}`, "openai.retry_delay_ms": "1" });
  try {
    agent.registerTool({ name: "effect", inputSchema: { type: "object" } });
    agent.send("test learned budget");
    let effects = 0, ended = false;
    const end = performance.now() + 3000;
    while (!ended && performance.now() < end) {
      const e = agent.poll(0);
      if (!e) { await Bun.sleep(2); continue; }
      if (e.type === "tool_call") { effects++; agent.toolResult(e.callId, "committed"); }
      if (e.type === "tool_start") throw new Error("partial tool escaped");
      if (e.type === "turn_end") { ended = true; expect(e.stopReason).toBe("end_turn"); }
    }
    expect(ended).toBe(true);
    expect(effects).toBe(1);
    expect(bodies.map(b => b.max_tokens)).toEqual([4096, 8192, 8192, 8192]);
    expect(bodies[2]).toEqual(bodies[3]);
    expect(agent.history()).not.toContain("discard me");
  } finally { agent.free(); server.stop(true); }
});

const batch = (calls: object[]) => new Response(chunk({ tool_calls: calls }, "tool_calls") + "data: [DONE]\n\n");
const bashCall = (index: number, id: string, args: string) =>
  ({ index, id, type: "function", function: { name: "bash", arguments: args } });
const invalidBatch = () => batch([bashCall(0, "invalid", '{"secret_value":')]);

for (const allowance of [0, 1, 10]) test(`invalid batches respect both retry limits (${allowance})`, async () => {
  const r = await run(invalidBatch, {"openai.max_retries": String(allowance)});
  expect(r.attempts).toBe(1 + Math.min(allowance, 2));
  expect(r.events.filter(e => e.type === "model_retry")).toHaveLength(Math.min(allowance, 2));
  for (const e of r.events.filter(e => e.type === "model_retry")) {
    expect(e).toMatchObject({reason: "invalid_tool_batch", validationReason: "tool_calls[0]: arguments are not valid JSON"});
  }
  expect(r.events.at(-1)).toMatchObject({stopReason: "error"});
  const error = r.events.find(e => e.type === "error");
  expect(error?.type === "error" && error.message).toContain("retry allowance exhausted");
  expect(error?.type === "error" && error.message).not.toContain("secret_value");
});

test("invalid batch recovery uses the same request and clears provisional text", async () => {
  const r = await run(n => n === 1 ? new Response(chunk({content: "abandoned"}) + chunk({tool_calls: [bashCall(0, "invalid", "[")]}, "tool_calls") + "data: [DONE]\n\n") : success());
  expect(r.attempts).toBe(2);
  expect(r.bodies[1]).toEqual(r.bodies[0]);
  expect(r.events.find(e => e.type === "model_retry")).toMatchObject({discardedTextBytes: 9});
  expect(r.history).not.toContain("abandoned");
  expect(r.events.at(-1)).toMatchObject({stopReason: "end_turn"});
});

test("mixed failure types cannot reset the malformed batch retry cap", async () => {
  const r = await run(n => n === 2 ? new Response("busy", {status: 503}) : invalidBatch(), {"openai.max_retries": "10"});
  expect(r.attempts).toBe(4);
  expect(r.events.filter(e => e.type === "model_retry").map(e => e.reason)).toEqual(["invalid_tool_batch", "server", "invalid_tool_batch"]);
});

test("invalid batch backoff is bounded by the logical request deadline", async () => {
  const r = await run(invalidBatch, {"openai.retry_delay_ms": "1000", "openai.request_timeout_ms": "80"});
  expect(r.attempts).toBe(1);
  expect(r.events.find(e => e.type === "error")).toMatchObject({code: -1});
  const error = r.events.find(e => e.type === "error");
  expect(error?.type === "error" && error.message).toContain("arguments are not valid JSON; recovery request deadline exceeded");
});

for (const priorToolFailed of [false, true]) for (const outcome of ["recovered", "exhausted", "cancelled"]) test(`invalid batch ${outcome} never replays committed tools or executes a valid subset (prior failure: ${priorToolFailed})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sope-invalid-batch-"));
  const bodies: unknown[] = [];
  const server = Bun.serve({port: 0, async fetch(req) {
    bodies.push(await req.json());
    if (bodies.length === 1) return batch([bashCall(0, "once", JSON.stringify({command: "printf 'once\\n' >> counter; cat counter" + (priorToolFailed ? "; exit 7" : "")}))]);
    if (bodies.length === 2 || outcome !== "recovered") return batch([
      bashCall(0, "rejected", JSON.stringify({command: "printf 'BAD\\n' >> counter"})),
      bashCall(1, "broken", "{"),
    ]);
    return success();
  }});
  let agent = Agent.open(join(dir, "session"), {provider: "openai", model: "fixture", "openai.max_tokens": "4096", cwd: dir, permissions: "allow",
    "openai.base_url": `http://127.0.0.1:${server.port}`, "openai.retry_delay_ms": outcome === "cancelled" ? "500" : "10"});
  try {
    agent.send("run once");
    const events: SopeEvent[] = [];
    const deadline = performance.now() + 4000;
    while (performance.now() < deadline) {
      const e = agent.poll(0);
      if (!e) {await Bun.sleep(2); continue;}
      events.push(e);
      if (outcome === "cancelled" && e.type === "model_retry") agent.cancel();
      if (e.type === "turn_end") break;
    }
    expect(events.at(-1)).toMatchObject({type: "turn_end", stopReason: outcome === "recovered" ? "end_turn" : outcome === "cancelled" ? "cancelled" : "error"});
    expect(events.filter(e => e.type === "tool_start")).toHaveLength(1);
    expect(events.filter(e => e.type === "tool_end")).toHaveLength(1);
    expect(events.find(e => e.type === "tool_end")).toMatchObject({isError: priorToolFailed});
    expect(readFileSync(join(dir, "counter"), "utf8")).toBe("once\n");
    expect(bodies).toHaveLength(outcome === "recovered" ? 3 : outcome === "exhausted" ? 4 : 2);
    for (const body of bodies.slice(2)) expect(body).toEqual(bodies[1]);
    expect(JSON.stringify(bodies[1])).toContain('once');
    agent.free();
    agent = Agent.open(join(dir, "session"));
    expect(agent.history()).toContain("once");
    expect(agent.history()).not.toContain("BAD");
    expect(agent.recovery().pending).toBe(false);
    expect(readFileSync(join(dir, "counter"), "utf8")).toBe("once\n");
  } finally {agent.free(); server.stop(true); rmSync(dir, {recursive: true, force: true});}
});


test("a recovery attempt timing out keeps the last validation reason terminal", async () => {
  const r = await run(n => n === 1 ? invalidBatch() : new Response(new ReadableStream({start(c) { c.enqueue(new TextEncoder().encode(": wait\n\n")); }})),
    {"openai.retry_delay_ms": "1", "openai.request_timeout_ms": "150", "openai.idle_timeout_ms": "1000"});
  expect(r.attempts).toBe(2);
  const error = r.events.find(e => e.type === "error");
  expect(error).toMatchObject({code: -1});
  expect(error?.type === "error" && error.message).toContain("arguments are not valid JSON; recovery request deadline exceeded");
});

test("a stalled partial tool retries on progress timeout without dispatch or replay", async () => {
  const partial = chunk({reasoning_content:"discard-this-thought"}) + chunk({tool_calls:[{index:0,id:"stalled",function:{name:"echo",arguments:'{"input":"unfinished'}}]});
  const r = await run(n => n === 1 ? new Response(new ReadableStream({start(c) {c.enqueue(new TextEncoder().encode(partial));}})) : success(),
    {"openai.progress_timeout_ms":"80", "openai.idle_timeout_ms":"1000"});
  expect(r.attempts).toBe(2);
  expect(r.events.at(-1)).toMatchObject({stopReason:"end_turn"});
  expect(r.history).not.toContain("unfinished");
  expect(r.history).not.toContain("discard-this-thought");
  expect(r.history).toContain("recovered");
});

for (const override of [undefined, "1234"]) test(`startup and partial-stream progress limits (override: ${override})`, async () => {
  const r = await run(() => success(), override ? {"openai.progress_timeout_ms":override} : {});
  const traces = r.events.filter((e): e is Extract<SopeEvent, {type:"log"}> => e.type === "log" && e.message.startsWith('{"event":"provider.'))
    .map(e => JSON.parse(e.message));
  expect(traces.find(e => e.event === "provider.start").progress_limit_ms).toBe(override ? 1234 : 300000);
  expect(traces.find(e => e.event === "provider.end").progress_limit_ms).toBe(override ? 1234 : 60000);
  expect(r.attempts).toBe(1);
});

test("heartbeats after partial output cannot postpone recovery", async () => {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  try {
    const r = await run(n => n === 1 ? new Response(new ReadableStream({
      start(c) {
        c.enqueue(encoder.encode(chunk({content:"uncommitted partial output"})));
        timer = setInterval(() => c.enqueue(encoder.encode(": heartbeat\n\n")), 10);
      },
      cancel() { clearInterval(timer); },
    })) : success(), {"openai.progress_timeout_ms":"100", "openai.idle_timeout_ms":"2000"});
    expect(r.attempts).toBe(2);
    expect(r.times[1]! - r.times[0]!).toBeLessThan(1500);
    expect(r.events.at(-1)).toMatchObject({stopReason:"end_turn"});
    expect(r.history).not.toContain("uncommitted partial output");
    const trace = r.events.find(e => e.type === "log" && e.message.includes('"event":"provider.retry"'));
    expect(trace?.type).toBe("log");
    if (trace?.type === "log") {
      const info = JSON.parse(trace.message);
      expect(info.progress_idle_ms).toBeGreaterThanOrEqual(100);
      expect(info.progress_limit_ms).toBe(100);
      expect(info.idle_ms).toBeLessThan(info.progress_idle_ms);
    }
  } finally { clearInterval(timer); }
});
