// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { CellBuffer } from "../src/render/buffer";
import { EventLog } from "../src/ui/eventlog";

const origin = { agentId: 0, turnId: 1, sequence: 0 };
const render = (log: EventLog) => {
  const buffer = new CellBuffer(140, 8);
  log.render(buffer, {x:0,y:0,w:140,h:8}, "");
  return buffer.chars.join("");
};

test("stream fragments do not evict lifecycle events or expose their text", () => {
  const log = new EventLog();
  log.event({...origin, type:"turn_start"});
  for (let i=0;i<10000;i++) log.event({...origin,type:"thinking_delta",text:"private-thought"});
  const text = render(log);
  expect(log.count).toBe(10001);
  expect(text).toContain("turn_start");
  expect(text).toContain("10000 chunks");
  expect(text).not.toContain("private-thought");
  log.event({...origin,agentId:7,type:"thinking_delta",text:"x"});
  expect(render(log)).toContain("a7/t1");
});

test("the trace ring keeps the newest entries in order across wraparound", () => {
  const log=new EventLog();
  for (let i=0;i<log.max+3;i++) log.note(`marker-${i}`);
  const text=render(log);
  for (let i=log.max-4;i<log.max+2;i++) expect(text.indexOf(`marker-${i} `)).toBeLessThan(text.indexOf(`marker-${i+1} `));
  expect(text).not.toContain("marker-0 ");
});

test("tool boundaries split stream groups and retain separate counts", () => {
  const log=new EventLog();
  for(let i=0;i<3;i++)log.event({...origin,type:"text_delta",text:"a"});
  log.event({...origin,type:"tool_start",callId:4,name:"read",input:"{}"});
  for(let i=0;i<2;i++)log.event({...origin,type:"text_delta",text:"b"});
  const text=render(log);
  expect(text).toContain("3 bytes · 3 chunks");
  expect(text).toContain("tool_start");
  expect(text).toContain("2 bytes · 2 chunks");
});
