# sope C ABI

`include/sope.h` is the source of truth for the ABI. This document covers details that do not fit in header comments: the threading model, lifetimes, turn and subagent semantics, ownership, and guidance for language binding authors.

> Current version: 0.4.0 (ABI 0.4). Compatibility rules (`sope_version_number()` returns the version actually loaded at runtime):
> - From 1.0 onward, semantic versioning applies: a host compiled against X.Y can use any X.Z library where Z ≥ Y. Breaking changes require a new major version.
> - Before 1.0, a minor version change may break the ABI: the host requires matching major and minor versions; patch versions may differ.
>
> Bindings should check the version when loading the library (the JS bindings already do). See [release.md](release.md) for the release and versioning policy.

## 1. Basic conventions

| Convention | Details |
|---|---|
| Return values | `int` functions return `SOPE_OK` (0) or a positive value on success, or a negative `SOPE_E*` error code |
| Error messages | Call `sope_last_error()` after a failure to get a description. It is **thread-local**, like `errno`, so concurrent calls do not interfere |
| Strings | Always UTF-8. Inputs with explicit lengths do not need a NUL terminator; strings returned by the library are always NUL-terminated |
| Ownership | The library never takes ownership of caller memory; all inputs are copied before the call returns |
| Handles | `sope_agent_t*` is opaque; do not assume anything about its layout |

### Error codes

| Code | Value | Meaning |
|---|---|---|
| `SOPE_OK` | 0 | Success |
| `SOPE_ERROR` | -1 | Unclassified error |
| `SOPE_EINVAL` | -2 | Invalid argument |
| `SOPE_ENOMEM` | -3 | Out of memory |
| `SOPE_ENOTFOUND` | -4 | Object not found (tool call ID, provider, etc.) |
| `SOPE_ECLOSED` | -5 | Agent is closed |
| `SOPE_ECANCELLED` | -6 | Operation was cancelled |
| `SOPE_EBUSY` | -7 | Operation is not allowed in the current state (e.g. changing the thread count after the pool has started) |

## 2. Architecture and threading model

```
  Host                                  libsope
 ┌────────────────┐ send / cancel /    ┌──────────────────────────────────────────────────────┐
 │ UI / app thread│─ tool_result ─────▶│ agent A ─┬─ subagent A1  ┐                           │
 │                │                    │ agent B  └─ subagent A2  ├─▶ Shared thread pool      │
 │ Event loop     │◀─ fd readable ─────│ agent C                  ┘   (N threads)             │
 │ (poll/epoll)   │◀─ sope_poll ───────│ Built-in tools (one task per call)      ▲             │
 └────────────────┘                    │ HTTP I/O thread (libcurl multi) ────────┤ wake up     │
                                       │ Process reaper thread (bash children) ──┘             │
                                       └──────────────────────────────────────────────────────┘
```

- **Agents do not occupy dedicated threads.** All agents, including subagents, run on one process-wide shared thread pool. Creating an agent only allocates memory.
- **Turns within an agent execute strictly in sequence.** Different agents and multiple subagents within a turn run concurrently.
- **Waiting turns release their worker.** Local file I/O and durable commits are synchronous, but a turn is otherwise a state machine: while waiting for tool results, subagents, or the next model output chunk, it suspends and releases its thread. A single HTTP I/O thread (libcurl multi) drives all network activity and wakes the relevant turn when data arrives. A single reaper thread reads output and collects exit statuses from `bash` child processes, likewise waking tasks only when there is activity.
- **Each built-in tool call is a separate task**, so multiple tools requested in one model response actually execute in parallel. File reads and searches run directly on the thread pool; waiting for commands or downloads does not occupy a thread.
- `sope_set_threads(n)` sets the thread count. Call it before the first `sope_agent_new` (or after `sope_shutdown`); otherwise it returns `SOPE_EBUSY`. `0` selects the default: the CPU count, clamped to 2–8.
- `sope_shutdown()` stops and joins the thread pool, HTTP thread, and process reaper thread. All agents must have been freed first. This optional call is useful before unloading the dynamic library or when collecting a clean leak report. The next `sope_agent_new` restarts everything automatically.

### Which threads may call which functions

| Function | Rule |
|---|---|
| All functions except the two below | Any thread; concurrent calls are allowed |
| `sope_poll` | Any thread, but **only one thread may poll a given agent at a time** (single consumer) |
| `sope_agent_free` | Must not run concurrently with any other call on the same agent |

## 3. Waiting for events: blocking poll or readable fd

Choose either approach:

1. **Blocking poll**: `sope_poll(agent, &ev, timeout_ms)`. Suitable for hosts with one polling thread (or Worker) per agent.
2. **Readable fd**: `sope_agent_fd(agent)` returns a file descriptor that is readable **if and only if** `sope_poll` would not block (events are queued, or the agent is closed). Add it to an event loop such as `poll`/`epoll`/`kqueue`/libuv/asyncio so a single thread can wait on thousands of agents. When it becomes readable, drain events with `sope_poll(agent, &ev, 0)`.

The agent owns the fd: **do not read, write, or close it**. It is created on the first call (using 2 fds per agent) and closed by `sope_agent_free`. Currently POSIX-only. See `examples/multiplex.c`.

## 4. Lifecycle

```
sope_agent_new ─▶ sope_agent_set_option / sope_tool_register / sope_subagent_register
              ─▶ sope_send ──┐
                             ▼
               ┌──── Wait for events (sope_poll or fd) ◀───────────┐
               │  TOOL_CALL → execute tool → sope_tool_result       │
               │  TURN_END  → turn complete                        │
               └───────────────────────────────────────────────────┘
sope_agent_close ─▶ Drain events until SOPE_ECLOSED ─▶ sope_agent_free
```

- `sope_agent_close` is idempotent: it cancels the running turn and its subagents, ends queued turns as `cancelled`, and makes subsequent `sope_send` calls return `SOPE_ECLOSED`. Once remaining events have been drained, `sope_poll` returns `SOPE_ECLOSED`.
- `sope_agent_free` closes the agent if needed, waits for the thread pool to finish processing the agent **and all its subagents**, then frees memory.
- `sope_agent_reset` clears conversation history, taking effect at the start of the next turn.
- **Saving and restoring sessions**: `sope_agent_history(agent, &json, &len)` exports conversation history as a JSON array, and `sope_agent_load_history(agent, json, len)` restores it (possibly into a new agent in another process). Both are only available between turns and return `SOPE_EBUSY` if a turn is running or queued, so `SOPE_EVENT_TURN_END` is a good time to export. The exported pointer remains valid until the next `sope_agent_history` or `sope_agent_free`; the host must not free it. For ephemeral agents, the host decides where to save these snapshots. For crash-safe execution, use `sope_agent_open` with a host-selected session directory; libsope manages its durable journal (section 13).

  ```json
  [{"role":"user","content":"Fix this bug"},
   {"role":"assistant","content":"Let me take a look.",
    "tool_uses":[{"id":"call_1","name":"read","input":"{\"file_path\":\"a.c\"}"}]},
   {"role":"tool","tool_use_id":"call_1","name":"read","content":"…","is_error":false},
   {"role":"assistant","content":"Fixed."}]
  ```

  `input` is the tool's JSON input encoded as a string. User and tool messages with images also include `"images":[{"media_type":"image/png","data":"<base64>"}]`. Compacted history begins with a summary (one user message); reasoning is not saved. On restore, trailing tool calls without responses receive “cancelled” results. The agent also forgets which files it has read, so files must be read again before editing. Invalid history returns `SOPE_EINVAL`, and `sope_last_error()` identifies the offending message.

- **Images**: `sope_attach_image(agent, media_type, data, len)` attaches an image to the next `sope_send` message (raw PNG, JPEG, GIF, or WebP bytes, up to 10 MiB; the library copies them). That message consumes all previously attached images; `sope_compact` does not consume them. Pass NULL for `media_type` to detect it from the file header. Built-in tools can also produce images: `read` attaches image files to its result, and `web_fetch` does the same for image URLs. The `openai` provider sends images as `image_url` content blocks with data URLs. Tool messages support only text, so images from a round of tool results are sent immediately afterward in a separate user message. The model must support images: for text-only models such as glm-5.3 (whose server returns 400 for images), set `image_model` to switch subsequent requests to that model as soon as the conversation contains an image.

## 5. Turns and the agent loop

Each successful `sope_send` creates a turn and returns its `turn_id` (starting at 1 and increasing per agent). Each turn runs an agent loop:

```
Call model ──(tool requests)──▶ Run built-in tools / emit TOOL_CALL / start subagents ──(all results ready)──▶ Call model again ──▶ …
   └──(direct answer, no tools)──▶ TURN_END(end_turn)
```

- One model call can request multiple tools in parallel. The library executes built-in tools concurrently (see section 6). It emits host tools' `TOOL_CALL` events in sequence, and the host may execute them concurrently. The next round starts only after all results arrive.
- A turn may call the model at most `max_rounds` times (default: 32). Exceeding the limit ends the turn with `ERROR` + `TURN_END(error)`.
- If the model calls an unavailable tool, the library returns an error result directly to the model without involving the host.
- The agent retains conversation history (user messages, assistant messages and tool calls, and tool results) across turns. When a turn is cancelled, unanswered tool calls receive `cancelled` results so the history remains valid for the model API.
- Long histories can be compacted; see section 5.1.

Library invariants:

1. **Every accepted turn produces exactly one `TURN_END`**, even if closing the agent discards it before it starts.
2. A turn emits `TURN_START` when execution begins; a turn discarded before it starts emits only `TURN_END`.
3. All events for a turn, including subagent events, precede its `TURN_END`.
4. After `TOOL_CALL`, the turn waits for `sope_tool_result`; after `PERMISSION`, it waits for `sope_permit`, unless cancelled.
5. Every tool call the host sees opened (`TOOL_CALL` for host tools, `TOOL_START` for built-in tools) ends with a `TOOL_END` carrying the same `call_id`, before `TURN_END`. This also holds when a turn is cancelled (with result `Cancelled.`).
6. When a turn ends, all its unfinished tool calls become invalid. Late `sope_tool_result` / `sope_permit` calls return `SOPE_ENOTFOUND`.

`sope_cancel` kills running commands (their entire process groups), aborts active downloads, and then ends the turn.

`sope_cancel` cancels only the **running** turn and its subagents; queued turns are unaffected.

### 5.1 History compaction

Long conversations are compacted into a checkpoint plus a budgeted suffix of recent original messages. The current system prompt and tool schemas remain part of subsequent requests.

- **Automatic**: set `compact.threshold` to a positive token count. Before every model call, Sope estimates the full request (history, system prompt, tool schemas, images and newly added input/tool results), and takes the larger of that estimate and the last reported usage plus estimated growth. Restored histories use the estimate immediately. Missing or invalid usage reports preserve any prior calibration and add locally estimated growth; they do not reset the token watermark. The library default is disabled; the CLI defaults to 100000.
- **Model window**: set `context.window` to the model's full token capacity. Sope reserves `max(context.reserve, openai.max_tokens)` for output and uses the smaller of the remaining input capacity and `compact.threshold` as the automatic trigger. `context.window=0` means unknown: the soft threshold still works, but no model-specific hard limit can be enforced. `compact.threshold=0` disables all automatic summarization, including overflow recovery; a configured hard window is still checked.
- **Manual**: `sope_compact(agent, instructions, len, &turn_id)` queues a compaction turn. Optional instructions guide the summary. Empty history ends immediately with `end_turn`.
- **Retention**: a contiguous recent suffix remains verbatim, including images. An assistant's tool calls and all their results form an indivisible group. Retention is capped by `compact.retain_tokens` (default 8000), one quarter of the existing history, and one quarter of each configured input limit/automatic threshold. The retained suffix must also leave space for system/tool definitions, the incoming user input and the summary output budget plus its wrapper. Oversized groups are summarized, never split into orphan tool results. At turn start, the incoming user message is additionally kept verbatim outside summarization. Mid-turn compaction includes a continuation reminder. Checkpoints carry `"summary":true` in exported history so later compactions distinguish them from user intent.
- **Bounded summary input**: the model sees a plain-text transcript of the older prefix. Text, tool results and arguments remain complete when the entire summary request fits `compact.input_tokens` and the model window minus `compact.max_tokens`. Only when that request exceeds its budget are per-field limits reduced until it fits, retaining both ends with explicit omission markers. UTF-8 characters remain whole. Instructions and previous checkpoints are never clipped: a checkpoint is the only remaining record of earlier work. If these protected parts and framing cannot fit, compaction fails without changing history. Images outside the retained suffix are represented by an explicit unavailable-pixels notice. Over-budget clipping and model summarization remain lossy; a completed summary is not a guarantee of semantic completeness.
- **Summary integrity**: the provider must confirm normal completion. The OpenAI provider requires `finish_reason="stop"` and `[DONE]` for summaries; malformed or out-of-order streams, length/content-filter endings, refusals, tool calls (including incomplete calls), empty/whitespace summaries and allocation failures cannot replace history. Summary calls have their own `compact.max_tokens` output limit (default 2048), no tools, and emit neither `TEXT_DELTA` nor `THINKING_DELTA`.
- **Commit and failure**: a completed candidate is checked against the full input budget, including retained and incoming messages, before replacing the older prefix. Automatic compaction must also reduce the local request estimate. Failure/cancellation preserves original history and any held user input. Checkpoint installation and cancellation are serialized: cancellation accepted before installation prevents that checkpoint from being committed. Manual failure ends with `TURN_END(error)`. Automatic failure can continue only if the original request fits the configured hard budget and has not already been rejected by the server as oversized; otherwise the turn fails without sending that request.
- **Server overflow recovery**: structured `context_length_exceeded` / `context_window_exceeded` errors cause summary requests to retry at most twice with smaller transcript budgets. When automatic compaction is enabled, a normal request that fails with one of these codes before producing output can compact and retry once per model round. Each new compaction owns its retry budget, even if two compactions occur within one model round. A failed overflow recovery does not resend the known-oversized request. Retry attempts still emit diagnostic errors and consume any reported usage; there is no unbounded retry loop. The model-round limit is checked before automatic compaction, preserving final tool evidence when no next model call is allowed.
- **Events**: summary calls emit `USAGE` when supplied by the provider. Successful compaction emits `SOPE_EVENT_COMPACT`: `name` is `"auto"` or `"manual"`, and `data` contains the summary text. The retained suffix is available through the normal history export.

Token counts are estimates, not a model-specific tokenizer: ASCII text uses roughly four bytes per token, non-ASCII text is charged conservatively, and image estimates include a conservative encoded-size allowance. Set the window for the model actually used, including `image_model`, and allow headroom. No live model quality evaluation is implied by the deterministic regression suite.

## 6. Built-in tools

Every agent comes with tools executed by the library; the host does not need to implement them. The set is inspired by the most commonly used tools in soren (Claude Code's tool design):

| Tool | Purpose | Permission required |
|---|---|---|
| `read` | Read files with `cat -n`-style line numbers; paginate with `offset`/`limit` (default: 2000 lines). Image files (PNG, JPEG, GIF, WebP) go directly to the model; other binary files and directories produce errors | No |
| `glob` | Find files by path pattern (`**/*.ts`, `src/**/test_*.{c,h}`), newest modification time first, up to 100 results | No |
| `grep` | Search content with regular expressions; `output_mode` is `files_with_matches` (default), `content`, or `count`. Supports `glob`, `case_insensitive`, `context`, and `head_limit` | No |
| `write` | Write a file, creating parent directories automatically | Yes |
| `edit` | Replace exact text; errors if `old_string` is not unique unless `replace_all` is set. An empty `old_string` creates a file | Yes |
| `bash` | Run a command with `bash -c`, returning merged stdout/stderr and the exit code; `timeout` defaults to 2 minutes, up to 10 minutes; `run_in_background` enables background execution | Yes |
| `bash_output` | Read new output from a background command since the last call, and report whether it is still running | No |
| `bash_kill` | Stop a background command and all its child processes | No |
| `web_fetch` | Fetch an HTTP(S) URL: convert HTML to text with headings, lists, and links (page images become `![alt](url)`); return text and JSON unchanged; send image URLs' images directly to the model. Follows redirects; paginate long pages with `offset` (about 40000 bytes per page) | Yes |
| `todo_write` | Maintain a task list: submit the full list each time, with `content`, `activeForm`, and `status` for each item | No |

Full tool descriptions and JSON schemas are next to each tool in `src/tool_*.c`; these are what the model sees.

**Events.** Each built-in tool call first emits `TOOL_START` (`data` contains JSON input, which the host can display—for example, rendering a `todo_write` list), then `TOOL_END` (`code` is 1 on failure; `data` is the result shown to the model). Host tool calls also emit `TOOL_END`, allowing the host to display all tool results in one place.

**Permissions.** Tools that change files, execute commands, or access the network (marked “Yes” above) emit `PERMISSION` before execution and wait:

```c
case SOPE_EVENT_PERMISSION:
    /* ev.name: tool name; ev.data: JSON input. Ask the user or apply the host's policy. */
    sope_permit(agent, ev.call_id, user_said_yes, reason, reason_len);
```

A denial can include a `message`, such as “Use edit instead,” which is passed to the model with the denial. The `permissions` option sets the overall policy: `ask` (default), `allow` (execute without asking), or `deny` (reject immediately, useful for read-only use). Policies such as “always allow this tool for this session” belong in the host: simply call `sope_permit` immediately after receiving `PERMISSION`.

**Working directory.** The `cwd` option sets the base for relative paths and the working directory for commands. It defaults to the process's current directory. Tools accept absolute paths, and `~/` expands to `$HOME`.

**Read before editing.** The agent records the modification time and size of every file the model has read or written. `write` and `edit` reject changes to existing files the model has not read, or that have changed since it read them. The model must read the file again to avoid overwriting others' changes based on stale content. `sope_agent_reset` clears this record; subagents maintain their own records.

**Search rules.** `glob` and `grep` skip hidden files, `node_modules`, and paths ignored by `.gitignore` files at every level from the repository root to the search directory. Patterns without `/`, such as `*.c`, match only within the search directory; use `**/*.c` for recursive matching. `grep` uses POSIX extended regular expressions and rewrites common model-generated syntax into equivalents: `\d`, `\w`, `\s` (and uppercase forms), `(?i)`, `(?:...)`, and lazy quantifiers. Binary files and files larger than 20 MB are skipped.

**Command environment.** `bash` commands run in a new session (without a controlling terminal, so the whole group can be killed), with stdin set to `/dev/null`. They inherit the host process's environment, with `PAGER=cat`, `GIT_PAGER=cat`, `GIT_TERMINAL_PROMPT=0`, `TERM=dumb`, and `NO_COLOR=1`. Each call starts a new shell; `cd` does not persist. Output larger than 30000 bytes retains only its beginning and end. Results have ANSI escape sequences removed and are valid UTF-8. Background commands belong to the root agent and are all killed by `sope_agent_free`.

**Replacing built-in tools.** Register a host tool with the same name using `sope_tool_register` to replace the corresponding built-in tool—for example, to run `bash` in a sandbox.

## 7. Subagents

Inspired by soren's AgentTool:

- As long as a subagent type is registered (`general-purpose` is built in), the model sees the built-in `agent` tool with input `{description, prompt, subagent_type?}`. Set `subagents=off` to hide it.
- When the model calls `agent`, the library creates a **subagent** with fresh conversation history, the type's system prompt, a tool set filtered by the type (both built-in and host tools), and an optional separate model. The tool set **never includes `agent` itself, preventing recursion**. Each subagent runs as a separate task on the thread pool, so multiple subagents launched in one response execute **in parallel**.
- A subagent closes automatically after one turn. Its **last message** becomes the parent agent's `agent` tool result. Cancellation or failure marks the result as an error and includes partial output.
- Subagent events go into the **same event queue** (and use the same fd). Their `agent_id` equals the `call_id` that launched the subagent. Host tool requests still appear as `TOOL_CALL`, and built-in tools requiring permission still emit `PERMISSION`. The host uses the root agent handle with `sope_tool_result` / `sope_permit` as usual.

Registering a subagent type:

```c
static const char def[] =
    "{\"name\":\"reviewer\",\"description\":\"Reviews a diff for bugs.\","
    "\"system_prompt\":\"You are a careful code reviewer...\","
    "\"tools\":[\"read\",\"grep\",\"glob\"],\"model\":\"glm-5.3\",\"max_rounds\":8}";
sope_subagent_register(agent, def, sizeof def - 1);
```

| Field | Required | Description |
|---|---|---|
| `name` | Yes | 1–64 characters from `[A-Za-z0-9_-]`; replaces an existing type with the same name |
| `description` | Yes | When to use this type; shown to the model |
| `system_prompt` | Yes | The subagent's system prompt |
| `tools` | No | Array of tool names (built-in or host), or `"*"` (default: all) |
| `model` | No | Overrides the parent's model |
| `max_rounds` | No | Overrides the parent's `max_rounds` |

## 8. Events

Before each `sope_poll`, set `ev.size` to `sizeof(sope_event_t)`. `name` and `data` are never NULL and remain valid until the next `sope_poll` on the same agent or `sope_agent_free`; copy them if needed later. `agent_id` is 0 for the agent's own events and nonzero for subagent events.

| Type | Value | Fields |
|---|---|---|
| `TURN_START` | 1 | `turn_id` |
| `TEXT_DELTA` | 2 | `data`: a chunk of assistant output text |
| `TOOL_CALL` | 3 | `call_id`, `name`: tool name, `data`: JSON input. Requires a response through `sope_tool_result` |
| `TURN_END` | 4 | `code`: `SOPE_STOP_END_TURN` (0) / `CANCELLED` (1) / `ERROR` (2) |
| `ERROR` | 5 | `code`: `SOPE_E*`, `data`: error description; usually followed by `TURN_END(error)` |
| `LOG` | 6 | `code`: `SOPE_LOG_DEBUG..ERROR` (0–3), `data`: log message |
| `THINKING_DELTA` | 7 | `data`: a chunk of model reasoning (such as GLM's `reasoning_content`) |
| `USAGE` | 8 | `data`: `{"input_tokens":N,"output_tokens":N}`, once per model call |
| `SUBAGENT_START` | 9 | `call_id`, `name`: subagent type, `data`: JSON input |
| `SUBAGENT_END` | 10 | `call_id`, `code`: `SOPE_STOP_*`, `data`: the subagent's final report |
| `COMPACT` | 11 | `name`: `auto` / `manual`, `data`: the summary that replaced history (see 5.1) |
| `TOOL_START` | 12 | `call_id`, `name`: built-in tool name, `data`: JSON input. Executed by the library (see section 6) |
| `TOOL_END` | 13 | `call_id`, `name`, `code`: 1 on failure, `data`: the result shown to the model. Emitted for all tool calls, both host and built-in |
| `PERMISSION` | 14 | `call_id`, `name`, `data`: JSON input. Requires a response through `sope_permit` |

**Hosts must ignore unknown event types** for compatibility with newer libraries.

### Memory layout on 64-bit platforms (for FFI)

Static assertions in `src/agent.c` enforce this layout.

| Offset | Field | Type |
|---|---|---|
| 0 | `size` | u32 |
| 4 | `type` | u32 |
| 8 | `turn_id` | u64 |
| 16 | `call_id` | u64 |
| 24 | `agent_id` | u64 |
| 32 | `name` | ptr |
| 40 | `name_len` | u64 |
| 48 | `data` | ptr |
| 56 | `data_len` | u64 |
| 64 | `code` | i32 |
| 68 | `reserved` | u32 |
| 72 | `sequence` | u64 |
| | Total | 80 bytes |

## 9. Options and providers

Use `sope_agent_set_option(agent, key, value)`; `value == NULL` removes an option. Options are read at the start of each turn, so changes take effect on the next turn. Subagents inherit all parent options.

| Key | Description | Default |
|---|---|---|
| `provider` | `mock` (offline) or `openai` (any OpenAI-compatible service) | `mock` |
| `model` | Model name, e.g. `glm-5.3`; required for `openai` | — |
| `image_model` | Model to switch to when the conversation contains images (for when `model` cannot process them) | Uses `model` |
| `system` | System prompt | A short built-in prompt |
| `max_rounds` | Maximum model calls per turn | `32` |
| `cwd` | Working directory for built-in tools | Process's current directory |
| `permissions` | `ask`: built-in tools requiring permission emit `PERMISSION` first; `allow`: execute immediately; `deny`: reject immediately | `ask` |
| `subagents` | `off` hides the built-in `agent` tool | — |
| `compact.threshold` | Full request token threshold for automatic compaction (see 5.1); `0` disables it | `0` |
| `context.window` | Full model context capacity, including reserved output; `0` means unknown | `0` |
| `context.reserve` | Minimum output reservation and default normal response output limit | `4096` |
| `compact.max_tokens` | Summary output limit/reservation, independent of normal output | `2048` |
| `compact.input_tokens` | Maximum estimated summary input, including system prompt/instructions | `64000` |
| `compact.retain_tokens` | Maximum recent original-message tokens; `0` summarizes all older messages | `8000` |
| `openai.base_url` | Service URL | `https://api.openai.com/v1` |
| `openai.api_key` | Sent as a Bearer token | — |
| `openai.wire_api` | `chat` (Chat Completions) or `responses` (stateless Responses with encrypted reasoning replay) | `chat` |
| `reasoning.effort` | `none`, `minimal`, `low`, `medium`, `high` or `xhigh`; support depends on the model | Provider default |
| `openai.max_tokens` | Normal response output token limit; increases the output reservation when larger | `context.reserve` |
| `tls.ca_file` | PEM file of trusted CAs, needed only for bundled builds (see section 12); used by both model calls and `web_fetch` | `$SSL_CERT_FILE`, otherwise a system certificate file |
| `mock.delay_ms` | Delay between mock output chunks | `25` |

### openai provider

By default, calls `POST {base_url}/chat/completions` with `stream: true`. Compatible with OpenAI, GLM, DeepSeek, Qwen, vLLM, and others. Supports streaming text, `reasoning_content` (→ `THINKING_DELTA`), parallel tool calls assembled by `index`, and the final usage chunk. With `openai.wire_api=responses`, calls `POST {base_url}/responses` with `store:false`, retaining complete output items and encrypted reasoning for replay. The endpoint and model must support the selected protocol. Connection failures, 429 responses, and 5xx responses are retried automatically **only if no output has been delivered to the host yet** (up to 3 attempts, with 1s and 2s backoff), logged as `LOG(warn)`.

Budget options are unsigned integers up to 4294967295. Only `compact.threshold`, `context.window` and `compact.retain_tokens` allow zero. Invalid budgets fail the next turn before a provider request. The model window, when known, must exceed both output reservations.

Network dependency: libcurl. Only `src/http.c` uses libcurl; see section 12.

### mock provider

Offline and deterministic, using exactly the same agent loop as a real model:

| Input | Behavior |
|---|---|
| Plain text | Streams a fixed response quoting the input |
| `!<tool> [arg]` | Calls the tool with `{"input": arg}` and reports the result in the next round |
| `!<tool> {json}` | Calls the tool with the given JSON input, e.g. `!read {"file_path":"a.c"}` |
| `!<t1> … ;; !<t2> …` | Calls multiple tools in one response |
| `!agent[:type] task1 \| task2 …` | Launches one subagent per task, in parallel |
| `!history` | Reports the current number of history entries |
| `!panic` | Fails the model call and ends the turn with `error` |
| (Compaction request) | Returns a summary listing all user messages |

## 10. Minimal example

```c
#include <sope.h>
#include <stdio.h>
#include <stdlib.h>

int main(void) {
    sope_agent_t *agent;
    sope_event_t ev;
    if (sope_agent_new(&agent) != SOPE_OK) return 1;
    sope_agent_set_option(agent, "provider", "openai");
    sope_agent_set_option(agent, "model", "glm-5.3");
    sope_agent_set_option(agent, "openai.base_url", "https://api-taas.moi.matrixorigin.cn/v1");
    sope_agent_set_option(agent, "openai.api_key", getenv("SOPE_API_KEY"));
    sope_send(agent, "hello", 5, NULL);
    for (;;) {
        ev.size = sizeof ev;
        if (sope_poll(agent, &ev, -1) != 1) break;
        if (ev.type == SOPE_EVENT_TEXT_DELTA && !ev.agent_id) fwrite(ev.data, 1, ev.data_len, stdout);
        if (ev.type == SOPE_EVENT_TURN_END && !ev.agent_id) break;
    }
    sope_agent_free(agent);
    return 0;
}
```

More examples: `examples/hello.c` (minimal host) and `examples/multiplex.c` (one thread driving multiple agents through fds).

## 11. Guidance for language binding authors

- **Do not make blocking `sope_poll` calls on a UI or event loop thread.** Either integrate `sope_agent_fd` into the host event loop or use a polling thread (a Worker in Bun/Node) to block on poll and forward events in batches. Durable admission, outcome submission and recovery APIs perform synchronous SQLite commits. Hosts with strict UI latency requirements should invoke them on a dedicated worker; ephemeral agent operations do not perform journal I/O. See `bindings/js/` and `tui/src/agent/`.
- Only 64-bit platforms are currently supported; treat `size_t` as u64.
- `sope_last_error()` is thread-local: read it **on the same thread**, immediately after the failed call.
- Event strings become invalid at the next poll; bindings should copy them immediately.
- Use `agent_id` to distinguish root agent events from subagent events. To detect the end of a turn, consider only `TURN_END` events with `agent_id == 0`.
- `PERMISSION` must receive a response (or the turn must be cancelled); otherwise the turn waits indefinitely. Hosts without an interactive interface should set `permissions` to `allow` or `deny`.

## 12. Building and dependencies

All builds compile SQLite 3.54.1 directly into both `libsope.dylib/.so` and `libsope.a`. CMake downloads the official amalgamation with a pinned SHA3-256 checksum; no system SQLite headers, library, Bun runtime, or Go SQLite driver is required. SQLite symbols use a private namespace, so a host can embed its own SQLite independently. The public ABI exposes no SQLite types. The CMake option `SOPE_CURL` selects the HTTP implementation:

| Value | Meaning | Suitable for |
|---|---|---|
| `system` (default) | Link against the system libcurl | macOS (libcurl is included with the OS, and TLS uses the system keychain); Linux with `libcurl-dev` installed |
| `bundled` | Download curl 8.23.0 and mbedTLS 3.6.7 at build time (pinned SHA-256 hashes) and link them statically into libsope, enabling only HTTP(S) | Linux releases; any deployment that should not depend on system libcurl |
| `off` | No network support or HTTP dependency; only the `mock` provider | Testing and offline embedding |

- The shared library exports only the public `sope_*` functions (35 in total). Internal symbols (`sope__*`, including SQLite) and bundled curl/mbedTLS symbols are hidden, avoiding conflicts with the host's SQLite, curl or OpenSSL.
- Bundled mode also produces `libsope-bundled.a`: sope, SQLite, curl, and mbedTLS merged into one object file with only `sope_*` as global symbols, ready for static linking (macOS also requires `-framework SystemConfiguration -framework CoreFoundation -framework CoreServices`). In `system` mode, the host must link `libsope.a` with `-lcurl` and the platform thread libraries. Neither static archive needs `-lsqlite3`.
- For offline builds, point `SOPE_SQLITE_URL` (and `SOPE_CURL_URL` / `SOPE_MBEDTLS_URL` in bundled HTTP mode) to local source archives. The pinned checksums still apply.

**Certificates in bundled mode.** mbedTLS cannot read the macOS keychain or the Windows certificate store; it can only read PEM certificate files. Lookup order:

1. The `tls.ca_file` option
2. The `SSL_CERT_FILE` environment variable
3. System certificate files, such as `/etc/ssl/cert.pem` (macOS, Alpine, BSD), `/etc/ssl/certs/ca-certificates.crt` (Debian/Ubuntu), and `/etc/pki/tls/certs/ca-bundle.crt` (Fedora/RHEL)

On Linux, administrators typically install corporate root certificates into the system certificate file, so they are available directly. On macOS, corporate or HTTPS proxy certificates installed only in the keychain are unavailable to mbedTLS. This is why macOS releases use `system` mode. If you need bundled mode on macOS, export the certificates and point `tls.ca_file` to them.

## 13. Known limitations and roadmap

- The event queue is unbounded: memory keeps growing if the host does not drain events for an extended period. Backpressure is planned.
- Timers use `CLOCK_REALTIME`; system clock jumps affect mock output timing and retry backoff.
- The fd and threading implementations currently support only POSIX (macOS/Linux); Windows support is planned using event handles.
- The library does not persist data itself. The host decides what to save and where using `sope_agent_history` / `sope_agent_load_history`. History cannot be exported during a turn, so a process crash mid-turn loses that turn.
- Context accounting uses local estimates supplemented by provider usage. Without an explicit `context.window`, Sope cannot know the model's actual capacity; configure it when switching models.
- Built-in tools are not sandboxed; permissions are the only safeguard. Hosts requiring isolation can replace `bash` with a host tool of the same name, or set `permissions=deny`.
- `grep` uses POSIX regexes with rewrites for common syntax, rather than ripgrep. It has no multiline matching and supports no Perl extensions beyond backreferences.
- `web_fetch` returns page text without executing scripts; content generated by scripts will be missing.
- Images are sent as base64 without resizing or compression. Once added, they stay in history and are included in subsequent requests while retained in history, including across compaction when they fit the recent-message budget, so large images significantly increase request size. Host tools (`sope_tool_result`) cannot yet return images.


## Durable execution and recovery

`sope_agent_new` creates an ephemeral agent. `sope_agent_open(&agent, directory)` creates or adopts a durable session directory; its parent must exist. The directory contains `execution.sqlite`, an exclusive `owner.lock`, and `artifacts/`. A second owner fails with `SOPE_EBUSY`, including another agent in the same process. The database format is versioned and unsupported versions are rejected; there is no transcript-only session migration.

The core owns execution persistence. The ordered `events` table retains admitted inputs, assistant responses/tool intents, individual tool results, compaction replacements, and artifact references. `state`, `inbox`, and `results` are projections for resumption. Growing model-history snapshots replace the current projection rather than being appended in full for every step. Earlier evidence remains in the event log after compaction.

The important transaction boundaries are:

1. `sope_send`/`sope_compact` commit input before returning success or scheduling work.
2. A complete assistant tool batch receives stable numeric call IDs and is committed before any tool is dispatched or exposed to the host.
3. Each tool result, including images, is committed before successful `TOOL_END` publication and before the model can consume it. A finished member of a parallel batch survives even if another member never returns.
4. Checkpoints include model history, active input, consumed model rounds, call ID allocation and context calibration. Turn termination and inbox completion commit together. Compaction retains the old persisted checkpoint until the replacement commits.

SQLite uses WAL and `synchronous=FULL`. Failed commits stop execution; an uncommitted result is not reported as successful. Reopen the session after resolving the storage problem. These are process-crash guarantees under the filesystem's SQLite/fsync contract, not a promise of exactly-once external effects.

Opening never starts recovered work. Configure options, credentials and tool definitions again, then call `sope_agent_recovery` (JS `agent.recovery()`). Its JSON contains `pending` and unresolved `calls` with string `call_id`, `name`, JSON-string `input`, and retained `artifacts` paths (including output from an interrupted child). Numeric IDs remain stable across restarts. Reopening and closing without resuming leaves this state intact.

- Completed calls use their committed results and are not dispatched again.
- Every issued call without a durable receipt is conservatively unknown, including a call that might not have started. No tool is automatically replayed.
- Inspect the external state and retained evidence; submit the observed outcome with `sope_agent_resolve` / JS `resolve`. This records evidence and never executes the operation. If it cannot be verified, leave the task paused.
- `sope_agent_resume` / JS `resume` fails with `SOPE_EBUSY` until all unknown calls are reconciled, then continues the original input and its queued successors. Reconciliation itself is durable across another crash.

Interrupted model requests can be attempted again (and may incur another provider charge); consumed rounds remain counted. Streaming text before a completed response is provisional. Completed child tool facts are journaled, but a crashed unfinished child is reconciled at its parent invocation: this API does not resurrect child runtimes or reattach OS shell processes. A shell may outlive its owner process, so reconciliation must check whether it is still running before authorizing any replacement operation.

`sope_agent_close` is explicit cancellation of active/queued work. It is not a suspend API. Closing a recovered session that has not resumed only releases ownership. Durable `reset` requires an idle session and commits immediately. History export/import remains useful for inspection and explicitly seeding an idle agent, but it is not execution recovery. Recovery and history JSON share the same returned-string storage; copy it before the next call to either accessor.

## File mutation isolation

Built-in `read`, `write`, and `edit` coordinate by canonical path, including symlink aliases and existing ancestors of new paths. Contention yields the worker instead of blocking a worker thread. A process-local gate and an advisory file lock cover the complete operation across cooperating sope agents/processes. Lock files under `/tmp/sope-file-locks-<uid>` must not be deleted while agents run.

A modifying call captures the revision the agent had seen at admission. It checks size, mtime and a content fingerprint after acquiring the lock. Two edits admitted against the same revision cannot both overwrite it: the second fails and requires a fresh read. New contents are written and fsynced in a same-directory temporary file, renamed over the canonical target, then the parent directory is synced. Existing permission bits are retained; new files start private. A crash can leave a staging file but cannot expose a partially rewritten target.

These are cooperating file-tool locks. Arbitrary shell commands, editors and other writers do not participate; use workspace isolation when they must mutate concurrently. Atomic replacement changes the target inode, so hard links to its old inode continue to refer to the old contents; ownership, ACL and extended-attribute preservation are not provided by this replacement mechanism.

## Complete tool-output artifacts

Shell stdout/stderr is streamed to a private archive while memory holds only a bounded preview. The archive is created and referenced in the execution journal before the process starts; completion flushes it before publishing the result. A failed archive is explicit and stops continuation rather than silently losing evidence.

Large host/built-in results are saved before generic preview clipping. Truncated `read` output includes a snapshot of the complete source file. `grep` does not discard the middle/end of a matching long line before the generic archive layer. Search result limits and HTTP response-size rejection remain explicit tool limits.

Previews include an absolute path and byte count. `artifact_read({path, offset, limit})` reads zero-based byte ranges up to 32768 bytes, without the file reader's per-line clipping. Text previews still undergo UTF-8/control-character sanitization; archived bytes are unchanged. Existing file/shell tools can search these paths. Background `bash_output` advances its cursor only by the bytes returned, even when it falls behind the memory buffer.

Archives outlive agent destruction. Durable agents keep them under their session directory; ephemeral agents use a private `/tmp/sope-artifacts-*` directory. The embedding host owns quota, retention and deletion. Do not delete referenced artifacts while a task needs recovery or evidence verification. Background jobs remain subject to the process lifecycle described above; the archive does not constitute a reconnectable job handle.


## 12. Embedding contract (ABI 0.4)

ABI 0.4 adds policy/sealing, idempotent admission, durable public event cursors,
terminal outcome queries, and suspend/wait. Native session format is version 2;
version 1 sessions are rejected without migration. See `include/sope.h` for exact
signatures and [the Go SDK contract](../bindings/go/README.md) for the host recovery
protocol and build/link instructions. SQLite stays inside libsope.

A sealed configuration can only change its explicit `openai.api_key` credential.
`openai.wire_api` accepts `chat` or `responses`; `reasoning.effort` accepts `none`,
`minimal`, `low`, `medium`, `high` or `xhigh` (model support varies). Responses uses
stateless full-input replay with encrypted reasoning items retained in history.
See the [Responses streaming specification](https://developers.openai.com/api/reference/resources/responses/streaming-events)
and [reasoning guide](https://developers.openai.com/api/docs/guides/reasoning).

The `sequence` field is the durable public stream cursor, zero for ephemeral
agents or uncommitted failure notifications. Root terminal events share a
transaction with the outcome and inbox completion. Tool receipts and their public
completion events also share one transaction, including host reconciliation.
A failed receipt commit leaves the operation unknown and emits an error, not a
completion. Cancellation tool completions precede the terminal event.
Live polling and durable replay are separate interfaces; polling does not
acknowledge persistent events. Poll filters obsolete tool/permission commands
after suspension or cancellation; already delivered commands remain the host's
responsibility. Build durable projections from ordered replay pages and only
advance the host cursor across pages actually applied, not a Poll/Status watermark.
Public events may contain NUL bytes and retain their explicit lengths.

Subprocess environments no longer inherit the host process environment. Unsealed
C agents default to `PATH=/usr/bin:/bin` plus fixed noninteractive settings; an
explicit policy environment replaces the default. Supply `HOME` explicitly for
home-directory expansion. A policy is capability routing, not an OS sandbox.
