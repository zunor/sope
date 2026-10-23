/* SPDX-License-Identifier: MIT */
/*
 * agent.c - public API: agent lifecycle, options, tools, the event queue
 * and its readable fd, and the registry of pending tool calls.
 *
 * Turns run in loop.c, subagents in subagent.c. An agent owns no thread: it
 * is a task on the shared pool (pool.c), woken by host calls that create work.
 */
#define _POSIX_C_SOURCE 200809L

#include "tools.h"

#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Bindings hard-code this layout; keep docs/abi.md in sync when it changes. */
_Static_assert(sizeof(void *) != 8 || sizeof(sope_event_t) == 80, "sope_event_t layout changed");

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

int sope__valid_name(const char *s, size_t n)
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

pending_call *sope__pending_find_locked(sope_agent_t *a, uint64_t call_id, pending_kind kind)
{
    pending_call *p;
    for (p = a->root->pending; p; p = p->next)
        if (p->call_id == call_id && p->kind == kind) return p;
    return NULL;
}

void sope__pending_free(pending_call *p)
{
    sope__tool_run_discard(p->run); /* still waiting for sope_permit */
    sope__images_free(p->images, p->n_images);
    free(p->name);
    free(p->content);
    free(p);
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

static ev_node *event_new(sope_agent_t *a, uint32_t type, uint64_t turn_id, uint64_t call_id, int32_t code,
                          const char *name, size_t name_len, const char *data, size_t data_len)
{
    ev_node *n = calloc(1, sizeof *n);
    if (!n) return NULL;
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
        return NULL;
    }
    return n;
}

static void event_enqueue_locked(sope_agent_t *root, ev_node *n)
{
    if (root->ev_tail)
        root->ev_tail->next = n;
    else
        root->ev_head = n;
    root->ev_tail = n;
    fd_signal_locked(root);
    pthread_cond_broadcast(&root->poll_cv);
}

int sope__push_event_locked(sope_agent_t *a, uint32_t type, uint64_t turn_id, uint64_t call_id, int32_t code,
                            const char *name, size_t name_len, const char *data, size_t data_len)
{
    ev_node *n = event_new(a, type, turn_id, call_id, code, name, name_len, data, data_len);
    if (!n) return SOPE_ENOMEM;
    sope_agent_t *root = a->root;
    if (!sope__journal_event(a, n)) { ev_free(n); return SOPE_ERROR; }
    if (!n->sequence) n->sequence = root->journal && !root->journal_failed ? root->event_sequence : 0;
    event_enqueue_locked(root, n);
    return SOPE_OK;
}

int sope__push_event(sope_agent_t *a, uint32_t type, uint64_t turn_id, uint64_t call_id, int32_t code,
                     const char *name, size_t name_len, const char *data, size_t data_len)
{
    pthread_mutex_lock(a->mu);
    int rc = sope__push_event_locked(a, type, turn_id, call_id, code, name, name_len, data, data_len);
    pthread_mutex_unlock(a->mu);
    return rc;
}

void sope__agent_free_memory(sope_agent_t *a)
{
    size_t i;
    sope__history_clear(&a->history);
    sope__files_clear(a);
    for (i = 0; i < a->n_tool_filter; i++) free(a->tool_filter[i]);
    free(a->tool_filter);
    free(a->history_json);
    while (a->in_head) {
        msg_node *m = a->in_head;
        a->in_head = m->next;
        sope__msg_node_free(m);
    }
    sope__images_free(a->attached, a->n_attached);
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

    sope__shells_free(a);
    while (a->pending) { pending_call *p = a->pending; a->pending = p->next; sope__pending_free(p); }
    sope__journal_close(a);
    free(a->artifact_dir);
    free(a->session_id); free(a->instance_id);
    sope__policy_free(a);
    ev_free(a->delivered);
    while (a->ev_head) {
        ev_node *n = a->ev_head;
        a->ev_head = n->next;
        ev_free(n);
    }
    while (a->subagents) {
        subagent_def *d = a->subagents;
        a->subagents = d->next;
        sope__subagent_free(d);
    }
    if (a->fd_read >= 0) close(a->fd_read);
    if (a->fd_write >= 0) close(a->fd_write);
    pthread_cond_destroy(&a->poll_cv);
    pthread_mutex_destroy(&a->mu_storage);
    free(a);
}

/* ------------------------------------------------------------------------ */
/* public API                                                                */
/* ------------------------------------------------------------------------ */

int sope_agent_new(sope_agent_t **out)
{
    sope_agent_t *a;
    subagent_def *gp;
    int rc;

    if (!out) return sope__set_error(SOPE_EINVAL, "sope_agent_new: out is NULL");
    *out = NULL;

    a = calloc(1, sizeof *a);
    if (!a) return sope__set_error(SOPE_ENOMEM, "sope_agent_new: out of memory");
    a->root = a;
    a->session_id = sope__identity(); a->instance_id = sope__identity();
    if (!a->session_id || !a->instance_id) { free(a->session_id); free(a->instance_id); free(a); return SOPE_ERROR; }
    a->mu = &a->mu_storage;
    a->fd_read = a->fd_write = -1;
    if (pthread_mutex_init(&a->mu_storage, NULL) != 0) {
        free(a->session_id); free(a->instance_id); free(a);
        return sope__set_error(SOPE_ERROR, "sope_agent_new: pthread_mutex_init failed");
    }
    if (pthread_cond_init(&a->poll_cv, NULL) != 0) {
        pthread_mutex_destroy(&a->mu_storage);
        free(a->session_id); free(a->instance_id); free(a);
        return sope__set_error(SOPE_ERROR, "sope_agent_new: pthread_cond_init failed");
    }

    gp = sope__subagent_general_purpose(&rc);
    if (rc == SOPE_OK) rc = sope__pool_acquire();
    if (rc != SOPE_OK) {
        sope__subagent_free(gp);
        pthread_cond_destroy(&a->poll_cv);
        pthread_mutex_destroy(&a->mu_storage);
        free(a->session_id); free(a->instance_id); free(a);
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
    if (value && !strcmp(key, "openai.wire_api") && strcmp(value, "chat") && strcmp(value, "responses"))
        return sope__set_error(SOPE_EINVAL, "openai.wire_api must be chat or responses");
    if (value && !strcmp(key, "reasoning.effort") && strcmp(value, "none") && strcmp(value, "minimal") &&
        strcmp(value, "low") && strcmp(value, "medium") && strcmp(value, "high") && strcmp(value, "xhigh"))
        return sope__set_error(SOPE_EINVAL, "invalid reasoning.effort");
    if (value && !strcmp(key, "openai.api_key") && (strchr(value, '\r') || strchr(value, '\n')))
        return sope__set_error(SOPE_EINVAL, "credential contains a line break");
    if (value && !(v = sope__strdup(value))) return sope__set_error(SOPE_ENOMEM, "sope_agent_set_option: out of memory");

    pthread_mutex_lock(a->mu);
    if ((a->sealed && strcmp(key, "openai.api_key")) || (a->contract_required && !a->sealed && a->active_turn)) {
        pthread_mutex_unlock(a->mu); free(v);
        return sope__set_error(SOPE_EBUSY, "sealed execution configuration is immutable");
    }
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
    if (!sope__valid_name(name, strlen(name)))
        return sope__set_error(SOPE_EINVAL, "sope_tool_register: invalid tool name '%s'", name);
    if (!strcmp(name, SOPE__AGENT_TOOL))
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
    if (a->sealed) { pthread_mutex_unlock(a->mu); tool_free(t); return sope__set_error(SOPE_EBUSY, "sealed tool definitions are immutable"); }
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
    if (!(d = sope__subagent_parse(definition_json, len, &rc))) return rc;
    pthread_mutex_lock(a->mu);
    int sealed = a->sealed;
    if (sealed) { pthread_mutex_unlock(a->mu); sope__subagent_free(d); return sope__set_error(SOPE_EBUSY, "sealed subagent definitions are immutable"); }
    sope__subagent_add(a, d);
    pthread_mutex_unlock(a->mu);
    return SOPE_OK;
}

/* Queues one turn: a user message, or a compaction request with optional
 * instructions. */
void sope__msg_node_free(msg_node *m)
{
    if (!m) return;
    free(m->text);
    free(m->request_key);
    sope__images_free(m->images, m->n_images);
    free(m);
}

static int enqueue(sope_agent_t *a, const char *fn, int compact, const char *key, const char *text, size_t len, uint64_t *turn_id_out)
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
    if (key && !(m->request_key = sope__strdup(key))) { sope__msg_node_free(m); return SOPE_ENOMEM; }

    pthread_mutex_lock(a->mu);
    if (!sope__contract_ready_locked(a)) { pthread_mutex_unlock(a->mu); sope__msg_node_free(m); return sope__set_error(SOPE_ECONFLICT, "seal the original execution configuration first"); }
    int duplicate = sope__journal_duplicate(a, m, turn_id_out);
    if (duplicate > 0) { sope__images_free(a->attached, a->n_attached); a->attached = NULL; a->n_attached = 0; }
    if (duplicate) { pthread_mutex_unlock(a->mu); sope__msg_node_free(m); return duplicate > 0 ? SOPE_OK : duplicate; }
    if (a->recovering || a->suspending || a->suspended || a->root->journal_failed) {
        pthread_mutex_unlock(a->mu);
        sope__msg_node_free(m);
        return sope__set_error(SOPE_EBUSY, "session needs recovery before accepting input");
    }
    if (a->closing) {
        pthread_mutex_unlock(a->mu);
        sope__msg_node_free(m);
        return sope__set_error(SOPE_ECLOSED, "%s: agent is closed", fn);
    }
    m->turn_id = ++a->next_turn_id;
    if (!compact) { /* the message carries the images attached since the last one */
        m->images = a->attached;
        m->n_images = a->n_attached;
    }
    if (!sope__journal_input(a, m)) {
        m->images = NULL; m->n_images = 0;
        pthread_mutex_unlock(a->mu);
        sope__msg_node_free(m);
        return sope__set_error(SOPE_ERROR, "input was not committed to execution journal");
    }
    if (!compact) {
        a->attached = NULL;
        a->n_attached = 0;
    }
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

int sope_attach_image(sope_agent_t *a, const char *media_type, const void *data, size_t len)
{
    static const char *const types[] = { "image/png", "image/jpeg", "image/gif", "image/webp" };
    sope_image img, *grown;
    const char *type = NULL;
    size_t i;

    if (!a || !data || !len) return sope__set_error(SOPE_EINVAL, "sope_attach_image: no image data");
    if (len > SOPE__MAX_IMAGE_BYTES)
        return sope__set_error(SOPE_EINVAL, "sope_attach_image: %zu bytes is over the %u byte limit", len, SOPE__MAX_IMAGE_BYTES);
    if (!media_type || !*media_type) media_type = sope__image_type(data, len);
    for (i = 0; media_type && i < sizeof types / sizeof *types; i++)
        if (!strcmp(media_type, types[i])) type = types[i];
    if (!type)
        return sope__set_error(SOPE_EINVAL, "sope_attach_image: unsupported media type %s (png, jpeg, gif or webp)",
                               media_type ? media_type : "(unknown)");
    if (!sope__image_init(&img, type, data, len)) return sope__set_error(SOPE_ENOMEM, "sope_attach_image: out of memory");

    pthread_mutex_lock(a->mu);
    if (a->closing) {
        pthread_mutex_unlock(a->mu);
        free(img.media_type);
        free(img.data);
        return sope__set_error(SOPE_ECLOSED, "sope_attach_image: agent is closed");
    }
    if (!(grown = realloc(a->attached, (a->n_attached + 1) * sizeof *grown))) {
        pthread_mutex_unlock(a->mu);
        free(img.media_type);
        free(img.data);
        return sope__set_error(SOPE_ENOMEM, "sope_attach_image: out of memory");
    }
    grown[a->n_attached++] = img;
    a->attached = grown;
    pthread_mutex_unlock(a->mu);
    return SOPE_OK;
}

int sope_send(sope_agent_t *a, const char *text, size_t len, uint64_t *turn_id_out)
{
    return enqueue(a, "sope_send", 0, NULL, text, len, turn_id_out);
}

int sope_submit(sope_agent_t *a, const char *key, const char *text, size_t len, uint64_t *id)
{
    if (!key || !*key || strlen(key) > 256) return sope__set_error(SOPE_EINVAL, "request key must be 1..256 bytes");
    return enqueue(a, "sope_submit", 0, key, text, len, id);
}

int sope_compact(sope_agent_t *a, const char *instructions, size_t len, uint64_t *turn_id_out)
{
    return enqueue(a, "sope_compact", 1, NULL, instructions, len, turn_id_out);
}

int sope_tool_result(sope_agent_t *a, uint64_t call_id, int is_error, const char *content, size_t len)
{
    pending_call *p;
    sope_agent_t *owner;
    char *copy;

    if (!a || (!content && len)) return sope__set_error(SOPE_EINVAL, "sope_tool_result: invalid argument");
    sope_buf output = {0};
    sope__buf_append(&output, content ? content : "", len);
    if (!sope__artifact_preview(a, call_id, &output, 512 * 1024)) {
        sope__buf_free(&output);
        return sope__set_error(SOPE_ERROR, "cannot archive tool output");
    }
    len = output.len;
    if (!(copy = output.ptr))
        return sope__set_error(SOPE_ENOMEM, "sope_tool_result: out of memory");

    pthread_mutex_lock(a->mu);
    p = sope__pending_find_locked(a, call_id, PENDING_TOOL);
    if (!p || p->done || p->permission || a->root->recovering || a->root->suspended || a->root->journal_failed) {
        pthread_mutex_unlock(a->mu);
        free(copy);
        return sope__set_error(SOPE_ENOTFOUND, "sope_tool_result: no pending tool call %" PRIu64, call_id);
    }
    p->content = copy;
    p->len = len;
    p->is_error = is_error != 0;
    if (!sope__journal_result(p->owner, p)) {
        p->content = NULL; p->len = 0;
        pthread_mutex_unlock(a->mu);
        free(copy);
        return sope__set_error(SOPE_ERROR, "tool result was not committed");
    }
    p->done = 1;
    p->reported = 1;
    owner = p->owner;
    /* Wake under the lock: the owner cannot be freed while its call is pending. */
    sope__task_wake(&owner->task);
    pthread_mutex_unlock(a->mu);
    return SOPE_OK;
}

int sope_permit(sope_agent_t *a, uint64_t call_id, int allow, const char *message, size_t len)
{
    pending_call *p;
    tool_run *r;
    sope_buf why = { 0 };

    if (!a || (!message && len)) return sope__set_error(SOPE_EINVAL, "sope_permit: invalid argument");
    if (!allow) {
        sope__buf_appends(&why, "The user denied this tool call, so it did not run.");
        if (len) {
            sope__buf_appends(&why, " They said: ");
            sope__buf_append(&why, message, len);
        } else {
            sope__buf_appends(&why, " Do not retry it as is: adjust your approach, or ask the user how to proceed.");
        }
        if (why.oom) {
            sope__buf_free(&why);
            return sope__set_error(SOPE_ENOMEM, "sope_permit: out of memory");
        }
    }

    pthread_mutex_lock(a->mu);
    for (p = a->root->pending; p; p = p->next) if (p->call_id == call_id && p->permission == 1 && !p->done) break;
    if (p) {
        if (a->root->suspending || a->root->recovering || a->root->journal_failed) {
            pthread_mutex_unlock(a->mu); sope__buf_free(&why); return SOPE_EBUSY;
        }
        if (allow) p->permission = 2;
        else {
            p->content = why.ptr; p->len = why.len; p->is_error = 1; why.ptr = NULL;
            p->done = sope__journal_result(p->owner, p);
            p->reported = 1;
        }
        sope__task_wake(&p->owner->task);
        int rc = a->root->journal_failed ? SOPE_ERROR : SOPE_OK;
        pthread_mutex_unlock(a->mu); sope__buf_free(&why); return rc;
    }
    p = sope__pending_find_locked(a, call_id, PENDING_BUILTIN);
    if (!p || !p->run || p->done || a->root->suspending || a->root->recovering || a->root->suspended || a->root->journal_failed) {
        pthread_mutex_unlock(a->mu);
        sope__buf_free(&why);
        return sope__set_error(SOPE_ENOTFOUND, "sope_permit: no tool call %" PRIu64 " is waiting for permission",
                               call_id);
    }
    r = p->run;
    p->run = NULL;
    if (allow) {
        /* Started under the lock, so a cancelled turn waits for it like any run. */
        sope__tool_run_start_locked(r);
        r = NULL;
    } else {
        p->content = why.ptr;
        p->len = why.len;
        p->is_error = 1;
        p->done = sope__journal_result(p->owner, p);
        p->reported = 1;
        why.ptr = NULL;
        sope__task_wake(&p->owner->task);
    }
    int rc = a->root->journal_failed ? SOPE_ERROR : SOPE_OK;
    pthread_mutex_unlock(a->mu);
    sope__tool_run_discard(r);
    sope__buf_free(&why);
    return rc;
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
    if (a->journal) {
        if (a->active_turn || a->in_head || a->recovering || a->journal_failed) {
            pthread_mutex_unlock(a->mu);
            return sope__set_error(SOPE_EBUSY, "finish or recover the durable task before resetting history");
        }
        sope__history_clear(&a->history);
        sope__files_clear(a);
        a->context_tokens = a->context_estimate = 0;
        int ok = sope__journal_checkpoint(a, "import", 1);
        pthread_mutex_unlock(a->mu);
        return ok ? SOPE_OK : SOPE_ERROR;
    }
    a->reset_requested = 1;
    pthread_mutex_unlock(a->mu);
    return SOPE_OK;
}

/* History belongs to the agent's task while a turn runs or waits to run;
 * between turns nothing touches it, and holding *mu keeps the next turn
 * from starting. */
static int between_turns_locked(const sope_agent_t *a)
{
    return !a->active_turn && !a->in_head;
}

int sope_agent_history(sope_agent_t *a, const char **json, size_t *len)
{
    char *s;
    size_t n = 2;

    if (!a || !json) return sope__set_error(SOPE_EINVAL, "sope_agent_history: agent or json is NULL");
    pthread_mutex_lock(a->mu);
    if (!between_turns_locked(a)) {
        pthread_mutex_unlock(a->mu);
        return sope__set_error(SOPE_EBUSY, "sope_agent_history: a turn is running or queued");
    }
    s = a->reset_requested ? sope__strdup("[]") : sope__history_json(&a->history, &n);
    if (s) {
        free(a->history_json);
        a->history_json = s;
    }
    pthread_mutex_unlock(a->mu);
    if (!s) return sope__set_error(SOPE_ENOMEM, "sope_agent_history: out of memory");
    *json = s;
    if (len) *len = n;
    return SOPE_OK;
}

int sope_agent_load_history(sope_agent_t *a, const char *json, size_t len)
{
    sope_history h;
    char err[160];
    int rc;

    if (!a || (!json && len)) return sope__set_error(SOPE_EINVAL, "sope_agent_load_history: agent or json is NULL");
    if ((rc = sope__history_parse(&h, json ? json : "", len, err, sizeof err)) != SOPE_OK)
        return sope__set_error(rc, "sope_agent_load_history: %s", err);
    pthread_mutex_lock(a->mu);
    if (!between_turns_locked(a)) {
        pthread_mutex_unlock(a->mu);
        sope__history_clear(&h);
        return sope__set_error(SOPE_EBUSY, "sope_agent_load_history: a turn is running or queued");
    }
    sope__history_clear(&a->history);
    a->history = h;
    a->reset_requested = 0;
    a->context_tokens = 0;
    a->context_estimate = 0; /* restored histories are measured before their first request */
    sope__files_clear(a); /* edits need fresh reads in this process */
    int committed = sope__journal_checkpoint(a, "import", 1);
    pthread_mutex_unlock(a->mu);
    return committed ? SOPE_OK : SOPE_ERROR;
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
    for (;;) {
        /* Dispatch notifications are capabilities of the current running state,
         * not commands to execute after suspension/cancellation. Retain their
         * audit copies in stream, but never deliver a stale live command. */
        n = a->ev_head;
        if (n && (n->type == SOPE_EVENT_TOOL_CALL || n->type == SOPE_EVENT_PERMISSION)) {
            pending_call *p = a->root->pending;
            while (p && p->call_id != n->call_id) p = p->next;
            int valid = p && !p->done && !p->owner->closing && !a->closing &&
                !a->suspending && !a->suspended && !a->recovering && !a->journal_failed &&
                (n->type == SOPE_EVENT_TOOL_CALL ? p->kind == PENDING_TOOL && !p->permission
                                               : p->permission == 1 || p->run != NULL);
            if (!valid) {
                a->ev_head = n->next;
                if (!a->ev_head) { a->ev_tail = NULL; if (!a->closed) fd_unsignal_locked(a); }
                ev_free(n);
                continue;
            }
        }
        if (a->ev_head) break;
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
    ev->sequence = n->sequence;
    return 1;
}
