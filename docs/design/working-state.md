# Working state outside summaries

A compressed transcript is fallible model memory. It cannot own the current
request, task status or execution outcomes. The native harness retains the
latest successful built-in `todo_write` list with its call and turn IDs. Its
result and the plan projection commit together; parallel replacements resolve
by call ID rather than completion order. Failed or host-overridden tools do
not replace this projection. It is bounded to 64 items and 16,000 JSON bytes.

Every model call that needs it receives a derived user-role working-state
message. It contains the exact current request when compaction has removed
that original message, the latest plan, remaining round/tool/search allowances,
eight recent process outcomes, and twelve recent read identities. Its tokens
participate in preflight context and compaction budgets. It is not appended to
history, journaled repeatedly, or submitted to the summarizer. Both Chat
Completions and Responses use this contract. The current request already lives
in the durable inbox, so crash recovery preserves its original text too.

These are different sources of information: the request is user-authored;
todos are model-authored assertions; execution receipts are native observations.
An exit status does not certify test assertions, coverage, source freshness or
correctness. Compaction transcripts keep native call IDs attached to their
invocations and retain provider IDs linking each result to its call. Old plans
remain visible across turns, but only a plan updated in the current turn
participates in completion reconciliation.

`evidence({session_id, call_id, offset, limit})` reads an original committed tool result
from the durable journal, scoped to the calling session and agent. Bare call
IDs or a different session ID are rejected; unrelated runs can reuse the same
call number. Working state and receipts carry session/agent/turn provenance;
recent execution entries include the exact bounded command, or explicitly mark
it omitted. A directory listing cannot stand in for a cited test invocation.
Results remain available after compaction and reopening. This is paginated historical retrieval, not
reexecution or a cache hit asserting current file validity. Offsets and limits
are bytes; pages preserve UTF-8 boundaries and return `next_offset`. Without
arguments the tool still returns the bounded execution receipt ledger. A
non-durable agent has no historical-result store and reports that explicitly.

When a text-only response arrives with pending/in-progress items, the loop
allows at most two completion reconciliations within the existing user turn.
The counter is durable and compaction cannot reset it. The model may finish
remaining work, correct its plan, or mark a genuine blocker with a reason.
Unresolved attempts end in error, preserving the evidence rather than reporting
normal completion. This checks declared consistency, not truth: a model can
still falsely mark tasks complete, omit tasks, or produce a poor report.

The trace correlates identical read ranges using per-trace keyed fingerprints,
read counts and prior call IDs; paths and contents are not exposed. A repeated
read may be justified by a changed file or missing detail. No semantic shell
analysis, automatic cross-file read suppression, or external model judge is
introduced. Summary fingerprints and closure events support investigation;
the journal remains the source for exact content comparisons.

For durable native text reads, successful results also commit a bounded content
fingerprint and size in the operation ledger. After `harness.max_repeats` full
deliveries of an identical request (default two), a fresh matching read returns
a qualified reference to a committed full result instead of emitting duplicate
contents. Shell commands and unrelated writes cannot reset these observations.
Changed contents reopen delivery even when size and mtime are unchanged. This
uses the file tool's existing non-cryptographic fingerprint; it is not an
adversarial content-integrity guarantee or a filesystem cache. File I/O still
occurs, and explicit historical retrieval remains available. Failed reads do
not commit observations. Ephemeral agents, images, different argument forms
and evicted operation entries do not receive this duplicate-content treatment.
New user turns reset the operation ledger and its read allowances.

Provider diagnostics distinguish `finish_state` (0: pending, 1: text stop,
2: tool batch) from `stream_done` (protocol terminal event received). A response
can stop producing text before its terminal event arrives; neither a completed
todo list nor a plausible final paragraph establishes protocol completion.
Timeout/retry/end records retain these numeric states without exposing payloads.

Limits: this is not an autonomous whole-task scheduler. Host wall-clock budgets
remain external. Only the current request's text is restored verbatim after
compaction, not every earlier instruction or image in a conversation. Derived
state cannot repair arbitrary interpretations of source code; review of model
reports is still necessary.
