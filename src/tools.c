/* SPDX-License-Identifier: MIT */
/*
 * tools.c - the built-in tool registry, the task that runs one call, and
 * the helpers every tool uses. See tools.h for the overall design; each
 * tool lives in a tool_*.c file with its description and schema.
 */
#define _POSIX_C_SOURCE 200809L

#include "tools.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define RESULT_MAX (512 * 1024)

/* ------------------------------------------------------------------------ */
/* registry                                                                 */
/* ------------------------------------------------------------------------ */

/* In the order the model sees them. */
static const sope_builtin *const BUILTINS[] = {
    &sope__builtin_read,  &sope__builtin_write,       &sope__builtin_edit,      &sope__builtin_glob,
    &sope__builtin_grep,  &sope__builtin_bash,        &sope__builtin_bash_output, &sope__builtin_bash_kill,
    &sope__builtin_web_fetch, &sope__builtin_todo_write,
    &sope__builtin_artifact_read, &sope__builtin_check, &sope__builtin_evidence,
};

size_t sope__builtin_count(void)
{
    return sizeof BUILTINS / sizeof BUILTINS[0];
}

const sope_builtin *sope__builtin_at(size_t i)
{
    return i < sope__builtin_count() ? BUILTINS[i] : NULL;
}

const sope_builtin *sope__builtin_find(const char *name)
{
    size_t i;
    for (i = 0; i < sope__builtin_count(); i++)
        if (!strcmp(BUILTINS[i]->name, name)) return BUILTINS[i];
    return NULL;
}

/* ------------------------------------------------------------------------ */
/* helpers                                                                  */
/* ------------------------------------------------------------------------ */

const char *sope__arg_string(tool_run *r, const char *key)
{
    return sope__json_string(sope__json_get(r->input, key), NULL);
}

int64_t sope__arg_int(tool_run *r, const char *key, int64_t fallback)
{
    const sope_json *v = sope__json_get(r->input, key);
    if (v && v->type == SOPE_JSON_NUMBER) return (int64_t)v->num;
    if (v && v->type == SOPE_JSON_STRING && v->len) {
        char *end;
        long long n = strtoll(v->str, &end, 10);
        if (!*end) return (int64_t)n;
    }
    return fallback;
}

int sope__arg_bool(tool_run *r, const char *key)
{
    const sope_json *v = sope__json_get(r->input, key);
    if (v && v->type == SOPE_JSON_BOOL) return v->boolean;
    return v && v->type == SOPE_JSON_STRING && !strcmp(v->str, "true");
}

sope_next sope__run_done(tool_run *r)
{
    (void)r;
    return (sope_next){ SOPE__NEXT_CLOSED, 0 };
}

sope_next sope__run_fail(tool_run *r, const char *fmt, ...)
{
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    r->out.len = 0;
    sope__buf_appends(&r->out, buf);
    r->is_error = 1;
    return sope__run_done(r);
}

/* Resolves "." and ".." in an absolute path. */
static char *normalize(const char *p)
{
    size_t n = strlen(p), o = 1;
    char *out = malloc(n + 2);
    if (!out) return NULL;
    out[0] = '/';
    while (*p) {
        const char *e;
        size_t len;
        while (*p == '/') p++;
        for (e = p; *e && *e != '/'; e++) {}
        len = (size_t)(e - p);
        if (!len) break;
        if (len == 2 && p[0] == '.' && p[1] == '.') {
            while (o > 1 && out[o - 1] != '/') o--;
            if (o > 1) o--;
        } else if (!(len == 1 && p[0] == '.')) {
            if (o > 1) out[o++] = '/';
            memcpy(out + o, p, len);
            o += len;
        }
        p = e;
    }
    out[o] = '\0';
    return out;
}

char *sope__run_path(tool_run *r, const char *path)
{
    const char *home = NULL;
    char **env = r->agent->root->environment;
    if (env) for (size_t i = 0; env[i]; i++) if (!strncmp(env[i], "HOME=", 5)) home = env[i] + 5;
    sope_buf b = { 0 };
    char *norm;
    if (path[0] == '~' && (path[1] == '/' || !path[1]) && home && *home) {
        sope__buf_appends(&b, home);
        sope__buf_appends(&b, "/");
        sope__buf_appends(&b, path + 1);
    } else if (path[0] != '/') {
        sope__buf_appends(&b, r->cwd);
        sope__buf_appends(&b, "/");
        sope__buf_appends(&b, path);
    } else {
        sope__buf_appends(&b, path);
    }
    norm = b.oom ? NULL : normalize(b.ptr);
    sope__buf_free(&b);
    return norm;
}

const char *sope__display_path(tool_run *r, const char *path)
{
    size_t n = strlen(r->cwd);
    if (n == 1 && r->cwd[0] == '/') return path[1] ? path + 1 : path;
    if (!strncmp(path, r->cwd, n)) {
        if (!path[n]) return ".";
        if (path[n] == '/') return path + n + 1;
    }
    return path;
}

/* ------------------------------------------------------------------------ */
/* the run task                                                             */
/* ------------------------------------------------------------------------ */

int sope__run_add_image(tool_run *r, const char *media_type, const void *data, size_t n)
{
    sope_image *grown = realloc(r->images, (r->n_images + 1) * sizeof *grown);
    if (!grown) return 0;
    r->images = grown;
    if (!sope__image_init(&r->images[r->n_images], media_type, data, n)) return 0;
    r->n_images++;
    return 1;
}

static void run_free(tool_run *r)
{
    sope__file_release(r);
    free(r->file_path);
    sope__images_free(r->images, r->n_images);
    sope__json_free(r->input);
    free(r->cwd);
    free(r->ca_file);
    free(r->receipt);
    free(r->check_archive);
    sope__buf_free(&r->out);
    sope__buf_free(&r->body);
    if (r->proc) sope__proc_release(r->proc);
    if (r->http) sope__http_release(r->http);
    free(r);
}

static sope_next run_step(sope_task *task)
{
    tool_run *r = task->owner;
    int cancel;

    pthread_mutex_lock(r->agent->mu);
    cancel = r->cancel || r->agent->cancel_requested || r->agent->closing || r->agent->root->journal_failed;
    pthread_mutex_unlock(r->agent->mu);
    if (cancel) {
        if (r->tool->cancel) r->tool->cancel(r);
        return sope__run_fail(r, "Cancelled.");
    }
    if (!r->input || r->input->type != SOPE_JSON_OBJECT)
        return sope__run_fail(r, "invalid input: expected a JSON object with the tool's arguments");
    return r->file_path ? sope__file_step(r) : r->tool->run(r);
}

/* On a pool thread once the run's task closed: report the result and hand
 * it to the waiting turn. */
static void run_closed(sope_task *task)
{
    tool_run *r = task->owner;
    sope_agent_t *a = r->agent;
    pending_call *p;
    tool_run **pp;

    if (!sope__artifact_preview(a, r->call_id, &r->out, RESULT_MAX)) {
        sope__run_fail(r, "Cannot archive complete tool output; execution stopped.");
        pthread_mutex_lock(a->mu);
        sope__storage_fail_locked(a, "Cannot archive tool output; execution stopped.");
        pthread_mutex_unlock(a->mu);
    }
    sope__buf_sanitize(&r->out, 0);
    if (r->out.oom) {
        sope__buf_free(&r->out);
        sope__buf_appends(&r->out, "out of memory");
        r->is_error = 1;
    } else if (!r->out.len) {
        sope__buf_appends(&r->out, "(no output)");
    }
    pthread_mutex_lock(a->mu);
    if ((p = sope__pending_find_locked(a, r->call_id, PENDING_BUILTIN))) {
        p->content = r->out.ptr; /* ownership moves to the pending call */
        p->len = r->out.len;
        p->is_error = r->is_error;
        p->images = r->images;
        p->n_images = r->n_images;
        r->images = NULL;
        r->n_images = 0;
        p->receipt = r->receipt; r->receipt = NULL;
        p->done = sope__journal_result(a, p);
        p->reported = 1;
        r->out.ptr = NULL;
        r->out.len = r->out.cap = 0;
    }
    for (pp = &a->runs; *pp; pp = &(*pp)->next)
        if (*pp == r) {
            *pp = r->next;
            break;
        }
    sope__task_wake(&a->task);
    pthread_mutex_unlock(a->mu);

    run_free(r);
    sope__pool_release();
}

tool_run *sope__tool_run_new(sope_agent_t *a, const sope_builtin *b, uint64_t call_id, const char *input,
                             size_t len)
{
    tool_run *r = calloc(1, sizeof *r);
    if (!r) return NULL;
    r->agent = a;
    r->tool = b;
    r->call_id = call_id;
    r->turn_id = sope__turn_id(a);
    r->input = sope__json_parse(input, len); /* NULL: the run reports bad input */
    r->cwd = sope__strdup(a->turn.cwd);
    pthread_mutex_lock(a->mu);
    r->ca_file = sope__option_dup_locked(a, "tls.ca_file");
    pthread_mutex_unlock(a->mu);
    if (!r->cwd || !sope__file_prepare(r)) {
        run_free(r);
        return NULL;
    }
    sope__task_init(&r->task, run_step, r);
    r->task.on_closed = run_closed;
    return r;
}

void sope__tool_run_start_locked(tool_run *r)
{
    r->next = r->agent->runs;
    r->agent->runs = r;
    sope__pool_acquire(); /* cannot fail: the pool is running */
    sope__task_wake(&r->task);
}

void sope__tool_run_start(tool_run *r)
{
    pthread_mutex_lock(r->agent->mu);
    sope__tool_run_start_locked(r);
    pthread_mutex_unlock(r->agent->mu);
}

void sope__tool_run_discard(tool_run *r)
{
    if (r) run_free(r);
}
