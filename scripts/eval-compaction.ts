#!/usr/bin/env bun
// SPDX-License-Identifier: MIT
// Opt-in, paid live-model evaluation. Only synthetic fixtures leave the host.
import { mkdirSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { Agent, type SopeEvent } from "../bindings/js/src";
import { loadConfig } from "../tui/src/config";

const args = process.argv.slice(2);
if (args.includes("--help")) {
  console.log("bun scripts/eval-compaction.ts [output-directory] [--quick|--provenance]\nUses SOPE configuration and makes paid real-model calls. --quick skips interruption/failure/cancellation probes.\n--provenance tests unverified constraints and a conflicting assistant claim across two summaries.\nWrites synthetic histories, model responses and exact-match checks; never API keys.");
  process.exit(0);
}
const config = loadConfig();
if (config.provider !== "openai" || !config.apiKey) throw new Error("Configure SOPE_API_KEY and the openai provider first");
const output = resolve(args.find((s) => !s.startsWith("--")) ?? `build/live-compaction-${Date.now()}`);
mkdirSync(output, { recursive: true });
const goal = ["PROJECT-COPPER", "NO_PROD_WRITE", "KEEP_ABI_V7", "NO_DEPENDENCIES", "P95_LE_180MS"];
const evidence = [
  ["schema/copper.sql", "BASELINE_ROWS=7319", "SNAPSHOT=amber-42"],
  ["checks/ordering.test", "FAILURE=cursor-skips-17", "REPRO_SEED=90173"],
  ["patch/cursor.c", "FIX=compare-epoch-before-offset", "REGRESSION=48/48"],
  ["reports/perf.json", "P95=172ms", "DECISION=offline-ready"],
];
const fixtures = evidence.map(([head, middle, tail], i) => {
  const noise = Array.from({ length: 180 }, (_, j) => `phase=${i + 1} batch=${j} routine scan completed; temporary samples discarded; no decision in this row.\n`).join("");
  return `PHASE ${i + 1} evidence source: ${head}\n${noise}\nIMPORTANT VERIFIED RESULT: ${middle}\n${noise}\nFINAL RESULT: ${tail}\nPHASE_COMPLETE=${i + 1}; NEXT_PHASE=${i === 3 ? "none; give the final report" : i + 2}\n`;
});
const report: {
  model: string; started: string; requests: unknown[]; turns: unknown[]; checkpoints: unknown[];
  checks: { name: string; pass: boolean; detail?: unknown }[];
} = { model: config.model, started: new Date().toISOString(), requests: [], turns: [], checkpoints: [], checks: [] };
const save = () => writeFileSync(`${output}/report.json`, JSON.stringify(report, null, 2));
function check(name: string, pass: boolean, detail?: unknown) {
  report.checks.push({ name, pass, detail }); save();
  console.log(`${pass ? "PASS" : "FAIL"} ${name}${detail ? ` ${JSON.stringify(detail)}` : ""}`);
}
let fault: "none" | "truncate" | "cancel" = "none";
let pendingCancel: (() => void) | undefined;
let compactCount = 0;
const controllers = new Set<AbortController>();
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, idleTimeout: 255, async fetch(req) {
  const body = await req.json() as { messages: { role: string; content: unknown }[] };
  const compaction = String(body.messages[0]?.content).startsWith("You summarize conversations");
  const injection = compaction ? fault : "none";
  if (compaction) fault = "none";
  const id = report.requests.length + 1;
  const trace = { id, compaction, injection, request: body, response: "", status: 0, elapsedMs: 0 };
  report.requests.push(trace); save();
  console.log(`request ${id}: ${compaction ? "summary" : "task"}${injection !== "none" ? ` (${injection})` : ""}`);
  const started = Date.now();
  const controller = new AbortController(); controllers.add(controller);
  // Reasoning models can legitimately take several minutes at a busy endpoint.
  const timer = setTimeout(() => controller.abort(), 360_000);
  try {
    const response = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
      method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify(body), signal: controller.signal,
    });
    trace.status = response.status;
    if (injection === "cancel") {
      trace.elapsedMs = Date.now() - started; save();
      pendingCancel?.(); controller.abort(); return new Response("", { status: 499 });
    }
    trace.response = await response.text();
    trace.elapsedMs = Date.now() - started; save();
    // Use actual model content, then simulate a broken transport before its finish/DONE.
    const returned = injection === "truncate" ? trace.response.split("\n").filter((line) =>
      !line.includes("[DONE]") && !/"finish_reason"\s*:\s*"/.test(line)).join("\n") : trace.response;
    return new Response(returned, { status: response.status, headers: { "content-type": "text/event-stream" } });
  } catch {
    trace.elapsedMs = Date.now() - started; save();
    return Response.json({ error: { message: "live evaluation upstream failed or was cancelled" } }, { status: 502 });
  } finally { clearTimeout(timer); controllers.delete(controller); }
} });

const agents: Agent[] = [];
function create() {
  const a = Agent.create({ provider: "openai", model: config.model,
    "openai.base_url": `http://127.0.0.1:${server.port}`, "compact.threshold": "6000",
    "compact.max_tokens": "2048", "compact.input_tokens": "64000", "compact.retain_tokens": "800",
    "openai.max_tokens": "4096", max_rounds: "10", permissions: "ask",
    system: "You are an evidence-based engineering assistant in a synthetic evaluation. Use only read_phase. Never run shell commands, access files or delegate. Preserve exact task constraints and verified evidence. Keep replies concise."
  });
  a.registerTool({ name: "read_phase", description: "Read a synthetic investigation phase, sequentially, once per phase.",
    inputSchema: { type: "object", properties: { phase: { type: "integer", minimum: 1, maximum: 4 } }, required: ["phase"], additionalProperties: false } });
  agents.push(a); return a;
}
const executed: number[] = [];
async function drain(a: Agent, label: string, allowTools = false) {
  const events: SopeEvent[] = [];
  const deadline = Date.now() + 900_000;
  while (Date.now() < deadline) {
    const e = a.poll(0);
    if (!e) { await Bun.sleep(10); continue; }
    if (e.type === "thinking_delta" || e.type === "text_delta") {
      const last = events.at(-1);
      if (last?.type === e.type) { last.text += e.text; continue; }
    }
    events.push(e);
    if (e.type === "permission") { a.permit(e.callId, false, "Only the synthetic read_phase host tool is allowed"); }
    if (e.type === "tool_call") {
      const phase = Number(JSON.parse(e.input).phase);
      if (!allowTools || e.name !== "read_phase" || phase !== executed.length + 1 || !fixtures[phase - 1]) {
        a.toolResult(e.callId, "Invalid or repeated phase; do not retry. Report the evidence already available.", true);
        check(`${label}: valid unique tool call`, false, { name: e.name, phase });
      } else { executed.push(phase); a.toolResult(e.callId, fixtures[phase - 1]!); }
    }
    if (e.type === "compact") {
      compactCount++;
      const expected = [...goal, ...evidence.slice(0, executed.length).flat()];
      const missing = expected.filter((s) => !e.summary.includes(s));
      report.checkpoints.push({ label, number: compactCount, summary: e.summary, missing });
      check(`${label}: checkpoint ${compactCount} evidence`, missing.length === 0, { missing });
      // Stop an unfinished task after its second committed checkpoint. The
      // next agent must recover progress without being told any original facts.
      if (allowTools && compactCount === 2 && !args.includes("--quick")) a.cancel();
    }
    if (e.type === "turn_end" && e.agentId === 0) {
      report.turns.push({ label, events }); save();
      return { stop: e.stopReason, text: events.flatMap((x) => x.type === "text_delta" ? [x.text] : []).join("") };
    }
  }
  a.cancel(); throw new Error(`${label} timed out`);
}
const expected = [...goal, ...evidence.flat()];
function recall(label: string, text: string) {
  const missing = expected.filter((s) => !text.includes(s));
  check(`${label}: original goal, all constraints and evidence`, missing.length === 0, { missing });
}
async function provenance() {
  let a = create();
  a.setOption("compact.retain_tokens", "0");
  a.loadHistory(JSON.stringify([
    { role: "user", content: "Investigate offline migration readiness for PROJECT-COPPER. Binding requirements: NO_PROD_WRITE means never write production; KEEP_ABI_V7 means preserve ABI version 7; NO_DEPENDENCIES means add no dependencies; P95_LE_180MS means p95 must not exceed 180 ms. Report what is verified and what still needs verification." },
    { role: "assistant", content: "", tool_uses: [{ id: "audit", name: "read_phase", input: '{"phase":4}' }] },
    { role: "tool", tool_use_id: "audit", name: "read_phase", content: evidence.map((row) => row.join("\n")).join("\n") + "\nABI_AUDIT=not-run\nDEPENDENCY_AUDIT=not-run\nPRODUCTION_WRITES=0\nThe readiness label is the tool's recorded decision, not proof of the unperformed audits." },
    // This unsupported ABI claim was observed in the long-task model output.
    { role: "assistant", content: "The migration design preserved the v7 ABI (snapshot amber-42 over BASELINE_ROWS=7319), ran offline (no production write path exercised), and introduced no new dependencies." },
  ]));
  for (let i = 1; i <= 2; i++) {
    a.compact();
    const result = await drain(a, `provenance-${i}`);
    check(`provenance-${i}: complete summary`, result.stop === "end_turn");
    recall(`provenance-${i}`, a.history());
    check(`provenance-${i}: unperformed audits retained`, ["ABI_AUDIT=not-run", "DEPENDENCY_AUDIT=not-run"].every((s) => a.history().includes(s)));
    const saved = a.history(); a.free(); a = create(); a.setOption("compact.retain_tokens", "0"); a.loadHistory(saved);
  }
  a.send('Using only the saved evidence, distinguish binding requirements, tool-verified findings and unsupported assistant claims. Return only a JSON object with keys abi_verified (boolean), dependencies_verified (boolean), latency_verified (boolean), production_writes (number), p95_ms (number), p95_limit_ms (number). No tools.');
  const result = await drain(a, "provenance-recall");
  check("provenance-recall: completed", result.stop === "end_turn");
  let answer: unknown;
  try { answer = JSON.parse(result.text.slice(result.text.indexOf("{"), result.text.lastIndexOf("}") + 1)); } catch { answer = result.text; }
  const wanted = { abi_verified: false, dependencies_verified: false, latency_verified: true, production_writes: 0, p95_ms: 172, p95_limit_ms: 180 };
  check("provenance-recall: requirements and claims were not promoted to verification", typeof answer === "object" && answer !== null && Object.entries(wanted).every(([k,v]) => (answer as Record<string,unknown>)[k] === v), answer);
}
async function longTask() {
  let a = create();
  a.send(`Investigate offline migration readiness for PROJECT-COPPER. This is a four-phase task. Constraints, all binding: NO_PROD_WRITE (never write production); KEEP_ABI_V7 (preserve ABI version 7); NO_DEPENDENCIES (add no dependencies); P95_LE_180MS (p95 must not exceed 180 ms). Call read_phase for phases 1 through 4 sequentially, exactly once each. Finish all four before the final report. Each result has a source path and important verified evidence that can occur anywhere in its log; retain every such value exactly. At the end report the original goal, all four constraint identifiers, every source path and verified value from every phase, distinguish the earlier failure from the later fix, and state the readiness decision. Do not invent missing facts.`);
  let result = await drain(a, "long-task", true);
  if (!args.includes("--quick")) {
    check("mid-task: cancelled after second checkpoint", result.stop === "cancelled" && executed.length === 2);
    const unfinished = a.history(); writeFileSync(`${output}/unfinished-history.json`, unfinished); a.free();
    a = create(); a.loadHistory(unfinished);
    check("mid-task: exact restore", a.history() === unfinished);
    a.send("Continue the unfinished original task from the saved conversation. Do not repeat completed phases. Complete the remaining phases and give the requested final report; preserve the original constraints and verified results.");
    result = await drain(a, "resumed-task", true);
  }
  check("long-task: finished", result.stop === "end_turn", { stop: result.stop });
  check("long-task: four phases executed once", executed.join(",") === "1,2,3,4", executed);
  check("long-task: repeated automatic compaction", compactCount >= 3, { compactCount });
  recall("long-task", result.text);
  const saved = a.history(); writeFileSync(`${output}/saved-history.json`, saved); a.free();
  a = create(); a.loadHistory(saved);
  check("restore: exact history round trip", a.history() === saved);
  if (!args.includes("--quick")) {
    fault = "truncate";
    a.compact();
    const failed = await drain(a, "broken-stream");
    check("broken-stream: error and original history retained", failed.stop === "error" && a.history() === saved);
    fault = "cancel"; pendingCancel = () => a.cancel();
    a.compact();
    const cancelled = await drain(a, "cancelled-summary");
    check("cancel: original history retained", cancelled.stop === "cancelled" && a.history() === saved);
    pendingCancel = undefined;
    a.compact();
    const recovered = await drain(a, "recovered-summary");
    check("recovery: successful checkpoint after failure and cancellation", recovered.stop === "end_turn");
    const recoveredHistory = a.history(); a.free(); a = create(); a.loadHistory(recoveredHistory);
  }
  a.send("Resume from the saved conversation without calling any tools. Report the original goal, every binding constraint identifier, every source path and important verified result across all phases with their exact values. Distinguish initial failure and subsequent fix; state the final readiness decision. If anything is unavailable say so; never guess.");
  const resumed = await drain(a, "restored-recall");
  check("restored-recall: finished", resumed.stop === "end_turn");
  recall("restored-recall", resumed.text);
}
try {
  if (args.includes("--provenance")) await provenance();
  else await longTask();
} finally {
  for (const a of agents) a.free();
  for (const c of controllers) c.abort();
  server.stop(true); save();
  console.log(`Evidence: ${output}/report.json`);
}
process.exitCode = report.checks.every((c) => c.pass) ? 0 : 1;
