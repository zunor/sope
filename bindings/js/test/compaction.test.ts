// SPDX-License-Identifier: MIT
// Offline integration tests exercise the real provider, request accounting,
// transactional compaction and persisted histories through the public ABI.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { Agent, type SopeEvent } from "../src";

type Message = { role: string; content: unknown; tool_calls?: unknown[]; tool_call_id?: string };
type Request = { messages: Message[]; max_tokens: number; tools?: unknown[] };
const requests: Request[] = [];
const agents: Agent[] = [];
let server: ReturnType<typeof Bun.serve>;
let respond: (body: Request) => Response;
const chunk = (content: string, finish: string | null = "stop") =>
  ({ choices: [{ index: 0, delta: { content }, finish_reason: finish }] });
const stream = (chunks: unknown[], done = true) => new Response(
  chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + (done ? "data: [DONE]\n\n" : ""),
  { headers: { "content-type": "text/event-stream" } },
);
const compact = (r: Request) => String(r.messages[0]?.content).startsWith("You summarize conversations");
const defaultResponse = (r: Request) => stream([chunk(compact(r) ? "Checkpoint: preserve the task and continue." : "continued")]);
const oldHistory = () => [
  { role: "user", content: "ORIGINAL_TASK: fix the parser and preserve permissions" },
  { role: "assistant", content: "old evidence\n".repeat(10000) },
];

beforeAll(() => {
  server = Bun.serve({ port: 0, async fetch(req) {
    const body = await req.json() as Request;
    requests.push(body);
    return respond(body);
  } });
});
afterAll(() => server.stop(true));
afterEach(() => {
  for (const agent of agents.splice(0)) agent.free();
  requests.length = 0;
});

function create(options: Record<string, string> = {}) {
  respond = defaultResponse;
  const agent = Agent.create({ provider: "openai", model: "test", system: "Preserve user permissions.",
    "openai.base_url": `http://127.0.0.1:${server.port}/v1`, ...options });
  agents.push(agent);
  return agent;
}
async function drain(agent: Agent, onTool?: (e: Extract<SopeEvent, { type: "tool_call" }>) => void) {
  const events: SopeEvent[] = [];
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const ev = agent.poll(0);
    if (!ev) { await Bun.sleep(1); continue; }
    events.push(ev);
    if (ev.type === "tool_call") {
      if (!onTool) throw new Error("unexpected tool call");
      onTool(ev);
    }
    if (ev.type === "turn_end" && !ev.agentId) return events;
  }
  throw new Error("turn timed out");
}
const errors = (events: SopeEvent[]) => events.flatMap((e) => e.type === "error" ? [e.message] : []);

for (const [name, response] of Object.entries({
  length: () => stream([chunk("half a summary", "length")]),
  content_filter: () => stream([chunk("filtered", "content_filter")]),
  missing_done: () => stream([chunk("half a summary")], false),
  missing_finish: () => stream([chunk("half a summary", null)]),
  empty: () => stream([chunk("")]),
  whitespace: () => stream([chunk(" \n\t ")]),
  malformed: () => new Response('data: {broken\n\ndata: [DONE]\n\n'),
  tool_call: () => stream([{ choices: [{ delta: { tool_calls: [{ index: 0, id: "x", function: { name: "read", arguments: "{}" } }] }, finish_reason: "stop" }] }]),
  http_error: () => Response.json({ error: { message: "bad request" } }, { status: 400 }),
})) {
  test(`rejects ${name} compaction without replacing persisted history`, async () => {
    const agent = create();
    agent.loadHistory(JSON.stringify(oldHistory()));
    const before = agent.history();
    respond = response;
    agent.compact();
    const events = await drain(agent);
    expect(events.at(-1)).toMatchObject({ stopReason: "error" });
    expect(events.some((e) => e.type === "compact" || e.type === "text_delta")).toBe(false);
    expect(errors(events).length).toBeGreaterThan(0);
    expect(agent.history()).toBe(before);
  });
}

test("restored history triggers preflight compaction without a usage report", async () => {
  const agent = create({ "compact.threshold": "12000" });
  agent.loadHistory(JSON.stringify(oldHistory()));
  agent.send("NEW_REQUEST: quote this exactly 中文");
  const events = await drain(agent);
  expect(events.at(-1)).toMatchObject({ stopReason: "end_turn" });
  expect(requests).toHaveLength(2);
  expect(compact(requests[0]!)).toBe(true);
  expect(String(requests[0]!.messages[1]!.content)).not.toContain("NEW_REQUEST");
  expect(requests[1]!.messages.at(-1)?.content).toBe("NEW_REQUEST: quote this exactly 中文");
  expect(requests[1]!.messages[0]?.content).toBe("Preserve user permissions.");
  expect(events.filter((e) => e.type === "compact")).toHaveLength(1);
});

test("new input is budgeted even when the preceding model reported little usage", async () => {
  const agent = create({ "compact.threshold": "12000", "compact.retain_tokens": "0" });
  agent.loadHistory(JSON.stringify([
    { role: "user", content: "prior task" }, { role: "assistant", content: "evidence ".repeat(2200) },
  ]));
  respond = (r) => compact(r) ? defaultResponse(r) : stream([
    chunk("continued"), { choices: [], usage: { prompt_tokens: 10, completion_tokens: 1 } },
  ]);
  agent.send("small");
  await drain(agent);
  expect(requests.some(compact)).toBe(false);
  agent.send("NEW_INPUT ".repeat(4000));
  const events = await drain(agent);
  expect(events.filter((e) => e.type === "compact")).toHaveLength(1);
  expect(String(requests.at(-1)!.messages.at(-1)!.content)).toBe("NEW_INPUT ".repeat(4000));
});

test("a large tool result triggers mid-turn compaction and retains its final failure", async () => {
  const agent = create({ "compact.threshold": "12000", "compact.retain_tokens": "0" });
  agent.registerTool({ name: "probe", description: "probe", inputSchema: { type: "object" } });
  let normal = 0;
  respond = (r) => compact(r) ? defaultResponse(r) : ++normal === 1 ? stream([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "p", function: { name: "probe", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
  ]) : defaultResponse(r);
  agent.send("Run the tests");
  const events = await drain(agent, (ev) => agent.toolResult(ev.callId,
    "BUILD_START\n" + "progress ".repeat(60000) + "\nFINAL_ERROR: parser_test failed, exit 1", true));
  expect(events.at(-1)).toMatchObject({ stopReason: "end_turn" });
  expect(events.filter((e) => e.type === "compact")).toHaveLength(1);
  const transcript = String(requests.find(compact)!.messages[1]!.content);
  expect(transcript).toContain("BUILD_START");
  expect(transcript).toContain("FINAL_ERROR: parser_test failed, exit 1");
  expect(transcript).toContain("bytes omitted");
  expect(String(requests.at(-1)!.messages[1]!.content)).toContain("Continue with the current task");
});

test("retains recent raw user messages, complete parallel tool groups and images across repeated compaction and restore", async () => {
  const agent = create();
  const recent = [
    { role: "user", content: "EXACT_CONSTRAINT: never deploy", images: [{ media_type: "image/png", data: "aGVsbG8=" }] },
    { role: "assistant", content: "", tool_uses: [
      { id: "a", name: "read", input: '{"path":"a"}' }, { id: "b", name: "read", input: '{"path":"b"}' },
    ] },
    { role: "tool", name: "read", tool_use_id: "a", content: "EXACT_A", is_error: false },
    { role: "tool", name: "read", tool_use_id: "b", content: "EXACT_B", is_error: false },
  ];
  agent.loadHistory(JSON.stringify([...oldHistory(), ...recent]));
  agent.compact();
  expect((await drain(agent)).at(-1)).toMatchObject({ stopReason: "end_turn" });
  const first = JSON.parse(agent.history());
  expect(first[0]).toMatchObject({ role: "user", summary: true });
  expect(first.slice(1)).toEqual(recent);
  expect(String(requests[0]!.messages[1]!.content)).not.toContain("EXACT_CONSTRAINT");
  const restored = create();
  restored.loadHistory(agent.history());
  expect(JSON.parse(restored.history())).toEqual(first);
  // Add older bulk before the recent suffix to test a second checkpoint.
  restored.loadHistory(JSON.stringify([first[0], oldHistory()[1], ...recent]));
  restored.compact();
  expect((await drain(restored)).at(-1)).toMatchObject({ stopReason: "end_turn" });
  const second = JSON.parse(restored.history());
  expect(second.filter((m: { summary?: boolean }) => m.summary)).toHaveLength(1);
  expect(second.slice(1)).toEqual(recent);
  expect(String(requests.at(-1)!.messages[1]!.content)).toContain("[previous checkpoint]");
});

test("bounds the entire summary request and gives it a separate output limit", async () => {
  const agent = create({ "compact.input_tokens": "1500", "compact.max_tokens": "700", "openai.max_tokens": "90" });
  agent.loadHistory(JSON.stringify([
    { role: "user", content: "HEAD_USER " + "中文".repeat(20000) + " TAIL_USER" },
    { role: "assistant", content: "HEAD_ASSISTANT " + "large ".repeat(20000) + " TAIL_ASSISTANT" },
  ]));
  agent.compact("preserve failures");
  expect((await drain(agent)).at(-1)).toMatchObject({ stopReason: "end_turn" });
  const request = requests[0]!;
  expect(request.max_tokens).toBe(700);
  const transcript = String(request.messages[1]!.content);
  expect(transcript).toContain("TAIL_USER");
  expect(transcript).toContain("TAIL_ASSISTANT");
  expect(transcript).toContain("preserve failures");
  expect(Buffer.byteLength(transcript)).toBeLessThan(6000);
  agent.send("continue");
  await drain(agent);
  expect(requests.at(-1)!.max_tokens).toBe(90);
});

test("rejects impossible summary instructions without sending a request", async () => {
  const agent = create({ "compact.input_tokens": "500" });
  agent.loadHistory(JSON.stringify(oldHistory()));
  const before = agent.history();
  agent.compact("mandatory instruction ".repeat(1000));
  const events = await drain(agent);
  expect(events.at(-1)).toMatchObject({ stopReason: "error" });
  expect(requests).toHaveLength(0);
  expect(agent.history()).toBe(before);
});

test("hard window rejects an oversized new request and keeps it in history", async () => {
  const agent = create({ "context.window": "12000", "compact.threshold": "8000" });
  agent.send("unsplittable request ".repeat(6000));
  const events = await drain(agent);
  expect(events.at(-1)).toMatchObject({ stopReason: "error" });
  expect(errors(events).join(" ")).toContain("context.window");
  expect(requests).toHaveLength(0);
  expect(JSON.parse(agent.history())[0].content).toBe("unsplittable request ".repeat(6000));
});

test("failed automatic compaction continues only while the full request fits", async () => {
  const agent = create({ "compact.threshold": "12000", "context.window": "100000" });
  agent.loadHistory(JSON.stringify(oldHistory()));
  respond = (r) => compact(r) ? stream([chunk("partial", "length")]) : defaultResponse(r);
  agent.send("continue");
  const events = await drain(agent);
  expect(events.at(-1)).toMatchObject({ stopReason: "end_turn" });
  expect(requests).toHaveLength(2);
  expect(events.some((e) => e.type === "compact")).toBe(false);
  expect(JSON.parse(agent.history())[0].content).toContain("ORIGINAL_TASK");

  requests.length = 0;
  agent.setOption("context.window", "12000");
  agent.send("continue again");
  const blocked = await drain(agent);
  expect(blocked.at(-1)).toMatchObject({ stopReason: "error" });
  expect(requests).toHaveLength(1);
  expect(compact(requests[0]!)).toBe(true);
  expect(JSON.parse(agent.history()).at(-1).content).toBe("continue again");
});

test("non-shrinking automatic summary is rejected without looping", async () => {
  const agent = create({ "compact.threshold": "12000" });
  agent.loadHistory(JSON.stringify(oldHistory()));
  respond = (r) => compact(r) ? stream([chunk("bloated summary ".repeat(20000))]) : defaultResponse(r);
  agent.send("continue");
  const events = await drain(agent);
  expect(requests).toHaveLength(2);
  expect(events.some((e) => e.type === "compact")).toBe(false);
  expect(errors(events).join(" ")).toContain("smaller history");
  expect(JSON.parse(agent.history())[0].content).toContain("ORIGINAL_TASK");
});

test("accounts for system instructions and tool schemas before sending", async () => {
  const agent = create({ "context.window": "12000", system: "instructions ".repeat(4000) });
  agent.send("hi");
  expect((await drain(agent)).at(-1)).toMatchObject({ stopReason: "error" });
  expect(requests).toHaveLength(0);
  const tools = create({ "context.window": "12000" });
  tools.registerTool({ name: "large", description: "schema description ".repeat(4000), inputSchema: { type: "object" } });
  tools.send("hi");
  expect((await drain(tools)).at(-1)).toMatchObject({ stopReason: "error" });
  expect(requests).toHaveLength(0);
});

const invalidOptions: Record<string, string>[] = [
  { "compact.threshold": "-1" }, { "context.window": "10000oops" },
  { "context.window": "4096" }, { "compact.max_tokens": "0" }, { "compact.retain_tokens": "1.5" },
];
for (const options of invalidOptions) {
  test(`rejects invalid budget configuration ${JSON.stringify(options)}`, async () => {
    const agent = create(options);
    agent.send("hi");
    expect((await drain(agent)).at(-1)).toMatchObject({ stopReason: "error" });
    expect(requests).toHaveLength(0);
  });
}

const contextError = () => Response.json(
  { error: { code: "context_length_exceeded", message: "model window exceeded" } }, { status: 400 },
);

test("server-reported summary overflow retries with smaller bounded transcripts", async () => {
  const agent = create();
  agent.loadHistory(JSON.stringify(oldHistory()));
  let attempts = 0;
  respond = (r) => ++attempts < 3 ? contextError() : defaultResponse(r);
  agent.compact();
  const events = await drain(agent);
  expect(events.at(-1)).toMatchObject({ stopReason: "end_turn" });
  expect(requests).toHaveLength(3);
  expect(String(requests[1]!.messages[1]!.content).length).toBeLessThan(String(requests[0]!.messages[1]!.content).length);
  expect(String(requests[2]!.messages[1]!.content).length).toBeLessThan(String(requests[1]!.messages[1]!.content).length);
  expect(events.filter((e) => e.type === "compact")).toHaveLength(1);
});

test("exhausted summary overflow retries preserve history", async () => {
  const agent = create();
  agent.loadHistory(JSON.stringify(oldHistory()));
  const before = agent.history();
  respond = contextError;
  agent.compact();
  expect((await drain(agent)).at(-1)).toMatchObject({ stopReason: "error" });
  expect(requests).toHaveLength(3);
  expect(agent.history()).toBe(before);
});

test("server overflow compacts and retries the same round, preserving incoming user text", async () => {
  const agent = create({ "compact.threshold": "1000000", max_rounds: "1" });
  agent.loadHistory(JSON.stringify(oldHistory()));
  let normal = 0;
  respond = (r) => !compact(r) && ++normal === 1 ? contextError() : defaultResponse(r);
  agent.send("EXACT_NEW_REQUEST");
  const events = await drain(agent);
  expect(events.at(-1)).toMatchObject({ stopReason: "end_turn" });
  expect(requests.map(compact)).toEqual([false, true, false]);
  expect(String(requests[1]!.messages[1]!.content)).not.toContain("EXACT_NEW_REQUEST");
  expect(requests[2]!.messages.at(-1)!.content).toBe("EXACT_NEW_REQUEST");
});

test("normal-request overflow recovery is bounded to one retry per round", async () => {
  const agent = create({ "compact.threshold": "1000000" });
  agent.loadHistory(JSON.stringify(oldHistory()));
  respond = (r) => compact(r) ? defaultResponse(r) : contextError();
  agent.send("continue");
  expect((await drain(agent)).at(-1)).toMatchObject({ stopReason: "error" });
  expect(requests.map(compact)).toEqual([false, true, false]);
});

test("disabling automatic compaction also disables overflow-triggered summarization", async () => {
  const agent = create({ "compact.threshold": "0" });
  agent.loadHistory(JSON.stringify(oldHistory()));
  respond = contextError;
  agent.send("continue");
  expect((await drain(agent)).at(-1)).toMatchObject({ stopReason: "error" });
  expect(requests).toHaveLength(1);
  expect(compact(requests[0]!)).toBe(false);
});

test("cancelling an in-flight automatic summary preserves both history and held user input", async () => {
  const agent = create({ "compact.threshold": "12000" });
  agent.loadHistory(JSON.stringify(oldHistory()));
  const before = JSON.parse(agent.history());
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  respond = () => new Response(new ReadableStream<Uint8Array>({ start(c) {
    controller = c;
    c.enqueue(new TextEncoder().encode(`data: ${JSON.stringify(chunk("partial checkpoint", null))}\n\n`));
  } }), { headers: { "content-type": "text/event-stream" } });
  agent.send("HELD_REQUEST");
  const deadline = Date.now() + 2000;
  while (!controller && Date.now() < deadline) await Bun.sleep(1);
  expect(controller).toBeDefined();
  agent.cancel();
  expect((await drain(agent)).at(-1)).toMatchObject({ stopReason: "cancelled" });
  expect(JSON.parse(agent.history())).toEqual([...before, { role: "user", content: "HELD_REQUEST" }]);
  try { controller!.close(); } catch { /* cancellation may already have closed the HTTP stream */ }
});

test("recompaction keeps the entire previous checkpoint while clipping new bulk", async () => {
  const agent = create({ "compact.input_tokens": "1800", "compact.retain_tokens": "0" });
  const checkpoint = "first ".repeat(250) + "NEVER_PUBLISH_WITHOUT_APPROVAL" + " last".repeat(250);
  agent.loadHistory(JSON.stringify([
    { role: "user", content: checkpoint, summary: true },
    { role: "assistant", content: "new log ".repeat(10000) },
  ]));
  agent.compact();
  expect((await drain(agent)).at(-1)).toMatchObject({ stopReason: "end_turn" });
  expect(String(requests[0]!.messages[1]!.content)).toContain(checkpoint);
});

test("missing usage does not discard a prior calibrated context estimate", async () => {
  const agent = create({ "compact.threshold": "12000", "compact.retain_tokens": "0" });
  agent.loadHistory(JSON.stringify([
    { role: "user", content: "prior task" },
    { role: "assistant", content: "relevant evidence ".repeat(300) },
  ]));
  let calls = 0;
  respond = (r) => compact(r) ? defaultResponse(r) : ++calls === 1 ? stream([
    chunk("continued"), { choices: [], usage: { prompt_tokens: 10000, completion_tokens: 10 } },
  ]) : defaultResponse(r);
  agent.send("first");
  await drain(agent);
  agent.send("second without usage");
  await drain(agent);
  expect(requests.some(compact)).toBe(false);
  agent.send("NEW_INPUT ".repeat(1000));
  expect((await drain(agent)).filter((e) => e.type === "compact")).toHaveLength(1);
});

test("retention leaves headroom for the summary and incoming request", async () => {
  const agent = create({ "context.window": "12000", "compact.threshold": "100000", "compact.max_tokens": "1000" });
  agent.loadHistory(JSON.stringify([...oldHistory(), { role: "user", content: "RECENT_RAW ".repeat(600) }]));
  respond = (r) => compact(r) ? stream([chunk("summary ".repeat(400))]) : defaultResponse(r);
  agent.send("CURRENT_INPUT ".repeat(1000));
  const events = await drain(agent);
  expect(events.at(-1)).toMatchObject({ stopReason: "end_turn" });
  expect(events.filter((e) => e.type === "compact")).toHaveLength(1);
  expect(String(requests[0]!.messages[1]!.content)).toContain("RECENT_RAW");
  expect(requests.at(-1)!.messages.at(-1)!.content).toBe("CURRENT_INPUT ".repeat(1000));
});

test("exhausting model rounds does not compact completed tool evidence", async () => {
  const agent = create({ "compact.threshold": "12000", max_rounds: "1" });
  agent.registerTool({ name: "probe", description: "probe", inputSchema: { type: "object" } });
  respond = (r) => compact(r) ? defaultResponse(r) : stream([
    { choices: [{ delta: { tool_calls: [{ index: 0, id: "p", function: { name: "probe", arguments: "{}" } }] }, finish_reason: "tool_calls" }] },
  ]);
  agent.send("run once");
  const result = "COMPLETE_EVIDENCE ".repeat(10000);
  const events = await drain(agent, (e) => agent.toolResult(e.callId, result));
  expect(events.at(-1)).toMatchObject({ stopReason: "error" });
  expect(requests).toHaveLength(1);
  expect(JSON.parse(agent.history()).at(-1).content).toBe(result);
});

for (const [name, response] of Object.entries({
  refusal: () => stream([{ choices: [{ delta: { content: "Cannot summarize.", refusal: "refused" }, finish_reason: "stop" }] }]),
  nameless_tool: () => stream([{ choices: [{ delta: { content: "summary", tool_calls: [{ index: 0, id: "x", function: { arguments: "{}" } }] }, finish_reason: "stop" }] }]),
  post_finish_content: () => stream([chunk("summary"), chunk("unfinished extra material", null)]),
  early_done: () => new Response(`data: [DONE]\n\ndata: ${JSON.stringify(chunk("late summary"))}\n\n`),
})) {
  test(`rejects ${name} without committing a checkpoint`, async () => {
    const agent = create();
    agent.loadHistory(JSON.stringify(oldHistory()));
    const before = agent.history();
    respond = response;
    agent.compact();
    expect((await drain(agent)).at(-1)).toMatchObject({ stopReason: "error" });
    expect(agent.history()).toBe(before);
  });
}

for (const usage of [{}, { prompt_tokens: 1 }, { prompt_tokens: -1, completion_tokens: 5 },
  { prompt_tokens: 1e100, completion_tokens: 0 }, { prompt_tokens: 1.5, completion_tokens: 0 }]) {
  test(`invalid usage preserves calibration: ${JSON.stringify(usage)}`, async () => {
    const agent = create({ "compact.threshold": "12000", "compact.retain_tokens": "0" });
    agent.loadHistory(JSON.stringify([{ role: "user", content: "prior task" },
      { role: "assistant", content: "evidence ".repeat(500) }]));
    let calls = 0;
    respond = (r) => compact(r) ? defaultResponse(r) : stream([
      chunk("continued"), { choices: [], usage: ++calls === 1 ? { prompt_tokens: 10000, completion_tokens: 10 } : usage },
    ]);
    agent.send("first");
    await drain(agent);
    agent.send("invalid usage");
    await drain(agent);
    agent.send("NEW_INPUT ".repeat(1000));
    expect((await drain(agent)).filter((e) => e.type === "compact")).toHaveLength(1);
  });
}

test("a checkpoint that cannot fit is preserved rather than silently clipped", async () => {
  const agent = create({ "compact.input_tokens": "500" });
  agent.loadHistory(JSON.stringify([
    { role: "user", summary: true, content: "CRITICAL_MEMORY ".repeat(500) },
    { role: "assistant", content: "bulk ".repeat(10000) },
  ]));
  const before = agent.history();
  agent.compact();
  expect((await drain(agent)).at(-1)).toMatchObject({ stopReason: "error" });
  expect(requests).toHaveLength(0);
  expect(agent.history()).toBe(before);
});

test("long tool loop survives repeated compaction and a failed middle summary without replaying tools", async () => {
  const agent = create({ "compact.threshold": "12000", "compact.retain_tokens": "0", max_rounds: "5" });
  agent.registerTool({ name: "probe", description: "probe", inputSchema: { type: "object" } });
  const issued: number[] = [];
  let modelRound = 0, summaries = 0;
  respond = (r) => {
    if (compact(r)) {
      summaries++;
      const transcript = String(r.messages[1]!.content);
      expect(transcript).toContain("KEEP_ORIGINAL_CONSTRAINT");
      expect(transcript).toContain(`RESULT_${modelRound}`);
      if (summaries === 2) return stream([chunk("partial", "length")]);
      return stream([chunk(`KEEP_ORIGINAL_CONSTRAINT; completed results through RESULT_${modelRound}`)]);
    }
    modelRound++;
    if (modelRound === 5) return defaultResponse(r);
    // Every ordinary request must have all retained tool calls paired exactly once.
    const ids = r.messages.flatMap((m) => m.tool_calls ?? []).map((c) => (c as { id: string }).id);
    const answers = r.messages.filter((m) => m.role === "tool").map((m) => m.tool_call_id);
    expect(answers).toEqual(ids);
    return stream([{ choices: [{ delta: { tool_calls: [{ index: 0, id: `p${modelRound}`,
      function: { name: "probe", arguments: JSON.stringify({ round: modelRound }) } }] }, finish_reason: "tool_calls" }] }]);
  };
  agent.send("KEEP_ORIGINAL_CONSTRAINT. Complete the four probes.");
  const events = await drain(agent, (e) => {
    const round = JSON.parse(e.input).round;
    issued.push(round);
    agent.toolResult(e.callId, `RESULT_${round}\n` + "long output ".repeat(10000) + `\nRESULT_${round}_END`);
  });
  expect(events.at(-1)).toMatchObject({ stopReason: "end_turn" });
  expect(issued).toEqual([1, 2, 3, 4]);
  expect(summaries).toBe(4);
  expect(events.filter((e) => e.type === "compact")).toHaveLength(3);
  const saved = agent.history();
  expect(JSON.parse(saved).filter((m: { summary?: boolean }) => m.summary)).toHaveLength(1);
  expect(saved).toContain("RESULT_4");
  const restored = create();
  restored.loadHistory(saved);
  restored.send("resume after four probes");
  expect((await drain(restored)).at(-1)).toMatchObject({ stopReason: "end_turn" });
  expect(String(requests.at(-1)!.messages[1]!.content)).toContain("RESULT_4");
});

for (const impossibleBudget of [false, true]) {
  test(`failed overflow recovery does not resend the known-oversized request (input budget=${impossibleBudget})`, async () => {
    const agent = create({ "compact.threshold": "1000000", ...(impossibleBudget ? { "compact.input_tokens": "1" } : {}) });
    agent.loadHistory(JSON.stringify(oldHistory()));
    respond = (r) => compact(r) ? stream([chunk("partial", "length")]) : contextError();
    agent.send("CURRENT_TASK");
    expect((await drain(agent)).at(-1)).toMatchObject({ stopReason: "error" });
    expect(requests.filter((r) => !compact(r))).toHaveLength(1);
    const history = JSON.parse(agent.history());
    expect(history[0].content).toContain("ORIGINAL_TASK");
    expect(history.at(-1).content).toBe("CURRENT_TASK");
  });
}

test("cancelled completed summary cannot overwrite history and the queued turn still runs", async () => {
  const agent = create({ "compact.threshold": "12000" });
  agent.loadHistory(JSON.stringify(oldHistory()));
  let first = true;
  respond = (r) => {
    if (compact(r) && first) {
      first = false;
      agent.cancel(); // wins before the complete response can be installed
      return stream([chunk("MUST_NOT_INSTALL")]);
    }
    return defaultResponse(r);
  };
  agent.send("CANCELLED_INPUT");
  agent.send("QUEUED_INPUT");
  expect((await drain(agent)).at(-1)).toMatchObject({ stopReason: "cancelled" });
  expect((await drain(agent)).at(-1)).toMatchObject({ stopReason: "end_turn" });
  const successfulTranscript = String(requests.filter(compact)[1]!.messages[1]!.content);
  expect(successfulTranscript.includes("ORIGINAL_TASK")).toBe(true);
  expect(requests.at(-1)!.messages.some((m) => m.content === "CANCELLED_INPUT")).toBe(true);
  expect(successfulTranscript).not.toContain("MUST_NOT_INSTALL");
  expect(requests.at(-1)!.messages.at(-1)!.content).toBe("QUEUED_INPUT");
});

test("each compaction gets fresh retries even within one model round", async () => {
  const agent = create({ "compact.threshold": "12000" });
  agent.loadHistory(JSON.stringify([...oldHistory(), { role: "user", content: "RECENT ".repeat(700) }]));
  let normal = 0, attempts = 0;
  respond = (r) => {
    if (!compact(r)) return ++normal === 1 ? contextError() : defaultResponse(r);
    attempts++;
    if (attempts === 1 || attempts === 2 || attempts === 4) return contextError();
    return stream([chunk(attempts === 3 ? "CHECKPOINT ".repeat(200) : "Complete checkpoint.")]);
  };
  agent.send("EXACT_CURRENT_INPUT");
  const events = await drain(agent);
  expect(events.at(-1)).toMatchObject({ stopReason: "end_turn" });
  expect(attempts).toBe(5);
  expect(normal).toBe(2);
  expect(events.filter((e) => e.type === "compact")).toHaveLength(2);
  expect(requests.at(-1)!.messages.at(-1)!.content).toBe("EXACT_CURRENT_INPUT");
});

test("summary receives middle tool evidence and arguments when the full transcript fits", async () => {
  const agent = create({ "compact.retain_tokens": "0" });
  const input = JSON.stringify({ context: "x".repeat(6000), required: "KEEP_ABI_V7", notes: "y".repeat(6000) });
  const result = "routine scan\n".repeat(1500) + "\nBASELINE_ROWS=7319\n" + "routine scan\n".repeat(1500);
  agent.loadHistory(JSON.stringify([
    { role: "user", content: "Investigate the migration; retain verified results." },
    { role: "assistant", content: "", tool_uses: [{ id: "read", name: "read_phase", input }] },
    { role: "tool", tool_use_id: "read", name: "read_phase", content: result },
  ]));
  agent.compact();
  expect((await drain(agent)).at(-1)).toMatchObject({ stopReason: "end_turn" });
  const transcript = String(requests[0]!.messages[1]!.content);
  expect(transcript.includes(input)).toBe(true);
  expect(transcript.includes(result)).toBe(true);
  expect(transcript).not.toContain("bytes omitted");
});
