# Evidence-backed acceptance and delegated work

sope distinguishes three things: a process observation, an interpretation, and
acceptance against a host-defined criterion. A successful model turn is not an
acceptance verdict. The host supplies the criteria; the model selects evidence;
the native runtime computes the result.

## Host contract

Open a durable execution and set `acceptance.contract` to JSON before sending a
turn. The contract contains 1–32 unique criteria, at most 16 KB in total:

```json
{
  "criteria": [{
    "id": "format",
    "description": "The selected file is already formatted",
    "cwd": "/absolute/repository",
    "argv": ["gofmt", "-l", "example.go"],
    "exit_code": 0,
    "output": {"empty": true}
  }]
}
```

Each criterion requires an absolute `cwd`, literal `argv` and expected exit code.
The cwd string must match the recorded execution directory; CLI hosts should use
the physical directory (`pwd -P`) rather than a symlink alias.
`output` is optional and has either `empty: true` or a nonempty `contains` string.
These are exact predicates, not a universal test-framework parser. In particular,
`gofmt -l` exiting zero with a filename fails the example criterion.

The CLI supports explicit acceptance in print mode:

```sh
sope -p --execution-dir /absolute/run --acceptance contract.json 'Verify the task'
```

The contract file is read once by the host. Print mode exits zero only for an
accepted report; rejected/incomplete reports and execution errors exit nonzero.
The execution directory retains original evidence. This is an unreleased option;
no package/version bump is implied.

Embedding applications use `Agent.open(directory, options)` in JS or
`sope_agent_open` and `sope_agent_set_option` in C. The terminal outcome has an
`acceptance` object (or null), available through JS `Agent.outcome(turnId)`, Go
`Outcome.Acceptance`, and C `sope_agent_outcome`. The final text is the same native
JSON report. Once all pending tools have completed and current todos are resolved,
the runtime closes directly from the committed report without another provider
request or compaction. `end_turn` means the report was delivered; inspect its status.

## Evidence and verdicts

The model submits one `report` entry per fixed criterion:

```json
{"entries":[{"id":"format","evidence":{
  "session_id":"current-session", "agent_id":0, "call_id":17
}}]}
```

An entry may instead provide an explicit `unverified` reason. Optional
`interpretation` is preserved as `unverified_interpretation`. It cannot determine
a verdict. Missing/duplicate entries, foreign-session references, a different
command/directory, host-tool imitations and another task's observations are
rejected as tool errors.

Native checks retain their original receipt and up to 1 MiB of complete UTF-8
combined stdout/stderr in the same SQLite transaction as tool completion. Output
predicates use this snapshot, not a model quotation, clipped preview or mutable
archive file. Missing, oversized or non-UTF-8 snapshots cannot satisfy a text
predicate. The result includes the expected criterion, qualified observation,
verdict, snapshot completeness, byte length and bounded excerpt.

- `accepted`: all predicates are satisfied.
- `rejected`: at least one predicate failed (others can still be unverified).
- `incomplete`: no failed predicate, but at least one is unverified.

The contract and submitted report live outside summarized conversation history.
Lossy compaction cannot erase criteria or rewrite receipts. Completing a todo
list does not satisfy the contract. Missing reports trigger at most two closure
reconciliations, then an execution error. With a contract active, model prose is
buffered and the published final text is replaced by the native report. Ordinary
conversations without a host contract retain their existing behavior; they do
not acquire an acceptance guarantee.

## Freshness and concurrency

Known `write`, `edit` and `bash` starts/completions after a check began conservatively
make that observation stale, including overlapping calls. Report evaluation is
rechecked under the completion lock and again at closure. Subsequent execution,
mutation or child completion invalidates a previously submitted report. Submit
the report after the work has quiesced. Read-only `bash` also invalidates evidence;
use the structured read tools for inspection.

This is a check-observation contract, not a hermetic build or a filesystem
attestation. External processes, untracked host mutations, environment changes,
and side effects hidden inside host-selected check programs are not detected by
this rule. The host must choose suitable verifier programs and isolation. Exact
argv/cwd and `PASS` do not establish coverage quality, absence of bugs, or the
truth of arbitrary semantic conclusions. The report says so explicitly.

## Native subagents

The parent gets a structured result: session ID, child agent ID, native stop
reason, explicit `state`, `completed`, `model_report_unverified`, and a bounded index of native
receipts. Cancelled/failed children retain partial text without being marked
complete. Children inherit the provider/model/options and isolated history, but
not the parent's acceptance contract; the parent owns final acceptance.

`evidence({session_id, agent_id, call_id})` reads a child's original committed tool
result after the child has exited, after compaction, and after reopening the
execution. `evidence({agent_id})` lists its latest 32 native receipts. Lineage
comes from native subagent-start events. A child cannot read its parent or
siblings; a parent can inspect its own direct children. Historical recall is
allowed, but acceptance references must belong to the current parent task.

This follows Soren's useful separation of child identity, lifecycle and saved
results. sope retains its existing non-recursive shared-pool task model. Child
results are evidence-bearing messages rather than trusted verification prose.
This change does not add background child resumption or isolated worktrees:
interrupted child execution requires reconciliation of unknown leaf operations before
recovery. The reconstructed envelope includes separately labelled `host_reconciliations`
with bounded excerpts and call IDs. The working-state index retains
`host_reconciled_call_ids`; `evidence` can recall their full stored results.
These host assertions never create native check observations. The runtime
reconstructs the delegated outcome; the host cannot replace
an entire child result with a success assertion. A completed local check can be
valid evidence even when the child later fails, is cancelled, or is interrupted.
All native child state counts, the task's recent 32 child states, and latest eight check IDs per recent child are
re-rendered outside the model summary on every request, and copied into the
acceptance report as `delegations` (`total`, `states`, `recent`). Counts cover all
started children of the current task; the recent index is bounded so older
failures cannot disappear merely because their detailed entries were evicted.
Original tool results and the full journal remain authoritative. Native lifecycle
events supply these states; the projection does not interpret child prose.
Changes in this lifecycle snapshot invalidate an in-flight or saved report,
just as later workspace mutations invalidate its observations.

On resume, a committed report whose todos are resolved and evidence remains
current closes before any round-limit check, compaction, or provider request.
A process failure between report commit and terminal commit cannot turn completed
acceptance work into a dependency on another model response.

Metadata traces record report status and satisfied/failed/unverified counts,
without storing command output or interpretation text. The durable native outcome
is authoritative; trace records are diagnostics.
