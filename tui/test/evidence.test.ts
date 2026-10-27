// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCommand, type CommandHost } from "../src/commands";
import { loadConfig } from "../src/config";
import { Session } from "../src/session";
import { Store } from "../src/store";
import { formatEvidence } from "../src/ui/evidence";

test("/evidence reads durable executions without a model turn or changing model history", async () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "sope-evidence-ui-")));
  const store = new Store(join(directory, "ui.db"));
  const config = loadConfig({ provider: "mock" }, {}, {});
  let turns = 0;
  let completed = () => {};
  const events: ConstructorParameters<typeof Session>[2] = (_, batch) => {
    for (const event of batch) if (event.type === "turn_end" && !event.agentId) { turns++; completed(); }
  };
  let session = new Session(config, () => "full", events, { store, directory });
  const evidence = () => runCommand({ session } as CommandHost, "/evidence");
  try {
    evidence();
    expect(session.id).toBeNull();
    expect(session.chat.messages.at(-1)?.text).toContain("No completed native executions");
    session.setOption("mock.delay_ms", "0");
    const done = new Promise<void>(resolve => completed = resolve);
    session.send('!bash {"command":"printf evidence-fixture"}');
    await done;
    expect(session.chat.messages.filter(m => m.role === "assistant").every(m => !m.text.includes("Execution evidence"))).toBe(true);
    const before = store.get(session.id!)!;
    const tokens = { ...session.tokens };
    evidence();
    expect(turns).toBe(1);
    expect(session.busy).toBe(false);
    expect(session.tokens).toEqual(tokens);
    const report = session.chat.messages.at(-1)!;
    expect(report.role).toBe("info");
    expect(report.text).toContain("1 retained executions");
    expect(report.text).toContain("process completed (exit 0)");
    expect(report.text).toContain("printf evidence-fixture");
    expect(report.text).toContain("Output archive:");
    session.save();
    expect(store.get(session.id!)!.history).toBe(before.history);
    await session.shutdown();
    session = new Session(config, () => "full", events, { store, directory, stored: store.get(before.id)! });
    evidence();
    expect(session.chat.messages.at(-1)?.text).toBe(report.text);
    expect(turns).toBe(1);
    runCommand({ session } as CommandHost, "/evidence invalid");
    expect(session.chat.messages.at(-1)?.text).toBe("usage: /evidence");
  } finally {
    await session.shutdown();
    store.close();
    rmSync(directory, { recursive: true, force: true });
  }
}, 10000);

test("evidence labels failures and timeouts without claiming tests passed", () => {
  const report = formatEvidence({ session_id: "fixture", agent_id: 0, retention: 32, scope: "historical", receipts: [
    { version: 2, session_id: "fixture", agent_id: 0, call_id: 2, turn_id: 1, tool: "check", input: null, input_omitted: true, cwd: "/workspace", exit_code: 1, outcome: "process_failed", test_verdict: "unverified", output_path: "/output/2.txt" },
    { version: 2, session_id: "fixture", agent_id: 0, call_id: 3, turn_id: 1, tool: "check", input: { argv: ["sleep", "10"] }, cwd: "/workspace", exit_code: 124, outcome: "timed_out", test_verdict: "unverified", output_path: "/output/3.txt" },
  ] });
  expect(report).toContain("process failed (exit 1)");
  expect(report).toContain("timed out (exit 124)");
  expect(report).toContain("omitted from the retained record");
  expect(report).toContain("Exit zero does not establish test success");
});
