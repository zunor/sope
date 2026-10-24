# GLM 5.3 long-task recovery

Date: 2026-10-25 (Asia/Shanghai). Sope base: `569ffa4` plus the local changes
recorded in the experiment manifests. Local development validation on macOS
arm64; embedded version remains 0.5.0. No publication or MatrixOne production
change is part of this task.

## Workload and evidence

Read Loom's module-test workflow and OpenCode's model retry policy and session
attempt handling. Ran the real sope AgentBridge/native runtime with GLM 5.3
only, against `pkg/common/arenaskl` in an independent archive of MatrixOne
`35e873a261b0b50ebbffe84b4264c65f42dc32e7`. The module dependency closure has no
CGo files. Its clean package baseline passed before model execution.

The task permits new tests and local reports only. Existing source and tests,
`go.mod` and `go.sum` are preserved. Loom production services, its database,
provider settings and the original MatrixOne checkout are not changed. This is
a simulation of Loom's module task through sope, not a new Loom runtime adapter.

Raw evidence is in `/Users/linjunhong/.loom/tmp/sope-arenaskl-20261025`:
immutable library copies and manifests, execution journal/output archives,
metadata traces, model output, source snapshot and fixture/validation logs.
`manifest-final.json` identifies the final source files and validation library;
`manifest-fixed.json` identifies the earlier immutable continuation library.
No credentials or raw model/tool content are included in committed traces.

## Confirmed runtime gaps and correction

The old provider retried at most three attempts, principally HTTP 429/5xx and
transport failures with status zero. It did not recover from HTTP-200 transient
error envelopes, incomplete streams or native idle expiry, and did not honor
Retry-After. Once output was visible it stopped rather than defining how to
abandon that attempt. Local fixtures reproduced these failures against the
immutable baseline, including a two-second Retry-After that was retried early.

The new contract is in [provider-retry.md](../design/provider-retry.md): one
immutable logical request owns an absolute deadline and bounded attempts;
individual attempts own partial text, tool arguments and idle timers. A typed
retry event separates abandoned output. Only a complete accepted response can
enter history or execute tools. It does not synthesize user prompts or replay
committed tool rounds. Terminal authentication, request, context, output-limit
and complete malformed-batch failures remain outside transient retries.

Backoff is jittered, capped and honors bounded Retry-After seconds/dates.
Monotonic ready times prevent incidental task wakeups from bypassing it.
Timeout retries are separately bounded. Metadata now identifies failure class,
delay, request age and remaining budget, plus buffered text/reasoning/tool-byte
counts to distinguish an idle connection from a still-generating response.

## Live observation

The baseline ran 677.282 seconds, completed 15 tools and one compaction, and
performed two connection retries. A later compaction emitted partial data then
hit its idle deadline; the existing compaction policy retained history and
continued. A normal model request subsequently emitted 422 text bytes, stalled,
and ended the turn with an idle timeout before its proposed tests were written.
The process drained successfully with zero active spans.

The fixed process reopened the same journal. No failure was injected into either
live run. Its first compaction stalled after 5,931 provisional summary bytes
and 69 reasoning bytes. Native code emitted `model_retry` after 164.960 seconds,
waited 910 ms, then retried the same request. Attempt two completed and installed
a 5,120-byte summary. Tool execution continued without an outer host retry or
another user turn. This establishes live recovery for that incident; it does
not make completion latency or model quality deterministic.

The model continued to repeat source reading and reran a passing package
baseline despite instructions to reuse it. A later summary introduced inaccurate
source claims. Runtime execution receipts do not validate those interpretations.
Model-generated tests and reports require separate assessment.

The fixed phase reached its 720.014-second host deadline while fuzz call #41
was active. Its result was `Cancelled`, not a pass. A final bounded continuation
used the final validation library, the same journal, a 6-minute host budget and
a 64,000-token compaction threshold (instead of the experiment's 16,000). Its
prompt supplied only verified execution state and asked for remaining fuzz,
reporting and self-check work; no defect hypothesis or test implementation was
provided. This is assisted task completion, not evidence that the previous
low-threshold configuration would have finished by itself.

The fixed phase also recovered a 30-second connection timeout in round 21.
The final continuation recovered another 30-second connection timeout in round
2 and completed normally in 147.309 seconds. Across all three
phases: 47 completed tool events (including errors/cancellation), 5 provider
retries, 5 successful compactions and approximately 25 minutes 45 seconds of
active runtime. Each process drained with zero active spans. Trace volume is
recorded in the local `trace-summary.json`.

## Module test outcome and review limits

GLM wrote two new test files, six basic tests plus a deterministic fuzz-seed
test and a Go fuzz target. It corrected a guessed Go executable path after
exit 126, and corrected its own expectation that duplicate insertion succeeds
after a real assertion failure. The supervising agent supplied neither fix.

Actual results: package test #36 passed after the six basic tests were added;
the corrected seed test #40 passed; the completed 20-second, two-worker fuzz
run (background shell 1, observed by #44) passed with exactly 79,207 executions.
The earlier cancelled fuzz attempt is not counted as success. No MatrixOne
production defect was confirmed. Ten original files (the complete target
module plus go.mod/go.sum) match the source revision byte for byte; both new
files pass a read-only gofmt check.

The generated report is an untrusted artifact with remaining limitations:

- The package pass preceded addition of the fuzz file; it is not a single final
  whole-package run over both new files. Seed and fuzz evidence are separate.
- The test claiming Last ignores the upper bound actually removes that bound
  before calling Last, so it does not prove that particular statement.
- The fuzz oracle checks keys/order/seeks over bounded single-threaded inputs;
  it does not check values, duplicate insertion behavior, concurrency or memory
  retention. The Close probe logs retained state; it proves no general lifetime
  or memory-retention conclusion.
- Several “excluded” hypotheses rest on contract inspection rather than a
  dedicated reproduction. Passing these finite checks does not establish that
  the module is defect-free.
- `reports/1.json` uses a `[Bug]: none found` title and lacks Loom's required
  issue-report fields. It is a local zero-finding note, not a valid issue for
  automatic ingestion or publication. `reports/findings.md` records the work.

These model-quality limits are recorded rather than hidden by modifying the
model's report. The runtime fix establishes recovery and execution provenance;
it does not automatically certify engineering conclusions.

## Validation

- Full Bun suite: 297 passed, 0 failed; TypeScript check passed.
- CTest: 11/11, including Go shared/static integration and SDK race checks.
- ASan/UBSan: 9/9 native tests. TSan: 9/9 native tests.
- Additional native client under each sanitizer: 503, partial text/reasoning
  and tool arguments, idle stream, structured transient SSE error, then success.
  Five attempts, four retry events, zero error events, zero dispatched tools;
  history contains only accepted text; both exited zero with no diagnostics.
- Fixtures cover discard boundaries, durable reopening, no tool replay,
  compaction installation, Retry-After seconds/dates/invalid/oversized hints,
  queued input during backoff, cancellation, retry exhaustion, timeout allowance,
  terminal controls, Responses API recovery and TUI/print attempt separation.
- Final metadata counters and the general timeout label passed 45 provider,
  retry, TUI/print and trace tests; TypeScript checking passed again. Earlier
  sanitizer evidence is reused for these telemetry-only refinements.

The original native unreachable-endpoint and Go truncated-Responses tests used
short fixture deadlines. Their retry delays are now explicitly 10 ms, retaining
the error/no-dispatch assertions while exercising the new bounded allowance.
Compaction policy tests disable transport retries to isolate terminal-failure
behavior; separate tests exercise successful summary retry and installation.

No Linux execution or remote CI result is claimed. Whole-task budgets remain a
host responsibility, and retry accounting starts a new logical request after
process recovery. These are explicit boundaries, not exactly-once model calls
or a guarantee of correct model-written conclusions.
