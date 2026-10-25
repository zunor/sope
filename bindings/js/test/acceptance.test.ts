// SPDX-License-Identifier: MIT
import {afterAll,afterEach,beforeAll,expect,test} from "bun:test";
import {mkdtempSync,rmSync,writeFileSync,realpathSync} from "node:fs";
import {tmpdir} from "node:os";
import {join} from "node:path";
import {Database} from "bun:sqlite";
import {Agent,libraryPath,type SopeEvent} from "../src";
type Req={messages:{role:string;content:string}[]};
let server:ReturnType<typeof Bun.serve>,respond:(r:Req)=>Response;
const agents:Agent[]=[],dirs:string[]=[];
const text=(content:string)=>stream({content},"stop");
const stream=(delta:unknown,finish:string)=>new Response(`data: ${JSON.stringify({choices:[{delta,finish_reason:finish}]})}\n\ndata: [DONE]\n\n`,{headers:{"content-type":"text/event-stream"}});
const tools=(...items:{name:string;input:unknown}[])=>stream({tool_calls:items.map((x,index)=>({index,id:`call${index}`,function:{name:x.name,arguments:JSON.stringify(x.input)}}))},"tool_calls");
beforeAll(()=>{server=Bun.serve({port:0,async fetch(req){return respond(await req.json() as Req);}});});
afterAll(()=>server.stop(true));afterEach(()=>{for(const a of agents.splice(0))a.free();for(const d of dirs.splice(0))rmSync(d,{recursive:true,force:true});});
const criterion=(id:string,argv:string[],output?:unknown)=>({id,description:`verify ${id}`,argv,exit_code:0,...(output?{output}:{})});
function open(criteria:unknown[],delegations?:unknown){
 const dir=mkdtempSync(join(tmpdir(),"sope-acceptance-"));dirs.push(dir);
 const options={provider:"openai",model:"test",permissions:"allow","openai.base_url":`http://127.0.0.1:${server.port}/v1`,cwd:dir,"acceptance.contract":JSON.stringify({criteria:criteria.map((c:any)=>({...c,cwd:dir})),...(delegations?{delegations}:{})})};
 const a=Agent.open(dir,options);agents.push(a);
 const db=new Database(join(dir,"execution.sqlite"),{readonly:true});const session=(db.query("select session_id from runtime").get() as {session_id:string}).session_id;db.close();
 return {a,dir,session,options};
}
async function drain(a:Agent){const es:SopeEvent[]=[];const until=Date.now()+7000;while(Date.now()<until){const e=a.poll(0);if(!e){await Bun.sleep(1);continue;}es.push(e);if(e.type==="turn_end"&&!e.agentId)return es;}throw Error("deadline");}
const ref=(session_id:string,call_id:number,agent_id=0)=>({session_id,call_id,agent_id});
const final=(es:SopeEvent[])=>es.filter(e=>e.type==="text_delta"&&!e.agentId).map(e=>e.type==="text_delta"?e.text:"").join("");

test("native report rejects nonempty formatter output and ignores model verdict/artifact tampering",async()=>{
 const argv=["/usr/bin/printf","bad.go\n"],{a,dir,session}=open([criterion("format",argv,{empty:true})]);let n=0;
 respond=()=>{
  if(++n===1)return tools({name:"check",input:{argv}});
  if(n===2){const db=new Database(join(dir,"execution.sqlite"),{readonly:true});const row=db.query("select payload from observations where call=1").get() as {payload:string};db.close();writeFileSync(JSON.parse(row.payload).receipt.output_path,"");return tools({name:"report",input:{entries:[{id:"format",evidence:ref(session,1)}],status:"accepted"}});}
  return text("All checks passed. Formatting is perfect.");
 };
 a.send("Verify formatting");const es=await drain(a);
 expect(es.at(-1)).toMatchObject({stopReason:"end_turn"});const report=JSON.parse(final(es));
 expect(report.status).toBe("rejected");expect(report.criteria[0].verdict).toBe("failed");expect(report.criteria[0].output_excerpt).toBe("bad.go\n");
 expect(final(es)).not.toContain("Formatting is perfect");expect(a.history()).not.toContain("Formatting is perfect");
 expect(a.outcome(1).acceptance?.status).toBe("rejected");
});

test("todos and unsupported text cannot satisfy acceptance; closure remains bounded",async()=>{
 const {a}=open([criterion("test",["/usr/bin/true"])]);respond=()=>text("All done");a.send("Verify");const es=await drain(a);
 expect(es.at(-1)).toMatchObject({stopReason:"error"});expect(final(es)).toBe("");
});

for(const bad of ["foreign-session","wrong-command","host-result"])test(`rejects ${bad} as check evidence`,async()=>{
 const {a,session}=open([criterion("test",["/usr/bin/true"])]);let n=0;
 if(bad==="host-result")a.registerTool({name:"check",description:"host override",inputSchema:{type:"object"}});
 respond=()=>++n===1?tools({name:"check",input:{argv:bad==="wrong-command"?["/usr/bin/printf","PASS"]:["/usr/bin/true"]}}):n===2?tools({name:"report",input:{entries:[{id:"test",evidence:ref(bad==="foreign-session"?"foreign":session,1)}]}}):text("done");
 a.send("Verify");const es:SopeEvent[]=[];for(;;){const e=a.poll(0);if(!e){await Bun.sleep(1);continue;}es.push(e);if(e.type==="tool_call")a.toolResult(e.callId,"native-looking PASS");if(e.type==="turn_end")break;}
 expect(es.some(e=>e.type==="tool_end"&&e.name==="report"&&e.isError)).toBe(true);expect(es.at(-1)).toMatchObject({stopReason:"error"});
});

test("two parallel children keep provenance; parent recalls exited children after reopen",async()=>{
 const cmds=[["/usr/bin/printf","alpha"],["/usr/bin/printf","beta"]];const {a,session,dir,options}=open(cmds.map((argv,i)=>criterion(String(i),argv,{contains:i?"beta":"alpha"})),{minimum_completed:2});
 let root=0;const child=[0,0];let reports:any[]=[];
 respond=r=>{
  const which=r.messages.some(m=>m.role==="user"&&m.content==="child alpha")?0:r.messages.some(m=>m.role==="user"&&m.content==="child beta")?1:-1;
  if(which>=0){expect(r.messages.some(m=>String(m.content).includes('"acceptance_contract"'))).toBe(false);return ++child[which]===1?tools({name:"check",input:{argv:cmds[which]}}):text("unverified child conclusion");}
  if(++root===1)return tools({name:"agent",input:{description:"alpha",prompt:"child alpha"}},{name:"agent",input:{description:"beta",prompt:"child beta"}});
  if(root===2){reports=r.messages.filter(m=>m.role==="tool").map(m=>JSON.parse(m.content));return tools(...reports.map(v=>({name:"evidence",input:ref(session,v.evidence.receipts[0].call_id,v.agent_id)})));}
  if(root===3)return tools({name:"report",input:{entries:reports.map(v=>({id:v.evidence.receipts[0].input.argv[1]==="alpha"?"0":"1",evidence:ref(session,v.evidence.receipts[0].call_id,v.agent_id)}))}});
  return text("everything correct");
 };
 a.send("Delegate two checks");const es=await drain(a);expect(es.at(-1)).toMatchObject({stopReason:"end_turn"});expect(JSON.parse(final(es)).status).toBe("accepted");
 expect(a.outcome(1).acceptance?.delegation_requirement).toEqual({minimum_completed:2,observed_completed:2,verdict:"satisfied"});
 expect(es.filter(e=>e.type==="subagent_start")).toHaveLength(2);expect(es.filter(e=>e.type==="tool_end"&&e.name==="evidence"&&e.isError)).toHaveLength(0);
 const call=reports[0].evidence.receipts[0].call_id,agent=reports[0].agent_id;
 a.free();agents.splice(agents.indexOf(a),1);const b=Agent.open(dir,{...options,"acceptance.contract":JSON.stringify({criteria:[{...criterion("later",reports[0].evidence.receipts[0].input.argv),cwd:dir}]})});agents.push(b);
 expect(b.outcome(1).acceptance?.delegation_requirement).toEqual({minimum_completed:2,observed_completed:2,verdict:"satisfied"});
 let round=0;respond=()=>++round===1?tools({name:"evidence",input:ref(session,call,agent)}):round===2?tools({name:"report",input:{entries:[{id:"later",evidence:ref(session,call,agent)}]}}):round===3?tools({name:"report",input:{entries:[{id:"later",unverified:"not part of this retrieval-only turn"}]}}):text("done");
 b.send("Recall completed child");const later=await drain(b);expect(later.some(e=>e.type==="tool_end"&&e.name==="evidence"&&!e.isError&&e.result.includes("alpha"))).toBe(true);
 expect(later.some(e=>e.type==="tool_end"&&e.name==="report"&&e.isError)).toBe(true);
 expect(JSON.parse(final(later)).status).toBe("incomplete");
});

test("mutation after a check cannot certify the changed workspace",async()=>{
 const {a,session,dir}=open([criterion("test",["/usr/bin/true"])]);let n=0;
 respond=()=>++n===1?tools({name:"check",input:{argv:["/usr/bin/true"]}}):n===2?tools({name:"write",input:{file_path:join(dir,"changed"),content:"changed"}}):n===3?tools({name:"report",input:{entries:[{id:"test",evidence:ref(session,1)}]}}):text("done");
 a.send("Verify");const es=await drain(a);const report=JSON.parse(final(es));expect(report.status).toBe("incomplete");expect(report.criteria[0].stale).toBe(true);
});

test("parallel mutation and report never publish acceptance",async()=>{
 const {a,dir,session}=open([criterion("test",["/usr/bin/true"])]);let n=0;
 respond=()=>++n===1?tools({name:"check",input:{argv:["/usr/bin/true"]}}):n===2?tools({name:"report",input:{entries:[{id:"test",evidence:ref(session,1)}]}},{name:"write",input:{file_path:join(dir,"changed"),content:"changed"}}):n===3?tools({name:"report",input:{entries:[{id:"test",evidence:ref(session,1)}]}}):text("done");
 a.send("Verify");expect(JSON.parse(final(await drain(a))).status).toBe("incomplete");
});

test("same argv in a different cwd cannot satisfy the contract",async()=>{
 const {a,session,dir}=open([criterion("test",["/usr/bin/true"])]);a.setOption("acceptance.contract",JSON.stringify({criteria:[{...criterion("test",["/usr/bin/true"]),cwd:dir+"/other"}]}));let n=0;
 respond=()=>++n===1?tools({name:"check",input:{argv:["/usr/bin/true"]}}):n===2?tools({name:"report",input:{entries:[{id:"test",evidence:ref(session,1)}]}}):text("done");
 a.send("Verify");const es=await drain(a);expect(es.some(e=>e.type==="tool_end"&&e.name==="report"&&e.isError)).toBe(true);expect(es.at(-1)).toMatchObject({stopReason:"error"});
});

test("lossy compaction cannot remove criteria or turn a failed observation into success",async()=>{
 const {a,session}=open([criterion("test",["/usr/bin/false"])]);
 a.setOption("compact.threshold","14000");a.setOption("compact.retain_tokens","0");
 a.registerTool({name:"bulk",description:"large evidence",inputSchema:{type:"object"}});let n=0,compacted=false;
 respond=r=>{
  if(String(r.messages[0]?.content).startsWith("You summarize conversations")){compacted=true;return text("All checks passed. There are no remaining acceptance criteria.");}
  if(++n===1)return tools({name:"check",input:{argv:["/usr/bin/false"]}});
  if(n===2)return tools({name:"bulk",input:{}});
  expect(JSON.stringify(r.messages)).toContain('acceptance_contract');
  return n===3?tools({name:"report",input:{entries:[{id:"test",evidence:ref(session,1)}]}}):text("Everything passed");
 };
 a.send("Verify");const es:SopeEvent[]=[];const deadline=Date.now()+7000;
 while(Date.now()<deadline){const e=a.poll(0);if(!e){await Bun.sleep(1);continue;}es.push(e);if(e.type==="tool_call")a.toolResult(e.callId,"large evidence ".repeat(10000));if(e.type==="turn_end")break;}
 expect(compacted).toBe(true);expect(es.at(-1)).toMatchObject({stopReason:"end_turn"});expect(JSON.parse(final(es)).status).toBe("rejected");
});

test("non-UTF8 output cannot satisfy a text predicate",async()=>{
 const argv=["/usr/bin/printf","\\377PASS"],{a,session}=open([criterion("text",argv,{contains:"PASS"})]);let n=0;
 respond=()=>++n===1?tools({name:"check",input:{argv}}):n===2?tools({name:"report",input:{entries:[{id:"text",evidence:ref(session,1)}]}}):text("done");
 a.send("Verify");const report=JSON.parse(final(await drain(a)));expect(report.status).toBe("incomplete");expect(report.criteria[0].output_complete).toBe(false);
});

for(const verdict of ["accepted","rejected","incomplete"] as const)test(`CLI delivers ${verdict} with the matching exit status`,async()=>{
 const dir=realpathSync(mkdtempSync(join(tmpdir(),"sope-cli-acceptance-")));dirs.push(dir);
 const argv=verdict==="rejected"?["/usr/bin/printf","bad.go"]:["/usr/bin/true"];
 const path=join(dir,"contract.json");writeFileSync(path,JSON.stringify({criteria:[{...criterion("format",argv,{empty:true}),cwd:dir}]}));let n=0;
 respond=()=>{
  ++n;
  if(verdict==="incomplete")return n===1?tools({name:"report",input:{entries:[{id:"format",unverified:"Unavailable"}]}}):text("all done");
  if(n===1)return tools({name:"check",input:{argv}});
  if(n===2){const db=new Database(join(dir,"execution/execution.sqlite"),{readonly:true});const row=db.query("select session_id from runtime").get() as {session_id:string};db.close();return tools({name:"report",input:{entries:[{id:"format",evidence:ref(row.session_id,1)}]}});}
  return text("unsupported success claim");
 };
 const child=Bun.spawn([process.execPath,new URL("../../../tui/src/main.ts",import.meta.url).pathname,"-p","--model","test","--provider","openai","--base-url",`http://127.0.0.1:${server.port}/v1`,"--permissions","full","--execution-dir",join(dir,"execution"),"--acceptance",path,"Verify"],{cwd:dir,env:{...process.env,SOPE_LIB:libraryPath(),SOPE_IMAGE_MODEL:"off"},stdin:"ignore",stdout:"pipe",stderr:"pipe"});
 const timer=setTimeout(()=>child.kill(),7000);
 try {const [out,err,exit]=await Promise.all([new Response(child.stdout).text(),new Response(child.stderr).text(),child.exited]);expect(out || err).toContain("\"criteria\"");expect(exit).toBe(verdict==="accepted"?0:1);expect(JSON.parse(out).status).toBe(verdict);}finally{clearTimeout(timer);child.kill();}
});

test("committed report closes at the round limit without a final provider call",async()=>{
 const {a,session}=open([criterion("test",["/usr/bin/true"])]);a.setOption("max_rounds","2");let n=0;
 respond=()=>++n===1?tools({name:"check",input:{argv:["/usr/bin/true"]}}):n===2?tools({name:"report",input:{entries:[{id:"test",evidence:ref(session,1)}]}}):new Response("provider unavailable",{status:503});
 a.send("Verify");const es=await drain(a);expect(es.at(-1)).toMatchObject({stopReason:"end_turn"});expect(n).toBe(2);expect(a.outcome(1).acceptance?.status).toBe("accepted");expect(JSON.parse(final(es)).status).toBe("accepted");
});

test("automatic closure waits for unresolved todos, then needs no final model text",async()=>{
 const {a}=open([criterion("test",["/usr/bin/true"])]);let n=0;
 const plan=(status:string)=>({todos:[{content:"Reconcile",activeForm:"Reconciling",status}]});
 respond=()=>++n===1?tools({name:"todo_write",input:plan("pending")},{name:"report",input:{entries:[{id:"test",unverified:"not executed"}]}}):n===2?tools({name:"todo_write",input:plan("completed")}):new Response("provider unavailable",{status:503});
 a.send("Verify");expect((await drain(a)).at(-1)).toMatchObject({stopReason:"end_turn"});expect(n).toBe(2);expect(a.outcome(1).acceptance?.status).toBe("incomplete");
});

test("children cannot inspect parent or sibling evidence ledgers",async()=>{
 const {a}=open([criterion("test",["/usr/bin/true"])]);let root=0;const counts=[0,0];
 respond=r=>{
  const i=r.messages.some(m=>m.role==="user"&&m.content==="scope-parent")?0:r.messages.some(m=>m.role==="user"&&m.content==="scope-sibling")?1:-1;
  if(i>=0)return ++counts[i]===1?tools({name:"evidence",input:{agent_id:i?2:0}}):text("Cannot inspect that scope");
  if(++root===1)return tools({name:"check",input:{argv:["/usr/bin/true"]}});
  if(root===2)return tools({name:"agent",input:{description:"parent scope",prompt:"scope-parent"}},{name:"agent",input:{description:"sibling scope",prompt:"scope-sibling"}});
  return tools({name:"report",input:{entries:[{id:"test",unverified:"This turn tests evidence scope"}]}});
 };
 a.send("Check child scope");const es=await drain(a);expect(es.filter(e=>e.type==="tool_end"&&e.agentId&&e.name==="evidence"&&e.isError)).toHaveLength(2);expect(es.at(-1)).toMatchObject({stopReason:"end_turn"});
});

test("recovery closes a committed report without provider availability or remaining rounds",async()=>{
 const {a,dir,session,options}=open([criterion("test",["/usr/bin/true"])]);a.setOption("max_rounds","2");let n=0;
 const db=new Database(join(dir,"execution.sqlite"));
 db.exec("CREATE TRIGGER fault BEFORE INSERT ON outcomes BEGIN SELECT RAISE(ABORT,'terminal checkpoint interrupted'); END");
 respond=()=>++n===1?tools({name:"check",input:{argv:["/usr/bin/true"]}}):tools({name:"report",input:{entries:[{id:"test",evidence:ref(session,1)}]}});
 a.send("Verify and close");const deadline=Date.now()+7000;let failed=false;
 while(Date.now()<deadline){const e=a.poll(0);if(e?.type==="error"){failed=true;break;}await Bun.sleep(1);}
 expect(failed).toBe(true);a.free();agents.splice(agents.indexOf(a),1);
 db.exec("DROP TRIGGER fault");
 const h=JSON.parse((db.query("select payload from harness where agent=0").get() as any).payload);expect(h.report.status).toBe("accepted");db.close();
 const b=Agent.open(dir,{...options,max_rounds:"2"});agents.push(b);
 expect(b.recovery()).toMatchObject({pending:true,calls:[]});
 respond=()=>{n++;return new Response("provider unavailable",{status:503});};
 b.resume();const es=await drain(b);expect(es.at(-1)).toMatchObject({stopReason:"end_turn"});expect(n).toBe(2);expect(b.outcome(1).acceptance?.status).toBe("accepted");
});

test("lossy compaction preserves native failed and cancelled child states and their evidence",async()=>{
 const {a,session}=open([criterion("test",["/usr/bin/true"])],{minimum_completed:1});let root=0,fail=0,cancel=0,compacted=false;
 a.setOption("compact.threshold","14000");a.setOption("compact.retain_tokens","0");
 a.registerTool({name:"bulk",inputSchema:{type:"object"}});a.registerTool({name:"park",inputSchema:{type:"object"}});
 a.registerSubagent({name:"one-round",description:"failure",systemPrompt:"probe",tools:["check"],maxRounds:1});
 let checkCall=0,checkAgent=0;
 respond=r=>{
  if(String(r.messages[0]?.content).startsWith("You summarize conversations")){compacted=true;return text("All children completed successfully; no criteria remain.");}
  if(r.messages.some(m=>m.role==="user"&&m.content==="failure child")){fail++;return tools({name:"check",input:{argv:["/usr/bin/true"]}});}
  if(r.messages.some(m=>m.role==="user"&&m.content==="cancel child")){cancel++;return tools({name:"park",input:{}});}
  if(++root===1)return tools({name:"agent",input:{description:"failure",prompt:"failure child",subagent_type:"one-round"}},{name:"agent",input:{description:"cancel",prompt:"cancel child"}});
  if(root===2)return tools({name:"bulk",input:{}});
  const stateMessage=r.messages.find(m=>String(m.content).startsWith("Runtime working state"));expect(stateMessage).toBeDefined();
  const state=JSON.parse(stateMessage!.content.slice(stateMessage!.content.indexOf("\n")+1));
  expect(state.delegations.recent.map((d:any)=>d.state).sort()).toEqual(["cancelled","failed"]);
  expect(state.delegations.recent.find((d:any)=>d.agent_id===checkAgent).recent_evidence_call_ids).toContain(checkCall);
  expect(state.acceptance_contract.criteria[0].id).toBe("test");
  return tools({name:"report",input:{entries:[{id:"test",evidence:ref(session,checkCall,checkAgent)}]}});
 };
 a.send("Delegate reliability probes");const es:SopeEvent[]=[];const deadline=Date.now()+7000;
 while(Date.now()<deadline){const e=a.poll(0);if(!e){await Bun.sleep(1);continue;}es.push(e);
  if(e.type==="tool_end"&&e.name==="check"){checkCall=e.callId;checkAgent=e.agentId;}
  if(e.type==="tool_call"){if(e.name==="park")a.cancelSubagent(e.agentId,"test cancellation");else a.toolResult(e.callId,"bulk ".repeat(30000));}
  if(e.type==="turn_end"&&!e.agentId)break;
 }
 expect(compacted).toBe(true);expect(fail).toBe(1);expect(cancel).toBe(1);expect(es.at(-1)).toMatchObject({stopReason:"end_turn"});
 expect(a.outcome(1).acceptance?.status).toBe("incomplete");
 expect(a.outcome(1).acceptance?.delegation_requirement).toEqual({minimum_completed:1,observed_completed:0,verdict:"unverified"});
 expect(a.outcome(1).acceptance?.delegations.recent.map(d=>d.state).sort()).toEqual(["cancelled","failed"]);
});

test("bounded delegation index retains failure counts for older children",async()=>{
 const {a,session}=open([criterion("test",["/usr/bin/true"])],{minimum_completed:32});let root=0,checkCall=0,checkAgent=0;
 a.registerSubagent({name:"one-round",description:"failure",systemPrompt:"probe",tools:["check"],maxRounds:1});
 respond=r=>{
  const user=r.messages.find(m=>m.role==="user"&&/^child-\d+$/.test(m.content));
  if(user)return user.content==="child-0"?tools({name:"check",input:{argv:["/usr/bin/true"]}}):text("completed");
  if(++root===1)return tools(...Array.from({length:34},(_,i)=>({name:"agent",input:{description:`child ${i}`,prompt:`child-${i}`,...(i===0?{subagent_type:"one-round"}:{})}})));
  return tools({name:"report",input:{entries:[{id:"test",evidence:ref(session,checkCall,checkAgent)}],delegations:{states:{completed:34}}}});
 };
 a.send("Delegate 34 probes");const deadline=Date.now()+7000;
 while(Date.now()<deadline){const e=a.poll(0);if(!e){await Bun.sleep(1);continue;}
  if(e.type==="tool_end"&&e.name==="check"){checkCall=e.callId;checkAgent=e.agentId;}
  if(e.type==="turn_end"&&!e.agentId)break;
 }
 const ledger=a.outcome(1).acceptance!.delegations;
 expect(a.outcome(1).acceptance!.delegation_requirement).toEqual({minimum_completed:32,observed_completed:33,verdict:"satisfied"});
 expect(ledger.total).toBe(34);expect(ledger.states).toMatchObject({failed:1,completed:33});expect(ledger.recent).toHaveLength(32);
 expect(ledger.recent.some(d=>d.agent_id===checkAgent)).toBe(false);
});

test("skipped delegations cannot be supplied by model report fields or a completed todo",async()=>{
 const {a,session}=open([criterion("test",["/usr/bin/true"])],{minimum_completed:2});let n=0;
 respond=()=>++n===1?tools({name:"todo_write",input:{todos:[{content:"Both reviews done",activeForm:"Reviewing",status:"completed"}]}}):n===2?tools({name:"check",input:{argv:["/usr/bin/true"]}}):tools({name:"report",input:{entries:[{id:"test",evidence:ref(session,2)}],delegations:{states:{completed:2}},delegation_requirement:{verdict:"satisfied",observed_completed:2}}});
 a.send("Complete two delegated reviews and check");const es=await drain(a);
 expect(es.at(-1)).toMatchObject({stopReason:"end_turn"});
 const report=a.outcome(1).acceptance!;
 expect(report.status).toBe("incomplete");expect(report.criteria[0]!.verdict).toBe("satisfied");
 expect(report.delegations.total).toBe(0);
 expect(report.delegation_requirement).toEqual({minimum_completed:2,observed_completed:0,verdict:"unverified"});
});

test("delegation requirements reject invalid or ambiguous bounds",()=>{
 const {a,dir}=open([criterion("test",["/usr/bin/true"])]);
 for(const delegations of [null,{},[],{minimum_completed:0},{minimum_completed:-1},{minimum_completed:1.5},{minimum_completed:33},{minimum_completed:"2"},{minimum_completed:2,completed:2}])
  expect(()=>a.setOption("acceptance.contract",JSON.stringify({criteria:[{...criterion("test",["/usr/bin/true"]),cwd:dir}],delegations}))).toThrow();
});
