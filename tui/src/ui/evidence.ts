// SPDX-License-Identifier: MIT
import type { ExecutionEvidence } from "sope";

/** Plain local transcript text, never injected into the model's conversation. */
export function formatEvidence(evidence: ExecutionEvidence): string {
  const lines = [
    "Execution evidence",
    `Session ${evidence.session_id}; agent ${evidence.agent_id}.`,
    `${evidence.receipts.length} retained executions (limit ${evidence.retention}; oldest first).`,
  ];
  if (!evidence.receipts.length) lines.push("No completed native executions recorded for this session.");
  for (const r of evidence.receipts) {
    const status = r.outcome === "timed_out" ? "timed out" : r.outcome === "process_exited_zero" ? "process completed" : r.outcome === "process_failed" ? "process failed" : r.outcome;
    const input = r.input_omitted || r.input === null ? "omitted from the retained record" : JSON.stringify(r.input);
    lines.push("", `#${r.call_id} · ${r.tool} · turn ${r.turn_id} · ${status} (exit ${r.exit_code})`,
      `Input: ${input}`, `Directory: ${JSON.stringify(r.cwd)}`, `Output archive: ${JSON.stringify(r.output_path)}`);
  }
  lines.push("", "Historical process outcomes only. Exit zero does not establish test success or current source correctness.");
  return lines.join("\n");
}
