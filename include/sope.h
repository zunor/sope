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
#define SOPE_VERSION_MINOR 1
#define SOPE_VERSION_PATCH 0
#define SOPE_VERSION_STRING "0.1.0"
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
 * next sope_agent_new. */
SOPE_API int sope_shutdown(void);

/* ------------------------------------------------------------------------ */
/* Agent                                                                     */
/* ------------------------------------------------------------------------ */

typedef struct sope_agent sope_agent_t;

/* Creates an agent. Cheap: it holds no thread, only memory. */
SOPE_API int sope_agent_new(sope_agent_t **out);

/* Sets (value != NULL) or removes (value == NULL) a string option. Options
 * are read when a turn starts, so changes apply from the next turn on.
 *   provider          "mock" (default, offline) or "openai" (any
 *                     OpenAI-compatible Chat Completions server)
 *   model             model name, e.g. "glm-5.3"; required by "openai"
 *   system            system prompt (a built-in default is used if unset)
 *   max_rounds        model calls allowed per turn (default 32)
 *   subagents         "off" hides the built-in `agent` tool
 *   compact.threshold compact the history automatically once a model call
 *                     reports this many tokens (input + output); unset or
 *                     0 never compacts on its own (see sope_compact)
 *   openai.base_url   default https://api.openai.com/v1
 *   openai.api_key    sent as a Bearer token
 *   openai.max_tokens optional output limit
 *   tls.ca_file       PEM file of trusted CAs, for builds with bundled curl
 *                     (default: $SSL_CERT_FILE, else the system bundle)
 *   mock.delay_ms     delay between streamed chunks of the mock provider */
SOPE_API int sope_agent_set_option(sope_agent_t *agent, const char *key, const char *value);

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
 *   tools          optional: array of host tool names, or "*" (default)
 *   model          optional: overrides the parent's model
 *   max_rounds     optional
 * A "general-purpose" type with all tools is built in. Subagents get a fresh
 * history, cannot launch subagents themselves, and return their final
 * message to the parent as the tool result. */
SOPE_API int sope_subagent_register(sope_agent_t *agent, const char *definition_json, size_t len);

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

/* Requests cancellation of the running turn, if any, including its
 * subagents. Queued turns are not affected. The turn still ends with
 * SOPE_EVENT_TURN_END. */
SOPE_API int sope_cancel(sope_agent_t *agent);

/* Queues a compaction turn: the model summarizes the conversation and the
 * summary replaces the history, freeing context for what comes next. The
 * turn emits SOPE_EVENT_COMPACT (and USAGE), never TEXT_DELTA. instructions
 * (optional, may be NULL with len 0) steer the summary, e.g. "keep the
 * test failures". Runs in order with sends, like a turn. */
SOPE_API int sope_compact(sope_agent_t *agent, const char *instructions, size_t len, uint64_t *turn_id_out);

/* Forgets the conversation history. Takes effect when the next turn starts. */
SOPE_API int sope_agent_reset(sope_agent_t *agent);

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
