// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type SopeEvent } from "../src/index";

function drain(agent: Agent): SopeEvent[] {
  const events: SopeEvent[] = [];
  for (;;) {
    const event = agent.poll(5000);
    if (!event) throw new Error("Timed out waiting for completion");
    events.push(event);
    if (event.type === "turn_end" && !event.agentId) {
      expect(event.stopReason).toBe("end_turn");
      return events;
    }
  }
}

test("evidence is read-only, survives compaction/reopen, and never becomes an answer footer", () => {
  const directory = realpathSync(mkdtempSync(join(tmpdir(), "sope-evidence-")));
  const options = { provider: "mock", "mock.delay_ms": "0", permissions: "allow", cwd: directory };
  let agent = Agent.open(directory, options);
  try {
    expect(agent.evidence()).toMatchObject({ agent_id: 0, retention: 32, receipts: [] });
    expect(agent.history()).toBe("[]");
    expect(agent.poll(0)).toBeNull();
    for (const argv of [["printf", "observed output"], ["false"]]) {
      const turn = agent.send(`!check ${JSON.stringify({ argv })}`);
      const events = drain(agent);
      expect(events.filter(e => e.type === "text_delta").map(e => e.text).join("")).not.toContain("Execution evidence");
      expect(agent.outcome(turn).final).not.toContain("Execution evidence");
    }
    const ledger = agent.evidence();
    expect(ledger.receipts.map(r => r.outcome)).toEqual(["process_exited_zero", "process_failed"]);
    expect(ledger.receipts.map(r => r.test_verdict)).toEqual(["unverified", "unverified"]);
    const history = agent.history();
    expect(history).not.toContain("Execution evidence");
    expect(agent.evidence()).toEqual(ledger);
    expect(agent.history()).toBe(history);
    expect(agent.poll(0)).toBeNull();
    // Query even while a new turn is queued/running: it neither waits for nor consumes it.
    agent.send("plain follow-up");
    expect(agent.evidence()).toEqual(ledger);
    const answer = drain(agent).filter(e => e.type === "text_delta").map(e => e.text).join("");
    expect(answer).toStartWith("You said: plain follow-up");
    expect(answer).not.toContain("Execution evidence");
    agent.compact();
    drain(agent);
    expect(agent.evidence()).toEqual(ledger);
    agent.free();
    agent = Agent.open(directory, options);
    expect(agent.evidence()).toEqual(ledger);
    // The AI-facing tool still returns exactly the same ledger.
    agent.send("!evidence {}");
    const result = drain(agent).find(e => e.type === "tool_end" && e.name === "evidence");
    expect(result?.type === "tool_end" && JSON.parse(result.result)).toEqual(ledger);
    agent.reset();
    agent.send("fresh conversation");
    drain(agent);
    expect(agent.evidence().receipts).toEqual([]);
  } finally {
    agent.free();
    rmSync(directory, { recursive: true, force: true });
  }
}, 15000);
