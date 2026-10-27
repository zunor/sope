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
  const options = agentOptions(config);
  let exitCode = 1;
  let interrupted: number | undefined;
  let outputClosed = false;
  let finishing = false;
  let endedWithNewline = true;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));

  const bridge = new AgentBridge(options, (events) => {
    for (const ev of events) {
      if (ev.type === "closed") continue;
      if (ev.type === "turn_end") runner.endTurn(ev.turnId, ev.agentId);
      if (ev.type === "tool_call" || ev.type === "tool_start") {
        err(`· ${ev.name} ${describeCall(ev.name, parseInput(ev.input)).replace(/\s+/g, " ").slice(0, 120)}`);
        if (ev.type === "tool_call") runner.run(ev.callId, ev.turnId, ev.name, ev.input, ev.agentId);
      } else if (ev.type === "permission") {
        if (interrupted !== undefined) continue; // cancellation owns pending calls now
        const v = judge(config.permissions, ev.name, parseInput(ev.input), options.cwd);
        if (!v.allow && config.permissions === "auto") err(`sope: refused ${ev.name}: ${v.reason}, and -p cannot ask (--permissions full runs it)`);
        else if (!v.allow) err(`sope: refused ${ev.name}: ${modeLabel(config.permissions)} is on, and -p cannot ask (--permissions auto or full)`);
        bridge.agent.permit(ev.callId, v.allow, v.allow ? "" : `Automatic permission policy (${config.permissions}): ${v.reason}. This noninteractive run cannot ask for approval; adjust the operation to the allowed scope.`);
      } else if (ev.type === "tool_end" && ev.name === "report" && ev.isError) {
        err(`sope: acceptance report: ${ev.result}`);
      } else if (ev.agentId) {
        continue; // subagents: only their tool calls matter here
      } else if (ev.type === "text_delta") {
        if (!outputClosed) process.stdout.write(ev.text);
        endedWithNewline = ev.text.endsWith("\n");
      } else if (ev.type === "model_retry") {
        const notice = `Model request interrupted (${ev.reason}${ev.validationReason ? `: ${ev.validationReason}; rejected batch not executed` : ""}); retrying attempt ${ev.attempt} in ${(ev.delayMs / 1000).toFixed(1)}s.`;
        err(`sope: ${notice}`);
        if (ev.discardedTextBytes && !config.acceptanceContract && !ev.compaction && !outputClosed) {
          process.stdout.write(`\n[${notice} Previous attempt output was discarded.]\n`);
          endedWithNewline = true;
        }
      } else if (ev.type === "subagent_start") {
        err(`· agent ${ev.subagentType}`);
      } else if (ev.type === "error") {
        err(`sope: ${ev.message}`);
      } else if (ev.type === "turn_end") {
        if (!endedWithNewline && !outputClosed) process.stdout.write("\n");
        exitCode = ev.stopReason === "end_turn" ? 0 : 1;
        if (config.acceptanceContract && ev.stopReason === "end_turn")
          exitCode = bridge.agent.outcome(ev.turnId).acceptance?.status === "accepted" ? 0 : 1;
        finish();
      }
    }
  }, config.executionDirectory);
  for (const tool of tools) bridge.agent.registerTool(tool);
  const runner = new HostToolRunner(bridge.agent, tools);

  // A supervisor must be able to stop the entire task, including shell tools.
  // Cancellation drains native tool outcomes before shutdown reaps all children.
  const cancel = (code: number) => {
    interrupted ??= code;
    bridge.trace?.record("host.cancel", { exitCode: code });
    if (!finishing) bridge.agent.cancel();
  };
  const onInt = () => cancel(130);
  const onTerm = () => cancel(143);
  const onHup = () => cancel(129);
  const onOutputError = (e: NodeJS.ErrnoException) => {
    outputClosed = true;
    cancel(e.code === "EPIPE" ? 0 : 1);
  };
  process.stdout.on("error", onOutputError);
  process.on("SIGINT", onInt);
  process.on("SIGTERM", onTerm);
  process.on("SIGHUP", onHup);
  try {
    for (const img of images) bridge.agent.attachImage(img.bytes, img.mediaType);
    bridge.agent.send(prompt);
    await finished;
    return interrupted ?? exitCode;
  } finally {
    finishing = true;
    await bridge.shutdown();
    process.stdout.off("error", onOutputError);
    process.off("SIGINT", onInt);
    process.off("SIGTERM", onTerm);
    process.off("SIGHUP", onHup);
  }
}
