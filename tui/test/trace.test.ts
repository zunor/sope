// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ExecutionTrace } from "../src/agent/trace";

const origin = { agentId: 0, turnId: 1, sequence: 7 };
test("trace correlates parallel spans without persisting payloads or token events", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sope-trace-"));
  try {
    const trace = new ExecutionTrace(dir);
    trace.event({ ...origin, type: "turn_start" });
    for (const agentId of [0, 9]) trace.event({ ...origin, agentId, type: "tool_start", callId: 4, name: "bash", input: "secret-input" });
    for (let i = 0; i < 10000; i++) trace.event({ ...origin, type: "thinking_delta", text: "secret-thought" });
    trace.event({ ...origin, type: "log", level: "debug", message: "secret-log" });
    trace.event({ ...origin, type: "error", code: -1, message: "secret-error" });
    trace.event({ ...origin, type: "log", level: "debug", message: JSON.stringify({ event: "provider.start", round: 1, compaction: 0, attempt: 1, status: 0, elapsed_ms: 0, request_bytes: 123, received_bytes: 0, complete: 0, failed: 0, finish_state: 2, stream_done: 0, failure_kind: 2, delay_ms: 900, remaining_ms: 2000, logical_ms: 30, text_bytes: 0, thinking_bytes: 42, tool_calls: 1, tool_argument_bytes: 256, secret: "secret-provider" }) });
    for (const agentId of [9, 0]) trace.event({ ...origin, agentId, type: "tool_end", callId: 4, name: "bash", result: "secret-result", isError: false });
    trace.event({ ...origin, type: "turn_end", stopReason: "end_turn" });
    await trace.close();
    const raw = readFileSync(trace.path, "utf8");
    expect(raw).not.toContain("secret");
    const rows = raw.trim().split("\n").map((line) => JSON.parse(line));
    expect(rows).toHaveLength(10);
    expect(rows.find(r => r.type === "provider.start")).toMatchObject({ finish_state: 2, stream_done: 0, failure_kind: 2, delay_ms: 900, remaining_ms: 2000, logical_ms: 30, thinking_bytes: 42, tool_argument_bytes: 256 });
    expect(rows.filter((r) => r.type === "tool_end").every((r) => r.durationMs >= 0 && !r.unmatched)).toBe(true);
    expect(rows.at(-1)).toMatchObject({ type: "trace.end", activeSpans: 0, thinkingBytes: 140000 });
    expect(statSync(trace.path).mode & 0o777).toBe(0o600);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("trace has a bounded file and an explicit limit marker", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sope-trace-"));
  try {
    let warnings = 0;
    const trace = new ExecutionTrace(dir, 2048, () => warnings++);
    for (let i = 0; i < 10000; i++) trace.event({ ...origin, type: "usage", inputTokens: i, outputTokens: i });
    await trace.close();
    const raw = readFileSync(trace.path, "utf8");
    expect(Buffer.byteLength(raw)).toBeLessThanOrEqual(2048);
    expect(raw).toContain('"type":"trace.limit"');
    expect(warnings).toBe(1);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("slow trace output drops bounded records and reports the gap", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sope-trace-"));
  try {
    const trace = new ExecutionTrace(dir);
    for (let i = 0; i < 10000; i++) trace.event({ ...origin, type: "usage", inputTokens: i, outputTokens: i });
    await trace.close();
    const rows = readFileSync(trace.path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    expect(rows.some((r) => r.type === "trace.gap" && r.count > 0)).toBe(true);
    expect(rows.length).toBeLessThan(2000);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("trace identifies repeated read ranges and closure without exposing paths or summaries", async()=>{
 const dir=mkdtempSync(join(tmpdir(),"sope-trace-"));
 try {
  const trace=new ExecutionTrace(dir);
  const emit=(callId:number,input:object)=>trace.event({...origin,type:"tool_start",callId,name:"read",input:JSON.stringify(input)});
  emit(1,{file_path:"secret-file"});emit(2,{limit:2000,offset:1,file_path:"./secret-file"});
  emit(3,{file_path:"secret-file",offset:2});
  trace.event({...origin,type:"compact",trigger:"auto",summary:"secret-summary"});
  trace.event({...origin,type:"log",level:"info",message:'{"event":"work.closure","outstanding":1}'});
  await trace.close();const raw=readFileSync(trace.path,"utf8");expect(raw).not.toContain("secret");
  const rows=raw.trim().split("\n").map(x=>JSON.parse(x));
  const reads=rows.filter(x=>x.type==="tool_start");
  expect(reads.map(x=>x.readCount)).toEqual([1,2,1]);expect(reads[1].previousReadCallId).toBe(1);
  expect(reads[1].readFingerprint).toBe(reads[0].readFingerprint);
  expect(rows.find(x=>x.type==="compact").summaryFingerprint).toHaveLength(64);
  expect(rows.some(x=>x.type==="work.closure")).toBe(true);
  const other=new ExecutionTrace(dir);other.event({...origin,type:"tool_start",callId:1,name:"read",input:'{"file_path":"secret-file"}'});await other.close();
  expect(JSON.parse(readFileSync(other.path,"utf8").trim().split("\n")[1]!).readFingerprint).not.toBe(reads[0].readFingerprint);
 } finally {rmSync(dir,{recursive:true,force:true});}
});

test("trace records acceptance counts without evidence or interpretations",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"sope-report-trace-"));
 try {const trace=new ExecutionTrace(dir);trace.event({...origin,type:"tool_end",name:"report",callId:4,isError:false,result:JSON.stringify({status:"rejected",criteria:[{verdict:"failed",observation:"secret"},{verdict:"satisfied",unverified_interpretation:"secret"},{verdict:"unverified"}]})});await trace.close();const raw=readFileSync(trace.path,"utf8");expect(raw).not.toContain("secret");expect(raw).toContain('"reportStatus":"rejected"');expect(raw).toContain('"failed":1');}finally{rmSync(dir,{recursive:true,force:true});}
});

test("trace counts exact command requests across compaction without exposing command arguments", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sope-command-trace-"));
  try {
    const trace = new ExecutionTrace(dir);
    const emit = (callId: number, name: string, input: object, agentId = 0, turnId = 1) =>
      trace.event({ ...origin, agentId, turnId, type: "tool_start", callId, name, input: JSON.stringify(input) });
    emit(1, "bash", { command: "cat secret-file", description: "first" });
    trace.event({ ...origin, type: "compact", trigger: "auto", summary: "forgot the command" });
    emit(2, "bash", { description: "different", timeout: 1000, command: "cat secret-file" });
    emit(3, "bash", { command: "cat ./secret-file" });
    emit(4, "check", { argv: ["cat", "secret-file"] });
    emit(5, "check", { argv: ["cat", "secret-file"], timeout: 2000 });
    emit(6, "check", { argv: ["cat", "secret-file"] }, 9);
    emit(7, "check", { argv: ["cat", "secret-file"] }, 0, 2);
    emit(8, "check", { argv: [1] });
    emit(9, "bash", { command: "x".repeat(65537) });
    trace.event({ ...origin, type: "permission", callId: 10, name: "bash", input: '{"command":"cat secret-file"}' });
    await trace.close();
    const raw = readFileSync(trace.path, "utf8");
    expect(raw).not.toContain("secret-file");
    expect(raw).not.toContain("cat ");
    const rows = raw.trim().split("\n").map(x => JSON.parse(x));
    const commands = rows.filter(x => x.type === "tool_start");
    expect(commands.map(x => x.commandCount)).toEqual([1, 2, 1, 1, 2, 1, 1, undefined, undefined]);
    expect(commands[1].previousCommandCallId).toBe(1);
    expect(commands[4].previousCommandCallId).toBe(4);
    expect(rows.find(x => x.type === "permission").commandCount).toBeUndefined();
    const other = new ExecutionTrace(dir);
    other.event({ ...origin, type: "tool_start", callId: 1, name: "bash", input: '{"command":"cat secret-file"}' });
    await other.close();
    const otherRows = readFileSync(other.path, "utf8").trim().split("\n").map(x => JSON.parse(x));
    expect(otherRows[1].commandFingerprint).not.toBe(commands[0].commandFingerprint);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});
