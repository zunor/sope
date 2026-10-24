// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";

test("print auto denial explains the boundary and permits a corrected workspace path", async () => {
  // Auto mode permits OS temp directories, including repositories checked
  // out there. A private home fixture exercises the workspace boundary.
  const dir = mkdtempSync(join(homedir(), ".sope-print-permit-"));
  const cwd = join(dir, "workspace");
  mkdirSync(cwd);
  const outside = join(dir, "report.md");
  let requests = 0;
  let denial = "";
  const server = Bun.serve({ port: 0, async fetch(req) {
    const body = await req.json() as { messages: { role: string; content: string }[] };
    requests++;
    if (requests === 2) denial = body.messages.find((m) => m.role === "tool")?.content ?? "";
    const path = requests === 1 ? outside : join(cwd, "report.md");
    const delta = requests <= 2
      ? { tool_calls: [{ index: 0, id: `write_${requests}`, type: "function", function: {
        name: "write", arguments: JSON.stringify({ file_path: path, content: "verified report" }),
      } }] }
      : { content: "done" };
    const chunk = { choices: [{ index: 0, delta, finish_reason: requests <= 2 ? "tool_calls" : "stop" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
  } });
  const child = Bun.spawn([process.execPath, resolve("tui/src/main.ts"), "-p", "--permissions", "auto",
    "--provider", "openai", "--model", "fixture", "--base-url", `http://127.0.0.1:${server.port}/v1`, "write report"], {
    cwd, env: { ...process.env, SOPE_API_KEY: "fixture", SOPE_LIB: process.env.SOPE_LIB || resolve("build/libsope." + (process.platform === "darwin" ? "dylib" : "so")) },
    stdin: "ignore", stdout: "ignore", stderr: "ignore",
  });
  try {
    expect(await Promise.race([child.exited, Bun.sleep(5000).then(() => "timeout")])).toBe(0);
    expect(requests).toBe(3);
    expect(denial).toContain("outside the working directory");
    expect(denial).toContain(outside);
    expect(existsSync(outside)).toBe(false);
    expect(readFileSync(join(cwd, "report.md"), "utf8")).toBe("verified report");
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 10000);
