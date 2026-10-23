/* SPDX-License-Identifier: MIT */
#define _POSIX_C_SOURCE 200809L
#define _XOPEN_SOURCE 700
#include "agent.h"
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

char *sope__identity(void)
{
    unsigned char bytes[16];
    int fd = open("/dev/urandom", O_RDONLY | O_CLOEXEC);
    if (fd < 0) return NULL;
    size_t n = 0;
    while (n < sizeof bytes) {
        ssize_t k = read(fd, bytes + n, sizeof bytes - n);
        if (k < 0 && errno == EINTR) continue;
        if (k <= 0) { close(fd); return NULL; }
        n += (size_t)k;
    }
    close(fd);
    char *s = malloc(33);
    if (s) for (size_t i = 0; i < 16; i++) {
        s[i*2] = "0123456789abcdef"[bytes[i] >> 4];
        s[i*2+1] = "0123456789abcdef"[bytes[i] & 15];
    }
    if (s) s[32] = 0;
    return s;
}

static int contains(const sope_json *list, const char *name)
{
    for (const sope_json *v = list ? list->child : NULL; v; v = v->next)
        if (v->type == SOPE_JSON_STRING && !strcmp(v->str, name)) return 1;
    return 0;
}
int sope__policy_allows(const sope_agent_t *a, const char *name)
{
    return !a->root->policy || contains(sope__json_get(a->root->policy, "tools"), name);
}
int sope__policy_external(const sope_agent_t *a, const char *name)
{
    return contains(sope__json_get(a->root->policy, "external"), name);
}
int sope__policy_authorize(const sope_agent_t *a)
{
    const sope_json *v = sope__json_get(a->root->policy, "authorize");
    return v && v->boolean;
}
void sope__policy_free(sope_agent_t *a)
{
    sope__json_free(a->policy);
    free(a->policy_json);
    if (a->environment) for (char **p = a->environment; *p; p++) free(*p);
    free(a->environment);
    a->policy = NULL; a->policy_json = NULL; a->environment = NULL;
}
static int cmp_string(const void *a, const void *b) { return strcmp(*(char *const *)a, *(char *const *)b); }

int sope_agent_policy(sope_agent_t *a, const char *text, size_t len)
{
    if (!a || a->parent || !text) return sope__set_error(SOPE_EINVAL, "root and policy JSON required");
    sope_json *v = sope__json_parse(text, len);
    sope_buf json = {0};
    char **env = NULL;
    const sope_json *tools = sope__json_get(v, "tools"), *ext = sope__json_get(v, "external");
    const sope_json *values = sope__json_get(v, "environment"), *auth = sope__json_get(v, "authorize");
    if (!v || v->type != SOPE_JSON_OBJECT || !tools || tools->type != SOPE_JSON_ARRAY ||
        (ext && ext->type != SOPE_JSON_ARRAY) || (values && values->type != SOPE_JSON_OBJECT) ||
        (auth && auth->type != SOPE_JSON_BOOL)) goto invalid;
    for (const sope_json *p = v->child; p; p = p->next)
        if (strcmp(p->key, "tools") && strcmp(p->key, "external") && strcmp(p->key, "environment") && strcmp(p->key, "authorize")) goto invalid;
    for (int i = 0; i < 2; i++) for (const sope_json *p = i ? (ext ? ext->child : NULL) : tools->child; p; p = p->next)
        if (p->type != SOPE_JSON_STRING || !sope__valid_name(p->str, p->len) ||
            (i && (!contains(tools, p->str) || !strcmp(p->str, "agent")))) goto invalid;
    env = calloc((values ? values->count : 0) + 1, sizeof *env);
    if (!env) goto invalid;
    size_t n = 0;
    for (const sope_json *p = values ? values->child : NULL; p; p = p->next) {
        if (!p->key_len || !(isalpha((unsigned char)p->key[0]) || p->key[0] == '_') ||
            p->type != SOPE_JSON_STRING || strlen(p->str) != p->len) goto invalid;
        for (size_t j = 0; j < p->key_len; j++) if (!isalnum((unsigned char)p->key[j]) && p->key[j] != '_') goto invalid;
        sope_buf item = {0}; sope__buf_appendf(&item, "%s=%s", p->key, p->str);
        if (item.oom) { sope__buf_free(&item); goto invalid; }
        env[n++] = item.ptr;
    }
    if (!sope__json_canonical(&json, v, 1)) goto invalid;
    pthread_mutex_lock(a->mu);
    if (a->sealed || a->active_turn || (a->in_head && !a->recovering) || a->closing) {
        pthread_mutex_unlock(a->mu);
        sope__json_free(v); sope__buf_free(&json);
        for (char **p = env; *p; p++) free(*p);
        free(env);
        return sope__set_error(SOPE_EBUSY, "policy is frozen while sealed, queued or running");
    }
    sope__policy_free(a);
    a->policy = v; a->policy_json = json.ptr; a->environment = env;
    pthread_mutex_unlock(a->mu);
    return SOPE_OK;
invalid:
    sope__json_free(v); sope__buf_free(&json);
    if (env) for (char **p = env; *p; p++) free(*p);
    free(env);
    return sope__set_error(SOPE_EINVAL, "invalid execution policy");
}

static void field(sope_buf *b, const char *v)
{
    sope__buf_append_json_string(b, v ? v : "", v ? strlen(v) : 0);
    sope__buf_appends(b, ",");
}
int sope_agent_seal(sope_agent_t *a, const char *revision, const char *env_revision)
{
    if (!a || !revision || !*revision || !env_revision || !*env_revision)
        return sope__set_error(SOPE_EINVAL, "host and environment revisions required");
    pthread_mutex_lock(a->mu);
    if (a->sealed || a->active_turn || (a->in_head && !a->recovering) || a->closing) {
        pthread_mutex_unlock(a->mu);
        return sope__set_error(SOPE_EBUSY, "configuration already sealed or execution started");
    }
    /* Bind cwd to an absolute directory, including the implicit default. A
     * later host chdir must not change the meaning of a sealed tool request. */
    option_kv *cwd = a->options;
    while (cwd && strcmp(cwd->key, "cwd")) cwd = cwd->next;
    char *absolute = realpath(cwd ? cwd->value : ".", NULL);
    if (!absolute) { pthread_mutex_unlock(a->mu); return sope__set_error(SOPE_EINVAL, "cwd must resolve before sealing"); }
    if (!cwd) {
        cwd = calloc(1, sizeof *cwd);
        if (!cwd || !(cwd->key = sope__strdup("cwd"))) { free(cwd); free(absolute); pthread_mutex_unlock(a->mu); return SOPE_ENOMEM; }
        cwd->next = a->options; a->options = cwd;
    }
    free(cwd->value); cwd->value = absolute;
    sope_buf b = {0};
    sope__buf_appends(&b, "["); field(&b, SOPE_VERSION_STRING); field(&b, revision); field(&b, env_revision);
    field(&b, a->policy_json);
    size_t n = 0;
    for (option_kv *p = a->options; p; p = p->next) n++;
    for (tool_def *p = a->tools; p; p = p->next) n++;
    for (subagent_def *p = a->subagents; p; p = p->next) n++;
    char **entries = calloc(n + 1, sizeof *entries);
    if (!entries) { pthread_mutex_unlock(a->mu); sope__buf_free(&b); return SOPE_ENOMEM; }
    n = 0;
    for (option_kv *p = a->options; p; p = p->next) {
        if (!strcmp(p->key, "openai.api_key")) continue;
        sope_buf e = {0}; field(&e, "option"); field(&e, p->key); field(&e, p->value);
        if (e.oom) b.oom = 1;
        entries[n++] = e.ptr;
    }
    for (tool_def *p = a->tools; p; p = p->next) {
        sope_buf e = {0}; field(&e, "tool"); field(&e, p->name); field(&e, p->description); field(&e, p->input_schema);
        if (e.oom) b.oom = 1;
        entries[n++] = e.ptr;
    }
    for (subagent_def *p = a->subagents; p; p = p->next) {
        sope_buf e = {0}; field(&e, "subagent"); field(&e, p->name); field(&e, p->description);
        field(&e, p->system_prompt); field(&e, p->model); sope__buf_appendf(&e, "%d,", p->max_rounds);
        for (size_t j = 0; j < p->n_tools; j++) field(&e, p->tools[j]);
        if (e.oom) b.oom = 1;
        entries[n++] = e.ptr;
    }
    if (!b.oom) {
        qsort(entries, n, sizeof *entries, cmp_string);
        for (size_t i = 0; i < n; i++) field(&b, entries[i]);
    }
    for (size_t i = 0; i < n; i++) free(entries[i]);
    free(entries);
    sope__buf_appends(&b, "null]");
    int rc = b.oom ? SOPE_ENOMEM : sope__journal_seal(a, b.ptr);
    if (rc == SOPE_OK) a->sealed = 1;
    pthread_mutex_unlock(a->mu);
    sope__buf_free(&b);
    return rc;
}
int sope__contract_ready_locked(sope_agent_t *a)
{
    return !a->root->contract_required || a->root->sealed;
}

int sope_agent_suspend(sope_agent_t *a)
{
    if (!a || !a->journal) return sope__set_error(SOPE_EINVAL, "suspend requires a durable root");
    pthread_mutex_lock(a->mu);
    if (a->closing || a->journal_failed) { pthread_mutex_unlock(a->mu); return SOPE_ECLOSED; }
    if (!a->recovering && !a->suspended) a->suspending = 1;
    pthread_mutex_unlock(a->mu);
    sope__task_wake(&a->task);
    return SOPE_OK;
}
int sope_agent_wait(sope_agent_t *a, int32_t ms)
{
    if (!a) return SOPE_EINVAL;
    struct timespec deadline;
    clock_gettime(CLOCK_REALTIME, &deadline);
    if (ms > 0) { deadline.tv_sec += ms / 1000; deadline.tv_nsec += (long)(ms % 1000)*1000000;
        if (deadline.tv_nsec >= 1000000000) { deadline.tv_sec++; deadline.tv_nsec -= 1000000000; } }
    pthread_mutex_lock(a->mu);
    while (!a->closed && !a->suspended && !a->recovering && !a->journal_failed) {
        if (!ms) { pthread_mutex_unlock(a->mu); return sope__set_error(SOPE_ETIMEOUT, "agent has not quiesced before the wait deadline"); }
        int rc = ms < 0 ? pthread_cond_wait(&a->poll_cv, a->mu) : pthread_cond_timedwait(&a->poll_cv, a->mu, &deadline);
        if (rc == ETIMEDOUT) { pthread_mutex_unlock(a->mu); return sope__set_error(SOPE_ETIMEOUT, "agent has not quiesced before the wait deadline"); }
    }
    int failed = a->journal_failed;
    pthread_mutex_unlock(a->mu);
    return failed ? sope__set_error(SOPE_ERROR, "execution journal failed; reopen to recover") : SOPE_OK;
}
