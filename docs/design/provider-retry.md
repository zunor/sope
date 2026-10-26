# Provider attempt ownership

One logical model request owns one immutable request body, an absolute deadline
and a bounded retry allowance. Individual HTTP attempts own their parser,
partial tool calls, provisional text and idle deadline. Only a complete validated
attempt can enter model history or dispatch tools. Retrying never replays an
already committed tool round. Cancellation terminates both I/O and backoff.

Classify failures from transport codes, HTTP status and structured provider
error codes. Retry rate limits, transient server/transport failures, truncated
streams and idle timeouts; do not retry authentication, invalid requests,
context overflow or refusals. Output-limit retries require a larger output budget.
Malformed Chat Completions tool batches may retry at most twice, only before
any tool use is admitted; the general attempt allowance and request deadline
also apply. Responses output and compaction tool calls remain terminal.
Validation reports the call index and failed constraint, never raw arguments.
A recovery deadline retains this terminal validation diagnosis rather than
inviting an outer task retry.
Context overflow remains owned by the existing compaction recovery path.

Use capped exponential backoff with jitter and bounded Retry-After hints. A
monotonic retry-ready timestamp prevents unrelated wakeups from skipping the
delay. Attempts and timeout retries are bounded separately; every wait consumes
the same absolute request budget. Defaults: five retries, at most three timeout
retries, 1-second initial gap capped at 10 seconds, 15-minute Retry-After cap.

Streamed text is provisional. A MODEL_RETRY event identifies the discarded
attempt and next attempt, with `validation_reason` for invalid batches; hosts must separate/mark its output before displaying
the next attempt. Successful history contains only the accepted attempt.
Compaction output is private and can be discarded without visible rollback.
No string-based continuation prompt or synthetic user turn is needed.

Metadata traces record logical elapsed time, attempt elapsed time, failure kind,
delay and remaining budget, without response bodies, headers or credentials.
Real GLM workloads and local injected faults are separate evidence: fixtures
establish recovery invariants, while the real workload measures observed use.
