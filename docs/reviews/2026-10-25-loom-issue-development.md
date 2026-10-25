# Loom MO issue development with GLM 5.3 — 2026-10-25

## Scope and source identity

Real MatrixOne issue #31057 (incomplete fractional exponent accepted as an alias),
selected from the MO repository configured in Loom. The host used a fresh isolated
clone at `553bf39dbb603898b9d383e2941a2a0b64ef8e57`, branch
`codex/sope-issue-31057`. Loom currently has no native sope execution adapter:
this experiment reproduces its fixed-workspace issue workflow through a local
sope SDK driver; it is not a production Loom task or integration claim. No push,
GitHub write, production service change, or existing MO checkout mutation.

Artifacts and task ledger are outside tracked source:
`/Users/linjunhong/.loom/tmp/sope-issue-develop-20261025/`.
They include exact issue input, approved Astra medium design, source fingerprints,
immutable library manifests, SQLite journals, trace metadata, original tool
observations, actual MySQL and MO results, and host interventions.

## Completed observations

The GLM 5.3 investigation took 949.8 seconds, with one completed native reviewer
and two provider idle-timeout retries. It reproduced the bug through the public
parser. Its proposed expansion into signed-integer behavior was rejected by the
independent design gate; PostgreSQL was also kept out of scope.

The first implementation turn ran for 2,700.0 seconds, ending in the harness's
45-minute cancellation limit. It performed 64 tools, seven provider retries and
three automatic compactions. It implemented the approved scanner correction and
regression tests, but did not start either requested implementation reviewer,
submit the required native checks, or produce an acceptance report. Cancellation
was not a successful completion. The host resumed the same durable execution with
specific feedback, so subsequent completion is assisted, not autonomous.

An isolated candidate service produced 54 public SQL observations: 28 malformed
fractional cases rejected with 1064 and 26 controls matched the actual base.
The first BVT attempt failed before executing its case because the host tester
selected a missing database. The host corrected that configuration and preserved
the failed attempt; it was not a product-code failure. At this point the new BVT
oracle was independently wrong: unbound identifier `1e` was claimed to return 1,
`1.5f` had a second alias, and the comment-separated alias result was missing.
A process-exit receipt alone did not establish those expectations were correct.

Compaction was followed by a forgotten parser signature and an extra `source/`
path component despite already running in that directory. Concurrent edits of
the same file were rejected by the read/revision guard, then corrected. Some
shell commands used output pipelines/cleanup whose overall exit status did not
prove test success. Native acceptance requires the exact host-selected `check`
argv and cwd and does not accept those shell receipts as replacements.

Neither exact `read` nor exact command repetition counts captured the repeated,
slightly different searches for BVT result formats. The first implementation had
29 distinct shell command requests. Zero exact repeats is not evidence of zero
repeated exploration. Semantic repetition remains a separate review question.

## Runtime changes and their boundaries

- `c044e0a`: working state includes actual turn cwd; recent executions and receipt
  footers preserve original launch cwd. False summaries and a reopened session
  configured with another cwd cannot relabel earlier observations. A durable
  parent and child receive location facts from their first request.
- `ba488a1`: bounded per-trace keyed fingerprints identify repeated exact bash
  command strings and check argv, scoped by agent and turn. They omit payloads,
  ignore descriptive text/timeouts and do not claim shell equivalence, staleness
  or success. Already running traces retain their originally loaded code.
- `64936cf`: optional host contract `delegations.minimum_completed` prevents an
  accepted report when required direct child completions are absent. Model prose,
  todos, forged report fields, failed/cancelled children, and false summaries do
  not satisfy it. Counts include children outside the recent index. An unmet
  minimum can close honestly as incomplete; this is a lifecycle predicate, not
  proof of distinct reviewer scopes or review quality. The original live five-
  check contract did not include this new requirement and is not retroactively
  claimed to enforce it.

Final sope validation: 337 JS/TUI tests, all 11 native/Go CTest targets, all nine
ASan/UBSan targets, TypeScript, metadata and whitespace checks passed. Development
libraries retain version 0.5.0; checksums/manifests identify the actual builds.
No release was published.

## Assisted completion and final evidence

The resumed turn also reached 2,700.0 seconds and was cancelled with an empty
final outcome and no acceptance report. It had 52 tool executions (root and
children), four provider retries, three compactions and two completed native
reviewers. Its only native check was a child's read-only git diff, not an
acceptance test. Repeated shell-based inspection continued after the first
compaction. The last readiness loop compared mysql's header-plus-row output with
a single `1`, which cannot report ready. Teardown stopped its test-owned service
and cancelled the waiting command. The original GLM candidate is retained under
`glm-candidate/`, before any host edits.

The BVT reviewer caught genuine SQL/result mismatches but also recommended row
markers and blank separators contradicted by its own cited `cte.result`. It
guessed decimal metadata incorrectly. Its result remains explicitly
`model_report_unverified`; completing a native child proves lifecycle completion,
not the correctness of those findings. The native scanner reviewer missed the
statement cleanup issue caught by Astra.

The host completed the parser-test cleanup and deterministic same-parser reuse
proof, generated actual BVT output and independently reconciled its semantic
values/errors. No further production logic was changed. Host fixture failures
are retained separately: a missing tester database, TCP TIME_WAIT during port
preflight, and mo-tester replacing `.loom` inside an absolute path with `.result`.
The tester's record mode returned zero despite failing to write its result; that
was **not** valid generation evidence. Normal comparison rejected it. Relative
case paths, explicit generation-success checks and nonempty normal-run summaries
fixed the fixture. These are not claimed as sope or MO product fixes.

Final MO evidence is green: both owning parser packages with named new tests,
gofmt, vet, configured incremental lint, 54 actual public SQL observations, and
two normal BVT comparisons on the same isolated instance (16/16 statements each,
zero failures, ignored or abnormal cases). The service terminated. Astra medium
final review found no unresolved material blocker; see `final-astra.md`,
`host-validation.json`, `host-final-source.json`, and the final `sql-candidate/`
attempt. The MO fix is committed locally as `4352c60` on
`codex/sope-issue-31057`. No remote delivery occurred.

At least one provider request was in flight for 2,650.3 of 2,700.0 seconds in the
first implementation and 2,504.6 of 2,700.0 seconds in the resumed turn (union of
request intervals; parallel children are not double-counted). This includes
model generation and transport waiting, not just retries, and can overlap tools.
It does not establish that all delay was a runtime defect. All 25 command
requests in the resumed turn were textually distinct despite repeated exploration.

This experiment does **not** demonstrate autonomous issue delivery. GLM produced
the core fix, but both long implementation turns failed to close acceptance.
Final completion depended on host intervention and independent review. The
runtime repairs strengthen factual state, diagnostics and the acceptance gate;
they do not make model conclusions trustworthy by themselves.

## Final live gate regression

A separate GLM 5.3 fixture used the final `64936cf` native library and current
trace code. It intentionally executed only `/usr/bin/true` while the immutable
contract required two completed children. The process predicate was satisfied,
but native acceptance was **incomplete**, with required2/observed0. The fixture
finished in 13.725 seconds; report-to-terminal delay was
1 ms, with no additional provider request to close. This is a negative
lifecycle-gate regression, not additional MatrixOne test evidence. See
`delegation-gate/outcome.json` and its trace. The MO source fingerprints remained
identical, its working tree is clean, and no test-owned MO service remains.
