/* SPDX-License-Identifier: MIT */
/*
 * tools.h - built-in tools: what the model can do without the host. Private.
 *
 * Every agent offers these tools (a host tool registered under the same name
 * replaces one). A call runs as its own task on the pool, so the parallel
 * tool calls of one model response run in parallel, and a running command
 * or download holds no thread while it waits.
 *
 *   tools.c        the registry, the run task, helpers for tools
 *   tool_file.c    read, write, edit (and what the model has seen)
 *   tool_search.c  glob, grep
 *   tool_bash.c    bash, bash_output, bash_kill (and background shells)
 *   tool_web.c     web_fetch: HTTP GET and HTML to text
 *   tool_todo.c    todo_write
 *   walk.c         glob patterns, .gitignore and the tree walk of glob/grep
 *
 * A tool is one sope_builtin: name, description and schema as the model
 * sees them, and a step function. Adding one means a tool_*.c file and a
 * line in the registry.
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
    char *file_path; /* canonical target, fixed at admission */
    file_state expected_file; /* revision seen when this call was admitted */
    int expected_read;
    uint64_t read_digest;
    size_t read_size;
    int read_observed, read_reused;
    struct file_gate *file_gate;

    sope_buf out; /* the result the model sees */
    int is_error;
    sope_image *images; /* shown to the model with the result */
    size_t n_images;

    /* bash */
    sope_proc *proc;
    int64_t deadline_ms; /* monotonic */
    int64_t timeout_ms;
    int timed_out;
    char *receipt;
    char *observation;
    char *check_archive;
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

/* The tools, in their tool_*.c files. */
extern const sope_builtin sope__builtin_read, sope__builtin_write, sope__builtin_edit;
extern const sope_builtin sope__builtin_glob, sope__builtin_grep;
extern const sope_builtin sope__builtin_bash, sope__builtin_bash_output, sope__builtin_bash_kill;
extern const sope_builtin sope__builtin_web_fetch;
extern const sope_builtin sope__builtin_todo_write;
extern const sope_builtin sope__builtin_artifact_read;
extern const sope_builtin sope__builtin_check, sope__builtin_evidence, sope__builtin_report;

/* tools.c: the registry */
size_t sope__builtin_count(void);
const sope_builtin *sope__builtin_at(size_t i);
const sope_builtin *sope__builtin_find(const char *name);

/* tools.c: running a call. A run of tool b, not started yet; NULL on out
 * of memory. */
tool_run *sope__tool_run_new(sope_agent_t *a, const sope_builtin *b, uint64_t call_id, const char *input,
                             size_t len);
/* Starts a prepared run; it ends with SOPE_EVENT_TOOL_END and completes its
 * pending call. The _locked variant expects *mu held. */
void sope__tool_run_start(tool_run *r);
void sope__tool_run_start_locked(tool_run *r);
/* Frees a run that never started. */
void sope__tool_run_discard(tool_run *r);

/* tools.c: helpers shared by the tool implementations. */
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

/* tool_file.c: forgets which files the agent has read (history reset, teardown). */
void sope__files_clear(sope_agent_t *a);
int sope__file_prepare(tool_run *r);
/* Checks a freshly read text fingerprint against committed observations. */
int sope__harness_read(tool_run *r, uint64_t digest, size_t size);
sope_next sope__file_step(tool_run *r);
void sope__file_release(tool_run *r);
/* Native execution fact; call only after process exit and a complete archive. */
void sope__execution_receipt(tool_run *r, int status);
/* tool_bash.c: kills the root's background shells (agent teardown). */
void sope__shells_free(sope_agent_t *root);
/* At a model boundary: append completed background results, or count pending ones. */
int sope__shells_collect(sope_agent_t *a, int *pending);
/* Called with *mu held before retiring a turn/child task. */
void sope__shells_detach_locked(sope_agent_t *a, int cancel);
/* tool_web.c: HTML to readable text with Markdown-style headings, lists and links. */
void sope__html_to_text(const char *html, size_t n, sope_buf *out);

/* walk.c: glob patterns */
#define SOPE__MAX_PATTERNS 64 /* alternatives one pattern expands to, at most */
/* Whether `pattern` (*, ?, [..], ** and {a,b}) matches all of `path`. */
int sope__glob_match(const char *pattern, const char *path);
/* The same for a pattern without {a,b}: one result of sope__glob_expand. */
int sope__glob_match_one(const char *pattern, const char *path);
/* Expands {a,b} groups into at most `room` malloc'd patterns; returns how many. */
size_t sope__glob_expand(const char *pattern, char **out, size_t room);

/* walk.c: the tree walk */
struct stat;
typedef struct sope_walk sope_walk;
struct sope_walk {
    int max_depth; /* directories below the start to enter; -1: unlimited */
    void (*on_file)(sope_walk *w, const char *path, const struct stat *st);
    void *ctx;
    int stop; /* on_file sets it to end the walk; also set past the entry limit */
    /* private */
    struct sope_ignore_rule *rules;
    size_t n_rules, cap_rules;
    size_t visited;
};
/* Applies the .gitignore files above `dir`, up to the repository root. */
void sope__walk_ignores_above(sope_walk *w, const char *dir);
/* Calls on_file for each file under `dir` that is not skipped, in name order. */
void sope__walk(sope_walk *w, const char *dir);
void sope__walk_free(sope_walk *w);

#endif /* SOPE_TOOLS_H */
