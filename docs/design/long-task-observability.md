# Long-task diagnostics

## Contract

One trace belongs to one AgentBridge lifetime, shared by print and interactive
sessions. Native event sequence, agent ID, turn ID and tool call ID identify
execution; a trace UUID identifies a host lifetime across restarts. Wall time
supports log correlation; monotonic elapsed time measures durations. Execution
journals remain the authority for recovery, not diagnostic JSONL.

Trace is opt-in through SOPE_TRACE_DIR. It contains metadata only: lifecycle,
counts, byte lengths, usage, provider attempts/status/durations and tool spans.
No prompt, reasoning, tool arguments/results, error bodies, URLs, API keys or
process environment are recorded. Provider telemetry uses an allowlisted JSON
schema in LOG events; arbitrary provider logs are not persisted.

Streaming text is counted, not written per token. A fifteen-second heartbeat reports
progress and active work even when the model is silent. Provider byte progress
is sampled at most once per fifteen seconds, including hidden compaction output. Tool starts and ends are
correlated across parallel subagents. An unmatched end is marked, not assigned
an invented duration. A stopped host with no terminal record is incomplete.

Files use exclusive creation and mode 0600. Writes are asynchronous and buffered,
with a 256 KiB queue limit and a 64 MiB lifetime limit. Overload is explicit via
gap/limit records and warnings; trace failures must not fail the agent or grow
memory without bound. Normal shutdown drains trace output before exiting.

## Validation workload

Reuse Loom's module-hunt instructions with a clean MatrixOne source snapshot
and run GLM 5.3 with unit/whitebox/fuzz work. The selected bytejson module's
outer package needs unavailable native dependencies; use its real pure-Go
validation dependency, pkg/internal/bytejsonvalidate, for the local workload.
Keep reports/tests in the snapshot, production Loom and MatrixOne untouched.
Record actual results separately from hypotheses. Native/host fault tests cover
provider retries/truncation, cancellation, long shell commands, bounded tracing,
and cleanup. No GitHub publication is part of this experiment.

## Compaction failure policy

Live GLM 5.3 execution exposed a failed-compaction loop: after each tool round,
the same soft threshold re-entered summarization, spending minutes on repeated
failed requests. A turn now remembers a failed proactive compaction. It retains
all history and continues normal requests while within the hard context budget;
new input or manual compaction starts a fresh attempt. The existing single
provider-overflow recovery remains bounded and stops if its summary fails.
No partial summary is installed, no tool is replayed, and the context limit is
never bypassed. This state belongs to the turn, not a provider-specific heuristic.

## Interactive trace cost

The TUI event panel coalesces adjacent text/thinking fragments for the same
agent and turn into byte/chunk counts. Lifecycle events and tool boundaries
remain separate. Its 2000-entry ring replaces array shifting, and payload
previews are bounded before formatting. The panel is for interactive inspection;
only the opt-in diagnostic file follows the metadata-only persistence contract.
