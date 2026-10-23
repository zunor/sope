// SPDX-License-Identifier: MIT
// Print mode (sope -p): one turn without the TUI. The answer streams to
// stdout; tool activity and errors go to stderr, so the output can be piped.
// Nobody is there to answer a permission request, so the mode decides
// alone: "Approve for me" runs what it would let through anyway and refuses
// the rest, "Ask for approval" refuses everything that would ask, and
// "Full access" runs it all.

import { AgentBridge } from "./agent/bridge";
import type { ImageFile } from "./agent/images";
import { judge, modeLabel } from "./agent/permissions";
import { HostToolRunner } from "./agent/runner";
import { describeCall, hostToolsFor, parseInput } from "./agent/tools";
import { agentOptions, type Config } from "./config";

export async function runPrint(config: Config, prompt: string, images: ImageFile[] = []): Promise<number> {
  const err = (line: string) => process.stderr.write(`${line}\n`);
  const tools = hostToolsFor(config.provider);
  let exitCode = 1;
  let endedWithNewline = true;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));

  const bridge = new AgentBridge(agentOptions(config), (events) => {
    for (const ev of events) {
      if (ev.type === "closed") continue;
      if (ev.type === "turn_end") runner.endTurn(ev.turnId, ev.agentId);
      if (ev.type === "tool_call" || ev.type === "tool_start") {
        err(`· ${ev.name} ${describeCall(ev.name, parseInput(ev.input)).replace(/\s+/g, " ").slice(0, 120)}`);
        if (ev.type === "tool_call") runner.run(ev.callId, ev.turnId, ev.name, ev.input, ev.agentId);
      } else if (ev.type === "permission") {
        const v = judge(config.permissions, ev.name, parseInput(ev.input));
        if (!v.allow && config.permissions === "auto") err(`sope: refused ${ev.name}: ${v.reason}, and -p cannot ask (--permissions full runs it)`);
        else if (!v.allow) err(`sope: refused ${ev.name}: ${modeLabel(config.permissions)} is on, and -p cannot ask (--permissions auto or full)`);
        bridge.agent.permit(ev.callId, v.allow);
      } else if (ev.agentId) {
        continue; // subagents: only their tool calls matter here
      } else if (ev.type === "text_delta") {
        process.stdout.write(ev.text);
        endedWithNewline = ev.text.endsWith("\n");
      } else if (ev.type === "subagent_start") {
        err(`· agent ${ev.subagentType}`);
      } else if (ev.type === "error") {
        err(`sope: ${ev.message}`);
      } else if (ev.type === "turn_end") {
        if (!endedWithNewline) process.stdout.write("\n");
        exitCode = ev.stopReason === "end_turn" ? 0 : 1;
        finish();
      }
    }
  });
  for (const tool of tools) bridge.agent.registerTool(tool);
  const runner = new HostToolRunner(bridge.agent, tools);

  // `sope -p ... | head` closes the pipe early: stop quietly, like other CLIs.
  process.stdout.on("error", (e: NodeJS.ErrnoException) => {
    if (e.code === "EPIPE") process.exit(0);
    throw e;
  });

  let interrupts = 0;
  process.on("SIGINT", () => {
    if (interrupts++ === 0) bridge.agent.cancel();
    else process.exit(130);
  });

  for (const img of images) bridge.agent.attachImage(img.bytes, img.mediaType);
  bridge.agent.send(prompt);
  await finished;
  await bridge.shutdown();
  return exitCode;
}
