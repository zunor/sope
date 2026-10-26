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

Context is checked before each model request, including restored sessions and newly added tool results. The TUI reads each model's window from the endpoint's `/models` list (`context_window` or `context_length`) at startup and when you switch models, passes it to libsope as `context.window`, and starts automatic compaction at 80% of it unless `SOPE_COMPACT_THRESHOLD` is set. `-p` mode does not query `/models`. Set `SOPE_CONTEXT_WINDOW` when the endpoint does not list a window, or for the model actually used (use the smaller capacity if switching between text and image models). The default input-admission reservation is 4096 tokens. Normal replies target 32000 tokens, fitted to the remaining model context; `/set openai.max_tokens 16000` overrides this target. In the TUI, `/set context.window 128000` changes the window from the next turn; `/set context.reserve 8192` increases the minimum output headroom. A window value of zero leaves the model capacity unknown.

`/compact [focus]` summarizes older messages while retaining recent originals within budget. `/set compact.retain_tokens 8000`, `/set compact.max_tokens 8192` and `/set compact.input_tokens 64000` control retention, summary output and summary input respectively. See the [ABI compaction contract](../abi.md#51-history-compaction) for failure behavior and estimation limits. If automatic compaction fails, sope preserves history and suppresses further proactive compaction for that turn. It continues only while the request fits the hard context budget; a new user turn or manual compaction can retry.

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
Repeated `read` ranges and exact `bash`/`check` command requests carry per-trace
keyed fingerprints, counts, and the previous call ID, scoped to an agent and
turn. These bounded indexes survive compaction within the trace. Command
descriptions and timeouts are ignored; different shell spellings remain distinct.
Counts describe requested work, not whether repeating it was unnecessary, whether
files changed, or whether a command succeeded. Shell reads are not included in
the `read` count. Raw paths, commands and arguments are never written to the trace.

The trace queue is capped at 256 KiB and each file at 64 MiB. `trace.gap` identifies
records dropped under backpressure; `trace.limit` marks the file limit. A normal
shutdown ends with `trace.end`; a missing terminal record means the trace is
incomplete. Retain or remove trace files according to your diagnostic needs.
They are not execution journals and cannot resume work.

Print mode handles SIGINT, SIGTERM and SIGHUP by cancelling the turn and cleaning
up its shell processes before returning status 130, 143 or 129 respectively.


## Provider recovery

Transient model failures retry automatically, including interrupted streams.
The previous attempt is marked as discarded; only a complete response can
execute tools. `/set openai.max_retries 5` controls the retry allowance (0–20;
zero disables retries). `/set openai.idle_timeout_ms 900000` bounds silence per
attempt and `/set openai.request_timeout_ms 1800000` bounds the whole request,
including retries and waiting. Cancellation also interrupts retry waits.

Backoff honors bounded `Retry-After` hints. Authentication, invalid requests and
output limits require correction rather than repeated requests. Enable
`SOPE_TRACE_DIR` to retain attempt, failure-class, delay and deadline metadata;
the trace does not contain model text, tool output or credentials.

Output truncation learns a larger budget (normally up to 64000 tokens; summaries
up to 32000). Durable sessions keep that hint across worker restarts, separately
for each endpoint/model/reasoning effort and for normal versus summary calls.
Current `openai.max_tokens_ceiling`, `compact.max_tokens_ceiling` and known context
capacity still bound every request. Set ceilings to the model endpoint’s limits.
Completed Chat reasoning is retained for same-model continuation; failed attempt
reasoning is discarded.

By default, model requests allow five minutes for the first response byte and
fifteen minutes between streamed chunks, accommodating slow reasoning providers.
The thirty-minute logical request deadline includes every retry and backoff.
Explicit shorter idle and request limits remain supported; cancellation interrupts
waiting. Web fetches retain their separate sixty-second transport limit.
