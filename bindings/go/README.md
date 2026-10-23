# Go SDK

The `sope` Go module wraps libsope through cgo. SQLite is compiled into libsope
under a private symbol namespace. The host needs **no SQLite Go driver, SQLite
cgo code, or `-lsqlite3`**. Building the host requires `CGO_ENABLED=1`, a C compiler
and a native library for the target OS/architecture.

## Build and link

From the sope repository root:

```sh
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release -DSOPE_CURL=system
cmake --build build -j
cd bindings/go
PKG_CONFIG_PATH=../../build/pkgconfig CGO_ENABLED=1 go test -a -race ./...
PKG_CONFIG_PATH=../../build/pkgconfig CGO_ENABLED=1 go test -a -tags sope_static ./...
```

The default uses `sope.pc` and links the shared library; the `sope_static` build
tag uses `sope-static.pc` and links the archive explicitly. System-curl builds
still link libcurl. For a single archive containing SQLite, curl and TLS, build
with `-DSOPE_CURL=bundled`; its static metadata selects `libsope-bundled.a` and
only the platform system dependencies. A host may independently use SQLite.

`cmake --install build --prefix /your/prefix` installs the header, libraries and
relocatable `lib/pkgconfig` metadata. Set `PKG_CONFIG_PATH` to that installation.
Go caches external C headers and archives: use `go build -a` / `go test -a`
after rebuilding libsope. SDK 0.4 rejects a different native ABI before opening
an agent. Rebuild both together when upgrading.

This checkout has no configured public Git remote, so the module is deliberately
local (`module sope`). A consuming repository can use:

```go
require sope v0.0.0
replace sope => ../sope/bindings/go
```

No consuming project is modified by building or testing this SDK.

## Ownership and execution contract

Create an agent with `Open(Config{...})`. `Directory`, `Revision`, and
`EnvironmentRevision` are required. The directory is exclusively owned until
`Close` finishes. `Status` exposes a persistent `SessionID` and a fresh
`InstanceID` for each open; use these identities instead of a PID.

`Open` registers options, tools and subagents, then seals the configuration.
The journal records the ABI, effective absolute working directory, options,
tool definitions, subagent definitions, policy, host revision and environment
revision. Reopening with a different contract returns `ErrConflict`. Environment
values and API credentials are excluded from this manifest; the host must bump
`EnvironmentRevision` when environment semantics change. The host revision must
cover changes to external executors and referenced instruction files. A changed
contract requires a new session. `SetCredential` rotates the explicit bearer
token for subsequent model calls, including calls by existing subagents.

`Policy.Tools` is an exact allowlist; empty means no tools. `Authorize` gates
**all** offered tools, including read tools, host tools and subagents.
`External` routes listed built-ins to `EventToolCall` for execution by the host.
For a sandboxed host, route every filesystem, shell and network capability that
must use that sandbox to the host executor. Built-in tools themselves run with
the host process's OS privileges; a working directory is not a filesystem jail.
Children inherit the root capability ceiling and may only narrow it.

`Policy.Environment` is the complete subprocess environment, without inherited
host secrets. The runtime adds fixed noninteractive pager/terminal settings.
Explicitly provide `PATH`, `HOME` and any tool credentials that execution needs.
Model credentials are supplied through `openai.api_key` or `SetCredential`; no
host login, OAuth refresh, subscription entitlement or `.env` discovery occurs
in this SDK.

## Host integration sequence

1. `Open`, then `Recovery`. If unfinished work exists, reconcile every unknown
   call against the host's own execution receipts using `Resolve`. Interrupted
   child agents are represented by their parent `agent` call, with their output
   artifacts and public child events available as evidence. `Resume` refuses
   unknown outcomes; it never blindly repeats a tool.
2. `Submit(requestKey, text)` durably admits input. A retry with the same key and
   payload returns the same turn ID, even after SIGKILL or completion. A changed
   payload returns `ErrConflict`. Admission does not mean completion.
3. First query `Outcome(turnID)`; a retried request may already be complete.
   Drain `Poll(ctx)` from one goroutine. Copying, lifetime and native thread-local
   errors are handled by the SDK. Respond to `EventPermission` with `Permit` and
   to `EventToolCall` with `ToolResult`. Other agent operations may run concurrently.
4. Build persistent projections from `Events(after, limit)`, in pages of at most
   256, and persist each applied page and its cursor in one **host** transaction.
   `Poll` can omit obsolete execution notifications after pause/cancellation;
   neither its sequence nor `Status.LastSequence` proves all earlier events were
   applied. Never re-execute tools merely because an event was replayed. Reconcile
   execution through `Recovery`. Sequence zero is a non-durable failure notification.
5. `Outcome` is the authoritative terminal record. It commits atomically with
   the final history, completed inbox entry and durable `EventTurnEnd`. A host
   crash between native completion and host projection does not lose completion.
   Tool receipts (including `Resolve`) also commit with their completion event;
   a failed receipt commit emits an error, not a false tool completion.
   This is an explicit recovery protocol across two journals, not a distributed
   transaction or an exactly-once guarantee for arbitrary external side effects.

`WaitOutcome` does not drain live events; keep a poller running to avoid memory
retention. Returned Go strings and values remain valid across future calls.
IDs are `uint64`, with decimal strings in journal/query JSON.

## Suspend, cancel and close

- `Suspend(ctx)` stops model generation and new admissions, drains admitted
  built-ins, and reloads committed state. It preserves unfinished input and
  unknown host outcomes. The host should stop/join its own external executors
  before reconciling; the C runtime cannot stop a host-owned goroutine/process.
  Live commands still queued when suspension begins are discarded by `Poll`;
  commands already handed to the host require host coordination.
- `Cancel()` cancels the currently executing turn and records a cancelled
  terminal outcome. It does not consume paused recovery work or queued turns.
- `Close(ctx)` starts cancellation/release once. For resumable shutdown, call
  `Suspend` successfully before `Close`. A close deadline only stops the caller's
  wait: cleanup continues under exclusive ownership, and new calls return
  `ErrClosed`. Calling `Close` again waits for that same cleanup.
- Poll/suspend/wait contexts interrupt waiting for SDK handle ownership as well
  as normal waits. A synchronous C call already entered must finish before its
  handle can be released; context expiry does not abandon it or free memory.
  Always close agents explicitly; there is no finalizer with side effects.
- `Shutdown()` releases shared native workers after all agents are closed.

## Models and recovery tests

Use `provider=openai`, `openai.wire_api=responses`, `model`,
`openai.base_url`, `openai.api_key`, and optionally `reasoning.effort`.
`chat` remains an explicit supported wire protocol (and the default).
Responses uses `store:false`, replays complete output items and persists encrypted
reasoning with tool calls. Only a validated `response.completed` authorizes tool
dispatch. Failed, incomplete, refused, mismatched and malformed responses leave
no executable tool batch. Compaction continues to preserve the recent raw suffix;
older provider state can be retired only when that history is compacted.

Tests use the native library, OS process SIGKILL and local HTTP fixtures, without
model credentials. They cover admission/intent/terminal crash boundaries,
repeated suspend/reconcile/reopen, child recovery, concurrent idempotent input,
policy gates and external routing, isolated environments, close deadlines,
output archives, multiple compactions and stateless Responses replay.
