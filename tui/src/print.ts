// Print mode (sope -p): one turn without the TUI. The answer streams to
// stdout; tool activity and errors go to stderr, so the output can be piped.
// Tools that change things are denied unless --allow-all.

import { AgentBridge } from "./agent/bridge";
import { ToolRunner } from "./agent/runner";
import { toolsFor } from "./agent/tools";
import { agentOptions, type Config } from "./config";
import { summarizeInput } from "./ui/chat";

export async function runPrint(config: Config, prompt: string, allowAll: boolean): Promise<number> {
  const err = (line: string) => process.stderr.write(`${line}\n`);
  const tools = toolsFor(config.provider);
  let exitCode = 1;
  let endedWithNewline = true;
  let finish!: () => void;
  const finished = new Promise<void>((resolve) => (finish = resolve));

  const bridge = new AgentBridge(agentOptions(config), (events) => {
    for (const ev of events) {
      if (ev.type === "closed") continue;
      if (ev.type === "tool_call") {
        err(`· ${ev.name} ${summarizeInput(ev.input).slice(0, 120)}`);
        runner.run(ev.callId, ev.turnId, ev.name, ev.input);
      } else if (ev.agentId) {
        continue; // subagents: only their tool calls need us
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
  const runner = new ToolRunner(
    bridge.agent,
    tools,
    async (req) => {
      err(`sope: denied ${req.tool.name} (run with --allow-all to permit edits and commands)`);
      return "deny";
    },
    () => {},
  );
  runner.allowAll = allowAll;

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

  bridge.agent.send(prompt);
  await finished;
  await bridge.shutdown();
  return exitCode;
}
