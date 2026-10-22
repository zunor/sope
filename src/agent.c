/* SPDX-License-Identifier: MIT */
/*
 * agent.c - public API: agent lifecycle, options, tools, subagent
 * definitions, the event queue and its readable fd.
 *
 * Turn execution lives in loop.c. An agent owns no thread: it is a task on
 * the shared pool (pool.c), woken by host calls that create work.
 */
#define _POSIX_C_SOURCE 200809L

#include "agent.h"

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Bindings hard-code this layout; keep docs/abi.md in sync when it changes. */
_Static_assert(sizeof(void *) != 8 || sizeof(sope_event_t) == 72, "sope_event_t layout changed");

static const char GENERAL_PURPOSE_PROMPT[] =
    "You are a subagent. Given the task below, use the tools available to complete it. Complete the task "
    "fully, but do not gold-plate. When you are done, respond with a concise report of what you did and any "
    "key findings; the caller relays it to the user, so include only the essentials.";

/* ------------------------------------------------------------------------ */
/* helpers                                                                   */
/* ------------------------------------------------------------------------ */

static void deadline_after(struct timespec *ts, int32_t ms)
{
    clock_gettime(CLOCK_REALTIME, ts);
    ts->tv_sec += ms / 1000;
    ts->tv_nsec += (long)(ms % 1000) * 1000000L;
    if (ts->tv_nsec >= 1000000000L) {
        ts->tv_sec += 1;
        ts->tv_nsec -= 1000000000L;
    }
}

static void ev_free(ev_node *n)
{
    if (!n) return;
    free(n->name);
    free(n->data);
    free(n);
}

static void tool_free(tool_def *t)
{
    if (!t) return;
    free(t->name);
    free(t->description);
    free(t->input_schema);
    free(t);
}

static void subagent_free(subagent_def *d)
{
    size_t i;
    if (!d) return;
    free(d->name);
    free(d->description);
    free(d->system_prompt);
    free(d->model);
    for (i = 0; i < d->n_tools; i++) free(d->tools[i]);
    free(d->tools);
    free(d);
}

static int valid_name(const char *s, size_t n)
{
    size_t i;
    if (n == 0 || n > 64) return 0;
    for (i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        if (!(isalnum(c) || c == '_' || c == '-')) return 0;
    }
    return 1;
}

static option_kv **option_slot_locked(sope_agent_t *a, const char *key)
{
    option_kv **pp = &a->options;
    while (*pp && strcmp((*pp)->key, key) != 0) pp = &(*pp)->next;
    return pp;
}

char *sope__option_dup_locked(sope_agent_t *a, const char *key)
{
    option_kv *kv = *option_slot_locked(a, key);
    return kv ? sope__strdup(kv->value) : NULL;
}

/* Keeps the fd readable exactly while events are queued or the agent is closed. */
static void fd_signal_locked(sope_agent_t *root)
{
    if (root->fd_write >= 0 && !root->fd_signaled) {
        ssize_t r;
        do r = write(root->fd_write, "!", 1);
        while (r < 0 && errno == EINTR);
        root->fd_signaled = 1;
    }
}

static void fd_unsignal_locked(sope_agent_t *root)
{
    if (root->fd_read >= 0 && root->fd_signaled) {
        char buf[16];
        ssize_t r;
        do r = read(root->fd_read, buf, sizeof buf);
        while (r < 0 && errno == EINTR);
        root->fd_signaled = 0;
    }
}

void sope__signal_closed_locked(sope_agent_t *root)
{
    root->closed = 1;
    fd_signal_locked(root);
    pthread_cond_broadcast(&root->poll_cv);
}

int sope__push_event(sope_agent_t *a, uint32_t type, uint64_t turn_id, uint64_t call_id, int32_t code,
                     const char *name, size_t name_len, const char *data, size_t data_len)
{
    sope_agent_t *root = a->root;
    ev_node *n = calloc(1, sizeof *n);
    if (!n) return SOPE_ENOMEM;
    n->type = type;
    n->code = code;
    n->turn_id = turn_id;
    n->call_id = call_id;
    n->agent_id = a->agent_id;
    n->name_len = name ? name_len : 0;
    n->data_len = data ? data_len : 0;
    n->name = sope__strndup(name ? name : "", n->name_len);
    n->data = sope__strndup(data ? data : "", n->data_len);
    if (!n->name || !n->data) {
        ev_free(n);
        return SOPE_ENOMEM;
    }

    pthread_mutex_lock(a->mu);
    if (root->ev_tail)
        root->ev_tail->next = n;
    else
        root->ev_head = n;
    root->ev_tail = n;
    fd_signal_locked(root);
    pthread_cond_broadcast(&root->poll_cv);
    pthread_mutex_unlock(a->mu);
    return SOPE_OK;
}

void sope__agent_free_memory(sope_agent_t *a)
{
    sope__history_clear(&a->history);
    while (a->in_head) {
        msg_node *m = a->in_head;
        a->in_head = m->next;
        free(m->text);
        free(m);
    }
    while (a->tools) {
        tool_def *t = a->tools;
        a->tools = t->next;
        tool_free(t);
    }
    while (a->options) {
        option_kv *kv = a->options;
        a->options = kv->next;
        free(kv->key);
        free(kv->value);
        free(kv);
    }
    if (a->root != a) {
        free(a);
        return;
    }

    ev_free(a->delivered);
    while (a->ev_head) {
        ev_node *n = a->ev_head;
        a->ev_head = n->next;
        ev_free(n);
    }
    while (a->subagents) {
        subagent_def *d = a->subagents;
        a->subagents = d->next;
        subagent_free(d);
    }
    if (a->fd_read >= 0) close(a->fd_read);
    if (a->fd_write >= 0) close(a->fd_write);
    pthread_cond_destroy(&a->poll_cv);
    pthread_mutex_destroy(&a->mu_storage);
    free(a);
}

/* Parses a subagent definition. On failure sets the error, stores its code
 * in *rc and returns NULL. */
static subagent_def *parse_subagent(const char *json, size_t len, int *rc)
{
    sope_json *root = sope__json_parse(json, len);
    const sope_json *name, *desc, *prompt, *model, *tools, *rounds;
    subagent_def *d = NULL;
    size_t n = 0;

    *rc = SOPE_EINVAL;
    if (!root || root->type != SOPE_JSON_OBJECT) {
        sope__set_error(SOPE_EINVAL, "sope_subagent_register: definition is not a JSON object");
        goto done;
    }
    name = sope__json_get(root, "name");
    desc = sope__json_get(root, "description");
    prompt = sope__json_get(root, "system_prompt");
    model = sope__json_get(root, "model");
    tools = sope__json_get(root, "tools");
    rounds = sope__json_get(root, "max_rounds");

    if (!sope__json_string(name, &n) || !valid_name(name->str, n)) {
        sope__set_error(SOPE_EINVAL, "sope_subagent_register: \"name\" must be 1-64 chars of [A-Za-z0-9_-]");
        goto done;
    }
    if (!sope__json_string(desc, &n) || !n || !sope__json_string(prompt, &n) || !n) {
        sope__set_error(SOPE_EINVAL, "sope_subagent_register: \"description\" and \"system_prompt\" are required");
        goto done;
    }
    if (tools && !(tools->type == SOPE_JSON_ARRAY || (tools->type == SOPE_JSON_STRING && !strcmp(tools->str, "*")))) {
        sope__set_error(SOPE_EINVAL, "sope_subagent_register: \"tools\" must be an array of names or \"*\"");
        goto done;
    }

    d = calloc(1, sizeof *d);
    if (!d || !(d->name = sope__strdup(name->str)) || !(d->description = sope__strdup(desc->str)) ||
        !(d->system_prompt = sope__strdup(prompt->str)) ||
        (sope__json_string(model, NULL) && !(d->model = sope__strdup(model->str))))
        goto oom;
    d->max_rounds = (int32_t)sope__json_number(rounds, 0);
    if (tools && tools->type == SOPE_JSON_ARRAY) {
        const sope_json *t;
        d->tools = calloc(tools->count ? tools->count : 1, sizeof *d->tools);
        if (!d->tools) goto oom;
        for (t = tools->child; t; t = t->next) {
            if (t->type != SOPE_JSON_STRING) continue;
            if (!(d->tools[d->n_tools] = sope__strdup(t->str))) goto oom;
            d->n_tools++;
        }
    }
    *rc = SOPE_OK;
    goto done;

oom:
    subagent_free(d);
    d = NULL;
    *rc = sope__set_error(SOPE_ENOMEM, "sope_subagent_register: out of memory");
done:
    sope__json_free(root);
    return d;
}

static int add_subagent(sope_agent_t *a, subagent_def *d)
{
    subagent_def **pp;
    pthread_mutex_lock(a->mu);
    pp = &a->subagents;
    while (*pp && strcmp((*pp)->name, d->name) != 0) pp = &(*pp)->next;
    if (*pp) {
        d->next = (*pp)->next;
        subagent_free(*pp);
    }
    *pp = d;
    pthread_mutex_unlock(a->mu);
    return SOPE_OK;
}

/* ------------------------------------------------------------------------ */
/* public API                                                                */
/* ------------------------------------------------------------------------ */

int sope_agent_new(sope_agent_t **out)
{
    static const char builtin[] =
        "{\"name\":\"general-purpose\",\"description\":\"General-purpose agent for researching complex "
        "questions and executing multi-step tasks. Use it to work on an independent subtask in a fresh "
        "context, or to run several subtasks in parallel.\",\"tools\":\"*\",\"system_prompt\":\"-\"}";
    sope_agent_t *a;
    subagent_def *gp;
    int rc;

    if (!out) return sope__set_error(SOPE_EINVAL, "sope_agent_new: out is NULL");
    *out = NULL;

    a = calloc(1, sizeof *a);
    if (!a) return sope__set_error(SOPE_ENOMEM, "sope_agent_new: out of memory");
    a->root = a;
    a->mu = &a->mu_storage;
    a->fd_read = a->fd_write = -1;
    if (pthread_mutex_init(&a->mu_storage, NULL) != 0) {
        free(a);
        return sope__set_error(SOPE_ERROR, "sope_agent_new: pthread_mutex_init failed");
    }
    if (pthread_cond_init(&a->poll_cv, NULL) != 0) {
        pthread_mutex_destroy(&a->mu_storage);
        free(a);
        return sope__set_error(SOPE_ERROR, "sope_agent_new: pthread_cond_init failed");
    }

    /* The built-in definition is parsed like a user one; its prompt is filled in here. */
    gp = parse_subagent(builtin, sizeof builtin - 1, &rc);
    if (gp) {
        free(gp->system_prompt);
        if (!(gp->system_prompt = sope__strdup(GENERAL_PURPOSE_PROMPT)))
            rc = sope__set_error(SOPE_ENOMEM, "sope_agent_new: out of memory");
    }
    if (rc == SOPE_OK) rc = sope__pool_acquire();
    if (rc != SOPE_OK) {
        subagent_free(gp);
        pthread_cond_destroy(&a->poll_cv);
        pthread_mutex_destroy(&a->mu_storage);
        free(a);
        return rc;
    }
    a->subagents = gp;
    sope__task_init(&a->task, sope__agent_run, a);
    *out = a;
    return SOPE_OK;
}

int sope_agent_set_option(sope_agent_t *a, const char *key, const char *value)
{
    option_kv **slot;
    char *v = NULL;

    if (!a || !key || !*key) return sope__set_error(SOPE_EINVAL, "sope_agent_set_option: invalid argument");
    if (value && !(v = sope__strdup(value))) return sope__set_error(SOPE_ENOMEM, "sope_agent_set_option: out of memory");

    pthread_mutex_lock(a->mu);
    slot = option_slot_locked(a, key);
    if (*slot) {
        option_kv *kv = *slot;
        if (v) {
            free(kv->value);
            kv->value = v;
        } else {
            *slot = kv->next;
            free(kv->key);
            free(kv->value);
            free(kv);
        }
    } else if (v) {
        option_kv *kv = calloc(1, sizeof *kv);
        if (!kv || !(kv->key = sope__strdup(key))) {
            pthread_mutex_unlock(a->mu);
            free(kv);
            free(v);
            return sope__set_error(SOPE_ENOMEM, "sope_agent_set_option: out of memory");
        }
        kv->value = v;
        kv->next = a->options;
        a->options = kv;
    }
    pthread_mutex_unlock(a->mu);
    return SOPE_OK;
}

int sope_tool_register(sope_agent_t *a, const char *name, const char *description, const char *input_schema_json)
{
    tool_def *t, **slot;
    sope_json *schema;

    if (!a || !name) return sope__set_error(SOPE_EINVAL, "sope_tool_register: invalid argument");
    if (!valid_name(name, strlen(name)))
        return sope__set_error(SOPE_EINVAL, "sope_tool_register: invalid tool name '%s'", name);
    if (!strcmp(name, "agent"))
        return sope__set_error(SOPE_EINVAL, "sope_tool_register: 'agent' is reserved for subagents");
    if (input_schema_json) {
        schema = sope__json_parse(input_schema_json, strlen(input_schema_json));
        if (!schema || schema->type != SOPE_JSON_OBJECT) {
            sope__json_free(schema);
            return sope__set_error(SOPE_EINVAL, "sope_tool_register: input schema of '%s' is not a JSON object", name);
        }
        sope__json_free(schema);
    }

    t = calloc(1, sizeof *t);
    if (!t || !(t->name = sope__strdup(name)) || !(t->description = sope__strdup(description ? description : "")) ||
        !(t->input_schema = sope__strdup(input_schema_json ? input_schema_json : "{\"type\":\"object\"}"))) {
        tool_free(t);
        return sope__set_error(SOPE_ENOMEM, "sope_tool_register: out of memory");
    }

    pthread_mutex_lock(a->mu);
    slot = &a->tools;
    while (*slot && strcmp((*slot)->name, name) != 0) slot = &(*slot)->next;
    if (*slot) {
        t->next = (*slot)->next;
        tool_free(*slot);
    }
    *slot = t;
    pthread_mutex_unlock(a->mu);
    return SOPE_OK;
}

int sope_subagent_register(sope_agent_t *a, const char *definition_json, size_t len)
{
    subagent_def *d;
    int rc;
    if (!a || !definition_json) return sope__set_error(SOPE_EINVAL, "sope_subagent_register: invalid argument");
    if (!(d = parse_subagent(definition_json, len, &rc))) return rc;
    return add_subagent(a, d);
}

/* Queues one turn: a user message, or a compaction request with optional
 * instructions. */
static int enqueue(sope_agent_t *a, const char *fn, int compact, const char *text, size_t len, uint64_t *turn_id_out)
{
    msg_node *m;

    if (!a || (!text && len)) return sope__set_error(SOPE_EINVAL, "%s: invalid argument", fn);

    m = calloc(1, sizeof *m);
    if (!m || !(m->text = sope__strndup(text ? text : "", len))) {
        free(m);
        return sope__set_error(SOPE_ENOMEM, "%s: out of memory", fn);
    }
    m->len = len;
    m->compact = compact;

    pthread_mutex_lock(a->mu);
    if (a->closing) {
        pthread_mutex_unlock(a->mu);
        free(m->text);
        free(m);
        return sope__set_error(SOPE_ECLOSED, "%s: agent is closed", fn);
    }
    m->turn_id = ++a->next_turn_id;
    if (a->in_tail)
        a->in_tail->next = m;
    else
        a->in_head = m;
    a->in_tail = m;
    if (turn_id_out) *turn_id_out = m->turn_id;
    pthread_mutex_unlock(a->mu);

    sope__task_wake(&a->task);
    return SOPE_OK;
}

int sope_send(sope_agent_t *a, const char *text, size_t len, uint64_t *turn_id_out)
{
    return enqueue(a, "sope_send", 0, text, len, turn_id_out);
}

int sope_compact(sope_agent_t *a, const char *instructions, size_t len, uint64_t *turn_id_out)
{
    return enqueue(a, "sope_compact", 1, instructions, len, turn_id_out);
}

int sope_tool_result(sope_agent_t *a, uint64_t call_id, int is_error, const char *content, size_t len)
{
    pending_call *p;
    sope_agent_t *owner;
    char *copy;

    if (!a || (!content && len)) return sope__set_error(SOPE_EINVAL, "sope_tool_result: invalid argument");
    if (!(copy = sope__strndup(content ? content : "", len)))
        return sope__set_error(SOPE_ENOMEM, "sope_tool_result: out of memory");

    pthread_mutex_lock(a->mu);
    for (p = a->root->pending; p; p = p->next)
        if (p->call_id == call_id && p->kind == PENDING_TOOL && !p->done) break;
    if (!p) {
        pthread_mutex_unlock(a->mu);
        free(copy);
        return sope__set_error(SOPE_ENOTFOUND, "sope_tool_result: no pending tool call %" PRIu64, call_id);
    }
    p->content = copy;
    p->len = len;
    p->is_error = is_error != 0;
    p->done = 1;
    owner = p->owner;
    /* Wake under the lock: the owner cannot be freed while its call is pending. */
    sope__task_wake(&owner->task);
    pthread_mutex_unlock(a->mu);
    return SOPE_OK;
}

int sope_cancel(sope_agent_t *a)
{
    int wake = 0;
    if (!a) return sope__set_error(SOPE_EINVAL, "sope_cancel: agent is NULL");
    pthread_mutex_lock(a->mu);
    if (a->active_turn) a->cancel_requested = wake = 1;
    pthread_mutex_unlock(a->mu);
    if (wake) sope__task_wake(&a->task);
    return SOPE_OK;
}

int sope_agent_reset(sope_agent_t *a)
{
    if (!a) return sope__set_error(SOPE_EINVAL, "sope_agent_reset: agent is NULL");
    pthread_mutex_lock(a->mu);
    a->reset_requested = 1;
    pthread_mutex_unlock(a->mu);
    return SOPE_OK;
}

int sope_agent_close(sope_agent_t *a)
{
    if (!a) return sope__set_error(SOPE_EINVAL, "sope_agent_close: agent is NULL");
    pthread_mutex_lock(a->mu);
    a->closing = 1;
    pthread_mutex_unlock(a->mu);
    sope__task_wake(&a->task);
    return SOPE_OK;
}

void sope_agent_free(sope_agent_t *a)
{
    if (!a) return;
    sope_agent_close(a);
    sope__task_wait_closed(&a->task); /* the root closes only after all its subagents */
    sope__pool_release();
    sope__agent_free_memory(a);
}

int sope_agent_fd(sope_agent_t *a)
{
    int fds[2], i, fd;

    if (!a) return sope__set_error(SOPE_EINVAL, "sope_agent_fd: agent is NULL");
    pthread_mutex_lock(a->mu);
    if (a->fd_read < 0) {
        if (pipe(fds) != 0) {
            int err = errno;
            pthread_mutex_unlock(a->mu);
            return sope__set_error(SOPE_ERROR, "sope_agent_fd: pipe failed: %s", strerror(err));
        }
        for (i = 0; i < 2; i++) {
            fcntl(fds[i], F_SETFL, fcntl(fds[i], F_GETFL) | O_NONBLOCK);
            fcntl(fds[i], F_SETFD, FD_CLOEXEC);
        }
        a->fd_read = fds[0];
        a->fd_write = fds[1];
        a->fd_signaled = 0;
        if (a->ev_head || a->closed) fd_signal_locked(a);
    }
    fd = a->fd_read;
    pthread_mutex_unlock(a->mu);
    return fd;
}

int sope_poll(sope_agent_t *a, sope_event_t *ev, int32_t timeout_ms)
{
    struct timespec deadline;
    ev_node *n;

    if (!a || !ev) return sope__set_error(SOPE_EINVAL, "sope_poll: invalid argument");
    if (ev->size < sizeof(sope_event_t))
        return sope__set_error(SOPE_EINVAL, "sope_poll: event size %u, expected %zu", ev->size, sizeof(sope_event_t));
    if (timeout_ms > 0) deadline_after(&deadline, timeout_ms);

    pthread_mutex_lock(a->mu);
    ev_free(a->delivered);
    a->delivered = NULL;
    while (!a->ev_head) {
        if (a->closed) {
            pthread_mutex_unlock(a->mu);
            return sope__set_error(SOPE_ECLOSED, "sope_poll: agent is closed");
        }
        if (timeout_ms == 0) {
            pthread_mutex_unlock(a->mu);
            return 0;
        }
        if (timeout_ms < 0) {
            pthread_cond_wait(&a->poll_cv, a->mu);
        } else if (pthread_cond_timedwait(&a->poll_cv, a->mu, &deadline) == ETIMEDOUT && !a->ev_head &&
                   !a->closed) {
            pthread_mutex_unlock(a->mu);
            return 0;
        }
    }
    n = a->ev_head;
    a->ev_head = n->next;
    if (!a->ev_head) {
        a->ev_tail = NULL;
        if (!a->closed) fd_unsignal_locked(a);
    }
    a->delivered = n;
    pthread_mutex_unlock(a->mu);

    ev->type = n->type;
    ev->turn_id = n->turn_id;
    ev->call_id = n->call_id;
    ev->agent_id = n->agent_id;
    ev->name = n->name;
    ev->name_len = n->name_len;
    ev->data = n->data;
    ev->data_len = n->data_len;
    ev->code = n->code;
    ev->reserved = 0;
    return 1;
}
