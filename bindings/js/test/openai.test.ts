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

const sse = (chunks: unknown[]) =>
  chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
const delta = (d: object, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

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
  expect(first!.tools!.map((t) => t.function.name)).toEqual(["echo", "agent"]);
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
  expect(events.some((e) => e.type === "log" && e.level === "warn" && e.message.includes("HTTP 503"))).toBe(true);
  expect(events.some((e) => e.type === "error")).toBe(false);
  expect(events.at(-1)).toMatchObject({ type: "turn_end", stopReason: "end_turn" });
});
