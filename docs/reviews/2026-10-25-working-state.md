# Long-task working state experiment

The provider recovery change was committed as `120285c`. Working-state and
completion reconciliation were committed as `f862a7c`. These are local development
commits, not a versioned release. No remote publication is part of this task.

## Workload

Use GLM 5.3 only through the real sope AgentBridge and native runtime. Reuse the
same independent MatrixOne `35e873a261b0b50ebbffe84b4264c65f42dc32e7` source archive
and prior model-written arenaskl tests/report as initial material. The six-part
task asks the model to audit those artifacts, extend boundary tests, improve a
reference-model test, assess the concurrency contract, run package/race/fuzz
checks, and reconcile the final report. The task allows no changes to original
module files or go.mod/go.sum. It requires no database service or online action.

Both phases have a 45-minute host ceiling, 150 model-round ceiling, 24,000-token
compaction threshold, 4,096 summary output tokens, and 360-second logical request
deadline. They run sequentially with immutable libraries and separate execution
directories. Wall-clock duration includes provider stalls and retries; neither
run is instructed to consume its entire allowance. No synthetic fault is injected
into the real GLM requests. The same task prompt is used in both phases; the
fixed phase also uses the revised sope system prompt.

## Baseline observation

The baseline ran 945.305 seconds (15 minutes 45 seconds), with 23 completed tools,
one successful compaction and three native retries. After its first compaction,
read calls #13 and #14 repeated the same complete file/range as #3 and #4 before
any test-file change. Source reading also moved through bash, which an exact
read-identity counter cannot classify semantically. The model wrote coverage and
progress notes and reached the second work item. Some test execution used a
shell pipeline despite the task's request for literal `check` invocations.

The supervisor cancelled this baseline after reproducing the post-compaction
rereads, to move to the validated fixed build. This was a controlled observation
cutoff, not autonomous completion or proof that the 45-minute budget would have
been exhausted. Shutdown drained with zero active spans. Original materials
remain available separately from the fixed run.

## Runtime changes and deterministic evidence

[Working-state design](../design/working-state.md) separates the current request,
model-authored plan, native execution observations, and fallible summary. The
latest native plan commits atomically with its tool result. Historical tool
results can be retrieved by call ID after compaction and durable reopening.
Completion reconciliation has a durable two-attempt bound. Blocked items retain
a reason and render separately from completed items. Trace read fingerprints
remain private to each trace and do not expose paths or contents.

Fixtures reproduce a summary that falsely says everything passed: subsequent
requests still receive the original constraint, pending plan and actual failed
process outcome. Other checks cover bounded unresolved completion, invalid or
oversized plan replacement, deterministic parallel replacement, host overrides,
UTF-8 result pagination after reopen without replay, and both wire APIs. The
initial five working-state fixtures fail against the immutable baseline.

Validation at `f862a7c`: 306 Bun tests and 11 CTest targets passed. ASan/UBSan and
TSan each passed all nine native targets; the final bound/accounting refinements
also passed the three affected native targets under each sanitizer. The final
additional oversized-plan case and TUI checks passed 19 focused tests. TypeScript,
metadata and diff checks passed. The default development library was rebuilt.
No Linux or remote CI result is claimed.

## Provenance correction found during the fixed run

The first fixed run's coverage report incorrectly associated current call IDs
#2/#3 (directory inspection and reading a previous report) with historical test
claims from another run. It also claimed cancelled observations that had not
occurred in this execution. The report is preserved verbatim in the evidence
root. This is a model inference error; terse runtime entries containing only
call IDs/outcomes also made the association ambiguous.

The follow-up change qualifies receipts and working state with session/agent/
turn identity and includes bounded exact invocation data. Historical retrieval
requires both the current session ID and call ID, rejects bare/foreign references,
and still limits results to the calling agent. A two-session fixture reuses call
#1 for a failed check and an unrelated echo, then verifies foreign/bare recall
is rejected and the correct observation remains retrievable. This establishes
provenance enforcement, not a guarantee that model-written prose is correct.
The provenance revision passed 308 Bun tests, all 11 CTest targets, TypeScript,
and the three affected targets under both ASan/UBSan and TSan.

## Evidence locations and limits

Local evidence roots:

- `/Users/linjunhong/.loom/tmp/sope-long-task-20261025`: baseline driver, task prompt,
  immutable library, journal, summaries, metadata trace and validation logs.
- `/Users/linjunhong/.loom/tmp/sope-long-task-fixed-20261025`: independent fixed run,
  its immutable library, exact prompt, journal and generated artifacts.

These stochastic runs are observations, not a controlled model-quality benchmark.
Plan consistency does not prove that its items or report are correct. Repeated
reads can be justified; the trace detects equal requests, not arbitrary shell
semantics or file freshness. The journal contains exact evidence; metadata traces
alone cannot validate source interpretations or test assertions. Original MO
checkouts and Loom production state are outside the experiment.
