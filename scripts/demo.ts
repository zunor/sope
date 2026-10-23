#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// English demos with real libsope tools and TUI, in a disposable workspace.
// Configured credentials select GLM 5.3; --offline uses a scripted local model.
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { loadConfig } from "../tui/src/config";
import { findLibrary } from "../bindings/js/src/ffi";
import { Store, type SavedMessage } from "../tui/src/store";

const prompts = {
  tour: "Explore Lumen\nGive me a concise tour of this project.",
  edit: "Bound the backoff\nCap the retry delay at two seconds, then verify the change.",
  review: "Review the policy\nReview the retry policy from two independent angles.",
} as const;
type Scenario = keyof typeof prompts;
type Message = { role: string; content?: string | null; tool_call_id?: string };
type ToolCall = { id: string; name: string; input: Record<string, unknown> };

const args = process.argv.slice(2);
const usage = "Usage: bun run demo [tour|edit|review] [--print] [--live|--offline] [--auto]";
if (args.includes("--help")) {
  console.log(`${usage}\n\nDefault: GLM 5.3 when an API key is configured; otherwise a scripted local model.\n--live: require your configured endpoint and API key (makes real API calls).\n--offline: force the scripted local model; no API key or external requests.\n--auto: approve ordinary fixture edits and tests without a dialog.\n--print: run without a terminal. Interactive runs open four conversations.`);
  process.exit(0);
}
const scenario = (args.find((arg) => !arg.startsWith("--")) ?? "tour") as Scenario;
if (!Object.hasOwn(prompts, scenario) || args.filter((arg) => !arg.startsWith("--")).length > 1
  || args.some((arg) => arg.startsWith("--") && !["--print", "--live", "--offline", "--auto"].includes(arg))
  || (args.includes("--live") && args.includes("--offline"))) {
  console.error(usage);
  process.exit(2);
}
const print = args.includes("--print");
const configured = args.includes("--offline") ? null : loadConfig({ provider: "openai", model: "glm-5.3" });
if (args.includes("--live") && !configured?.apiKey) {
  console.error("The live demo needs SOPE_API_KEY in .env, the environment, or your sope config.");
  process.exit(2);
}
const live = configured?.apiKey ? configured : null;
let demoFailed = false;
if (!print && (!process.stdin.isTTY || !process.stdout.isTTY)) {
  console.error("Open this demo in a terminal, or add --print.");
  process.exit(2);
}
const library = resolve(findLibrary());
const scratch = mkdtempSync(join(tmpdir(), "sope-demo-"));
const workspace = join(realpathSync(scratch), "lumen");
mkdirSync(join(workspace, "src"), { recursive: true });
writeFileSync(join(workspace, "README.md"), `# Lumen

A small retry policy for a thoughtful HTTP client.

- src/retry.ts: pure delay calculation, with exponential backoff.
- src/retry.test.ts: fast, deterministic policy tests.
- Run the suite with bun test.

Demo fixture for sope. The retry tests do not make network requests.
`);
writeFileSync(join(workspace, "src/retry.ts"), `/** Exponential backoff, starting at 250 ms. */
export function retryDelay(attempt: number): number {
  return 250 * 2 ** Math.max(0, attempt);
}
`);
writeFileSync(join(workspace, "src/retry.test.ts"), `import { expect, test } from "bun:test";
import { retryDelay } from "./retry";

test("starts gently", () => expect(retryDelay(0)).toBe(250));
test("backs off exponentially", () => expect(retryDelay(2)).toBe(1000));
test("treats negative attempts as zero", () => expect(retryDelay(-1)).toBe(250));
`);

const call = (id: string, name: string, input: Record<string, unknown>): ToolCall => ({ id, name, input });
function response(messages: Message[]): { text: string; calls?: ToolCall[] } {
  const userIndex = messages.findLastIndex((m) => m.role === "user");
  const prompt = messages[userIndex]?.content ?? "";
  const results = messages.slice(userIndex + 1).filter((m) => m.role === "tool");
  const has = (id: string) => results.some((m) => m.tool_call_id === id);
  const result = (id: string) => results.find((m) => m.tool_call_id === id)?.content ?? "";
  if (results.some((m) => /denied|cancelled|not permitted/i.test(m.content ?? ""))) {
    return { text: "Permission was declined. I have stopped this demo without retrying the action." };
  }
  if (prompt.startsWith("REVIEW:")) {
    if (!has("inspect")) return { text: "I will inspect the policy and its tests.", calls: [call("inspect", "read", { file_path: prompt.includes("coverage") ? "src/retry.test.ts" : "src/retry.ts" })] };
    return { text: prompt.includes("coverage")
      ? "Coverage: the tests cover the starting delay, growth, and negative inputs. Add an upper-bound test so large attempt counts cannot cause excessive waits."
      : "Behavior: delay grows without a ceiling. Cap it at 2,000 ms; keep the existing 250 ms starting point and exponential growth." };
  }
  if (/review|independent/i.test(prompt)) {
    if (!has("behavior")) return { text: "I will split this into behavior and test coverage, with an independent reader for each.\n\n", calls: [
      call("behavior", "agent", { description: "Retry behavior", prompt: "REVIEW: Inspect retry behavior in src/retry.ts. Keep your report concise.", subagent_type: "general-purpose" }),
      call("coverage", "agent", { description: "Test coverage", prompt: "REVIEW: Inspect test coverage in src/retry.test.ts. Keep your report concise.", subagent_type: "general-purpose" }),
    ] };
    return { text: "## Two perspectives. One small fix.\n\n**Behavior** — exponential backoff has no upper bound.\n**Coverage** — the suite does not assert a maximum delay.\n\nCap the delay at **2,000 ms** and add a regression test for a large attempt count. The public API can stay exactly as it is.\n\nNo files changed." };
  }
  if (/cap|delay|change/i.test(prompt)) {
    if (!has("read-source")) return { text: "I will read the policy and tests, make the smallest change, then run the suite.\n\n", calls: [
      call("read-source", "read", { file_path: "src/retry.ts" }),
      call("read-tests", "read", { file_path: "src/retry.test.ts" }),
    ] };
    if (!has("cap-delay")) return { text: "The delay doubles correctly; it just needs a ceiling. Here is the proposed change.\n\n", calls: [call("cap-delay", "edit", {
      file_path: "src/retry.ts", old_string: "return 250 * 2 ** Math.max(0, attempt);", new_string: "return Math.min(2_000, 250 * 2 ** Math.max(0, attempt));",
    })] };
    if (!has("add-test")) return { text: "I will lock in the upper bound with a regression test.\n\n", calls: [call("add-test", "edit", {
      file_path: "src/retry.test.ts", old_string: 'test("starts gently", () => expect(retryDelay(0)).toBe(250));',
      new_string: 'test("starts gently", () => expect(retryDelay(0)).toBe(250));\ntest("caps long waits", () => expect(retryDelay(12)).toBe(2000));',
    })] };
    if (!has("test")) return { text: "Now I will run the tests.\n\n", calls: [call("test", "bash", { command: "bun test", description: "Verify the retry policy" })] };
    const passed = /\b4 pass\b/.test(result("test")) && /\[exit code 0\]/.test(result("test"));
    if (!passed) {
      demoFailed = true;
      if (print) console.error(result("test"));
    }
    return { text: passed
      ? "## A ceiling, without changing the rhythm.\n\nThe delay is now **250 → 500 → 1,000 → 2,000 ms**, then stays at two seconds.\n\n- Updated `src/retry.ts` with a single bounded expression.\n- Added a regression test for large attempt counts.\n- **4 tests passed.** No new dependencies; the API is unchanged."
      : "The test command finished. Please inspect its output above; the demo did not observe the expected four passing tests." };
  }
  if (!has("files")) return { text: "I will follow the code from the public function to the tests.\n\n", calls: [call("files", "glob", { pattern: "**/*" })] };
  if (!has("source")) return { text: "", calls: [call("source", "read", { file_path: "src/retry.ts" })] };
  return { text: "## Small surface. Clear responsibilities.\n\n**Lumen** is a tiny retry policy for an HTTP client.\n\n- `src/retry.ts` owns the delay calculation: a pure function, no I/O.\n- `src/retry.test.ts` covers the starting delay, growth, and negative inputs.\n- `README.md` is the entry point; `bun test` runs the suite.\n\n```ts\nretryDelay(0)  // 250 ms\nretryDelay(2)  // 1,000 ms\n```\n\n**A useful next step:** cap long waits at two seconds and add a regression test.\n\nNo files changed." };
}

const token = crypto.randomUUID();
const server = live ? null : Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  async fetch(req) {
    if (req.headers.get("authorization") !== `Bearer ${token}`) return new Response("Unauthorized", { status: 401 });
    const path = new URL(req.url).pathname;
    if (path === "/v1/models") return Response.json({ data: [{ id: "sope-demo", context_length: 32000 }] });
    if (path !== "/v1/chat/completions" || req.method !== "POST") return new Response("Not found", { status: 404 });
    const body = await req.json() as { messages: Message[] };
    const next = response(body.messages);
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      async start(controller) {
        const emit = (delta: object, finish: string | null = null) => controller.enqueue(encoder.encode(`data: ${JSON.stringify({ choices: [{ index: 0, delta, finish_reason: finish }] })}\n\n`));
        try {
          emit({ role: "assistant" });
          for (const part of next.text.match(/.{1,18}(?:\s|$)|.{1,18}/gs) ?? []) {
            emit({ content: part });
            if (!print) await Bun.sleep(24);
          }
          if (next.calls) emit({ tool_calls: next.calls.map((c, index) => ({ index, id: c.id, type: "function", function: { name: c.name, arguments: JSON.stringify(c.input) } })) });
          emit({}, next.calls ? "tool_calls" : "stop");
          controller.enqueue(encoder.encode("data: [DONE]\n\n"));
          controller.close();
        } catch { /* The user may cancel a streamed turn. */ }
      },
    });
    return new Response(stream, { headers: { "content-type": "text/event-stream" } });
  },
});
const env: Record<string, string> = {};
for (const key of ["PATH", "HOME", "TERM", "COLORTERM", "TERM_PROGRAM", "LANG", "LC_ALL", "TMPDIR", "SOPE_TRUECOLOR", "SOPE_GRAPHICS"]) {
  if (process.env[key]) env[key] = process.env[key]!;
}
Object.assign(env, {
  SOPE_DB: join(scratch, "sessions.db"), XDG_CONFIG_HOME: join(scratch, "config"),
  SOPE_LIB: library, SOPE_API_KEY: live?.apiKey ?? token, SOPE_COMPACT_THRESHOLD: "0", SOPE_IMAGE_MODEL: "off",
});
if (live) {
  for (const key of ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "all_proxy", "no_proxy", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE"]) {
    if (process.env[key]) env[key] = process.env[key]!;
  }
} else {
  env.NO_PROXY = env.no_proxy = "127.0.0.1,localhost";
}
// Populate the tab bar through the normal persistence API. These are explicitly
// scripted conversations, not fabricated tool executions or test results.
if (!print) {
  const store = new Store(env.SOPE_DB);
  const conversations = [
    {
      title: "Project notes",
      prompt: "Outline the design of this small client library.",
      answer: "## One function. One responsibility.\n\nLumen keeps its retry policy separate from network I/O.\n\n- **Policy:** calculate the delay for an attempt.\n- **Transport:** decide when to retry a request.\n- **Tests:** check the policy without timers or network calls.\n\nKeep the public surface small: `retryDelay(attempt)` returns milliseconds. A caller can supply its own scheduler and cancellation behavior.",
    },
    {
      title: "Test strategy",
      prompt: "Suggest a focused test plan for bounded exponential backoff.",
      answer: "## Test the boundaries. Keep the suite fast.\n\n1. The first attempt starts at **250 ms**.\n2. Early attempts double the delay.\n3. Large attempt counts stop at **2,000 ms**.\n4. Negative attempts behave like zero.\n\nUse direct assertions against the pure function; no sleeps, mocks, or external services are needed.\n\nThis is a proposed test plan. The active coding demo will make the change and run the suite.",
    },
    {
      title: "Release checklist",
      prompt: "Prepare a short release checklist for this change.",
      answer: "## A small change, ready to verify.\n\n- Inspect the one-line policy diff.\n- Add a regression test for the upper bound.\n- Run the complete local test suite.\n- Confirm the function signature is unchanged.\n- Describe the behavior change in the release notes.\n\n**Draft release note**\n\nRetry delays now stop growing after two seconds, preserving the existing 250 ms starting point and exponential progression.\n\nNothing has been published. Complete the checks before using this draft.",
    },
  ];
  try {
    conversations.forEach(({ title, prompt, answer }, index) => {
      const id = crypto.randomUUID();
      const now = Date.now() - (conversations.length - index) * 1000;
      const messages: SavedMessage[] = [
        { role: "user", text: prompt },
        { role: "assistant", text: answer },
      ];
      const history = JSON.stringify(messages.map(({ role, text }) => ({ role, content: text })));
      store.create(id, workspace, title, now);
      store.save(id, { title, history, tokensIn: 0, tokensOut: 0, context: 0 },
        new Map(messages.map((message, seq) => [seq, message])), messages.length, now);
    });
  } finally {
    store.close();
  }
}
const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../tui/src/main.ts"),
  "--provider", "openai", "--base-url", live?.baseUrl ?? `http://127.0.0.1:${server!.port}/v1`, "--model", live?.model ?? "sope-demo",
  "--permissions", print || args.includes("--auto") ? "auto" : "ask", ...(print ? ["--print"] : []),
  prompts[scenario] + (live ? "\nReply in English. Work only in this Lumen fixture. Use relative file paths in tool calls. Read the source and tests first; keep changes focused and run bun test when editing. Finish with a concise summary of the actual changes and test results." : ""),
], { cwd: workspace, env, stdin: "inherit", stdout: "inherit", stderr: "inherit" });
for (const signal of ["SIGTERM", "SIGHUP", "SIGINT"] as const) process.on(signal, () => child.kill(signal === "SIGINT" ? "SIGTERM" : signal));
try {
  process.exitCode = (await child.exited) || (demoFailed ? 1 : 0);
} finally {
  server?.stop(true);
  rmSync(scratch, { recursive: true, force: true });
}
