# Changelog

The version in `include/sope.h` is authoritative. The library, bindings, and `sope` executable are released together; see [docs/release.md](docs/release.md) for the policy.

## Unreleased

- TUI: distinguish horizontal wheel reports from vertical scrolling, use precise one-row wheel steps (`SOPE_SCROLL_SPEED` overrides), and coalesce redraws at a 60 Hz target while honoring terminal write backpressure. Diagonal trackpad gestures no longer move vertical panes in the wrong direction; reversing or stopping does not leave queued scroll animation.

- TUI: draw the tab bar like a browser's: the active tab is a grey outline, matching the input box, whose feet flare into a grey baseline under the bar, all within two rows, a hovered tab gets a subtle rounded ground, and thin grey separators stand between the others; the bar keeps the terminal's background. Pixel shapes where the terminal shows graphics, tinted text otherwise.

- TUI: show "n files changed +n -n" for the files each turn changed, two rows tall in a rounded pixel outline like a tab (tinted text without terminal graphics), through write, edit or commands (no git needed): right of the status while the turn runs, then in the transcript when it ends; each turn counts from zero. It lights up under the pointer, and a click (or `/diff` for the last turn) opens that turn's diffs in a panel that takes the right of the screen. The running status gets its own row, with the tip below it.

- Bound streams that emit only heartbeats or stop making model progress with a five-minute allowance before initial progress and a one-minute deadline after progress begins; continuous reasoning, text and tool arguments keep the request alive. Preserve excluded candidates and evidence references in compaction handoffs.

- Limit identical program repeats consecutively so a different shell command can repair state and reopen the retry allowance, even if its final probe fails. Keep aggregate tool-call limits and clarify that another model response does not start a new user turn.

- Accommodate slow reasoning providers with five-minute first-byte and fifteen-minute chunk-idle limits, within a thirty-minute logical request budget; remove the conflicting curl low-speed cutoff for model streams.

- Start normal model requests with a 32000-token output target and summaries with an independent 8192-token budget; fit requests to remaining context and retain learned truncation budgets across turns and durable worker restarts.
- Preserve completed Chat reasoning across tool rounds and durable history, replaying it only to its producing endpoint/model/effort; discard failed-attempt reasoning and count retained reasoning in context estimates.

## 0.6.0 — 2026-10-26

This release adds bounded model recovery, evidence-backed task acceptance,
durable subagent recovery, and terminal controls for long-running work. The C ABI
advances to 0.6 for new subagent/shell controls, retry events and runtime options.
Embedded hosts must rebuild with the matching header, library and bindings.
Durable sessions sealed with ABI 0.5 remain on a matching 0.5 runtime.

- Complete turn-state cleanup before hosts can observe the terminal event; fix Linux POSIX clock declarations and static math-library linkage.

- Recover truncated summaries with an independent output ceiling and bounded input accounting; preserve original history on failure/cancellation, identify provider error phases, and include attempts and elapsed time in timeout diagnostics.

- Recover output-truncated model responses with bounded output-budget growth, preserving committed tools and reported usage; expose output-limit exhaustion and budget changes in events and traces.

- Close a quiescent accepted/rejected/incomplete report directly in the runtime once todos are resolved, eliminating a final provider request and unnecessary compaction.

- Evaluate host-defined acceptance criteria against original native check observations; publish structured verdicts, preserve contracts through compaction, and prevent unsupported prose or todo completion from establishing acceptance.
- Return qualified native subagent results and let parents recall direct-child evidence after exit/reopen; record acceptance counts in traces.
- Add print-mode `--acceptance` and `--execution-dir`, and expose durable acceptance outcomes in JS/Go.

- Retain content-aware native text-read observations across compaction and unrelated commands; return qualified historical-result references for repeated unchanged payloads while still detecting changed file contents.
- Distinguish provider finish reasons from stream terminal events in diagnostic traces.

- Scope execution evidence by session and agent, include exact bounded invocations in working state, and reject ambiguous historical-result references.

- Preserve task plans and execution observations outside model summaries; retrieve historical tool results without rerunning them, reconcile unfinished plans before completion, and trace repeated reads.

- Retry transient provider and interrupted-stream failures with bounded attempts, jittered backoff, Retry-After and shared deadlines; expose explicit discarded-attempt events in the ABI, bindings, TUI and print mode.
- Extend diagnostic traces with retry classification, delay and remaining request budget.

- TUI: see and stop background work. Each subagent takes one row in the transcript, with its elapsed time, tool calls and tokens; a finished one unfolds into its tool calls and report on a click. While subagents or background shells run, the footer counts them after the permission mode; `↓` on an empty input, `/tasks` or a click on that summary opens a task tree (sope → subagents and shells → their latest tool calls or output), where `x` stops the selected subagent (with an optional note for the model) or shell while the rest of the turn goes on.
- Add `sope_subagent_cancel` to stop one subagent and let its parent turn continue, and `sope_agent_shells` / `sope_shell_stop` to list and stop background shells from the host (new ABI functions in 0.6).

- TUI: search the conversation with `ctrl+f` or `/find`. Matches are highlighted as you type; `enter`, `n`/`N` and the search bar's `↑` `↓` buttons cycle through them, matches in collapsed tool output are expanded, and `esc` returns to the previous position. `ctrl+f` no longer moves the input cursor; use `→`.

- Bound stalled model streams with native idle and absolute request deadlines; retry delays share the same absolute budget.

- Bound repeated reads, failed retries and aggregate tool/search work in the native harness; retain budgets across compaction and recovery.
- Add literal-argv `check`, a durable `evidence` ledger and runtime execution summaries that distinguish process exits from unverified test claims.

- Fix ancestor-path allocations leaking during file searches outside a Git repository.
- Add cross-platform CI, sanitizers, credential scanning and installable-package checks.
- Check subagent concurrency with a host-tool barrier instead of a wall-clock speed threshold.

## 0.5.0 — 2026-10-24

This release adds context visibility, hardens agent execution, and improves
long-session rendering and live demos. The C ABI advances to 0.5 because
`sope_agent_context` is new; hosts built for ABI 0.4 must rebuild with the
matching header and bindings.

### libsope (C ABI 0.5)

- Add `sope_agent_context`: report context usage, its breakdown, the automatic
  compaction threshold, and the largest tool results, including during a turn.
- Reject concurrent pool acquisition and duplicate shutdown during teardown.
- Reject malformed tool-call batches before dispatching any tool in the batch.
- Reject FIFOs and other special files in file, search, ignore-file and artifact
  readers, preventing shared workers from blocking on unbounded input.

### Bindings

- Expose context usage through Go `Agent.Context()` and JS `agent.context()`.
- Expose the native execution policy through JS `agent.setPolicy()`.
- Update the Go and JS compile/runtime guards to ABI 0.5.

### TUI

- Add `/context`, model/context usage in the bottom bar, and `/effort` with
  `--effort` / `SOPE_REASONING_EFFORT` controls.
- Size automatic compaction from 80% of the model's reported context window,
  while respecting explicit threshold and window settings.
- Scope host-tool cancellation by both agent and turn, so one finished
  subagent cannot cancel a sibling's tools.
- Avoid repeated Markdown style scans and cache folded output widths;
  measure fold hit areas only for visible output blocks.
- Handle malformed terminal key code points and zero-height approval previews.
- Restore shell access to Bun and other developer tools using an explicit
  environment, without inheriting model credentials or shell startup hooks.
- Use real GLM 5.3 for configured demos, with `--offline` for deterministic
  local responses and `--live` to require the configured endpoint. Failed
  offline edit verification reports the command output and exits nonzero.
- Update the README with the user-provided Ghostty capture of the live GLM 5.3
  edit demo.

### Development

- Move the repository release skill from `.claude` to `.agents` and update its
  documentation links.
- Keep Bun workspace lockfile versions in sync when bumping a release.
- Run special-file regression probes in fresh processes so macOS leak
  instrumentation does not interfere with their timeout checks.

## 0.4.0 — 2026-10-24

This release adds durable execution and host integration across libsope and its
bindings, plus permission-aware TUI workflows and stronger context handling.
The ABI advances to 0.4; hosts built for 0.3 must recompile.

### Bindings

- Add a Go SDK with typed lifecycle, recovery, durable receipts, event replay,
  terminal outcomes and context-aware waits; include shared/static pkg-config
  metadata. SQLite remains private inside libsope.

### libsope (C ABI 0.4)

- Commit tool receipts with replayable completion events; preserve committed
  cursors on rollback, filter stale live commands after suspension, and make
  SDK handle contention interruptible by context cancellation and close.
- Seal host execution contracts; provide tool allowlists, all-tool authorization,
  external execution routing and isolated per-agent subprocess environments.
- Add resumable suspension, stable session/open identities and atomic terminal
  checkpoint/outcome/event commits. Session format 2 rejects older databases.
- Support stateless Responses API requests, reasoning effort and encrypted
  reasoning replay across tool rounds and recovery; retain Chat Completions.
- Bump the event ABI to 80 bytes with a durable sequence field. Extend native and
  Go tests for SIGKILL, concurrency, repeated recovery, output archives and
  incomplete model responses.

#### Durable execution and tools

- Add `sope_agent_open`, `sope_agent_recovery`, `sope_agent_resolve`, and `sope_agent_resume` (and JS equivalents). Persist accepted inputs, stable tool intents, individual results, round accounting, and checkpoints with SQLite WAL/FULL transactions; retain an ordered execution log independently of compressed model history.
- Hold exclusive session ownership across processes. Reopened unfinished tasks stay paused; committed results are reused and unknown outcomes require explicit reconciliation. Journal/archival failures stop execution. Options, credentials and host tool definitions are supplied again by the host.
- Use native journals for TUI execution state and add `/recover`. Old transcript-only sessions are not automatically migrated or treated as resumable tasks.
- Serialize built-in file operations by canonical path across agents and cooperating sope processes. Freeze expected content revisions when admitting edits, detect changes even when size/mtime are restored, and replace files atomically after syncing the new contents.
- Archive full shell stdout/stderr, large built-in/host results and truncated file reads. Add `artifact_read` byte pagination; background readers no longer advance over omitted bytes. The host owns archive retention.
- Add real SIGKILL, repeated recovery, queued-input, failed-commit, atomic-write interruption, concurrent-process mutation, long-output and TUI journal-authority regressions. SQLite is compiled into both shared and static libsope artifacts, including offline builds; no system SQLite installation or host SQLite driver is required. Its private symbol namespace avoids collisions with a host's SQLite.

#### Context compaction

- Validate complete streamed summaries before replacing history; truncated, malformed, empty or cancelled summaries preserve the original conversation.
- Estimate full requests before sending, including restored history, system/tool definitions, new user input, images and tool results. Add explicit model windows and output reservations, and bounded recovery for server-reported context overflow.
- Keep a budgeted recent suffix with intact tool-call/result groups and images; mark persisted checkpoints separately from user intent. Bound summarization input and preserve both ends of large tool output with UTF-8-safe omission markers.
- Add independent summary input/output and retention options, and `SOPE_CONTEXT_WINDOW` for the CLI. Normal responses now use an explicit output limit (4096 by default); raise `context.reserve` or set `openai.max_tokens` for larger responses.
- Add offline provider integration tests and native budget/retention tests.
- Preserve full prior checkpoints on repeated compression, carry usage calibration through missing/invalid reports, and reserve actual request headroom before retaining recent messages.
- Serialize cancellation with checkpoint installation; reset retries per compaction, stop before unnecessary compaction at the model-round limit, and do not resend requests after failed overflow recovery.
- Reject refusals, incomplete tool calls and out-of-order streamed summaries; add continuous tool-loop, repeated-compaction and queued-turn recovery regressions.
- Preserve complete tool results and arguments whenever the full summary request fits its budget; fixed per-tool clipping could silently discard critical middle evidence. Add an opt-in live-model compaction/restore/failure evaluation.

### TUI

- Three permission modes: Ask for approval, Approve for me (default), and Full access. The bottom bar shows the current mode; `shift+tab` cycles modes; `/permissions` opens the picker; `--permissions ask|auto|full` / `SOPE_PERMISSIONS` sets the initial mode (`--allow-all` is equivalent to `full`).
- Approve for me parses shell commands (pipelines, `$( )`, `sh -c`, `find -exec`, `xargs`, and heredocs), prompting only for deleting or changing files outside the working directory, deleting the entire directory or `.git`, publishing such as `git push`, discarding uncommitted Git changes, `sudo`, global installs, `ssh`, `curl` uploads, and `curl | sh`. The dialog explains why approval is needed.
- Approval prompts now use a bordered dialog: select with `↑`/`↓` and confirm with Enter, or use `1`–`4`, mouse clicks, or `y`/`a`/`n`/`esc`. Switching to a more permissive mode automatically approves pending requests.
- `-p` evaluates actions according to the permission mode (previously all were denied unless `--allow-all` was set).
- Model picker (`/model` or `alt+m`): lists chat models from the endpoint, with recently used models first; type to search or use a model name directly. Recently used models are stored in the database.
- The tab bar occupies two rows with thin rounded image borders, fixed 20-column widths, and one-column gaps. Image-rendered titles sit vertically centered with padding, truncate and slowly scroll back and forth on hover. All tab titles use regular weight; the active session uses a white outline. Borders are sized to terminal cell pixels and cached independently of the meteor; unsupported terminals or unavailable text rasterization fall back to native text with subtle background tabs.
- The status bar uses a square pixel meteor, one row high and two columns wide, that completes a lap every 3 seconds with a thicker, brighter head. Enabled only after detecting Kitty graphics protocol support; other terminals and tmux/screen/Zellij fall back to Braille. `SOPE_GRAPHICS=0` disables the pixel effect. One blank row is kept above the status bar.
- Typing `/` opens a command list with filtering, keyboard and mouse selection, Tab completion, and Esc dismissal.
- `/help` is generated from the same table as the command list, so the two always agree: each command with its arguments, description, and shortcut.
- Long tool and subagent outputs show six lines by default. Hovering anywhere in the output block turns its connector and `… N more lines` white. Click the block to expand, then click anywhere in the expanded block to collapse; no separate collapse label is inserted.
- The input uses a rounded character box that grows to eight content rows, constrained by the window height. Enable enhanced keyboard reporting for Shift+Enter newlines, retaining Ctrl+J and Alt+Enter as alternatives; Enter sends.
- User messages appear in right-aligned rounded character boxes. Only the latest message's border breathes from gray to white and back over six seconds, updating at 10 fps while idle and visible; older messages keep gray borders.
- The bottom bar now shows only the permission mode and temporary hints, with distinct diamond icons. Only Full access is red; other modes are light gray. Key hints, model, context, and token statistics have been removed. Dialog key hints have moved into the dialog's bottom border.

## 0.3.0 — 2026-10-23

Sessions can be saved and restored, and messages can include images. The library exports and reloads conversation history; the TUI stores sessions by directory in SQLite, and screenshots and diagrams can be sent to the model. The ABI advances to 0.3 with new functions; hosts built for 0.2 must recompile.

### libsope (C ABI 0.3)

- `sope_agent_history` / `sope_agent_load_history`: export and restore conversation history as a JSON array to save and restore sessions; available only between turns (otherwise `SOPE_EBUSY`).
- `sope_attach_image`: attach images to the next `sope_send` (PNG/JPEG/GIF/WebP, ≤10 MiB).
- `read` passes image files to the model, and `web_fetch` does the same for image URLs. Images within web pages are represented as `![alt](url)` (previously just `[image: alt]`) so the model can fetch them separately.
- The `openai` provider sends `image_url` content blocks with data URLs; images from tool results are sent immediately afterward in a separate user message.
- New `image_model` option: the model to switch to when the conversation contains images.
- History JSON includes images (`images`); compaction represents them as `[N images attached]`. The library exports 23 symbols in total.

### Bindings

- `Agent.history()`, `Agent.loadHistory(json)`, and `Agent.attachImage(bytes, mediaType?)`.

### TUI

- Session tabs: a single row of adjacent colored tabs, with each right edge fading into a soft shadow (colors are based on the terminal background queried through OSC 11). Hover to reveal `×` for closing (soft deletion). Only the 5 most recent sessions appear by default; `⋯` on the right or `/sessions` opens a filterable list of all sessions.
- Sessions are stored in SQLite (`~/.local/share/sope/sope.db`, configurable with `SOPE_DB`); displayed history and model memory are restored at startup.
- Image input: `ctrl+v` pastes clipboard images, dragging in an image file attaches it automatically, and `--image <file>` works from the command line. On the default endpoint, images are sent to `kimi-k3` (`SOPE_IMAGE_MODEL`, since glm-5.3 cannot process images).
- `write` / `edit` approval previews now show a diff against the current file, with line numbers, addition/deletion backgrounds, and syntax highlighting.
- Running status moves to a separate row above the input box: a meteor crosses `──━━✦ Thinking… (1m 4s · 38 tok/s · tip: …)`, with an animated highlight on the verb. Elapsed time updates every second, speed is estimated from the last 3 seconds of streaming output, and tips appear for 10 seconds every 30 seconds.
- Removes the top version information row; the model, context size, and total tokens move to the right side of the bottom hint row.

## 0.2.0 — 2026-10-23

Tools move from the TUI into the library: embedding libsope from any language now provides file reading and writing, search, command execution, and web fetching directly. The ABI advances to 0.2 with new functions and events; hosts built for 0.1 must recompile.

### libsope (C ABI 0.2)

- Built-in tools: `read`, `write`, `edit`, `glob`, `grep`, `bash` (`run_in_background` plus `bash_output` / `bash_kill`), `web_fetch`, and `todo_write`, inspired by soren's tools of the same names.
- Each tool call is a separate thread pool task: parallel tool calls actually run concurrently, and waiting for commands or downloads does not occupy a thread. Adds a process reaper thread (`src/proc.c`).
- New events: `SOPE_EVENT_TOOL_START` (12), `SOPE_EVENT_TOOL_END` (13, emitted for all tool calls, including host tools), and `SOPE_EVENT_PERMISSION` (14).
- New `sope_permit` function to approve or deny tool calls requiring permission, with an optional denial message for the model.
- New options: `cwd` (tool working directory) and `permissions` (`ask` / `allow` / `deny`).
- `write` / `edit` require files to have been read first and to remain unchanged since that read.
- Cancelling a turn kills running commands (entire process groups), aborts downloads, and closes every open tool call with `TOOL_END`.
- Hosts can replace built-in tools by registering tools with the same names. A subagent type's `tools` list applies to both built-in and host tools.
- Mock provider: `!<tool> {json}` passes JSON input directly; `;;` calls multiple tools in one response.

### sope executable

- No longer implements tools itself; it only displays tool events from the library and answers permission requests.
- `todo_write` task lists appear directly in the conversation.
- In `-p` mode without `--allow-all`, the library now directly denies tools requiring permission and sends the reason to the model.

## 0.1.1 — 2026-10-23

- License: MIT (`LICENSE`, copyright holder Zonor, SPDX identifiers in source files). Bundled release archives include curl and mbedTLS licenses.
- The TUI captures mouse input by default: the wheel scrolls the conversation (previously it became ↑/↓ in the alternate screen and browsed input history). Drag to select text and release to copy to the clipboard (OSC 52 plus pbcopy/wl-copy/xclip). `SOPE_MOUSE=0` or `/mouse` returns mouse input to the terminal.
- New output no longer pushes the view down while scrolling up.

## 0.1.0 — 2026-10-22

Initial release.

### libsope (C ABI 0.1)

- Agent loop: model → tools → model, supporting multiple tool calls at once; `max_rounds` limits the number of rounds.
- Subagents: built-in `agent` tool and custom types through `sope_subagent_register`; multiple subagents run in parallel.
- Shared thread pool: agents do not occupy dedicated threads, and waiting for models, tools, or subagents does not occupy a thread.
- One readable fd per agent (`sope_agent_fd`), for integration with poll/epoll/kqueue/libuv.
- History compaction: automatic with `compact.threshold`, manual with `sope_compact`, and the `SOPE_EVENT_COMPACT` event.
- Providers: OpenAI-compatible streaming Chat Completions (including reasoning, parallel tool calls, usage, and automatic retries), plus an offline mock.
- Build option `SOPE_CURL=system|bundled|off`: bundled mode links curl and mbedTLS statically into libsope, exporting only `sope_*`; `tls.ca_file` option.
- The shared library exports only 19 `sope_*` symbols.

### sope executable

- Single file with embedded libsope: `sope` opens the full-screen TUI; `sope -p` provides noninteractive output and accepts piped input.
- Tools: `list_files`, `read_file`, and `search` (read-only, run directly); `write_file`, `edit_file`, and `bash` (require user approval).
- Permission prompts: allow once / always allow for this session / deny / deny and stop; `--allow-all` skips prompts.
- `/compact`, context size display, ABI trace panel, Markdown rendering, and subagent progress.
- Configuration through `~/.config/sope/config` or environment variables.
