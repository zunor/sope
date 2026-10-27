# Loom hunt recovery — 2026-10-27

The LOAD DATA hunt on sope 0.6.0 (`32b78b2`) spent 2,514 seconds in eight
discarded provider attempts. Seven had partial output; each waited roughly five
minutes without semantic progress. Its terminal error was separate: the same
service launch had been admitted twice, configuration was repaired through a
shell command, and three further launch attempts were rejected by the per-turn
repeat counter. The model incorrectly described its next response as a new turn.

Program repeat counts now bound consecutive identical `bash`/`check` admissions.
Another admitted program reopens earlier program allowances even when it returns
nonzero: the observed repair wrote the configuration successfully before its
last probe failed. Native reads and background polling alone do not reset these
counts. Aggregate call limits and the three-block termination rule remain.
Repeated tool results are not cached, and reopened allowances make no assertion
about the freshness of earlier results. The rejection message explicitly says
that another model response does not create a new user turn.

Provider requests retain the five-minute allowance before initial semantic
progress. Once reasoning, text, or tool arguments arrive, the default no-progress
limit is one minute. An explicit `openai.progress_timeout_ms` overrides both
phases. Heartbeats do not count as progress. Retry traces include wire silence,
semantic silence, and the effective progress limit. Existing complete-batch
validation, discarded partial responses, committed history, bounded retries,
request deadlines, and cancellation semantics are retained.

The local OpenCode implementation informed the recovery comparison: it preserves
native transport failures and can continue from recorded tool results after an
interrupted stream. Its default first-header allowance is also five minutes.
The original production traces do not identify whether the stranded connections
originated at the gateway, network, or HTTP client. This change bounds that
observed failure mode; it does not claim to repair the unidentified network cause
or adopt OpenCode's eager streamed-tool execution semantics.

## Validation

- The new shell-repair fixture fails against a fresh build of the original
  commit: its third launch is blocked. It passes with the repaired library.
  Native tests also cover unchanged repeats, polling, persisted counters,
  intervening failed executions, and the aggregate call limit.
- 207 JS SDK tests and 188 TUI tests passed using absolute test paths.
- All 11 native/Go CTest targets passed, including Go race tests; all nine
  ASan/UBSan native targets passed. TypeScript, metadata, CTest registration,
  and whitespace checks passed.
- Real TCP reset and premature EOF fixtures recovered with default timeout
  limits and a 10 ms retry backoff, completing in about 80 ms. A previously
  committed command ran once; the incomplete batch never ran.
- A separately rebuilt Loom worker passed its tests and a combined local HTTP
  fixture with the actual default progress/backoff settings. Two failed launch
  checks, a shell configuration repair ending nonzero, and the same successful
  launch stayed in one durable turn. A subsequent partial tool response stalled
  while sending heartbeats. Recovery began after 60.005 seconds, the next request
  arrived after 61.098 seconds, and the worker exited successfully. The retry
  request matched the failed request, three launch attempts were recorded, and
  no partial tool executed.

Initial test invocations using relative Bun paths failed on both original and
repaired libraries; absolute-path invocations passed. Those failed attempts are
retained. The first consumer fixture completed execution but its Bun read-only
SQLite inspection failed; a second run using Python SQLite for inspection passed
all assertions. These fixture failures are not counted as successful checks.

Builds remain unreleased version 0.6.0. The development library is
`build-hunt-fix/libsope.dylib`; sanitizers use `build-hunt-fix-asan/`. Original user
TUI changes are preserved. No production worker was replaced and no live hunt
was restarted. Source fingerprints, library/worker checksums, logs, the consumer
driver, and its result are under
`/Users/linjunhong/.loom/tmp/sope-load-hunt-fix-20261027/`.
