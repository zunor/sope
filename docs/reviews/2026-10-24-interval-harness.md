# GLM 5.3 interval workload: harness behavior

Date: 2026-10-24. Sope revision: `54ff46a`, including the Bash pipefail fix.
Model: `glm-5.3`, low reasoning effort, on the configured endpoint. No other
model was invoked. A read-only model-list lookup preceded the user's decision
to retain GLM.

## Experiment

The real AgentBridge/native agent investigated `pkg/fileservice/interval` in
an independent archive of MatrixOne commit
`35e873a261b0b50ebbffe84b4264c65f42dc32e7`. The task allowed new tests/reports,
with no production changes. Its package baseline passed on the same source.
The existing release skill edit was not part of the experiment.

The development library was explicitly selected and hashed in the local
manifest. The host imposed a 20-minute deadline, at most three turns, 60 model
rounds per turn, 8,192 output tokens per request, and a 32,000-token proactive
compaction threshold. These are experiment settings, not new product defaults.
The host could request a generic second-pass review after a finished report.
No faults or tool outputs were injected, and no human-selected bug hypothesis
or test correction was fed to the model during investigation.

## Observed boundaries

| Boundary | Evidence | Assessment |
| --- | --- | --- |
| Failed test pipelines | Calls 16–18 piped Go tests through `tail`. Syntax, type and assertion failures all produced `is_error=true`, exit 1. | The previous pipefail fix works in a real model workload. |
| Correcting errors | The model fixed syntax and casts, then corrected its wrong expectation that adjacent half-open intervals overlap. | Error feedback enabled recovery without human correction. |
| Arbitrary script status | Call 22 appended `echo EXIT=$?` after a failed fuzz check. The output showed `FAIL` and `EXIT=1`, but the shell's final exit was 0. | Ordinary Bash semantics remain. The harness cannot infer every script's intended success criterion. |
| Model efficiency | Seven caller-search calls repeated or broadened similar lookups; the model then reran the already-passing baseline. | Execution bounds do not guarantee useful progress. |
| Test quality | A visit-order probe logs a mismatch instead of failing. Other comments claim broader coverage than their assertions. | A passing process does not establish a valid test oracle. |

Five initial probes eventually printed individual PASS results and a package
pass. That evidence came from actual output, not just the wrapper's status.
The first fuzz attempt failed during seed-corpus validation, before a timed
fuzz campaign began. Its expected unique set conflicted with duplicate entries
returned after repeated insertion; that observation alone is not a product bug.

The model corrected that assumption without human assistance. The next fuzz
campaign completed 873 executions in 25 seconds and passed. Whole-package
tests and the selected probe tests under `-race` also passed. No MatrixOne
production defect was confirmed. The race run does not prove concurrency
coverage: the generated probes themselves do not introduce concurrent access.

## Confirmed harness defect and correction

The model wrote its report path in the snapshot's parent directory. Auto mode
correctly rejected the operation, with an explicit outside-workspace reason.
The experiment host discarded that reason when calling `permit`, as did the
production `runPrint` implementation. The model received only a generic
user-denial message. It tried `mkdir` on the same wrong path twice before
eventually correcting the path itself. The boundary held throughout.

Print mode now passes the existing policy reason to the native agent, including
the noninteractive limitation. Native denial text no longer attributes every
decision to a human user. Permission rules are unchanged. Interactive TUI
approvals still require the user's decision as before.

A local HTTP fixture exercises the actual print CLI: deny an outside-workspace
write, inspect the next provider request for the precise reason and path, then
perform a permitted workspace write. The test failed against the previous
code and passed with the fix; the denied file stays absent. This fixture
validates feedback and enforcement, not model intelligence. The fixture uses
no external model or billed request.

The initial real run reached its 20-minute deadline: 34 tools, 353 trace rows /
96,541 bytes, three provider retries, successful shutdown drain, and zero
active spans. It saved a checkpoint but had not finished findings or review.
The same durable session was reopened with the fix for bounded report
completion. Because the model had already corrected the path before the first
deadline, any successful continuation cannot prove that the new reason caused
its correction.

The resumed run completed normally in 179.678 seconds, with three tool calls,
one provider retry and one successful automatic compaction (2,655-byte
summary). It wrote findings, reran the package once despite the instruction to
reuse evidence, and finished its todo list. It did not execute the separate
second-phase review. Both host lifetimes drained cleanly with zero active
spans: 37 total tools, 405 trace records / 110,450 bytes over about 23 minutes
of active execution. No failed tool outcome was silently replayed on reopen.

The generated report remains an untrusted artifact. It says roughly 875 fuzz
executions (the actual output says 873), omits initial compilation failures,
and claims tests were not repeated (the journal shows repeated baselines and
package checks). Passing finite random tests does not rule out all defects or
prove coverage of a particular fixup branch. A loose height bound does not
prove red-black invariants. The unchanged visit-order test still logs rather
than asserts a mismatch. These limitations were recorded by the supervising
review, not automatically detected by sope.

Validation of the fix: 244 Bun tests passed, 11/11 CTest passed, and TypeScript
typecheck passed. No new Linux or sanitizer run was performed for this string
and feedback change.

The fix is committed as `660705f`; the default local development library was
rebuilt and used for the continuation. Six tracked files (the target package,
`go.mod` and `go.sum`) still match the MatrixOne baseline byte for byte.

Raw evidence is local under `.loom/tmp/sope-interval-20261024`: source snapshot,
execution journal/artifacts, trace, model output, manifest and task record.
It is not included in the public repository.
