// SPDX-License-Identifier: MIT
import { expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

async function until(check: () => boolean, timeout = 5000) {
  const end = Date.now() + timeout;
  while (!check()) { if (Date.now() >= end) throw new Error("condition timed out"); await Bun.sleep(10); }
}
const alive = (pid: number) => { try { process.kill(pid, 0); return true; } catch { return false; } };

for (const [signal, code] of [["SIGTERM", 143], ["SIGINT", 130], ["SIGHUP", 129]] as const) {
test(`${signal} cancels a print task and reaps its active shell`, async () => {
  const dir = mkdtempSync(join(tmpdir(), "sope-print-"));
  let shellPid = 0;
  const server = Bun.serve({ port: 0, fetch() {
    const input = JSON.stringify({command: `echo $$ > '${dir}/shell.pid'; exec sleep 120`, timeout: 180000});
    const chunk = { choices: [{ index: 0, delta: { tool_calls: [{index: 0, id: "call_sleep", type: "function", function: {name: "bash", arguments: input}}] }, finish_reason: "tool_calls" }] };
    return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`, {headers: {"content-type":"text/event-stream"}});
  }});
  const child = Bun.spawn([process.execPath, resolve("tui/src/main.ts"), "-p", "--permissions", "full", "--provider", "openai", "--model", "fixture", "--base-url", `http://127.0.0.1:${server.port}/v1`, "run the test command"], {
    cwd: dir, env: {...process.env, SOPE_API_KEY: "fixture", SOPE_LIB: process.env.SOPE_LIB || resolve("build/libsope." + (process.platform === "darwin" ? "dylib" : "so")), SOPE_TRACE_DIR: join(dir,"trace")},
    stdin: "ignore", stdout: "ignore", stderr: "pipe",
  });
  try {
    await until(() => { try { shellPid = Number(readFileSync(join(dir,"shell.pid"),"utf8")); return shellPid > 0; } catch {return false;} });
    expect(alive(shellPid)).toBe(true);
    child.kill(signal);
    expect(await Promise.race([child.exited, Bun.sleep(5000).then(() => "timeout")])).toBe(code);
    await until(() => !alive(shellPid), 1000);
  } finally {
    child.kill("SIGKILL");
    await child.exited;
    if (shellPid && alive(shellPid)) process.kill(shellPid, "SIGKILL");
    server.stop(true);
    rmSync(dir, { recursive: true, force: true });
  }
}, 15000);

}

test("a closed stdout pipe still cleans up background shell tools", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sope-print-pipe-"));
  let shellPid = 0;
  let request = 0;
  const server = Bun.serve({ port: 0, fetch() {
    if (++request === 1) {
      const input = JSON.stringify({command: `echo $$ > '${dir}/shell.pid'; exec sleep 120`, run_in_background: true});
      const chunk = { choices: [{index: 0, delta: {tool_calls: [{index: 0, id: "background", type: "function", function: {name:"bash",arguments:input}}]}, finish_reason:"tool_calls"}]};
      return new Response(`data: ${JSON.stringify(chunk)}\n\ndata: [DONE]\n\n`);
    }
    let timer: ReturnType<typeof setInterval>;
    const body = new ReadableStream({
      start(controller) {
        timer = setInterval(() => controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({choices:[{index:0,delta:{content:"x".repeat(8192)},finish_reason:null}]})}\n\n`)), 10);
      },
      cancel() { clearInterval(timer); },
    });
    return new Response(body, {headers:{"content-type":"text/event-stream"}});
  }});
  const child = Bun.spawn([process.execPath, resolve("tui/src/main.ts"), "-p", "--permissions", "full", "--provider", "openai", "--model", "fixture", "--base-url", `http://127.0.0.1:${server.port}/v1`, "test pipe cleanup"], {
    cwd:dir, env:{...process.env, SOPE_API_KEY:"fixture", SOPE_LIB:process.env.SOPE_LIB || resolve("build/libsope." + (process.platform === "darwin" ? "dylib" : "so")),SOPE_TRACE_DIR:join(dir,"trace")},
    stdin:"ignore",stdout:"pipe",stderr:"ignore",
  });
  try {
    await until(() => { try { shellPid=Number(readFileSync(join(dir,"shell.pid"),"utf8"));return shellPid>0; } catch{return false;} });
    const reader = child.stdout.getReader();
    await reader.read();
    await reader.cancel();
    expect(await Promise.race([child.exited, Bun.sleep(5000).then(() => "timeout")])).toBe(0);
    await until(() => !alive(shellPid), 1000);
  } finally {
    child.kill("SIGKILL"); await child.exited;
    if (shellPid && alive(shellPid)) process.kill(shellPid,"SIGKILL");
    server.stop(true);
    rmSync(dir,{recursive:true,force:true});
  }
},15000);
