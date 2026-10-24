# Long-task working state experiment

The provider recovery change was committed as `120285c`. Working-state and
completion reconciliation were committed as `f862a7c`. Evidence provenance is
`79b68fd`; compaction invocation/result correlation is `6ac052a`; stream terminal
diagnostics are `d18942c`; content-aware read observations are `36a3fd6`. These
are local development commits, not a versioned release. No remote publication
is part of this task.

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
results can be retrieved by session and call ID after compaction and durable reopening.
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

The final compaction-header refinement passed 62 focused JS tests and the three
affected CTest targets (agent, compact and Go SDK). The default development
library was rebuilt. The full 308-test run preceded this header-only refinement;
it is not reported as a second full-suite run on the final commit.

## Independent fixed-run outcome

The full task ended normally (`end_turn`) after 2,306.692 seconds (38 minutes
27 seconds), with 62 completed tools, five compactions and four native provider
retries. There were no follow-up messages, external edits of its tests/reports,
or operator completion prompts. All six model-authored todos were completed;
the bounded completion-reconciliation path was not needed in this run. Shutdown
reported `drained: true` and zero active spans. The ten original module/build
files retained their recorded hashes.

This run used immutable `f862a7c` throughout. Later provenance, transcript and
diagnostic changes were not hot-swapped into it. Within session
`eb2bc6004cda03d1ef3542cef8984c41`, the journal establishes:

| Call | Actual check | Observed result |
|---|---|---|
| 39 | `go test -mod=readonly -count=1 -run TestLoom ./pkg/common/arenaskl/` | Exit 0 after the model repaired its own invalid assertions |
| 45 | Seeded reference-model test | Exit 0 |
| 51 | `-race -run TestLoomConcurrent` | Exit 0; scope is the added concurrent tests |
| 53 | Full target package, without a `-run` filter | Exit 0 |
| 54 | `FuzzLoomIterModel`, 60 seconds, two workers | PASS, 254,258 executions; 109 cached baseline inputs, 36 new interesting inputs |

Every check used a bounded tool timeout. The requested explicit `GOWORK=off`
was omitted. Passing process outcomes do not establish complete instruction
adherence or adequate assertions. No MatrixOne defect is established here.

Five subsequent reads had an identical traced identity to an earlier request
(calls 19, 21, 27, 42 and 60). Some supported test editing or progress recovery;
the counter is not a measure of unnecessary reading. The run cannot establish
that rereading is eliminated or quantitatively improved over the shorter,
operator-stopped baseline.

The final report retained source-interpretation errors. It claimed Iterator's
documentation required a single goroutine, although iterator.go:37 says all
iterator methods are thread-safe. This observation concerns what the document
says, not independent proof of thread safety. It also reported 11 new boundary
tests where the file contains 10. Progress notes were stale through much of the
run and updated only at closeout. The fifth summary mislocated a sentinel in a
different test file. No promotion of failed checks to successful checks was
observed in the sampled summaries, but these errors show why summaries and todo
completion must remain distinct from verified facts. No formatting check was
recorded in the main run despite its claimed final self-check.
The separate audit's read-only `gofmt -l` output listed
`loom_test_bounds_test.go`, confirming a formatting requirement remained unmet.

The final response itself stalled and recovered through a provider retry.
Existing metadata did not distinguish receipt of a finish reason from receipt
of the stream terminal event. Follow-up `d18942c` adds numeric `finish_state`
and `stream_done` fields. Nineteen focused provider/trace tests and TypeScript
passed, including a finished text delta whose absent stream terminator must
still time out and successful text/tool termination. This change improves
diagnosis; it does not treat a plausible final paragraph as protocol completion.

## Low-threshold audit and read-observation correction

A separate GLM 5.3 audit on immutable `d18942c` used a deliberately lower
12,000-token threshold and a 15-minute host ceiling. It reached 26 completed
tools, nine compactions and three retries. The host deadline cancelled it at
900.036 seconds with two completed todos and one in progress. It wrote a report
but did not finish autonomously. Shutdown drained with zero active spans.
This does not negate the main run's independent normal completion; it is also
not a successful audit. Metadata on a stalled summary showed `finish_state: 0`
and `stream_done: 0` before retry.

The audit reread unchanged reports, including a third full read of findings.md.
Successful read-only shell commands had reset the general read counters. Follow-up
`36a3fd6` moves native text-read repetition handling behind actual file I/O.
Successful observations retain file size/content fingerprint and an original
result ID, atomically with tool results. A third identical request with matching
content returns a qualified historical-result reference instead of repeating the
payload. Shell commands and unrelated writes cannot erase those observations;
changed contents reopen delivery. This is bounded content deduplication, not
skipping file I/O or proving freshness indefinitely. Explicit evidence retrieval
is available when the original contents are needed after compaction.

The new regression fails against `d18942c` and passes with the correction. It
covers compaction, unrelated native writes, read-only commands, same-size
external edits with restored mtime, exact historical recall, and reopening for
a new user turn. The change passed 310 Bun tests, 11 CTest targets, all nine
ASan/UBSan and all nine TSan targets. Final small refinements also passed 21
focused JS tests, four affected native targets under normal and both sanitizer
builds, and TypeScript. No compatibility layer or versioned release was added.

The audit report itself also contains errors: it repeated the incorrect count
of 11 boundary tests and treated native `test_verdict: unverified` as absence of
actual successful runner output. The original outputs include Go `ok` and fuzz
`PASS`. Native runtime assessment, framework-reported results, and assertion
quality are separate claims. Working-state guidance now states this explicitly.
The audit's exported JSON had embedded long output strings that the read tool
could clip by line length; the full artifact existed but the model did not
recover every detail. A subsequent fresh audit separates execution output into
text files and returns to the main run's 24,000-token threshold. These changed
conditions preclude a controlled before/after model-quality comparison.

## Fresh audit on the final runtime

An independent audit using immutable `36a3fd6` ended normally after 353.095
seconds (5 minutes 53 seconds), with 14 completed tools, one compaction and one
provider retry. All three model-authored todos were completed without follow-up
prompts. Shutdown drained with zero active spans. The ten original module/build
files retained their hashes.

The report correctly distinguished the original session
`eb2bc6004cda03d1ef3542cef8984c41` from its own session
`18df6383097f0ac08ef56d158ed78b90`, recognized the original Go `ok` and fuzz `PASS`
outputs, counted ten boundary tests, and identified the formatting omission.
Current-session check #8 ran `gofmt -l .`: exit zero with the boundary test path
in output. The model interpreted that output as a formatting failure rather
than treating the process exit as a formatting pass. The audit reused existing
package/race/fuzz evidence instead of rerunning those checks.

The final report is still not a verified acceptance decision. It incorrectly
says the original report omitted risks even though that report has explicit
unverified-boundary and coverage-limit sections. It also changes the meaning of
the first task in its acceptance matrix and suggests coverage measurement could
support a broad no-defect claim. These are interpretation errors, not new native
execution failures, and the raw report is preserved. Neither reported completion
nor an independent model audit establishes correctness by itself.

The trace contains only one native `read`, with no repeated native-read identity;
most source inspection used shell commands. Therefore this live run demonstrates
normal completion and recovery on the final runtime, not live proof that the
new duplicate-read branch fired or that semantic rereading disappeared. Its
content-deduplication branch is established by the failing-before/passing-after
regression. The native budget, original request, execution provenance and
retrievable outputs provide a recoverable basis for review; model-authored
claims remain fallible.

## Evidence locations and limits

Local evidence roots:

- `/Users/linjunhong/.loom/tmp/sope-long-task-20261025`: baseline driver, task prompt,
  immutable library, journal, summaries, metadata trace and validation logs.
- `/Users/linjunhong/.loom/tmp/sope-long-task-fixed-20261025`: independent fixed run,
  its immutable library, exact prompt, journal and generated artifacts.
- `/Users/linjunhong/.loom/tmp/sope-long-task-audit-20261025`: low-threshold audit,
  preserved incomplete report and qualified execution export.
- `/Users/linjunhong/.loom/tmp/sope-long-task-audit-final-20261025`: fresh audit
  using the read-observation correction and separately readable output files.

These stochastic runs are observations, not a controlled model-quality benchmark.
Plan consistency does not prove that its items or report are correct. Repeated
reads can be justified; the trace detects equal requests, not arbitrary shell
semantics or file freshness. The journal contains exact evidence; metadata traces
alone cannot validate source interpretations or test assertions. Original MO
checkouts and Loom production state are outside the experiment.
