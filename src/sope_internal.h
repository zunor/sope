/*
 * sope_internal.h - declarations shared between the library's translation
 * units. Nothing here is part of the ABI.
 *
 * Layering (bottom up):
 *   util.c, json.c   strings, buffers, errors, JSON
 *   pool.c           shared worker pool: runs tasks one short step at a time
 *   http.c           libcurl multi on one I/O thread; wakes tasks as bytes arrive
 *   provider_*.c     one streaming model call ("round"), as a state machine
 *   loop.c           a turn: model round -> tools/subagents -> next round ...
 *   agent.c          public API, event queue, readable fd, lifecycle
 */
#ifndef SOPE_INTERNAL_H
#define SOPE_INTERNAL_H

#include "sope.h"

#include <pthread.h>
#include <stdarg.h>
#include <stddef.h>
#include <stdint.h>
#include <time.h>

#if defined(__GNUC__) || defined(__clang__)
#  define SOPE_PRINTF(fmt, args) __attribute__((format(printf, fmt, args)))
#else
#  define SOPE_PRINTF(fmt, args)
#endif

/* ======================================================================== */
/* util.c                                                                    */
/* ======================================================================== */

/* Records a message for sope_last_error() and returns `code`. */
int sope__set_error(int code, const char *fmt, ...) SOPE_PRINTF(2, 3);

char *sope__strndup(const char *s, size_t n);
char *sope__strdup(const char *s);

typedef struct sope_buf {
    char *ptr;
    size_t len;
    size_t cap;
    int oom; /* set once an append failed; later appends are no-ops */
} sope_buf;

void sope__buf_append(sope_buf *b, const char *s, size_t n);
void sope__buf_appends(sope_buf *b, const char *s);
void sope__buf_appendf(sope_buf *b, const char *fmt, ...) SOPE_PRINTF(2, 3);
/* Appends s as a quoted, escaped JSON string. */
void sope__buf_append_json_string(sope_buf *b, const char *s, size_t n);
/* Drops the first n bytes. */
void sope__buf_consume(sope_buf *b, size_t n);
void sope__buf_free(sope_buf *b);

/* ======================================================================== */
/* json.c                                                                    */
/* ======================================================================== */

typedef enum {
    SOPE_JSON_NULL,
    SOPE_JSON_BOOL,
    SOPE_JSON_NUMBER,
    SOPE_JSON_STRING,
    SOPE_JSON_ARRAY,
    SOPE_JSON_OBJECT
} sope_json_type;

typedef struct sope_json sope_json;
struct sope_json {
    sope_json_type type;
    sope_json *next;  /* next sibling inside an array or object */
    sope_json *child; /* first element or member */
    size_t count;     /* number of children */
    char *key;        /* member name when inside an object */
    size_t key_len;
    char *str; /* SOPE_JSON_STRING, NUL-terminated UTF-8 */
    size_t len;
    double num;
    int boolean;
};

/* Returns NULL on malformed input or out of memory. */
sope_json *sope__json_parse(const char *s, size_t n);
void sope__json_free(sope_json *v);
const sope_json *sope__json_get(const sope_json *obj, const char *key);
const sope_json *sope__json_at(const sope_json *arr, size_t index);
const char *sope__json_string(const sope_json *v, size_t *len);
double sope__json_number(const sope_json *v, double fallback);

/* ======================================================================== */
/* pool.c                                                                    */
/* ======================================================================== */

enum { SOPE__TASK_IDLE, SOPE__TASK_QUEUED, SOPE__TASK_RUNNING, SOPE__TASK_SLEEPING, SOPE__TASK_CLOSED };

typedef enum {
    SOPE__NEXT_CONTINUE, /* run again soon (after other ready tasks) */
    SOPE__NEXT_SLEEP,    /* run again after `ms`, or earlier on wake */
    SOPE__NEXT_WAIT,     /* run again on wake */
    SOPE__NEXT_CLOSED    /* never run again */
} sope_next_kind;

typedef struct sope_next {
    sope_next_kind kind;
    int32_t ms;
} sope_next;

typedef struct sope_task sope_task;
struct sope_task {
    sope_next (*run)(sope_task *task); /* one non-blocking step, on a pool thread */
    /* If set, called on a pool thread once the task is CLOSED. The pool never
     * touches the task afterwards, so the callback may free it. Tasks with
     * on_closed must not be waited on with sope__task_wait_closed. */
    void (*on_closed)(sope_task *task);
    void *owner;
    /* Guarded by the pool lock. */
    int state;
    int wake_pending;
    size_t heap_index;
    struct timespec deadline;
    sope_task *next_ready;
};

/* Registers a live task, starting the pool on first use. */
int sope__pool_acquire(void);
void sope__pool_release(void);
void sope__task_init(sope_task *t, sope_next (*run)(sope_task *), void *owner);
/* Makes the task run soon. Safe from any thread, with or without other locks held. */
void sope__task_wake(sope_task *t);
/* Blocks until the task returned SOPE__NEXT_CLOSED and no thread touches it anymore. */
void sope__task_wait_closed(sope_task *t);

/* ======================================================================== */
/* http.c                                                                    */
/* ======================================================================== */

typedef struct sope_http sope_http;

int sope__http_available(void);
/* Starts a POST on the I/O thread. `wake` is woken whenever bytes arrive and
 * when the transfer ends. headers are "Name: value" strings. ca_file: PEM
 * bundle of trusted CAs, NULL for the default. */
sope_http *sope__http_post(const char *url, const char *const *headers, size_t nheaders, const char *body,
                           size_t body_len, const char *ca_file, sope_task *wake);
/* Moves received bytes to `out`. Returns 1 once the transfer is over; then
 * *status is the HTTP status (0 if none) and err holds a transport error
 * message (empty if none). */
int sope__http_take(sope_http *h, sope_buf *out, long *status, char *err, size_t errlen);
/* Cancels the transfer if running and drops the caller's reference. `wake`
 * is never woken after this returns. */
void sope__http_release(sope_http *h);
/* Stops the I/O thread; only when no transfer is alive. */
void sope__http_shutdown(void);

/* ======================================================================== */
/* conversation history (loop.c)                                             */
/* ======================================================================== */

typedef enum { SOPE__MSG_USER, SOPE__MSG_ASSISTANT, SOPE__MSG_TOOL } sope_msg_role;

typedef struct sope_tool_use {
    char *id;   /* provider-assigned id, echoed back with the result */
    char *name;
    char *input; /* JSON */
    size_t input_len;
    uint64_t call_id; /* our id: TOOL_CALL / SUBAGENT_* events and sope_tool_result */
} sope_tool_use;

typedef struct sope_message {
    struct sope_message *next;
    sope_msg_role role;
    char *content; /* text; may be empty, never NULL */
    size_t content_len;
    sope_tool_use *tool_uses; /* assistant only */
    size_t n_tool_uses;
    char *tool_use_id; /* tool only: sope_tool_use.id this answers */
    char *tool_name;   /* tool only */
    int is_error;      /* tool only */
} sope_message;

typedef struct sope_history {
    sope_message *head, *tail;
    size_t count;
} sope_history;

/* ======================================================================== */
/* providers: one streaming model call                                       */
/* ======================================================================== */

typedef struct sope_call sope_call;

/* A tool as offered to the model. */
typedef struct sope_tool_spec {
    const char *name;
    const char *description;
    const char *input_schema; /* JSON Schema object */
} sope_tool_spec;

typedef enum {
    SOPE__STEP_CONTINUE, /* call step again soon */
    SOPE__STEP_SLEEP,    /* call step again after `value` ms */
    SOPE__STEP_WAIT,     /* call step again when woken (e.g. by http.c) */
    SOPE__STEP_DONE      /* the call is over; `value` is SOPE_OK or a SOPE_E* code */
} sope_step_kind;

typedef struct sope_step {
    sope_step_kind kind;
    int32_t value;
} sope_step;

typedef struct sope_provider {
    const char *name;
    /* Begins a call; returns per-call state or NULL (after sope__call_error). */
    void *(*start)(sope_call *c);
    /* Never blocks. Called repeatedly, never concurrently for one call, and
     * not at all once the turn is cancelled. */
    sope_step (*step)(sope_call *c, void *state);
    /* Called exactly once per successful start, including cancelled calls. */
    void (*finish)(void *state);
} sope_provider;

extern const sope_provider sope__provider_mock;
extern const sope_provider sope__provider_openai;

/* Inputs of the call. Valid for the call's lifetime. */
const sope_history *sope__call_history(sope_call *c);
const char *sope__call_system(sope_call *c); /* may be NULL */
size_t sope__call_tool_count(sope_call *c);
const sope_tool_spec *sope__call_tool(sope_call *c, size_t i);
int sope__call_has_tool(sope_call *c, const char *name);
/* malloc'd copy of an agent option, or NULL. */
char *sope__call_option(sope_call *c, const char *key);
sope_task *sope__call_task(sope_call *c);
uint64_t sope__call_round(sope_call *c);
/* The call summarizes the history for compaction (no tools, output hidden). */
int sope__call_is_compaction(sope_call *c);

/* Outputs. Text and thinking stream to the host immediately; tool uses are
 * collected and dispatched by the loop when the call is done. */
void sope__call_text(sope_call *c, const char *s, size_t n);
void sope__call_thinking(sope_call *c, const char *s, size_t n);
int sope__call_tool_use(sope_call *c, const char *id, const char *name, const char *input, size_t input_len);
void sope__call_usage(sope_call *c, uint64_t input_tokens, uint64_t output_tokens);
void sope__call_log(sope_call *c, int level, const char *fmt, ...) SOPE_PRINTF(3, 4);
void sope__call_error(sope_call *c, int code, const char *fmt, ...) SOPE_PRINTF(3, 4);

/* ======================================================================== */
/* compact.c                                                                 */
/* ======================================================================== */

extern const char sope__compact_system[];
/* The request asking the model to summarize `h`, as one user message:
 * instructions, optional extra instructions, then a transcript. NULL on OOM. */
char *sope__compact_request(const sope_history *h, const char *extra, size_t extra_len, size_t *len);
/* The user message that replaces the history. NULL on OOM. */
char *sope__compact_summary(const char *summary, size_t n, int mid_turn, size_t *len);

#endif /* SOPE_INTERNAL_H */
