// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Session } from "../src/session";
import { loadConfig } from "../src/config";

const delta = (text: string, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] })}\n\n`;
function fixture(invalidBatch = false) {
  let attempts = 0;
  const rejected = delta("abandoned") + (invalidBatch
    ? `data: ${JSON.stringify({choices: [{delta: {tool_calls: [{index: 0, id: "bad", function: {name: "bash", arguments: "{"}}]}, finish_reason: "tool_calls"}]})}\n\ndata: [DONE]\n\n` : "");
  return Bun.serve({ port: 0, fetch() { return new Response(++attempts === 1 ? rejected : delta("accepted", "stop") + "data: [DONE]\n\n"); } });
}

for (const invalidBatch of [false, true]) test(`TUI separates abandoned output and shows retry diagnostics (invalid batch: ${invalidBatch})`, async () => {
  const server = fixture(invalidBatch);
  let finish!: () => void;
  const done = new Promise<void>(resolve => { finish = resolve; });
  const session = new Session(loadConfig({ provider: "openai", model: "fixture", baseUrl: `http://127.0.0.1:${server.port}` }, {}, {}), () => "auto", (_s, events) => {
    if (events.some(e => e.type === "turn_end" && !e.agentId)) finish();
  });
  try {
    session.setOption("openai.retry_delay_ms", "10");
    session.send("test retry display");
    expect(await Promise.race([done.then(() => true), Bun.sleep(3000).then(() => false)])).toBe(true);
    const messages = session.chat.messages;
    const rejected = messages.findIndex(m => m.role === "assistant" && m.text === "abandoned");
    const notice = messages.findIndex(m => m.role === "info" && m.text.includes("discarded"));
    const accepted = messages.findIndex(m => m.role === "assistant" && m.text === "accepted");
    expect(rejected).toBeGreaterThanOrEqual(0);
    expect(notice).toBeGreaterThan(rejected);
    expect(accepted).toBeGreaterThan(notice);
    expect(messages[rejected]!.streaming).toBe(false);
    if (invalidBatch) {
      expect(messages[notice]!.text).toContain("tool_calls[0]: arguments are not valid JSON");
      expect(messages[notice]!.text).toContain("rejected batch not executed");
      expect(messages[notice]!.text).not.toMatch(/[\u4e00-\u9fff]/);
    }
  } finally { await session.shutdown(); server.stop(true); }
});

for (const invalidBatch of [false, true]) test(`print output retains retry diagnostics when stderr is separate (invalid batch: ${invalidBatch})`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sope-retry-print-"));
  const server = fixture(invalidBatch);
  const child = Bun.spawn([process.execPath, resolve("tui/src/main.ts"), "-p", "--provider", "openai", "--model", "fixture", "--base-url", `http://127.0.0.1:${server.port}`, "test"], {
    cwd: dir, env: { ...process.env, SOPE_API_KEY: "fixture", SOPE_LIB: process.env.SOPE_LIB || resolve(`build/libsope.${process.platform === "darwin" ? "dylib" : "so"}`) },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  try {
    const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(status).toBe(0);
    expect(out).toMatch(/abandoned\n\[Model request interrupted[\s\S]*discarded\.\]\naccepted/);
    expect(err).toContain("retrying attempt 2");
    if (invalidBatch) {
      expect(err).toContain("tool_calls[0]: arguments are not valid JSON");
      expect(err).toContain("rejected batch not executed");
      expect(err).not.toMatch(/[\u4e00-\u9fff]/);
    }
  } finally { child.kill(); await child.exited; server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});
