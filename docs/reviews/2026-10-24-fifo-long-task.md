# FIFO workload with GLM 5.3

Date: 2026-10-24. Sope baseline: `d74304a`. Fix: `3fb9e5c`.
Platform: macOS arm64. This is local sope development validation, with no
release or MatrixOne production patch.

## Workload

GLM 5.3 investigated `pkg/fileservice/fifocache` in an isolated archive of
MatrixOne commit `35e873a261b0b50ebbffe84b4264c65f42dc32e7`. It read
implementation and callers, generated tests, ran normal and race checks, and
challenged initial hypotheses. The original checkout was not edited.

The host used the real AgentBridge/native agent, auto permissions, durable
execution history, metadata-only trace, and a 30-minute deadline. The live
process retained the baseline library; fixes were built in `build-long-task`
to avoid replacing its loaded library.

## Confirmed sope fix

The model repeatedly piped Go checks through `head` or `tail`. A failing
compiler/assertion/race check then returned shell status zero because the
filter succeeded. This did not make the test successful: the failure remained
visible in its output. The host initially trusted a zero status too quickly;
inspection corrected that assessment.

The bash tool now uses `/bin/bash -o pipefail -c`, explicitly requiring Bash.
A pipeline returns its rightmost nonzero status. `errexit` remains disabled;
explicit recovery works normally. Tool guidance recommends running checks
directly because output is already bounded and archived. A later `echo` or
another command can still override status; scripts must capture and return it.

Five regression controls cover failed pipelines, rightmost failure, successful
pipelines, explicit recovery, and preserving status across later output. Four
assertions failed against the original implementation; all passed after the
change. This fixes a tool contract weakness, not arbitrary model-generated
scripts or fabricated test APIs. No P0 was established.

## Workload findings and limits

GLM generated nonexistent API references and overly strong assumptions about
concurrent capacity. It corrected those tests after reading actual failures.
Its test named `FuzzStateModel` is a seeded operation sequence, not a Go fuzz
campaign or a complete independent state model; several invariants claimed in
comments are not actually asserted. Passing those probes does not establish
complete cache correctness.

GLM independently wrote a concurrent Replace/Delete/Set probe that triggered
the Go race detector between `Replace` writing `item.size` (`fifo.go:658`) and
`enqueue` reading it (`fifo.go:465`). An independent direct invocation without
a pipeline reproduced the race and returned exit 1. Disk cache has a real
Replace caller, but an end-to-end disk-cache reproduction and any claimed
permanent accounting impact require additional evidence. Only the data race
is established here; no MatrixOne production fix was made.

## Validation

The run reached its 30-minute deadline after 26 completed tool calls and four
turns. Two turns failed with low-speed transport timeouts and one with a
connection reset. Continuations reused existing history; the fourth turn was
cancelled while waiting for a model response. It did not complete its findings
report or the planned second-phase self-review. No claim of successful
end-to-end task completion is made.

The trace contains 356 rows / 96,615 bytes over 1,800.019 seconds, with 119
heartbeats. Shutdown recorded `drained: true` and zero active spans. Maximum
sampled host RSS was 74,334,208 bytes; this is an observation, not a memory-leak
proof. A one-second process sample showed network polling and idle workers,
not a busy loop. A single minimal GLM request returned successfully in 5.7
seconds during the earlier stall; this does not establish its root cause.
No compaction occurred in this workload, so it adds no live compaction evidence.

- Bun suite against the fixed isolated library: 243 passed, 0 failed,
  1,471 assertions across 32 files.
- CTest: 11/11 passed, including Go integration.
- TypeScript typecheck, CTest registration, version metadata and diff checks
  passed. Version remains 0.5.0.
- No Linux or sanitizer result is claimed for this change.

After the live process exited, the default `build` library was rebuilt with
the fix and its native tools test passed. The pre-existing release skill edit
was left outside these commits.

Raw local evidence lives under `.loom/tmp/sope-fifo-20261024`: execution
journal, metadata trace, source snapshot, manifests and test logs. These are
not published with the repository.
