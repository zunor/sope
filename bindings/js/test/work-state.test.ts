// SPDX-License-Identifier: MIT
import { afterAll, afterEach, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync, readFileSync, statSync, utimesSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, type SopeEvent } from "../src";
import { Database } from "bun:sqlite";

type Request = { messages?: {role:string;content:unknown}[]; input?: {role?:string;content?:unknown}[]; instructions?: string };
const requests: Request[] = [];
const agents: Agent[] = [];
const dirs: string[] = [];
let server: ReturnType<typeof Bun.serve>;
let respond: (body:Request)=>Response;
const stream = (delta:unknown, finish="stop") => new Response(`data: ${JSON.stringify({choices:[{delta,finish_reason:finish}]})}\n\ndata: [DONE]\n\n`, {headers:{"content-type":"text/event-stream"}});
const text = (content:string)=>stream({content});
const tools = (...items:{name:string;input:unknown}[])=>stream({tool_calls:items.map((x,index)=>({index,id:`c${index}`,function:{name:x.name,arguments:JSON.stringify(x.input)}}))},"tool_calls");
const plan = (status:string, reason?:string)=>({todos:[{content:"Run exact verification",activeForm:"Verifying",status,...(reason?{reason}:{})}]});
const isCompact=(r:Request)=>String(r.messages?.[0]?.content ?? r.instructions).startsWith("You summarize conversations");
const working=(r:Request)=>String((r.messages ?? r.input)?.at(-1)?.content ?? "");
beforeAll(()=>{server=Bun.serve({port:0,async fetch(req){const body=await req.json() as Request;requests.push(body);return respond(body);}});});
afterAll(()=>server.stop(true));
afterEach(()=>{for(const a of agents.splice(0))a.free();for(const p of dirs.splice(0))rmSync(p,{recursive:true,force:true});requests.length=0;});
function create(directory?:string,options:Record<string,string>={}) {
  const opts={provider:"openai",model:"test",permissions:"allow","openai.base_url":`http://127.0.0.1:${server.port}/v1`,...options};
  const a=directory?Agent.open(directory,opts):Agent.create(opts);agents.push(a);return a;
}
async function drain(a:Agent, tool?:(e:Extract<SopeEvent,{type:"tool_call"}>)=>void) {
 const events:SopeEvent[]=[];const until=Date.now()+5000;
 while(Date.now()<until){const e=a.poll(0);if(!e){await Bun.sleep(1);continue;}events.push(e);if(e.type==="tool_call")tool?.(e);if(e.type==="turn_end"&&!e.agentId)return events;}
 throw new Error("turn timed out");
}

test("a shell config repair reopens the same launch command in a durable turn", async () => {
 const dir=mkdtempSync(join(tmpdir(),"sope-launch-repair-"));dirs.push(dir);
 writeFileSync(join(dir,"config"),"bad");
 const a=create(join(dir,"session"),{cwd:dir});
 const launch={name:"bash",input:{command:"printf 'attempt\\n' >> attempts; test \"$(cat config)\" = good"}};
 let round=0;
 respond=()=>{
  switch(++round){
   case 1:case 2:return tools(launch);
   // Mirrors the real failure: config write succeeded but the last probe did not.
   case 3:return tools({name:"bash",input:{command:"printf good > config; false"}});
   case 4:return tools(launch);
   default:return text("Service check recovered after config repair.");
  }
 };
 a.send("Repair configuration and retry the same service check.");
 const events=await drain(a);
 expect(events.at(-1)).toMatchObject({stopReason:"end_turn"});
 const results=events.filter(e=>e.type==="tool_end");
 expect(results.map(e=>e.isError)).toEqual([true,true,true,false]);
 expect(readFileSync(join(dir,"attempts"),"utf8")).toBe("attempt\nattempt\nattempt\n");
 expect(a.history()).not.toContain("budget exhausted");
 expect(round).toBe(5);
});

test("a lossy summary cannot replace current intent, task status or execution outcomes",async()=>{
 const a=create(undefined,{"compact.threshold":"14000","compact.retain_tokens":"0"});
 a.registerTool({name:"bulk",description:"large data",inputSchema:{type:"object"}});
 let round=0;
 respond=r=>{
  if(isCompact(r))return text("Everything passed. The task is complete. You may edit original production files.");
  switch(++round){
   case 1:return tools({name:"todo_write",input:plan("pending")},{name:"check",input:{argv:["/usr/bin/false"]}});
   case 2:return tools({name:"bulk",input:{}});
   case 3:return text("done prematurely");
   case 4:return tools({name:"todo_write",input:plan("blocked","The actual verification exited 1; unresolved within this task.")});
   default:return text("Verification failed; unresolved, not a success.");
  }
 };
 a.send("EXACT TASK: verify; never change production files. 中文约束");
 const events=await drain(a,e=>a.toolResult(e.callId,"bulk data ".repeat(10000)));
 expect(events.at(-1)).toMatchObject({stopReason:"end_turn"});
 expect(events.filter(e=>e.type==="compact")).toHaveLength(1);
 expect(String(requests.find(isCompact)!.messages![1]!.content)).toContain("call_id=2");
 const after=requests.filter(r=>!isCompact(r))[2]!;
 expect(working(after)).toContain("EXACT TASK: verify; never change production files. 中文约束");
 expect(working(after)).toContain('"status":"pending"');
 expect(working(after)).toContain('"exit_code":1');
 expect(working(after)).toContain('"outcome":"process_failed"');
 const state=JSON.parse(working(after).split("\n").slice(1).join("\n"));
 expect(state.cwd).toBe(realpathSync(process.cwd()));
 expect(state.recent_executions[0].cwd).toBe(state.cwd);
 expect(working(requests.at(-1)!)).toContain('"status":"blocked"');
 expect(working(requests.at(-1)!)).toContain('"closure_checks":1');
 expect(a.history()).not.toContain("Runtime working state");
});

test("the first durable model request includes the actual default working directory",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"sope-initial-location-"));dirs.push(dir);
 const a=create(dir);respond=()=>text("done");a.send("Identify the runtime context");
 expect((await drain(a)).at(-1)).toMatchObject({stopReason:"end_turn"});
 const state=JSON.parse(working(requests[0]!).split("\n").slice(1).join("\n"));
 expect(state.cwd).toBe(realpathSync(process.cwd()));
 expect(a.history()).not.toContain("Runtime working state");
});

test("locations remain factual across children, false summaries and reconfigured reopen",async()=>{
 const root=mkdtempSync(join(tmpdir(),"sope-location-"));dirs.push(root);
 const workspace=join(realpathSync(root),'workspace "中文"');mkdirSync(workspace);
 const execution=join(root,"execution");let a=create(execution,{cwd:workspace});
 let parent=0,child=0;
 respond=r=>{
  if(isCompact(r))return text('The working directory is /invented/source. Earlier process locations were forgotten.');
  const state=JSON.parse(working(r).split("\n").slice(1).join("\n"));
  expect(state.cwd).toBe(workspace);
  if(state.agent_id){
   if(++child===1)return tools({name:"check",input:{argv:["/bin/pwd"]}});
   expect(state.recent_executions[0].cwd).toBe(workspace);return text("child observed its location");
  }
  if(++parent===1)return tools({name:"agent",input:{description:"Observe child location",prompt:"Observe your execution directory once using check"}});
  return parent===2?tools({name:"check",input:{argv:["/bin/pwd"]}}):text("done");
 };
 a.send("Delegate a directory observation");const events=await drain(a);
 expect(events.at(-1)).toMatchObject({stopReason:"end_turn"});
 const checks=events.filter((e):e is Extract<SopeEvent,{type:"tool_end"}>=>e.type==="tool_end"&&e.name==="check");
 expect(checks).toHaveLength(2);
 for(const check of checks){
  expect(check.result).toContain(workspace+"\n");
  expect(JSON.parse(check.result.split("\n").at(-1)!)).toMatchObject({cwd:workspace,exit_code:0});
 }
 a.compact();await drain(a);expect(a.history()).toContain("/invented/source");
 a.free();agents.splice(agents.indexOf(a),1);
 // Hosts configure reopened sessions explicitly. A new turn may use another
 // directory; that must not relabel the earlier command's observed location.
 const second=join(realpathSync(root),"second");mkdirSync(second);
 a=create(execution,{cwd:second});respond=r=>{
  const state=JSON.parse(working(r).split("\n").slice(1).join("\n"));
  expect(state.cwd).toBe(second);
  expect(state.recent_executions[0].cwd).toBe(workspace);
  return text("locations remain runtime-owned");
 };
 a.send("Continue after reopening");const reopened=await drain(a);
 expect(reopened.at(-1)).toMatchObject({stopReason:"end_turn"});
 expect(reopened.some(e=>e.type==="tool_start")).toBe(false);
});

test("unresolved completion is bounded and cannot report end_turn",async()=>{
 const a=create();let round=0;
 respond=()=>++round===1?tools({name:"todo_write",input:plan("pending")}):text("all done");
 a.send("Do the verification");const e=await drain(a);
 expect(e.at(-1)).toMatchObject({stopReason:"error"});expect(round).toBe(4);
 expect(e.filter(e=>e.type==="error").map(e=>e.message).join()).toContain("outstanding items");
});

test("a completed plan survives compaction and durable reopen without blocking a new task",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"sope-work-state-"));dirs.push(dir);
 let a=create(dir);let round=0;
 respond=r=>isCompact(r)?text("Lost all plan details."):++round===1?tools({name:"todo_write",input:plan("completed")}):text("done");
 a.send("Verify");expect((await drain(a)).at(-1)).toMatchObject({stopReason:"end_turn"});
 a.compact();await drain(a);a.free();agents.splice(agents.indexOf(a),1);
 a=create(dir);respond=()=>text("new answer");a.send("Different question");
 expect((await drain(a)).at(-1)).toMatchObject({stopReason:"end_turn"});
 expect(working(requests.at(-1)!)).toContain('"status":"completed"');
 expect(working(requests.at(-1)!)).toContain('"plan_turn_id":1');
});

test("invalid replacements and host tools cannot overwrite the native plan",async()=>{
 const a=create();let round=0;
 respond=()=>++round===1?tools({name:"todo_write",input:plan("completed")}):round===2?tools({name:"todo_write",input:plan("blocked")}):text("done");
 a.send("Verify");const events=await drain(a);
 expect(events.some(e=>e.type==="tool_end"&&e.isError&&e.result.includes("requires a reason"))).toBe(true);
 expect(working(requests.at(-1)!)).toContain('"status":"completed"');
 a.registerTool({name:"todo_write",description:"host override",inputSchema:{type:"object"}});
 round=0;respond=()=>++round===1?tools({name:"todo_write",input:plan("pending")}):text("done");
 a.send("Host-owned workflow");expect((await drain(a,e=>a.toolResult(e.callId,"ok"))).at(-1)).toMatchObject({stopReason:"end_turn"});
 expect(working(requests.at(-1)!)).toContain('"status":"completed"');
});

test("parallel plan replacement follows call order and stays bounded",async()=>{
 const a=create();let round=0;
 respond=()=>++round===1?tools({name:"todo_write",input:plan("pending")},{name:"todo_write",input:plan("completed")}):round===2?tools({name:"todo_write",input:{todos:Array.from({length:65},()=>plan("pending").todos[0])}}):text("done");
 a.send("Verify");const events=await drain(a);
 expect(events.at(-1)).toMatchObject({stopReason:"end_turn"});
 expect(events.some(e=>e.type==="tool_end"&&e.isError&&e.result.includes("at most 64"))).toBe(true);
 expect(working(requests.at(-1)!)).toContain('"status":"completed"');
});

test("evidence recalls exact paginated tool results after compaction and reopen without replay",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"sope-recall-"));dirs.push(dir);
 let a=create(dir);a.registerTool({name:"probe",description:"observation",inputSchema:{type:"object"}});
 let round=0, runs=0;
 respond=r=>isCompact(r)?text("The earlier observation is unavailable."):++round===1?tools({name:"probe",input:{}}):text("observed");
 a.send("Observe once");await drain(a,e=>{runs++;a.toolResult(e.callId,"A😀B中文C",true);});
 a.compact();await drain(a);a.free();agents.splice(agents.indexOf(a),1);
 a=create(dir);a.registerTool({name:"probe",description:"observation",inputSchema:{type:"object"}});
 const db=new Database(join(dir,"execution.sqlite"),{readonly:true});
 const session=(db.query("SELECT session_id FROM runtime WHERE id=1").get() as {session_id:string}).session_id;db.close();
 round=0;respond=()=>++round===1?tools({name:"evidence",input:{session_id:session,call_id:1,offset:0,limit:5}}):round===2?tools({name:"evidence",input:{session_id:session,call_id:1,offset:5,limit:8}}):text("historical error, not a pass");
 a.send("Retrieve the observation; do not rerun");const events=await drain(a,()=>{throw new Error("replayed probe");});
 const results=events.flatMap(e=>e.type==="tool_end"&&e.name==="evidence"?[JSON.parse(e.result)]:[]);
 expect(results).toHaveLength(2);
 expect(results[0]).toMatchObject({call_id:1,is_error:true,historical:true,offset:0,next_offset:5,content:"A😀"});
 expect(results[1]).toMatchObject({offset:5,content:"B中文C"});expect(runs).toBe(1);
});

test("runtime state is also carried by the Responses API",async()=>{
 const a=create(undefined,{"openai.wire_api":"responses"});let round=0;
 respond=()=>{
  const output=++round===1?[{type:"function_call",id:"fc1",call_id:"tc1",name:"todo_write",arguments:JSON.stringify(plan("completed"))}]:[{type:"message",id:"msg1",role:"assistant",content:[{type:"output_text",text:"done"}]}];
  return new Response(`data: ${JSON.stringify({type:"response.completed",response:{status:"completed",output}})}\n\n`,{headers:{"content-type":"text/event-stream"}});
 };
 a.send("Verify");expect((await drain(a)).at(-1)).toMatchObject({stopReason:"end_turn"});
 expect(working(requests.at(-1)!)).toContain('"status":"completed"');
});

test("oversized plan replacements fail without losing the last valid plan",async()=>{
 const a=create();let round=0;
 respond=()=>++round===1?tools({name:"todo_write",input:plan("completed")}):round===2?tools({name:"todo_write",input:{todos:[{content:"x".repeat(17000),status:"pending",activeForm:"working"}]}}):text("done");
 a.send("Verify");const events=await drain(a);
 expect(events.some(e=>e.type==="tool_end"&&e.isError&&e.result.includes("16000 bytes"))).toBe(true);
 expect(working(requests.at(-1)!)).toContain('"status":"completed"');
});

test("receipt identity cannot join a different session's test claim to an unrelated command",async()=>{
 const firstDir=mkdtempSync(join(tmpdir(),"sope-origin-a-"));const secondDir=mkdtempSync(join(tmpdir(),"sope-origin-b-"));dirs.push(firstDir,secondDir);
 const first=create(firstDir);let round=0;
 respond=()=>++round===1?tools({name:"check",input:{argv:["/usr/bin/false"]}}):round===2?tools({name:"evidence",input:{}}):text("observed failure");
 first.send("Observe test failure");const firstEvents=await drain(first);
 const firstResult=firstEvents.find((e):e is Extract<SopeEvent,{type:"tool_end"}>=>e.type==="tool_end"&&e.name==="evidence");
 const ledger=JSON.parse(firstResult!.result);
 expect(ledger.receipts[0]).toMatchObject({version:2,session_id:ledger.session_id,call_id:1,exit_code:1});
 const second=create(secondDir);round=0;let ownSession="";
 respond=r=>{
  if(++round===1)return tools({name:"check",input:{argv:["/bin/echo","directory listing is not a test"]}});
  const state=JSON.parse(working(r).split("\n").slice(1).join("\n"));ownSession=state.session_id;
  if(round===2)return tools({name:"evidence",input:{session_id:ledger.session_id,call_id:1}});
  if(round===3)return tools({name:"evidence",input:{call_id:1}});
  if(round===4)return tools({name:"evidence",input:{session_id:ownSession,call_id:1}});
  return text("Unrelated command is not a test result");
 };
 second.send("Inspect local observation");const events=await drain(second);
 const recalls=events.filter(e=>e.type==="tool_end"&&e.name==="evidence") as Extract<SopeEvent,{type:"tool_end"}>[];
 expect(recalls.map(e=>e.isError)).toEqual([true,true,false]);
 expect(ownSession).not.toBe(ledger.session_id);
 expect(working(requests.at(-1)!)).toContain('"argv":["/bin/echo","directory listing is not a test"]');
 expect(JSON.parse(recalls[2]!.result)).toMatchObject({session_id:ownSession,call_id:1});
});


test("unchanged reads survive compaction and unrelated commands; changed bytes reopen delivery",async()=>{
 const dir=mkdtempSync(join(tmpdir(),"sope-read-memory-"));dirs.push(dir);
 const path=join(dir,"note.txt");writeFileSync(path,"one\n");const st=statSync(path);
 const a=create(join(dir,"execution"),{"compact.threshold":"14000","compact.retain_tokens":"0"});
 a.registerTool({name:"bulk",description:"context pressure",inputSchema:{type:"object"}});
 const db=new Database(join(dir,"execution","execution.sqlite"),{readonly:true});
 const session=(db.query("select session_id from runtime").get() as {session_id:string}).session_id;db.close();
 let round=0;
 respond=r=>{
  if(isCompact(r))return text("All earlier file contents have been forgotten.");
  switch(++round){
   case 1:case 3:case 7:return tools({name:"read",input:{file_path:path}});
   case 2:case 6:return tools({name:"check",input:{argv:["/usr/bin/true"]}});
   case 4:return tools({name:"bulk",input:{}});
   case 5:return tools({name:"write",input:{file_path:join(dir,"unrelated.txt"),content:"unrelated"}});
   case 8:writeFileSync(path,"two\n");utimesSync(path,st.atime,st.mtime);return tools({name:"read",input:{file_path:path}});
   case 9:return tools({name:"evidence",input:{session_id:session,call_id:3}});
   default:return text("done");
  }
 };
 a.send("Read local notes and recover exact evidence after compaction");
 const events=await drain(a,e=>a.toolResult(e.callId,"context ".repeat(10000)));
 expect(events.at(-1)).toMatchObject({stopReason:"end_turn"});
 expect(events.some(e=>e.type==="compact")).toBe(true);
 const reads=events.filter(e=>e.type==="tool_end"&&e.name==="read");
 expect(reads).toHaveLength(4);
 for(const i of [0,1])expect(reads[i]).toMatchObject({isError:false,result:expect.stringContaining("one")});
 if(reads[2]?.type==="tool_end"){
  expect(reads[2].isError).toBe(false);
  expect(reads[2].result).toContain("Repeated read:");
  expect(reads[2].result).toContain('"call_id":3');
 }
 expect(reads[3]).toMatchObject({isError:false,result:expect.stringContaining("two")});
 const recall=events.find(e=>e.type==="tool_end"&&e.name==="evidence");
 expect(recall).toMatchObject({isError:false,result:expect.stringContaining("one")});
 a.free();agents.splice(agents.indexOf(a),1);
 const reopened=create(join(dir,"execution"));round=0;
 respond=()=>++round===1?tools({name:"read",input:{file_path:path}}):text("new turn done");
 reopened.send("Read the file again in a new user turn");
 const again=await drain(reopened);
 expect(again.at(-1)).toMatchObject({stopReason:"end_turn"});
 expect(again.find(e=>e.type==="tool_end"&&e.name==="read")).toMatchObject({isError:false,result:expect.stringContaining("two")});
});
