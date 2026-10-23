// SPDX-License-Identifier: MIT
// Built-in tools through the bindings: events, permission, web_fetch.
import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type SopeEvent } from "../src/index";

let agent: Agent | null = null;
const dir = realpathSync(mkdtempSync(join(tmpdir(), "sope-js-tools-")));

afterEach(() => {
  agent?.free();
  agent = null;
});

process.on("exit", () => rmSync(dir, { recursive: true, force: true }));

function run(a: Agent, cmd: string, answer?: (e: Extract<SopeEvent, { type: "permission" }>) => void): SopeEvent[] {
  a.send(cmd);
  const events: SopeEvent[] = [];
  for (;;) {
    const ev = a.poll(10000);
    if (!ev) throw new Error("timed out waiting for the turn");
    events.push(ev);
    if (ev.type === "permission") answer?.(ev);
    if (ev.type === "turn_end" && !ev.agentId) return events;
  }
}

const ends = (events: SopeEvent[]) => events.filter((e) => e.type === "tool_end");

test("built-in tools announce themselves and report results", () => {
  agent = Agent.create({ "mock.delay_ms": "0", cwd: dir, permissions: "allow" });
  const events = run(agent, '!write {"file_path":"a.txt","content":"hello\\n"} ;; !todo_write {"todos":[]}');
  const starts = events.filter((e) => e.type === "tool_start");
  expect(starts.map((e) => e.name).sort()).toEqual(["todo_write", "write"]);
  expect(ends(events)).toHaveLength(2);
  expect(ends(events).find((e) => e.name === "write")).toMatchObject({ isError: false, result: "Created a.txt (1 lines)" });
  expect(readFileSync(join(dir, "a.txt"), "utf8")).toBe("hello\n");
  expect(events.some((e) => e.type === "permission")).toBe(false);
});

test("asks before changing things", () => {
  agent = Agent.create({ "mock.delay_ms": "0", cwd: dir });
  let events = run(agent, '!bash {"command":"echo allowed"}', (p) => {
    expect(p.name).toBe("bash");
    expect(JSON.parse(p.input)).toEqual({ command: "echo allowed" });
    agent!.permit(p.callId, true);
  });
  expect(ends(events)[0]).toMatchObject({ name: "bash", isError: false });
  expect(ends(events)[0]!.result).toStartWith("allowed\n");
  expect(ends(events)[0]!.result).toContain("Full output:");
  expect(ends(events)[0]!.result).toEndWith("[exit code 0]");

  events = run(agent, '!bash {"command":"rm -rf /tmp/nothing"}', (p) => agent!.permit(p.callId, false, "too risky"));
  expect(ends(events)[0]!.isError).toBe(true);
  expect(ends(events)[0]!.result).toContain("too risky");
  expect(() => agent!.permit(12345, true)).toThrow(/no tool call 12345/);
});

test("host tools end with tool_end too", () => {
  agent = Agent.create({ "mock.delay_ms": "0", cwd: dir });
  agent.registerTool({ name: "echo", description: "Echo." });
  agent.send("!echo hi");
  const events: SopeEvent[] = [];
  for (;;) {
    const ev = agent.poll(5000)!;
    events.push(ev);
    if (ev.type === "tool_call") agent.toolResult(ev.callId, "echoed");
    if (ev.type === "turn_end") break;
  }
  expect(ends(events)).toEqual([expect.objectContaining({ name: "echo", isError: false, result: "echoed" })]);
});

test("web_fetch turns HTML into text", async () => {
  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === "/old") return Response.redirect("/page", 302);
      if (url.pathname === "/page")
        return new Response(
          "<html><head><title>Docs</title><script>alert(1)</script></head><body><h2>Install</h2>" +
            '<p>Run <code>make</code>, then see <a href="/next">the next page</a>.</p></body></html>',
          { headers: { "content-type": "text/html; charset=utf-8" } },
        );
      if (url.pathname === "/data") return Response.json({ ok: true });
      if (url.pathname === "/big") return new Response("x".repeat(100_000));
      return new Response("nope", { status: 404 });
    },
  });
  try {
    agent = Agent.create({ "mock.delay_ms": "0", cwd: dir, permissions: "allow" });
    const base = `http://127.0.0.1:${server.port}`;
    // The poll loop blocks this thread, so the server needs the event loop: poll without blocking.
    const fetchOnce = async (args: object) => {
      agent!.send(`!web_fetch ${JSON.stringify(args)}`);
      for (;;) {
        const ev = agent!.poll(0);
        if (!ev) {
          await Bun.sleep(5);
          continue;
        }
        if (ev.type === "tool_end") return ev;
      }
    };
    const page = await fetchOnce({ url: `${base}/old` });
    expect(page.isError).toBe(false);
    expect(page.result).toBe(
      `Redirected to: ${base}/page\n\n# Docs\n\n## Install\n\nRun \`make\`, then see [the next page](${base}/next).`,
    );
    expect((await fetchOnce({ url: `${base}/data` })).result).toBe('{"ok":true}');
    const missing = await fetchOnce({ url: `${base}/missing` });
    expect(missing.isError).toBe(true);
    expect(missing.result).toBe("HTTP 404\n\nnope");
    const big = await fetchOnce({ url: `${base}/big`, offset: 80_000 });
    expect(big.result).toContain("[showing bytes 80000-100000 of 100000]");
    expect((await fetchOnce({ url: "ftp://example.com" })).isError).toBe(true);
  } finally {
    server.stop(true);
  }
});
