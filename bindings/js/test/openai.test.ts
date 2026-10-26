// SPDX-License-Identifier: MIT
// The openai provider against a local fake server: request shape, SSE
// parsing (text, reasoning, fragmented parallel tool calls, usage), the
// multi-round tool loop, and HTTP errors. No network access needed.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Agent, type SopeEvent } from "../src";

type Body = {
  model: string;
  stream: boolean;
  messages: Array<{ role: string; content: string | null; tool_call_id?: string; tool_calls?: unknown[] }>;
  tools?: Array<{ function: { name: string; parameters: unknown } }>;
};

const requests: Body[] = [];
let flakyFailures = 0;
let server: ReturnType<typeof Bun.serve>;
let agent: Agent | null = null;
let overrideStream: string | null = null;

const sse = (chunks: unknown[]) =>
  chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
const delta = (d: object, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

const heartbeatTimers = new Set<ReturnType<typeof setInterval>>();

beforeAll(() => {
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (req.headers.get("authorization") !== "Bearer test-key")
        return Response.json({ error: { message: "bad key" } }, { status: 401 });
      if (new URL(req.url).pathname.startsWith("/flaky/") && flakyFailures-- > 0)
        return new Response("overloaded", { status: 503 });
      const body = (await req.json()) as Body;
      requests.push(body);
      const path = new URL(req.url).pathname;
      if (path.startsWith("/productive/") && body.messages.at(-1)?.role !== "tool") {
        const kind = path.split("/")[2];
        let timer: ReturnType<typeof setInterval> | undefined;
        const stream = new ReadableStream({
          start(controller) {
            const emit = (d: object, finish: string | null = null) => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta(d, finish))}\n\n`));
            if (kind === "tool") emit({tool_calls: [{index: 0, id: "slow", function: {name: "echo", arguments: '{"input":"'}}]});
            let count = 0;
            timer = setInterval(() => {
              emit(kind === "tool" ? {tool_calls: [{index: 0, function: {arguments: "x"}}]} : {[kind === "reasoning" ? "reasoning_content" : "content"]: "x"});
              if (++count === 12) {
                clearInterval(timer); heartbeatTimers.delete(timer!);
                if (kind === "tool") emit({tool_calls: [{index: 0, function: {arguments: '"}'}}]}, "tool_calls");
                else emit({content: "done"}, "stop");
                controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n")); controller.close();
              }
            }, 40);
            heartbeatTimers.add(timer);
          },
          cancel() { if (timer) { clearInterval(timer); heartbeatTimers.delete(timer); } },
        });
        return new Response(stream, {headers: {"content-type": "text/event-stream"}});
      }
      if (new URL(req.url).pathname.startsWith("/stall/")) {
        const heartbeat = new URL(req.url).pathname.includes("heartbeat");
        let timer: ReturnType<typeof setInterval> | undefined;
        const stream = new ReadableStream({
          start(controller) {
            const finish = new URL(req.url).pathname.includes("finished") ? "stop" : null;
            controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(delta({ content: "partial" }, finish))}\n\n`));
            if (heartbeat) {
              timer = setInterval(() => controller.enqueue(new TextEncoder().encode(": keepalive\n\n")), 15);
              heartbeatTimers.add(timer);
            }
          },
          cancel() { if (timer) { clearInterval(timer); heartbeatTimers.delete(timer); } },
        });
        return new Response(stream, { headers: { "content-type": "text/event-stream" } });
      }
      if (overrideStream !== null) return new Response(overrideStream, { headers: { "content-type": "text/event-stream" } });
      const last = body.messages.at(-1)!;
      const stream =
        last.role === "tool"
          ? sse([delta({ content: `echo said: ${last.content}` }, "stop")])
          : sse([
              delta({ role: "assistant", content: "" }),
              delta({ reasoning_content: "Need the " }),
              delta({ reasoning_content: "echo tool." }),
              delta({ content: "Let me " }),
              delta({ content: "check." }),
              delta({ tool_calls: [{ index: 0, id: "call_a", type: "function", function: { name: "echo", arguments: "" } }] }),
              delta({ tool_calls: [{ index: 0, id: null, function: { name: null, arguments: '{"input":' } }] }),
              delta({ tool_calls: [{ index: 0, id: null, function: { name: null, arguments: '"你好"}' } }] }),
              delta({}, "tool_calls"),
              { choices: [], usage: { prompt_tokens: 42, completion_tokens: 7 } },
            ]);
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
});

afterAll(() => server.stop(true));
afterEach(() => {
  agent?.free();
  agent = null;
  requests.length = 0;
  overrideStream = null;
  for (const timer of heartbeatTimers) clearInterval(timer);
  heartbeatTimers.clear();
});

// The server runs on this thread, so poll without blocking and yield in between.
async function drainTurn(a: Agent, onToolCall: (e: Extract<SopeEvent, { type: "tool_call" }>) => void) {
  const events: SopeEvent[] = [];
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const ev = a.poll(0);
    if (!ev) {
      await Bun.sleep(2);
      continue;
    }
    events.push(ev);
    if (ev.type === "tool_call") onToolCall(ev);
    if (ev.type === "turn_end") return events;
  }
  throw new Error("timed out");
}

function openaiAgent(key = "test-key", prefix = "") {
  const a = Agent.create({
    provider: "openai",
    model: "glm-test",
    "openai.base_url": `http://127.0.0.1:${server.port}${prefix}/v1/`,
    "openai.api_key": key,
    system: "Be brief.",
  });
  a.registerTool({ name: "echo", description: "Echo", inputSchema: { type: "object", properties: { input: { type: "string" } } } });
  return a;
}

test("streams text and reasoning, assembles tool calls, loops until the model stops", async () => {
  agent = openaiAgent();
  agent.send("echo 你好");
  const events = await drainTurn(agent, (call) => {
    expect(call.name).toBe("echo");
    expect(JSON.parse(call.input)).toEqual({ input: "你好" });
    agent!.toolResult(call.callId, "你好!");
  });

  const joined = (type: "text_delta" | "thinking_delta") =>
    events.map((e) => (e.type === type ? e.text : "")).join("");
  expect(joined("thinking_delta")).toBe("Need the echo tool.");
  expect(joined("text_delta")).toBe("Let me check.echo said: 你好!");
  expect(events.find((e) => e.type === "usage")).toMatchObject({ inputTokens: 42, outputTokens: 7 });
  expect(events.at(-1)).toMatchObject({ type: "turn_end", stopReason: "end_turn" });

  expect(requests).toHaveLength(2);
  const [first, second] = requests;
  expect(first!.model).toBe("glm-test");
  expect(first!.stream).toBe(true);
  expect(first!.messages[0]).toEqual({ role: "system", content: "Be brief." });
  expect(first!.tools!.map((t) => t.function.name)).toEqual([
    "echo",
    ...["read", "write", "edit", "glob", "grep", "bash", "bash_output", "bash_kill", "web_fetch", "todo_write", "artifact_read", "check", "evidence"],
    "agent",
  ]);
  // Round two replays the assistant tool call and answers it by id.
  expect(second!.messages.map((m) => m.role)).toEqual(["system", "user", "assistant", "tool"]);
  expect(second!.messages[2]!.tool_calls).toEqual([
    { id: "call_a", type: "function", function: { name: "echo", arguments: '{"input":"你好"}' } },
  ]);
  expect(second!.messages[3]).toEqual({ role: "tool", tool_call_id: "call_a", content: "你好!" });
});

test("surfaces HTTP errors", async () => {
  agent = openaiAgent("wrong-key");
  agent.send("hi");
  const events = await drainTurn(agent, () => {});
  const error = events.find((e) => e.type === "error");
  expect(error).toMatchObject({ type: "error" });
  expect((error as { message: string }).message).toContain("HTTP 401");
  expect((error as { message: string }).message).toContain("bad key");
  expect(events.at(-1)).toMatchObject({ type: "turn_end", stopReason: "error" });
});

test("retries transient failures before any output", async () => {
  flakyFailures = 1;
  agent = openaiAgent("test-key", "/flaky");
  agent.send("plain");
  const events = await drainTurn(agent, (call) => agent!.toolResult(call.callId, "ok"));
  expect(events.filter((e) => e.type === "model_retry")).toHaveLength(1);
  expect(events.some((e) => e.type === "log" && e.level === "warn" && e.message.includes("retrying"))).toBe(false);
  expect(events.some((e) => e.type === "error")).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: "turn_end", stopReason: "end_turn" });
  const telemetry = events.flatMap((event) => event.type === "log" && event.message.startsWith('{"event":"provider.') ? [JSON.parse(event.message)] : []);
  expect(telemetry.filter((event) => event.event === "provider.start").map((event) => [event.round, event.attempt])).toEqual([[1, 1], [1, 2], [2, 1]]);
  expect(telemetry.find((event) => event.event === "provider.retry")).toMatchObject({status: 503, complete: 0, attempt: 1});
  expect(telemetry.filter((event) => event.event === "provider.end").every((event) => event.status === 200 && event.complete === 1 && event.elapsed_ms >= 0 && event.received_bytes > 0)).toBe(true);
  expect(telemetry.find(event => event.event === "provider.end")).toMatchObject({ text_bytes: 13, thinking_bytes: 19, tool_calls: 1, tool_argument_bytes: 18, finish_state: 2, stream_done: 1 });
  expect(telemetry.filter(event => event.event === "provider.end").at(-1)).toMatchObject({ finish_state: 1, stream_done: 1 });
  expect(JSON.stringify(telemetry)).not.toContain("test-key");
});

test("disabling retries exposes a truncated response once", async () => {
  overrideStream = `data: ${JSON.stringify(delta({ content: "partial" }))}\n\n`;
  agent = openaiAgent();
  agent.setOption("openai.max_retries", "0");
  agent.send("test disconnect");
  const events = await drainTurn(agent, () => { throw new Error("unexpected tool"); });
  expect(requests).toHaveLength(1);
  expect(events.filter((e) => e.type === "text_delta").map((e) => e.text).join("")).toBe("partial");
  expect(events.at(-1)).toMatchObject({type: "turn_end", stopReason: "error"});
  const terminal = events.find((e) => e.type === "log" && e.message.startsWith('{"event":"provider.end"'));
  expect(terminal?.type === "log" && JSON.parse(terminal.message)).toMatchObject({complete: 0, failed: 1, attempt: 1});
});

const tool = (index: number, id = "call_a", name = "echo", args = "{}") =>
  ({ index, id, type: "function", function: { name, arguments: args } });

for (const [name, calls, finish, diagnostic] of [
  ["fractional index", [tool(0.5)], "tool_calls", "tool_calls[0]: index must be an integer"],
  ["out of range index", [tool(0), tool(64, "call_b")], "tool_calls", "tool_calls[1]: index must be an integer"],
  ["stop with a tool batch", [tool(0)], "stop", "finish_reason must be tool_calls"],
  ["missing tool name", [tool(0), tool(1, "call_b", "")], "tool_calls", "tool_calls[1]: missing tool name"],
  ["invalid tool name", [tool(0, "call_a", "bad name")], "tool_calls", "invalid tool name"],
  ["duplicate call IDs", [tool(0), tool(1)], "tool_calls", "tool_calls[1]: duplicate tool call id"],
  ["NUL in ID", [tool(0, "bad\0id")], "tool_calls", "tool id contains NUL"],
  ["incomplete arguments after a valid call", [tool(0), tool(1, "call_b", "echo", '{"secret_value":')], "tool_calls", "tool_calls[1]: arguments are not valid JSON"],
  ["non-object arguments", [tool(0, "call_a", "echo", '[]')], "tool_calls", "arguments must be a JSON object"],
  ["non-string arguments", [{...tool(0), function: {name: "echo", arguments: {secret_value: 1}}}], "tool_calls", "arguments must be a JSON-encoded string"],
  ["string index", [{...tool(0), index: "0"}], "tool_calls", "index must be a number"],
  ["empty tool batch", [], "tool_calls", "empty batch"],
] as const) {
  test(`rejects the entire malformed tool batch: ${name}`, async () => {
    overrideStream = sse([delta({ tool_calls: calls }), delta({}, finish)]);
    agent = openaiAgent();
    agent.setOption("openai.max_retries", "0");
    agent.send("test malformed batch");
    const events = await drainTurn(agent, (call) => agent!.toolResult(call.callId, "must not run"));
    expect(requests).toHaveLength(1);
    expect(events.filter((e) => e.type === "tool_call" || e.type === "tool_start" || e.type === "permission")).toHaveLength(0);
    expect(events.at(-1)).toMatchObject({ type: "turn_end", stopReason: "error" });
    const error = events.find(e => e.type === "error");
    expect(error?.type === "error" && error.message).toContain(diagnostic);
    expect(error?.type === "error" && error.message).not.toContain("secret_value");
  });
}


for (const [name, prefix, idle, total, expected, finish] of [
  ["silent partial stream", "/stall/idle", 150, 2000, "idle", 0],
  ["finish reason without stream terminator remains incomplete", "/stall/finished", 150, 2000, "idle", 1],
  ["keepalives cannot extend request lifetime", "/stall/heartbeat", 200, 400, "request", 0],
] as const) test(name, async () => {
  agent = openaiAgent("test-key", prefix);
  agent.setOption("openai.max_retries", "0");
  agent.setOption("openai.idle_timeout_ms", String(idle));
  agent.setOption("openai.request_timeout_ms", String(total));
  agent.send("bounded response");
  const events = await drainTurn(agent, () => { throw new Error("partial response executed a tool"); });
  expect(events.at(-1)).toMatchObject({ type: "turn_end", stopReason: "error" });
  expect(events.find((ev) => ev.type === "error")?.type).toBe("error");
  expect(events.some((ev) => ev.type === "error" && ev.message.includes(`${expected} deadline exceeded`))).toBe(true);
  expect(events.filter((ev) => ev.type === "text_delta").map((ev) => ev.text).join("")).toBe("partial");
  expect(requests).toHaveLength(1);
  const timeout = events.find((ev) => ev.type === "log" && ev.message.includes('"event":"provider.timeout"'));
  expect(timeout?.type).toBe("log");
  if (timeout?.type === "log") expect(JSON.parse(timeout.message)).toMatchObject({ finish_state: finish, stream_done: 0, complete: 0 });
});

test("request deadline includes retry backoff", async () => {
  flakyFailures = 2;
  agent = openaiAgent("test-key", "/flaky");
  agent.setOption("openai.request_timeout_ms", "150");
  agent.send("deadline expires before second attempt");
  const events = await drainTurn(agent, () => { throw new Error("unexpected tool"); });
  expect(events.at(-1)).toMatchObject({ type: "turn_end", stopReason: "error" });
  expect(flakyFailures).toBe(1);
  expect(events.some((ev) => ev.type === "error" && ev.message.includes("request deadline exceeded"))).toBe(true);
});

for (const prefix of ["/stall/idle", "/stall/heartbeat"]) test(`semantic progress deadline bounds ${prefix}`, async () => {
  agent = openaiAgent("test-key", prefix);
  agent.setOption("openai.max_retries", "0");
  agent.setOption("openai.idle_timeout_ms", "2000");
  agent.setOption("openai.request_timeout_ms", "3000");
  agent.setOption("openai.progress_timeout_ms", "200");
  agent.send("bounded progress");
  const events = await drainTurn(agent, () => { throw new Error("unexpected tool"); });
  expect(events.at(-1)).toMatchObject({type: "turn_end", stopReason: "error"});
  expect(events.some(e => e.type === "error" && e.message.includes("progress deadline exceeded"))).toBe(true);
});

for (const kind of ["text", "reasoning", "tool"]) test(`productive ${kind} resets progress deadline`, async () => {
  agent = openaiAgent("test-key", `/productive/${kind}`);
  agent.setOption("openai.max_retries", "0");
  agent.setOption("openai.progress_timeout_ms", "200");
  agent.send("slow but productive");
  const events = await drainTurn(agent, call => agent!.toolResult(call.callId, "ok"));
  expect(events.some(e => e.type === "error")).toBe(false);
  expect(events.at(-1)).toMatchObject({type: "turn_end", stopReason: "end_turn"});
  if (kind === "tool") expect(events.filter(e => e.type === "tool_call")).toHaveLength(1);
});
