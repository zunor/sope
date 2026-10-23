# Changelog

The version in `include/sope.h` is authoritative. The library, bindings, and `sope` executable are released together; see [docs/release.md](docs/release.md) for the policy.

## Unreleased

Adds permission modes, a model picker, and slash-command suggestions, and improves the tab bar, status animation, and tool output interactions. Also strengthens context compaction and adds durable execution, isolated file mutations, and complete output archives. New C recovery functions are exported; the event layout is unchanged.

### Durable execution and tools

- Add `sope_agent_open`, `sope_agent_recovery`, `sope_agent_resolve`, and `sope_agent_resume` (and JS equivalents). Persist accepted inputs, stable tool intents, individual results, round accounting, and checkpoints with SQLite WAL/FULL transactions; retain an ordered execution log independently of compressed model history.
- Hold exclusive session ownership across processes. Reopened unfinished tasks stay paused; committed results are reused and unknown outcomes require explicit reconciliation. Journal/archival failures stop execution. Options, credentials and host tool definitions are supplied again by the host.
- Use native journals for TUI execution state and add `/recover`. Old transcript-only sessions are not automatically migrated or treated as resumable tasks.
- Serialize built-in file operations by canonical path across agents and cooperating sope processes. Freeze expected content revisions when admitting edits, detect changes even when size/mtime are restored, and replace files atomically after syncing the new contents.
- Archive full shell stdout/stderr, large built-in/host results and truncated file reads. Add `artifact_read` byte pagination; background readers no longer advance over omitted bytes. The host owns archive retention.
- Add real SIGKILL, repeated recovery, queued-input, failed-commit, atomic-write interruption, concurrent-process mutation, long-output and TUI journal-authority regressions. SQLite is compiled into both shared and static libsope artifacts, including offline builds; no system SQLite installation or host SQLite driver is required. Its private symbol namespace avoids collisions with a host's SQLite.

### Context compaction

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
- Tabs have a light background, are one row high and 24 columns wide, and are separated by one column. Long titles are truncated and slowly scroll back and forth on hover. The active session uses bold text and a brighter background.
- The status bar uses a square pixel meteor, one row high and two columns wide, that completes a lap every 3 seconds with a thicker, brighter head. Enabled only after detecting Kitty graphics protocol support; other terminals and tmux/screen/Zellij fall back to Braille. `SOPE_GRAPHICS=0` disables the pixel effect. One blank row is kept above the status bar.
- Typing `/` opens a command list with filtering, keyboard and mouse selection, Tab completion, and Esc dismissal.
- `/help` is generated from the same table as the command list, so the two always agree: each command with its arguments, description, and shortcut.
- Long tool and subagent outputs show six lines by default. Hovering over the connector or `… N more lines` highlights both; click to expand, then click the connector or `show fewer lines` to collapse. Long output also has a collapse control at the end.
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
