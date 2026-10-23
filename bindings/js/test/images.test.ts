// SPDX-License-Identifier: MIT
// Images: attachImage() and read/web_fetch results, as the openai provider
// sends them (content parts with data URLs), and the switch to image_model.
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, SopeError, type SopeEvent } from "../src";

type Part = { type: string; text?: string; image_url?: { url: string } };
type Msg = { role: string; content: string | Part[] | null; tool_calls?: unknown[] };
type Body = { model: string; messages: Msg[] };

// A PNG signature and an IHDR header: enough for the media type sniffing.
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
const PNG_URL = `data:image/png;base64,${Buffer.from(PNG).toString("base64")}`;

const requests: Body[] = [];
let server: ReturnType<typeof Bun.serve>;
let agent: Agent | null = null;
const dir = realpathSync(mkdtempSync(join(tmpdir(), "sope-js-images-")));

const sse = (chunks: unknown[]) => chunks.map((c) => `data: ${JSON.stringify(c)}\n\n`).join("") + "data: [DONE]\n\n";
const delta = (d: object, finish: string | null = null) => ({ choices: [{ index: 0, delta: d, finish_reason: finish }] });

beforeAll(() => {
  writeFileSync(join(dir, "shot.png"), PNG);
  server = Bun.serve({
    port: 0,
    async fetch(req) {
      if (new URL(req.url).pathname === "/img.png") return new Response(PNG, { headers: { "content-type": "image/png" } });
      const body = (await req.json()) as Body;
      body.messages = body.messages.filter((m) => m.role !== "system"); // the default prompt is not under test
      requests.push(body);
      const first = body.messages.find((m) => m.role === "user")!;
      const text = typeof first.content === "string" ? first.content : first.content?.[0]?.text;
      // "read it" asks for the read tool once; everything else gets a plain answer.
      const wantsTool = text === "read it" && !body.messages.some((m) => m.role === "tool");
      const stream = wantsTool
        ? sse([
            delta({ tool_calls: [{ index: 0, id: "call_r", type: "function", function: { name: "read", arguments: '{"file_path":"shot.png"}' } }] }),
            delta({}, "tool_calls"),
          ])
        : sse([delta({ content: "I see it." }, "stop")]);
      return new Response(stream, { headers: { "content-type": "text/event-stream" } });
    },
  });
});

afterAll(() => {
  server.stop(true);
  rmSync(dir, { recursive: true, force: true });
});
afterEach(() => {
  agent?.free();
  agent = null;
  requests.length = 0;
});

async function turn(a: Agent, text: string): Promise<SopeEvent[]> {
  a.send(text);
  const events: SopeEvent[] = [];
  const deadline = Date.now() + 5000;
  while (Date.now() < deadline) {
    const ev = a.poll(0);
    if (!ev) {
      await Bun.sleep(2);
      continue;
    }
    events.push(ev);
    if (ev.type === "turn_end" && !ev.agentId) return events;
  }
  throw new Error("timed out");
}

function create(imageModel?: string): Agent {
  return Agent.create({
    provider: "openai",
    model: "text-model",
    ...(imageModel ? { image_model: imageModel } : {}),
    "openai.base_url": `http://127.0.0.1:${server.port}/v1`,
    "openai.api_key": "k",
    cwd: dir,
    permissions: "allow",
  });
}

test("an attached image goes as a content part, and image_model takes over", async () => {
  agent = create("vision-model");
  await turn(agent, "hello");
  expect(requests[0]!.model).toBe("text-model"); // no image yet

  agent.attachImage(PNG);
  await turn(agent, "what is this?");
  const req = requests[1]!;
  expect(req.model).toBe("vision-model");
  expect(req.messages.at(-1)).toEqual({
    role: "user",
    content: [
      { type: "text", text: "what is this?" },
      { type: "image_url", image_url: { url: PNG_URL } },
    ],
  });
  expect(req.messages[0]).toEqual({ role: "user", content: "hello" }); // earlier text stays plain

  // The image stays in the conversation, so the image model keeps it.
  await turn(agent, "and now?");
  expect(requests[2]!.model).toBe("vision-model");
});

test("without image_model the main model gets the image", async () => {
  agent = create();
  agent.attachImage(PNG, "image/png");
  await turn(agent, "look");
  expect(requests[0]!.model).toBe("text-model");
});

test("an image read by a tool follows the tool results in a user message", async () => {
  agent = create("vision-model");
  const events = await turn(agent, "read it");
  expect(events.find((e) => e.type === "tool_end")).toMatchObject({ name: "read", isError: false });
  const req = requests[1]!;
  expect(req.model).toBe("vision-model");
  const roles = req.messages.map((m) => m.role);
  expect(roles).toEqual(["user", "assistant", "tool", "user"]);
  expect(req.messages[2]!.content).toBe("Image shot.png (png, 1 KB), attached for you to look at.");
  expect(req.messages[3]!.content).toEqual([
    { type: "text", text: "(Images returned by the tool calls above.)" },
    { type: "text", text: "From read (call_r):" },
    { type: "image_url", image_url: { url: PNG_URL } },
  ]);
});

test("web_fetch of an image URL returns the image", async () => {
  const a = Agent.create({ "mock.delay_ms": "0", permissions: "allow" });
  agent = a;
  const events = await turn(a, `!web_fetch {"url":"http://127.0.0.1:${server.port}/img.png"}`);
  const end = events.find((e) => e.type === "tool_end") as Extract<SopeEvent, { type: "tool_end" }>;
  expect(end.result).toMatch(/^Fetched an image from http:\/\/127\.0\.0\.1:\d+\/img\.png \(png, 1 KB\)/);
  const history = JSON.parse(a.history()) as Array<{ role: string; images?: Array<{ media_type: string; data: string }> }>;
  expect(history.find((m) => m.role === "tool")!.images).toEqual([{ media_type: "image/png", data: Buffer.from(PNG).toString("base64") }]);
});

test("attachImage rejects what is not an image", () => {
  agent = create();
  expect(() => agent!.attachImage(new TextEncoder().encode("not an image"))).toThrow(SopeError);
  expect(() => agent!.attachImage(new Uint8Array())).toThrow(/no image data/);
});
