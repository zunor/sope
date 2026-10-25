/* SPDX-License-Identifier: MIT
 * Copyright (c) 2026 Zonor */
/*
 * sope.h - public C ABI of sope, an embeddable agent library.
 *
 * This header is the single source of truth for the ABI. docs/abi.md covers
 * the lifecycle, threading model and ownership rules in more depth.
 *
 * Conventions
 *   - Functions returning int return SOPE_OK (0) or a positive value on
 *     success and a negative SOPE_E* code on failure. After a failure,
 *     sope_last_error() describes it on the calling thread.
 *   - Strings are UTF-8. Inputs that take an explicit length need not be
 *     NUL-terminated; strings handed out by the library always are.
 *   - The library never takes ownership of caller memory: every input is
 *     copied before the call returns.
 *   - Every function may be called from any thread. Different agents are
 *     fully independent. The exceptions are sope_poll (one polling thread
 *     per agent at a time) and sope_agent_free (no concurrent calls).
 *   - Agents own no threads. All of them are run by one shared worker pool;
 *     an agent's turns run one at a time and in order, while different
 *     agents (and subagents) run in parallel.
 */
#ifndef SOPE_H
#define SOPE_H

#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#if defined(_WIN32)
#  if defined(SOPE_BUILD_SHARED)
#    define SOPE_API __declspec(dllexport)
#  elif defined(SOPE_USE_SHARED)
#    define SOPE_API __declspec(dllimport)
#  else
#    define SOPE_API
#  endif
#elif defined(__GNUC__) || defined(__clang__)
#  define SOPE_API __attribute__((visibility("default")))
#else
#  define SOPE_API
#endif

/* ------------------------------------------------------------------------ */
/* Version                                                                   */
/* ------------------------------------------------------------------------ */

#define SOPE_VERSION_MAJOR 0
#define SOPE_VERSION_MINOR 5
#define SOPE_VERSION_PATCH 0
#define SOPE_VERSION_STRING "0.5.0"
#define SOPE_VERSION_NUMBER \
    ((SOPE_VERSION_MAJOR << 16) | (SOPE_VERSION_MINOR << 8) | SOPE_VERSION_PATCH)

/* Version of the library actually loaded, which may differ from the header
 * the caller was compiled against. Compatibility follows semver on the ABI:
 * a host built against X.Y works with any loaded X.Z where Z >= Y (while
 * X is 0, Y must match exactly). */
SOPE_API uint32_t sope_version_number(void);
SOPE_API const char *sope_version(void);

/* ------------------------------------------------------------------------ */
/* Result codes                                                              */
/* ------------------------------------------------------------------------ */

#define SOPE_OK          0
#define SOPE_ERROR      (-1) /* unspecified failure */
#define SOPE_EINVAL     (-2) /* invalid argument */
#define SOPE_ENOMEM     (-3) /* allocation failed */
#define SOPE_ENOTFOUND  (-4) /* no such object: tool call id, provider, ... */
#define SOPE_ECLOSED    (-5) /* the agent is closed */
#define SOPE_ECANCELLED (-6) /* the operation was cancelled */
#define SOPE_EBUSY      (-7) /* not allowed in the current state */
#define SOPE_ECONFLICT  (-8) /* request key or execution configuration differs */
#define SOPE_ETIMEOUT   (-9) /* wait deadline expired; object remains owned */

/* Static description of a result code. Never NULL. */
SOPE_API const char *sope_strerror(int code);

/* Message for the most recent failed call on the calling thread. Never NULL;
 * valid until the next sope_* call on the same thread. */
SOPE_API const char *sope_last_error(void);

/* ------------------------------------------------------------------------ */
/* Worker pool                                                               */
/* ------------------------------------------------------------------------ */

/* Sets the number of threads in the shared worker pool. The pool starts with
 * the first sope_agent_new, so call this before it (or after sope_shutdown);
 * otherwise it returns SOPE_EBUSY. 0 selects the default: the number of
 * CPUs, clamped to [2, 8]. Pool threads never block on a turn (waiting for a
 * tool result, a subagent or model output costs no thread), so a few
 * threads can serve many agents. */
SOPE_API int sope_set_threads(uint32_t n);

/* Stops and joins the worker pool and the HTTP I/O thread. Every agent must
 * be freed first (SOPE_EBUSY otherwise). Optional: use it before unloading
 * the library or for a clean leak-checker report. The pool restarts on the
 * next sope_agent_new. During shutdown, concurrent sope_shutdown and
 * sope_agent_new calls return SOPE_EBUSY. */
SOPE_API int sope_shutdown(void);

/* ------------------------------------------------------------------------ */
/* Agent                                                                     */
/* ------------------------------------------------------------------------ */

typedef struct sope_agent sope_agent_t;

/* Creates an agent. Cheap: it holds no thread, only memory. */
SOPE_API int sope_agent_new(sope_agent_t **out);

/* Opens an exclusively owned durable session directory (parent must exist).
 * Inputs, tool intents/results and checkpoints are committed with SQLite FULL
 * durability. Options/credentials/tools must be configured again by the host.
 * Reopened unfinished work is paused; inspect recovery(), reconcile unknown
 * calls with resolve(), then resume(). No interrupted tool is blindly replayed.
 * Artifacts and execution.sqlite remain after free; the host owns retention. */
SOPE_API int sope_agent_open(sope_agent_t **out, const char *directory);
/* JSON {pending:bool, calls:[{call_id:string,agent_id:string,name,input,artifacts:string[]}],
 * delegations:[{agent_id:string,unknown_calls:number,action:"reconstruct_from_journal"}]}.
 * Calls are unknown leaf operations; delegation results are runtime-owned.
 * Shares returned-string storage with history(). */
SOPE_API int sope_agent_recovery(sope_agent_t *agent, const char **json, size_t *len);
/* Supply an observed outcome for an interrupted call, including built-ins.
 * This records a host reconciliation, never executes the tool or creates a
 * native check receipt. Unknown leaves block resume; agent invocation IDs
 * cannot be resolved by supplying a fabricated delegated outcome. */
SOPE_API int sope_agent_resolve(sope_agent_t *agent, uint64_t call_id, int is_error,
                                const char *content, size_t len);
SOPE_API int sope_agent_resume(sope_agent_t *agent);

/* Host execution contract. Configure before seal/send/resume. tools is a required
 * array (empty = none); external routes named built-ins to TOOL_CALL so the host
 * can execute them in its sandbox. authorize=true gates every offered tool,
 * including host tools and subagents, through PERMISSION. environment is the
 * complete bash environment, never merged with the process environment.
 * Example: {"tools":["read","bash"],"external":["bash"],
 *           "authorize":true,"environment":{"PATH":"/usr/bin:/bin"}}
 * This policy controls capabilities, not an OS sandbox: unrestricted built-in
 * file/shell tools retain the host user's filesystem access. */
SOPE_API int sope_agent_policy(sope_agent_t *agent, const char *json, size_t len);
/* Seal current options, tool/subagent definitions and policy against a durable
 * configuration identity. revision covers host executors/instructions; env_revision
 * covers environment values (which are not stored). Credentials are excluded.
 * Reopen must seal with the same configuration before resume or new input.
 * A sealed agent's configuration is immutable; credentials may be rotated. */
SOPE_API int sope_agent_seal(sope_agent_t *agent, const char *revision, const char *env_revision);
/* Durable idempotent admission. Same key + same payload returns the original ID;
 * different payload is ECONFLICT, including after completion or process death. */
SOPE_API int sope_submit(sope_agent_t *agent, const char *request_key, const char *text,
                         size_t len, uint64_t *turn_id_out);
/* JSON state includes session_id (persistent), instance_id (this open), state,
 * active_turn, last_sequence. Returned JSON uses history()'s scratch storage. */
SOPE_API int sope_agent_status(sope_agent_t *agent, const char **json, size_t *len);
/* Durable event pages, after an exclusive sequence cursor, up to 256 records.
 * IDs are decimal strings. No consumption/ack is implicit: the host persists its
 * cursor atomically with its own projection. Terminal outcomes are independently
 * queryable even when the host died before observing TURN_END. Build projections
 * from these pages: Poll can omit stale execution commands, so a live event's
 * sequence or status watermark is not an acknowledgement of earlier records.
 * Tool receipts/resolve and completion events commit atomically. */
SOPE_API int sope_agent_events(sope_agent_t *agent, uint64_t after, uint32_t limit,
                               const char **json, size_t *len);
SOPE_API int sope_agent_outcome(sope_agent_t *agent, uint64_t turn_id, const char **json, size_t *len);
/* Suspend a durable root without completing its unfinished input. Stops model
 * generation and new tool dispatch, drains already-running built-ins, preserves
 * unknown host outcomes for resolve(). Reopen or resume only after reconciliation.
 * Undelivered live execution commands are filtered by Poll; the host must stop
 * its already-dispatched external executors before reconciliation.
 * wait timeout does not cancel suspension and never frees memory; storage
 * failures return SOPE_ERROR rather than reporting successful quiescence. */
SOPE_API int sope_agent_suspend(sope_agent_t *agent);
SOPE_API int sope_agent_wait(sope_agent_t *agent, int32_t timeout_ms);

/* Sets (value != NULL) or removes (value == NULL) a string option. Options
 * are read when a turn starts, so changes apply from the next turn on.
 *   provider          "mock" (default, offline) or "openai" (any
 *                     OpenAI-compatible Chat Completions server)
 *   model             model name, e.g. "glm-5.3"; required by "openai"
 *   image_model       model used instead once the conversation holds an
 *                     image (sope_attach_image, or read/web_fetch of one),
 *                     for when `model` reads text only; unset: `model`
 *   system            system prompt (a built-in default is used if unset)
 *   max_rounds        model calls allowed per turn (default 32)
 *   cwd               working directory of the built-in tools (default:
 *                     the process's current directory)
 *   permissions       "ask" (default): built-in tools that change files,
 *                     run commands or use the network wait for sope_permit;
 *                     "allow": run them without asking; "deny": refuse them
 *   subagents         "off" hides the built-in `agent` tool
 *   compact.threshold estimated full-request trigger; 0 disables automatic
 *                     compaction, including overflow recovery (default 0)
 *   context.window    full model token capacity; 0 means unknown (default 0)
 *   context.reserve   minimum output reserve/default output limit (4096)
 *   compact.max_tokens summary output limit/reserve (2048)
 *   compact.input_tokens estimated summary request input budget (64000)
 *   compact.retain_tokens recent original-message budget (8000; 0: none)
 *   openai.base_url   default https://api.openai.com/v1
 *   openai.wire_api   "chat" (default) or "responses" (stateless replay)
 *   reasoning.effort  none, minimal, low, medium, high or xhigh (model-dependent)
 *   openai.api_key    explicit Bearer token; rotatable after seal
 *   openai.max_tokens normal output limit (default context.reserve); also
 *                     raises the output reservation if larger
 *   tls.ca_file       PEM file of trusted CAs, for builds with bundled curl
 *                     (default: $SSL_CERT_FILE, else the system bundle)
 *   openai.max_retries  additional attempts per request, 0..20 (default 5)
 *   openai.retry_delay_ms initial backoff, capped at 10000 ms (default 1000)
 *   openai.idle_timeout_ms attempt silence limit (default 120000)
 *   openai.request_timeout_ms total request budget (default 600000)
 *   mock.delay_ms     delay between streamed chunks of the mock provider */
SOPE_API int sope_agent_set_option(sope_agent_t *agent, const char *key, const char *value);

/* Built-in tools. Every agent can use these without any host code; the
 * library runs them on its worker pool:
 *   read, glob, grep          read files, find files, search contents
 *   write, edit               create and change files                 (ask)
 *   bash                      run a shell command, optionally in the
 *                             background                              (ask)
 *   bash_output, bash_kill    follow and stop background commands
 *   web_fetch                 fetch a URL as text                     (ask)
 *   todo_write                keep a task list
 * Each call emits SOPE_EVENT_TOOL_START and ends with SOPE_EVENT_TOOL_END.
 * Tools marked (ask) first emit SOPE_EVENT_PERMISSION and wait for
 * sope_permit, unless the "permissions" option says otherwise. A host tool
 * registered under a built-in's name replaces it. docs/abi.md describes
 * each tool. */

/* Registers a host tool the model may call, replacing any tool with the same
 * name. name: 1-64 chars of [A-Za-z0-9_-]; "agent" is reserved.
 * input_schema_json must be a JSON Schema object (NULL: any object). */
SOPE_API int sope_tool_register(sope_agent_t *agent, const char *name,
                                const char *description, const char *input_schema_json);

/* Registers (or replaces, by name) a subagent type the model can launch
 * through the built-in `agent` tool. The definition is a JSON object:
 *   name           required, 1-64 chars of [A-Za-z0-9_-]
 *   description    required: when the model should use it
 *   system_prompt  required
 *   tools          optional: array of tool names (built-in or host), or
 *                  "*" (default: all)
 *   model          optional: overrides the parent's model
 *   max_rounds     optional
 * A "general-purpose" type with all tools is built in. Subagents get a fresh
 * history, cannot launch subagents themselves, and return their final
 * message to the parent as the tool result. */
SOPE_API int sope_subagent_register(sope_agent_t *agent, const char *definition_json, size_t len);

/* Stops one running subagent: agent_id is the call_id of its
 * SOPE_EVENT_SUBAGENT_START. The parent turn and the other subagents keep
 * running; the parent gets the subagent's cancelled result, with note
 * (optional, may be NULL with len 0) added to tell the model why or what
 * to do instead. SOPE_ENOTFOUND if no such subagent is running. */
SOPE_API int sope_subagent_cancel(sope_agent_t *agent, uint64_t agent_id, const char *note, size_t len);

/* The background shells (bash with run_in_background) as a JSON array,
 * oldest first:
 *   [{"id":1,"command":"bun run dev","running":true,"exit_code":null,
 *     "stopped":false,"output_bytes":2048,"tail":"ready on :3000\n"}]
 * exit_code is null while running; stopped is true once
 * sope_shell_stop stopped it; tail is the end of its output (at most 512
 * bytes). The string stays valid until the next call of this, history or
 * context. Shells outlive turns until bash_kill, sope_shell_stop or
 * sope_agent_free. */
SOPE_API int sope_agent_shells(sope_agent_t *agent, const char **json, size_t *len);

/* Stops a background shell and every process it started. The model's next
 * bash_output for it reports that the user stopped it. SOPE_ENOTFOUND if
 * there is no such shell. */
SOPE_API int sope_shell_stop(sope_agent_t *agent, uint32_t shell_id);

/* Attaches an image to the next sope_send: the message carries every image
 * attached since the previous one. data is the raw file content (PNG, JPEG,
 * GIF or WebP, at most 10 MiB) and is copied; media_type is "image/png",
 * "image/jpeg", "image/gif" or "image/webp", or NULL to tell from the bytes.
 * The model must read images (see the option image_model). SOPE_EINVAL for
 * other content, SOPE_ECLOSED once the agent is closed. */
SOPE_API int sope_attach_image(sope_agent_t *agent, const char *media_type, const void *data, size_t len);

/* Queues a user message. Each accepted message becomes one turn; turns run
 * one at a time in order. The turn id is written to *turn_id_out if non-NULL.
 * Within a turn the agent may call the model several times, executing tool
 * calls in between, until the model answers without calling tools. */
SOPE_API int sope_send(sope_agent_t *agent, const char *text, size_t len, uint64_t *turn_id_out);

/* Delivers the result of a SOPE_EVENT_TOOL_CALL, including those raised by
 * subagents. Returns SOPE_ENOTFOUND if the call is not pending, e.g. because
 * its turn was cancelled. */
SOPE_API int sope_tool_result(sope_agent_t *agent, uint64_t call_id, int is_error,
                              const char *content, size_t len);

/* Answers a SOPE_EVENT_PERMISSION: allow != 0 runs the tool, 0 refuses it.
 * message (optional, may be NULL with len 0) tells the model why, or what
 * to do instead. Returns SOPE_ENOTFOUND if the call is not waiting, e.g.
 * because its turn was cancelled. */
SOPE_API int sope_permit(sope_agent_t *agent, uint64_t call_id, int allow, const char *message, size_t len);

/* Requests cancellation of the running turn, if any, including its
 * subagents. Queued turns are not affected. The turn still ends with
 * SOPE_EVENT_TURN_END. */
SOPE_API int sope_cancel(sope_agent_t *agent);

/* Queues a compaction turn: the model summarizes the conversation and the
 * summary replaces the older prefix, retaining recent messages within budget. The
 * turn emits SOPE_EVENT_COMPACT (and USAGE), never TEXT_DELTA. instructions
 * (optional, may be NULL with len 0) steer the summary, e.g. "keep the
 * test failures". Runs in order with sends, like a turn. */
SOPE_API int sope_compact(sope_agent_t *agent, const char *instructions, size_t len, uint64_t *turn_id_out);

/* Forgets the conversation history. Takes effect when the next turn starts. */
SOPE_API int sope_agent_reset(sope_agent_t *agent);

/* The conversation history as JSON, for saving it. *json stays valid until
 * the next sope_agent_history or sope_agent_free on the same agent; *len
 * (may be NULL) is its length. Works between turns only: SOPE_EBUSY while a
 * turn runs or is queued (call it on SOPE_EVENT_TURN_END). The format is an
 * array of messages, oldest first:
 *
 *   [{"role":"user","content":"fix the bug"},
 *    {"role":"assistant","content":"Let me look.",
 *     "tool_uses":[{"id":"call_1","name":"read","input":"{\"file_path\":\"a.c\"}"}]},
 *    {"role":"tool","tool_use_id":"call_1","name":"read","content":"…","is_error":false},
 *    {"role":"assistant","content":"Fixed."}]
 *
 * "input" is the tool's JSON input as a string. User and tool messages with
 * images also have "images":[{"media_type":"image/png","data":"<base64>"}].
 * After compaction, history starts with a user message marked "summary":true,
 * followed by the retained recent originals and any incoming user message.
 * Reasoning is not kept. */
SOPE_API int sope_agent_history(sope_agent_t *agent, const char **json, size_t *len);

/* How full the model's context is, as JSON, measured the way compaction
 * measures it. Shares sope_agent_history's storage. Works at any time:
 * between turns it measures the request the next turn would send; while a
 * turn runs it reports the turn's last request ("state":"running"), and
 * SOPE_EBUSY only before a queued turn has started.
 *
 *   {"state":"idle","used":42130,"estimate":41800,"window":200000,
 *    "reserve":4096,"threshold":100000,
 *    "parts":{"system":1210,"tools":6830,"summary":2100,"messages":12400,
 *             "tool_results":19260,"images":0},
 *    "counts":{"tools":14,"messages":38,"tool_results":9,"images":0},
 *    "largest":[{"name":"read","input":"{\"file_path\":\"a.c\"}","tokens":6100}]}
 *
 * The parts are local estimates and add up to "estimate"; "used" is what
 * compaction compares with "threshold", also counting the provider's report
 * of the last request. "window" and "threshold" are 0 when unknown or
 * disabled (options context.window and compact.threshold); "reserve" is the
 * output reservation, 0 without a window. "largest" lists up to three tool
 * results, biggest first; "input" is the call's JSON input, left out when
 * long. */
SOPE_API int sope_agent_context(sope_agent_t *agent, const char **json, size_t *len);

/* Replaces the conversation history with one from sope_agent_history, to
 * resume a saved conversation. Between turns only (SOPE_EBUSY otherwise);
 * SOPE_EINVAL if json is not such an array. Unanswered tool uses at the end
 * are answered as cancelled. The agent forgets which files it has read, so
 * edits need a fresh read first. */
SOPE_API int sope_agent_load_history(sope_agent_t *agent, const char *json, size_t len);

/* Stops the agent: cancels the running turn, ends queued turns as cancelled
 * and rejects further sends. Once the remaining events are drained,
 * sope_poll returns SOPE_ECLOSED. Idempotent. */
SOPE_API int sope_agent_close(sope_agent_t *agent);

/* Closes the agent if needed, waits until the pool is done with it and its
 * subagents, and frees all memory. Must not run concurrently with any other
 * call on the same agent. NULL is a no-op. */
SOPE_API void sope_agent_free(sope_agent_t *agent);

/* Returns a file descriptor that is readable exactly while sope_poll would
 * not block: an event is queued, or the agent is closed. Use it to wait for
 * many agents with one poll/epoll/kqueue/libuv loop, then drain each ready
 * agent with sope_poll(agent, &ev, 0). The fd is owned by the agent: never
 * read, write or close it. Created on first call; valid until
 * sope_agent_free. POSIX only for now. */
SOPE_API int sope_agent_fd(sope_agent_t *agent);

/* ------------------------------------------------------------------------ */
/* Events                                                                    */
/* ------------------------------------------------------------------------ */

#define SOPE_EVENT_TURN_START     1  /* a turn began running */
#define SOPE_EVENT_TEXT_DELTA     2  /* data: a chunk of assistant text */
#define SOPE_EVENT_TOOL_CALL      3  /* call_id, name: tool, data: JSON input. Answer with sope_tool_result */
#define SOPE_EVENT_TURN_END       4  /* code: SOPE_STOP_* */
#define SOPE_EVENT_ERROR          5  /* code: SOPE_E*, data: message */
#define SOPE_EVENT_LOG            6  /* code: SOPE_LOG_*, data: message */
#define SOPE_EVENT_THINKING_DELTA 7  /* data: a chunk of the model's reasoning */
#define SOPE_EVENT_USAGE          8  /* data: {"input_tokens":N,"output_tokens":N} for one model call */
#define SOPE_EVENT_SUBAGENT_START 9  /* call_id, name: subagent type, data: JSON input (description, prompt) */
#define SOPE_EVENT_SUBAGENT_END   10 /* call_id, code: SOPE_STOP_*, data: the subagent's final report */
#define SOPE_EVENT_COMPACT        11 /* name: "auto" or "manual", data: the summary now standing in for the history */
#define SOPE_EVENT_TOOL_START     12 /* call_id, name: built-in tool, data: JSON input. The library runs it */
#define SOPE_EVENT_TOOL_END       13 /* call_id, name, code: 1 if it failed, data: the result the model sees */
#define SOPE_EVENT_PERMISSION     14 /* call_id, name, data: JSON input. Answer with sope_permit */
#define SOPE_EVENT_MODEL_RETRY    15 /* call_id: model round, code: next attempt, name: failure class.
                                    * data: {delay_ms,compaction,discarded_text_bytes,discarded_thinking_bytes}.
                                    * Prior attempt output is provisional and discarded from history.
                                    * Hosts must mark/separate it before displaying the next attempt. */

#define SOPE_STOP_END_TURN  0
#define SOPE_STOP_CANCELLED 1
#define SOPE_STOP_ERROR     2

#define SOPE_LOG_DEBUG 0
#define SOPE_LOG_INFO  1
#define SOPE_LOG_WARN  2
#define SOPE_LOG_ERROR 3

/* Filled in by sope_poll. The caller sets `size` to sizeof(sope_event_t)
 * before each call so the struct can grow in later versions. `name` and
 * `data` are never NULL and stay valid until the next sope_poll or
 * sope_agent_free on the same agent.
 *
 * Every tool call the host sees opened (TOOL_CALL for host tools, TOOL_START
 * for built-ins) is closed by a TOOL_END with the same call_id before its
 * turn's TURN_END, also when the turn is cancelled.
 *
 * agent_id is 0 for events of the agent itself. Events of a subagent carry
 * the call_id of the SOPE_EVENT_SUBAGENT_START that launched it; its
 * turn_id then counts that subagent's own turns. */
typedef struct sope_event {
    uint32_t size;
    uint32_t type;      /* SOPE_EVENT_* */
    uint64_t turn_id;
    uint64_t call_id;   /* TOOL_CALL, SUBAGENT_START, SUBAGENT_END */
    uint64_t agent_id;
    const char *name;
    size_t name_len;
    const char *data;
    size_t data_len;
    int32_t code;
    uint32_t reserved;
    uint64_t sequence; /* durable public stream cursor, 0 for ephemeral events */
} sope_event_t;

/* Waits for the next event. timeout_ms < 0 waits forever, 0 never blocks.
 * Returns 1 if *event was filled, 0 on timeout, SOPE_ECLOSED once the agent
 * is closed and every event has been delivered. Only one thread may poll an
 * agent at a time. Hosts must ignore event types they do not know. */
SOPE_API int sope_poll(sope_agent_t *agent, sope_event_t *event, int32_t timeout_ms);

#ifdef __cplusplus
}
#endif

#endif /* SOPE_H */
