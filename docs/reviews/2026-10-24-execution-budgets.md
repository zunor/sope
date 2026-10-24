# Execution budgets and GLM 5.3 validation

Date: 2026-10-24. Scope: local sope harness development, not a MatrixOne fix or
release. Only `glm-5.3` was used for live model requests. The pre-existing
release skill edit was excluded from these commits. Validation follows the
release skill's local-build mode; no version, remote account or release changed.

## Runtime design and validation map

| Boundary | Implementation | Evidence |
|---|---|---|
| Repeated searches/operations | Canonical argument identity, bounded 64-entry working set, per-turn repeat/search/total budgets; three blocked calls terminate execution | Native tests cover reordered keys, description-only changes, successful repeated shell searches, aggregate limits and absence of a blocked side effect |
| Ineffective retries | Known failures retain counts; successful native edits/writes reopen retry budgets; new user turns reset aggregate budgets | Unit regressions cover failed host calls, a justified retry after editing, checkpoint round-trip and rejection after history replacement |
| Compaction/recovery | Admission state commits before dispatch; native receipts commit with tool results; ledger is separate from model history | Durable regression executes a failing check, compacts, reopens and retrieves the original failure; explicit reset clears it |
| Inflated test claims | Literal-argv `check`, native foreground-shell receipts, `evidence`, deterministic normal-completion footer | Native/JS tests distinguish failed, zero-exit, timeout, denied and malformed invocations; a later shell echo never becomes a verified test verdict |
| Stalled provider/retry waits | Native idle and absolute request deadlines, including retry backoff | HTTP fixtures cover partial silent streams, keepalives and deadline expiration before a second attempt |
| Lifecycle/memory | Existing task wake/cancel/process drain and root locking own the new state | 11 C/Go CTest targets; 9 native targets under ASan/UBSan and 9 under TSan |

Implementation commits: `89c0c2d` (budgets/receipts), `124da8f` (successful
command repetition, recovered identities, smaller result receipts), `0515e11`
(provider deadlines). The normal build is ABI 0.5.0, unreleased. The latest
full Bun run passed 248 tests; TypeScript checking passed. These are local
macOS arm64 results, not new Linux CI or release validation.

The failure/trace contract is intentionally narrow. Process exit zero does not
prove tests ran, test assertions were sound, coverage was sufficient, current
source is unchanged, or a suspected product bug is valid. No arbitrary log
parser or extra system-prompt checklist is used to manufacture that proof.
Model-written reports remain untrusted. Semantically equivalent but differently
expressed shell searches are not deduplicated; aggregate limits still apply.
Budget-triggered rejections were exercised by regression tests, not observed
in the live workload below.

## Real workload

An independent MatrixOne worktree at
`35e873a261b0b50ebbffe84b4264c65f42dc32e7` investigated `pkg/common/spool`.
GLM selected its own hypothesis and produced a new test and report. Production
files, existing tests, `go.mod` and `go.sum` remained byte-for-byte unchanged.
No MatrixOne implementation or PR was attempted. The user's explicit GLM-only
constraint applied; no separate paid-model design or review was invoked.

The first phase loaded an immutable library copy from `89c0c2d`, with its SHA-256
recorded locally. Limits: 12 minutes, one user turn, 48 model rounds,
8,192 output tokens/request, 16,000-token proactive compaction threshold. It
completed 13 tool calls, one compaction and three provider retries before a
partial model stream went silent. The existing HTTP low-speed limit eventually
ended the turn after roughly five minutes of silence. Total phase duration was
699.23 seconds. No completed tool was replayed after that partial stream.

This exposed a concrete waiting-boundary gap: there was no native request
lifetime budget and only a five-minute transport silence limit. The fix adds a
120-second default idle deadline and 600-second absolute request deadline,
configurable up to one hour. Incoming traffic cannot renew the absolute budget;
retry delays consume it. The silent-stream fixture failed against the first
phase's library (no termination within the fixture's five-second limit) and
passed with the fix in about 155 ms using a 150 ms configured idle deadline.
A keepalive fixture hit its 400 ms absolute deadline, and a 150 ms request
budget stopped during retry backoff. Partial output is not replayed.

The continuation loaded a second immutable library copy from `0515e11` and
reopened the same journal. Limits: six minutes, one new user turn and a
180-second absolute request deadline. The prior turn stopped for a provider
error, not an exhausted execution budget. The continuation performed nine
more tools and another successful compaction. It wrote the probe and findings
report before the host deadline cancelled the final model call. Both host
lifetimes drained cleanly and ended with zero active spans. This is not a
normal `end_turn` completion, and no normal-completion footer was observed in
this live run; footer behavior is covered by deterministic tests.

The continuation did not trigger a new provider timeout. Its improved apparent
progress cannot be attributed to the timeout change. Timeout enforcement is
established by the local HTTP fixtures, while the live continuation verifies
operation with the new code, durable state, check execution and cancellation.

## What actually ran versus what the model claimed

The repository CGo wrapper rejected the primary checkout's native artifact
provenance. A plain CGo test then failed to build. GLM used `CGO_ENABLED=0` and
correctly disclosed that this was an alternative build, not normal CGo or race
validation. These environmental failures are not sope failures.

| Native execution ID | Actual invocation/outcome |
|---|---|
| 17 | Selected new probes, `CGO_ENABLED=0`; one failure and two controls passing; process exit 1 |
| 18 | Whole package with `-count=2`, same alternative build; the new probe failed twice; process exit 1 |
| 19 | Nine pre-existing top-level tests selected with `-short -v`; PASS in actual output; process exit 0 |

All three used `check` with explicit `/bin/bash -c` argv. The last command also
piped through `tail`. Literal argv cannot change the semantics of an explicitly
requested interpreter: the ledger records the interpreter's exit, with
`test_verdict: unverified`. Full argv and output archives were retained. The
runtime did not label the zero-exit command as verified test success.

The generated report nevertheless overstates its conclusion. The new probe
uses a 100 ms scheduling wait and later polling sleeps; repeated failure does
not make its interleaving deterministic. It calls `Close` concurrently with a
blocked `Send` without establishing that this is supported by the documented
single-producer contract or by a real caller. Thus the observed probe failures
are real, but the asserted MatrixOne defect is **not confirmed** by this review.
No claim is made that the harness automatically detected those semantic errors.
Its trusted execution facts make the distinction inspectable; validating test
oracles and concurrency preconditions remains a separate responsibility.

## Evidence and cost

Combined live runtime: 17 minutes 39 seconds, 22 tool calls, two compactions,
three provider retries. Trace: 268 JSONL rows / 72,513 bytes, containing compact
metadata rather than prompts, credentials or tool-output bodies. The final
ledger retained 12 execution receipts across compaction and reopening. This is
an observed size, not a general performance benchmark.

Raw evidence is local under
`/Users/linjunhong/.loom/tmp/sope-spool-harness-20261024`: immutable library
copies and hashed manifests, execution SQLite journal and output archives,
trace summaries, model report and probe. Raw logs and generated MatrixOne files
are not committed to sope. The diagnostic worktree is retained for inspection.
