/* SPDX-License-Identifier: MIT */
/*
 * tools.h - built-in tools: what the model can do without the host. Private.
 *
 * Every agent offers these tools (a host tool registered under the same name
 * replaces one). A call runs as its own task on the pool, so the parallel
 * tool calls of one model response run in parallel, and a running command
 * or download holds no thread while it waits.
 *
 *   tools.c    registry, the run task, read/write/edit, bash, todo_write
 *   search.c   glob and grep: tree walking, glob patterns, .gitignore
 *   web.c      web_fetch: HTTP GET and HTML to text
 *
 * Tools that change things or reach the network ask the host first
 * (SOPE_EVENT_PERMISSION, answered with sope_permit), unless the agent's
 * "permissions" option says otherwise. loop.c dispatches calls; agent.c
 * routes sope_permit.
 */
#ifndef SOPE_TOOLS_H
#define SOPE_TOOLS_H

#include "agent.h"

typedef struct sope_builtin sope_builtin;

struct tool_run {
    sope_task task;
    struct tool_run *next; /* agent->runs, guarded by *mu */
    sope_agent_t *agent;   /* whose turn waits for the result */
    const sope_builtin *tool;
    uint64_t call_id;
    uint64_t turn_id;
    sope_json *input; /* parsed arguments; NULL if malformed */
    char *cwd;        /* working directory of the turn */
    char *ca_file;    /* option tls.ca_file, for web_fetch */
    int cancel;       /* guarded by *mu */

    sope_buf out; /* the result the model sees */
    int is_error;
    sope_image *images; /* shown to the model with the result */
    size_t n_images;

    /* bash */
    sope_proc *proc;
    int64_t deadline_ms; /* monotonic */
    int64_t timeout_ms;
    int timed_out;
    /* web_fetch */
    sope_http *http;
    sope_buf body;
};

struct sope_builtin {
    const char *name;
    const char *description;
    const char *schema;
    int ask; /* needs the host's permission */
    /* One step. Return SOPE__NEXT_CLOSED once r->out holds the result, or
     * WAIT/SLEEP to be called again (woken by proc.c or http.c). */
    sope_next (*run)(tool_run *r);
    /* Frees what a cancelled run holds (process, transfer). May be NULL. */
    void (*cancel)(tool_run *r);
};

/* tools.c */
size_t sope__builtin_count(void);
const sope_builtin *sope__builtin_at(size_t i);
const sope_builtin *sope__builtin_find(const char *name);

/* A run of tool b, not started yet. NULL on out of memory. */
tool_run *sope__tool_run_new(sope_agent_t *a, const sope_builtin *b, uint64_t call_id, const char *input,
                             size_t len);
/* Starts a prepared run; it ends with SOPE_EVENT_TOOL_END and completes its
 * pending call. The _locked variant expects *mu held. */
void sope__tool_run_start(tool_run *r);
void sope__tool_run_start_locked(tool_run *r);
/* Frees a run that never started. */
void sope__tool_run_discard(tool_run *r);

/* Kills the root's background shells (agent teardown). */
void sope__shells_free(sope_agent_t *root);
/* Forgets which files the agent has read (history reset, teardown). */
void sope__files_clear(sope_agent_t *a);

/* Helpers shared by the tool implementations. */
const char *sope__arg_string(tool_run *r, const char *key);
int64_t sope__arg_int(tool_run *r, const char *key, int64_t fallback);
int sope__arg_bool(tool_run *r, const char *key);
sope_next sope__run_fail(tool_run *r, const char *fmt, ...) SOPE_PRINTF(2, 3);
sope_next sope__run_done(tool_run *r);
/* Attaches image bytes to the result; 0 on OOM. */
int sope__run_add_image(tool_run *r, const char *media_type, const void *data, size_t n);
/* Absolute, lexically normalized path: relative paths start at r->cwd, and
 * a leading ~/ at $HOME. malloc'd; NULL on out of memory. */
char *sope__run_path(tool_run *r, const char *path);
/* path relative to r->cwd when inside it, else path itself. */
const char *sope__display_path(tool_run *r, const char *path);

/* search.c */
sope_next sope__tool_glob(tool_run *r);
sope_next sope__tool_grep(tool_run *r);
/* Whether `pattern` (*, ?, [..], ** and {a,b}) matches all of `path`. */
int sope__glob_match(const char *pattern, const char *path);

/* web.c */
sope_next sope__tool_web_fetch(tool_run *r);
void sope__tool_web_fetch_cancel(tool_run *r);
/* HTML to readable text with Markdown-style headings, lists and links. */
void sope__html_to_text(const char *html, size_t n, sope_buf *out);

#endif /* SOPE_TOOLS_H */
