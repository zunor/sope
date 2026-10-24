// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Session } from "../src/session";
import { loadConfig } from "../src/config";

const delta = (text: string, finish: string | null = null) =>
  `data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: text }, finish_reason: finish }] })}\n\n`;
function fixture() {
  let attempts = 0;
  return Bun.serve({ port: 0, fetch() { return new Response(++attempts === 1 ? delta("abandoned") : delta("accepted", "stop") + "data: [DONE]\n\n"); } });
}

test("TUI separates an abandoned stream from the accepted attempt", async () => {
  const server = fixture();
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
  } finally { await session.shutdown(); server.stop(true); }
});

test("print output includes the discard marker even when stderr is separate", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sope-retry-print-"));
  const server = fixture();
  const child = Bun.spawn([process.execPath, resolve("tui/src/main.ts"), "-p", "--provider", "openai", "--model", "fixture", "--base-url", `http://127.0.0.1:${server.port}`, "test"], {
    cwd: dir, env: { ...process.env, SOPE_API_KEY: "fixture", SOPE_LIB: process.env.SOPE_LIB || resolve(`build/libsope.${process.platform === "darwin" ? "dylib" : "so"}`) },
    stdin: "ignore", stdout: "pipe", stderr: "pipe",
  });
  try {
    const [out, err, status] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
    expect(status).toBe(0);
    expect(out).toMatch(/abandoned\n\[Model request interrupted[\s\S]*discarded\.\]\naccepted/);
    expect(err).toContain("retrying attempt 2");
  } finally { child.kill(); await child.exited; server.stop(true); rmSync(dir, { recursive: true, force: true }); }
});
