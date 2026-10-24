# Native acceptance and subagent provenance experiment

Implementation commits: `be92093` (acceptance/provenance/CLI) and `c99a033`
(runtime-owned closure). These are local, unreleased 0.5.0 development builds.
No package, tag, push or release was published.

## Scope and workload

Use GLM 5.3 only, including native sope subagents, on the isolated MatrixOne
arenaskl source/test/report snapshot from the previous working-state experiment.
No production source is edited, no service is started, and no other model is
used. The parent audits evidence and submits a native report. Independent children
review boundary tests, concurrency/fuzz assertions, and historical report claims.

The architecture reference is Soren's `AgentTool.tsx`, `runAgent.ts`,
`forkSubagent.ts` and built-in verification agent: separate child identity,
lifecycle and retained results are useful; model-written verdicts alone are not
an acceptance authority. sope keeps its shared pool, inherited model and isolated
child history, and its existing prohibition on nested child delegation.

## Baseline: parent cannot inspect exited child evidence

Revision `0930f02`, immutable library SHA-256
`ae6d2fab6b4a3c4474f78426fe7691f26cb6a68fe305fcb4f1765dc450271301`.
Two native children ran for a 342-second parent task, with one compaction and two
provider retries. The parent could not recall child A's actual formatting result
and reran checks itself. Its report explicitly described this platform limitation.

The fix returns qualified native child results and authorizes direct-child recall
from the durable journal, including after child destruction and parent reopen.
A child cannot read parent or sibling ledgers. A new task can read historical
child results, but cannot use them as current-task acceptance evidence.

## Fixed evidence path: three children, 180-second fuzz

Immutable development library SHA-256
`b551cd5e86728346dd5d84d8de17f52bf5dcac5f899867121b07de7a77694a59`.
This is an intermediate working-tree build, not the final committed CLI artifact.
The run ended autonomously after 410.9 seconds with 37 completed ordinary tools,
three native children, three compactions, zero provider retries and zero closure
reconciliation attempts. One file/range was read twice; there was no read loop.
All six checks were recalled from exited children, without rerunning them.

The native report and terminal outcome agreed exactly with stdout:

| Criterion | Child | Call | Native verdict |
|---|---:|---:|---|
| Formatting | 2 | 30 | failed |
| Boundary test count | 2 | 31 | satisfied |
| Package tests, count 10 | 3 | 13 | satisfied |
| Concurrent tests with race, count 10 | 3 | 27 | satisfied |
| Fuzz, 180 seconds | 3 | 28 | satisfied |
| Iterator documentation text | 4 | 25 | satisfied |

Overall status was `rejected`, despite all processes exiting zero: `gofmt -l`
listed the unformatted file. Fuzz produced `PASS` after 796,124 executions. These
are bounded observations, not a claim of exhaustive coverage or bug absence.

## Closing directly from a native report

The first fixed trace had a completed report at 376.925 seconds and a completed
plan at 382.643 seconds, followed by another compaction at 402.361 seconds and a
final model response at 410.896 seconds. That unnecessary final provider dependency
could fail after the actual work was done.

Commit `c99a033` closes directly once the native report is committed, the tool
batch has quiesced and current todos are resolved. It preserves tool results and
publishes the native report as the final assistant message. Missing reports and
unresolved todos retain bounded reconciliation. Explicit failed or unverified
outcomes close honestly; they do not become acceptance success.

## Committed CLI long run and durable reopen

The CLI run uses the immutable `be92093` build, three children, 20,000-token
compaction threshold, 300-second fuzz and a 30-minute host ceiling. The later
reopen run uses `c99a033`, a new two-criterion task in the same completed execution,
and two new native children. This tests reopening a completed session, not crash
recovery or automatic resumption of interrupted child programs.

The committed CLI run finished autonomously in 928.996 seconds (15 minutes
29 seconds), with three children, 43 ordinary tool completions, two compactions,
five provider retries and no repeated read ranges. Its library SHA-256 is
`da57f5429a37d02825b8c0bf528d4c9e07cc549aa00d0cc54fa593d39648cc0e`.
Fuzz produced `PASS` after 1,381,045 executions in 300.094 seconds.

A child ran `bash ls` after three earlier checks. Native report #41 therefore
returned `incomplete` with three stale observations, despite the model's submitted
interpretations. Without human steering, the parent reran exactly those three
short checks (#42–44), reused package/race/fuzz evidence, and submitted report
#45: five satisfied criteria and failed formatting. The final native outcome,
stdout JSON and CLI exit code 1 agreed.

After the final todo at 767.431 seconds, the old closure path still requested a
model response. That response stalled and hit the native idle timeout, then
retried successfully; terminal completion was at 928.981 seconds. This added
161.550 seconds after report and plan completion. The timeout/retry recovered
without repeating tools, but the final provider dependency was unnecessary.

The `c99a033` reopen run completed autonomously in 213.106 seconds, with two
new children, seven ordinary tools, one compaction, one timeout retry, and no
repeated read ranges. Its immutable library SHA-256 is
`4f8215e91321e6bd58391f3d2c677ce1bf862650dfa990b6ab494157c9233043`.
The retry happened before evidence review; completed child checks were not rerun.

Turn 2 accepted only its two new references: child 47/check #49 for formatting,
and child 48/check #50 for the test count. Report #54 was `rejected` (format failed,
count satisfied); prior task criteria and observations did not replace this
turn's contract. The final todo #55 and parent turn end were both recorded at
213.103 seconds in the host trace. There were **no provider events or compactions
after that final todo**. This is evidence of removing the final model dependency,
not a zero-latency performance claim. The final stdout JSON matched turn 2's
persisted acceptance object exactly, and the CLI returned 1 as required.

## Deterministic validation

The final closure implementation passes 329 JS/TUI tests, TypeScript checking,
11 native/Go CTests, 9 ASan/UBSan CTests and 9 TSan CTests. Builds complete without
compiler diagnostics. The checked CTest registry includes both Go consumers.

Targeted cases cover nonempty formatting output with exit zero, mutable archive
files, wrong commands/directories/sessions, host-tool imitations, direct-child
recall after reopen, expired task references, denied parent/sibling access,
concurrent mutation, lossy summaries, non-UTF-8 output, bounded missing-report
closure, native closure exactly at the model-round limit, pending todos, and
CLI exit codes for accepted/rejected/incomplete outcomes. Native sanitizer tests
also exercise the report gate and structured child results. The JS fixtures were
not run under ASan: macOS rejected injecting its sanitizer runtime into Bun.

[Acceptance design](../design/acceptance.md) specifies the authority boundary.
The host defines exact checks; the runtime evaluates their observations. Arbitrary
semantic interpretations remain unverified. Freshness conservatively treats bash
as potentially mutating, even for a read-only command. External processes and
side effects hidden in host-selected verifier programs require host isolation.

## Local evidence

The complete experiment directory is
`/Users/linjunhong/.loom/tmp/sope-acceptance-20261025/`:

- `baseline/`: initial two-child reproduction.
- `verified/`: three-child intermediate build, report and original snapshots.
- `cli-final/`: immutable committed CLI build, trace, contract, original outputs,
  SQLite evidence and terminal outcome.
- `resume-closure/`: the subsequent task's immutable build, prompt, trace and stdout;
  its durable journal is the original `cli-final/execution/` directory.
- `closure-*-tests.log`, `closure-*-build.log`, `closure-typecheck.log`: final
  serialized-per-build validation, completed successfully.

Runtime state, credentials, temporary source copies and binaries remain outside
Git. Tests and task documentation are committed with the implementation.
