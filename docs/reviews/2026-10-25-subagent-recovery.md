# Delegated recovery, evidence, and closure — 2026-10-25

Scope: local sope development on top of `b2ea3aa`, using native GLM 5.3
subagents against an isolated MatrixOne arenaskl test snapshot. No MatrixOne
source change, service startup, push, or release. The development library retains
version 0.5.0; version alone does not identify these unreleased builds.

## Findings and implementation

1. Recovery exposed unfinished parent `agent` calls, hiding which child tools
   had committed results and which had unknown external outcomes. A host could
   replace the whole delegation with success prose. Recovery now exposes actual
   unknown leaf calls with agent/call IDs and literal inputs. Delegation results
   belong to the native runtime and cannot be host-resolved as success.
2. Cancellation intent lived only in memory. The first request and note now
   commit before cancellation is scheduled. On resume, native lifecycle facts
   distinguish completed, failed, cancelled, interrupted, and never-started work.
   Child termination and reconstructed parent completion commit together.
3. A cancelled child can still have unknown external effects when its parent
   result was not committed. Those leaves still require reconciliation. An
   existing cancellation completion is not published a second time.
4. Host reconciliation must remain discoverable without becoming a native check.
   Reconstructed child results carry separately labelled host excerpts and call
   IDs; original results remain available through `evidence`. These assertions
   never create process observations or satisfy native acceptance by themselves.
5. Model summaries could lose child lifecycle distinctions. Working state and
   the final acceptance report now contain native state counts for every started
   child in the task, plus a bounded recent index of child/check/reconciliation
   IDs. State counts retain old failures even after detailed index eviction.
   A changed lifecycle snapshot invalidates an earlier report.
6. A crash after report commit but before terminal commit could require another
   provider round, or fail the round limit. Resume now closes an already-ready
   report before requesting compaction or a provider response.

The lifecycle projection is derived from journal events, not parsed model prose.
This retains Soren's useful separation of agent identity, lifecycle, and saved
results while keeping sope's native non-recursive shared worker pool. It does not
resurrect child runtimes, reattach OS processes, or promise exactly-once external
effects. A parent can reuse known evidence and arrange new work for unfinished
reasoning; interrupted reasoning is never silently labelled complete.

## Four-child reproduction and recovery

Artifacts: `/Users/linjunhong/.loom/tmp/sope-recovery-20261025/baseline/`.
The execution before recovery is retained in `execution-before-recovery/`.

- Four children exercised a one-round failure, cancellation after a check,
  source review plus an eight-minute fuzz check, and a parked host checkpoint.
- The process was killed after 675.449 seconds, after fuzz committed but while
  two delegations were still unfinished. Fuzz performed 2,188,386 executions and
  printed `PASS`; the check itself lasted about 482.6 seconds including startup.
- `recovery-old-runtime.json` exposes parent invocations 4 and 5. The repaired
  `recovery-before.json` exposes only child 5's unknown `fault_barrier` call 16;
  child 4 has no unknown leaf because its fuzz observation already committed.
- The host verified the separate marker contains exactly `once\n`, reconciled
  the unknown leaf, and resumed the same original input. Both unfinished
  children became `interrupted`, never completed.
- Recovery finished in 66.5 seconds, including a further compaction. All four
  stored observations remained byte-identical. No check or source read was
  repeated during recovery. Across both phases there were two compactions and
  no provider retries or repeated exact reads.
- Native acceptance remained **rejected**: three narrow checks satisfied their
  predicates, while nonempty `gofmt -l` output failed formatting. Completing the
  final todo closed the turn without another provider call.
- Every child has exactly one native terminal event and one parent completion;
  the external marker still contains one line.

## Six-child longer validation

Artifacts: `/Users/linjunhong/.loom/tmp/sope-recovery-20261025/fixed-long/`.
The driver adds a second one-round failure and a normally completed child to the
previous workload, and extends fuzz to ten minutes. It parks cancellation until
fuzz commits. A local SQLite test trigger prevents the cancelled child's terminal
commit, then the driver records cancellation through the native API and kills
its own process. This deterministically exercises durable cancellation intent
without a committed child exit. The trigger is removed before resume.

- The pre-interruption phase ran for 1,123.522 seconds (18 minutes 43 seconds).
  GLM encountered six transport/stream retries, including incomplete tool-call
  output; no partial attempt dispatched a duplicate tool.
- The requested ten-minute fuzz hit `check`'s existing 600,000 ms maximum.
  This was a fixture budgeting mistake: the requested 720,000 ms is clamped by
  the documented tool limit, so a full ten-minute fuzz plus startup cannot fit.
  The committed receipt is `timed_out`, exit 137 after about 600.006 seconds.
  This run is a negative timeout case, **not** a successful ten-minute fuzz run.
  The earlier eight-minute run provides the positive long-check result.
- SIGKILL occurred after cancellation intent was committed but before the
  cancelled child's terminal commit. Reopening exposed exactly two unknown
  host leaf calls: cancelled child 3/call 13 and interrupted child 5/call 12.
  Child 4's timeout receipt was already committed and required no host invention.
- Resume used the final validated library, reconciled the two known fixture
  effects, and finished in 170.2 seconds, with two compactions. One compaction
  occurred after report submission but before the final todo update. The report
  and native lifecycle counts survived unchanged.
- Final child counts: completed 1, failed 2, cancelled 1, interrupted 2. The
  original cancellation note and separately labelled host assertions survived.
  Every child has exactly one child terminal event and one parent completion.
- All six observations are byte-identical before and after recovery. There are
  still exactly six native checks; no check was restarted. Trace recorded no
  repeated exact read fingerprint. The external marker remains exactly one line.
- Final acceptance is **rejected**, with four satisfied criteria and two failed
  criteria: timeout and nonempty formatter output. The final report includes the
  native child counts and evidence/reconciliation IDs, rather than claiming the
  failed/cancelled/interrupted delegations completed.
- The final todo result was followed by native turn completion one millisecond
  later, with no further provider request. Both phases account for about 21.6
  minutes of active execution, excluding the inspection/restart gap.

## Deterministic coverage and validation

Native SIGKILL/storage-failure fixtures cover unknown child effects, a second
crash after reconciliation, failure during reconstructed parent commit, child
completion before parent commit, cancellation before and after child exit,
never-started delegation, and host reconciliation of a check whose native
receipt never committed. Tests assert one external effect, stable call IDs,
no replayed tools, balanced terminal events, and no forged native observation.
The Go SDK covers suspend/reconcile/resume with an actual child leaf call.

Provider fixtures deliberately return a false summary claiming all children
completed, and verify that native states, check IDs, and acceptance survive.
Another fixture makes the final checkpoint fail after report commit, then makes
the provider unavailable on resume with no model rounds remaining. Closure still
succeeds without a request. A 34-child test verifies that an early failed child
remains in native aggregate counts after leaving the recent 32-child index.

Final working-tree validation passed:

- 332 Bun JS/TUI tests and TypeScript checking.
- All 11 registered native/Go CTest targets.
- All 9 ASan/UBSan targets and all 9 TSan targets, without sanitizer diagnostics.
- Metadata and diff whitespace checks.

Build identity and logs are retained outside Git under
`/Users/linjunhong/.loom/tmp/sope-recovery-20261025/`:
`validated-build.json`, `validated.diff`, immutable library copies, driver scripts,
trace JSONL, SQLite evidence, and audit JSON. The final library SHA-256 is
`12b77ee9e95279b51df400a8c7a681631f04a8a5d4a3eecb6623c6c55a2064e1`.
The baseline and each recovery phase use explicitly selected immutable binaries;
no running process's loaded library is replaced.
