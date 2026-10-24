# Configuration

[Documentation](../README.md) · [Project overview](../../README.md)

Precedence, from lowest to highest: `~/.config/sope/config` (`KEY=VALUE` format) < environment variables < command-line arguments.

| Variable | Argument | Default |
|---|---|---|
| `SOPE_API_KEY` | | When set, selects the `openai` provider by default |
| `SOPE_MODEL` | `-m`, `--model` | `glm-5.3` |
| `SOPE_IMAGE_MODEL` | | `kimi-k3` on the default endpoint (glm-5.3 cannot process images); `off` sends images to `SOPE_MODEL` as well |
| `SOPE_DB` | | `~/.local/share/sope/sope.db` (session database) |
| `SOPE_BASE_URL` | `--base-url` | `https://api-taas.moi.matrixorigin.cn/v1` |
| `SOPE_PROVIDER` | `--provider` | `openai` when a key is set, otherwise `mock` |
| `SOPE_PERMISSIONS` | `--permissions`, `--allow-all` | `auto` (Approve for me); also supports `ask` and `full` |
| `SOPE_REASONING_EFFORT` | `--effort` | Unset (the model decides); `low`, `medium`, `high`, `xhigh`, also `none` and `minimal` |
| `SOPE_COMPACT_THRESHOLD` | | 80% of the model's window; `100000` while the window is unknown (`0` disables automatic compaction) |
| `SOPE_CONTEXT_WINDOW` | | The window the endpoint's `/models` reports for the model, otherwise unknown; set it to override |
| `SOPE_TRACE_DIR` | | Unset; environment-only opt-in directory for bounded metadata-only JSONL diagnostics |
| `SOPE_LIB` | | Load a different libsope instead of the embedded copy |
| `SOPE_MOUSE` | | `1`; `0` leaves mouse input to the terminal (the wheel becomes ↑/↓) |
| `SOPE_GRAPHICS` | | Automatically probes for the Kitty graphics protocol; `0` disables image tabs and the pixel meteor |
| `SOPE_TRUECOLOR` | | Automatically detected; `0`/`1` forces 256 colors / true color |

Context is checked before each model request, including restored sessions and newly added tool results. The TUI reads each model's window from the endpoint's `/models` list (`context_window` or `context_length`) at startup and when you switch models, passes it to libsope as `context.window`, and starts automatic compaction at 80% of it unless `SOPE_COMPACT_THRESHOLD` is set. `-p` mode does not query `/models`. Set `SOPE_CONTEXT_WINDOW` when the endpoint does not list a window, or for the model actually used (use the smaller capacity if switching between text and image models). The default output reservation is 4096 tokens. In the TUI, `/set context.window 128000` changes the window from the next turn; `/set context.reserve 8192` increases the normal output allowance. A window value of zero leaves the model capacity unknown.

`/compact [focus]` summarizes older messages while retaining recent originals within budget. `/set compact.retain_tokens 8000`, `/set compact.max_tokens 2048` and `/set compact.input_tokens 64000` control retention, summary output and summary input respectively. See the [ABI compaction contract](../abi.md#51-history-compaction) for failure behavior and estimation limits. If automatic compaction fails, sope preserves history and suppresses further proactive compaction for that turn. It continues only while the request fits the hard context budget; a new user turn or manual compaction can retry.

Native options are also available through `/set`. `/set openai.wire_api responses` selects stateless Responses requests on endpoints that support that protocol; the default is `chat`. `/effort` (or `/set reasoning.effort high`) sets the model's reasoning effort. Supported effort values depend on the model. These options take effect on the next turn; see the [ABI options table](../abi.md#9-options-and-providers) for the complete list.

## Shell tools

The TUI passes an explicit environment to libsope's shell tools: `PATH`, `HOME`,
temporary-directory and locale settings, and XDG configuration/data/cache paths.
The running executable's directory is prepended to `PATH`, so a source checkout's
`bun test` works even when its launcher did not include Bun in `PATH`.
Arbitrary environment variables, including model API keys and shell startup hooks,
are not inherited. This is environment hygiene, not a filesystem sandbox; tools
still run with your user account's file access. Embedded hosts can supply their
own complete environment through `sope_agent_policy` or JS `agent.setPolicy()`.

## Long-task diagnostics

Set `SOPE_TRACE_DIR=/absolute/path/to/traces` when launching either the TUI or
`sope -p`. Each session creates a private JSONL file with a trace ID. Records
contain tool/turn IDs, timings, provider attempts/status, token counts and a
periodic heartbeat; streamed text is counted rather than logged per token.
Prompts, reasoning, tool payloads, credentials and raw server errors are omitted.

The trace queue is capped at 256 KiB and each file at 64 MiB. `trace.gap` identifies
records dropped under backpressure; `trace.limit` marks the file limit. A normal
shutdown ends with `trace.end`; a missing terminal record means the trace is
incomplete. Retain or remove trace files according to your diagnostic needs.
They are not execution journals and cannot resume work.

Print mode handles SIGINT, SIGTERM and SIGHUP by cancelling the turn and cleaning
up its shell processes before returning status 130, 143 or 129 respectively.
