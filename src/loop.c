/* SPDX-License-Identifier: MIT */
/*
 * loop.c - turn execution: the agent loop and subagents.
 *
 * A turn (one sope_send) runs as a state machine on the pool:
 *
 *   START ─▶ CALL ─(model wants tools)─▶ TOOLS ─(all results in)─▶ CALL ─▶ ...
 *              └──(no tool use)──▶ end_turn
 *
 * CALL streams one model call through a provider; TOOLS waits for the tool
 * calls of that response: built-in tools (tools.c, each a task of its own,
 * maybe after the host's sope_permit), host tools (sope_tool_result) and
 * subagents. Each step returns instead of blocking, so waiting costs no
 * thread.
 *
 * COMPACT runs before a CALL once the last call reported more input tokens
 * than compact.threshold, or as the whole turn for sope_compact: one model
 * call summarizes the history (prompts in compact.c), and the summary
 * replaces it.
 *
 * Subagents follow the usual agent-tool design: the model calls the built-in
 * `agent` tool; we spawn a child agent with its own history, system prompt
 * and filtered tool set (never `agent` itself, so no recursion), run it as
 * its own task (so several run in parallel), and return its final message as
 * the tool result. A child forwards its events to the root's queue tagged
 * with agent_id = the spawning call id, and closes itself after one turn.
 */
#define _POSIX_C_SOURCE 200809L

#include "tools.h"

#include <inttypes.h>
#include <limits.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

#define DEFAULT_MAX_ROUNDS 32
#define AGENT_TOOL "agent"

static const char DEFAULT_SYSTEM[] =
    "You are sope, a capable assistant embedded in a host application. Use the provided tools when they help. "
    "Be concise and accurate.";

static const sope_provider *const providers[] = { &sope__provider_mock, &sope__provider_openai };

struct sope_call {
    sope_agent_t *agent;
    void *state;
    uint64_t round;
    int compaction;       /* summarizes `request` instead of the agent's history */
    sope_history request; /* compaction only */
    sope_buf text;
    sope_tool_use *uses;
    size_t n_uses, cap_uses;
    int failed; /* an error was reported */
};

static sope_next next(sope_next_kind kind)
{
    return (sope_next){ kind, 0 };
}

static uint64_t turn_id(sope_agent_t *a)
{
    return a->turn.msg->turn_id;
}

/* ------------------------------------------------------------------------ */
/* history                                                                   */
/* ------------------------------------------------------------------------ */

static void tool_uses_free(sope_tool_use *uses, size_t n)
{
    size_t i;
    for (i = 0; i < n; i++) {
        free(uses[i].id);
        free(uses[i].name);
        free(uses[i].input);
    }
    free(uses);
}

static void message_free(sope_message *m)
{
    if (!m) return;
    free(m->content);
    tool_uses_free(m->tool_uses, m->n_tool_uses);
    free(m->tool_use_id);
    free(m->tool_name);
    free(m);
}

static sope_message *message_new(sope_msg_role role, const char *content, size_t len)
{
    sope_message *m = calloc(1, sizeof *m);
    if (!m) return NULL;
    m->role = role;
    m->content_len = len;
    if (!(m->content = sope__strndup(content ? content : "", len))) {
        free(m);
        return NULL;
    }
    return m;
}

static void history_append(sope_history *h, sope_message *m)
{
    if (h->tail)
        h->tail->next = m;
    else
        h->head = m;
    h->tail = m;
    h->count++;
}

void sope__history_clear(sope_history *h)
{
    while (h->head) {
        sope_message *m = h->head;
        h->head = m->next;
        message_free(m);
    }
    h->tail = NULL;
    h->count = 0;
}

static sope_message *tool_message(const sope_tool_use *u, const char *content, size_t len, int is_error)
{
    sope_message *m = message_new(SOPE__MSG_TOOL, content, len);
    if (!m) return NULL;
    m->is_error = is_error;
    if (!(m->tool_use_id = sope__strdup(u->id)) || !(m->tool_name = sope__strdup(u->name))) {
        message_free(m);
        return NULL;
    }
    return m;
}

/* A turn that ends early may leave tool uses unanswered, which providers
 * reject on the next request; answer them so the history stays valid. */
static void history_repair(sope_history *h)
{
    sope_message *asst = NULL, *m;
    size_t i;
    for (m = h->head; m; m = m->next)
        if (m->role == SOPE__MSG_ASSISTANT) asst = m;
    if (!asst || !asst->n_tool_uses) return;
    for (i = 0; i < asst->n_tool_uses; i++) {
        const sope_tool_use *u = &asst->tool_uses[i];
        int answered = 0;
        for (m = asst->next; m; m = m->next)
            if (m->role == SOPE__MSG_TOOL && !strcmp(m->tool_use_id, u->id)) answered = 1;
        if (!answered && (m = tool_message(u, "cancelled", 9, 1))) history_append(h, m);
    }
}

/* ------------------------------------------------------------------------ */
/* turn setup and teardown                                                   */
/* ------------------------------------------------------------------------ */

static void free_specs(turn_state *t)
{
    size_t i;
    for (i = 0; i < t->n_specs; i++) {
        free((char *)t->specs[i].name);
        free((char *)t->specs[i].description);
        free((char *)t->specs[i].input_schema);
    }
    free(t->specs);
    free(t->spec_builtin);
    t->specs = NULL;
    t->spec_builtin = NULL;
    t->n_specs = 0;
}

static int add_spec(turn_state *t, const char *name, const char *description, const char *schema)
{
    sope_tool_spec *s = &t->specs[t->n_specs];
    s->name = sope__strdup(name);
    s->description = sope__strdup(description);
    s->input_schema = sope__strdup(schema);
    t->n_specs++;
    return s->name && s->description && s->input_schema;
}

/* Describes the subagent types to the model; *mu held. */
static int add_agent_spec_locked(sope_agent_t *a)
{
    sope_buf desc = { 0 }, schema = { 0 };
    subagent_def *d;
    int ok;

    sope__buf_appends(&desc,
                      "Launch a subagent to handle a complex, multi-step task autonomously in its own context.\n\n"
                      "Available agent types:\n");
    for (d = a->root->subagents; d; d = d->next) sope__buf_appendf(&desc, "- %s: %s\n", d->name, d->description);
    sope__buf_appends(&desc,
                      "\nUsage notes:\n"
                      "- Launch several agents concurrently whenever possible, using multiple agent tool calls in "
                      "one response.\n"
                      "- The subagent cannot see this conversation: give it a complete, self-contained task.\n"
                      "- Its final report comes back to you as the tool result and is not shown to the user, so "
                      "summarize what matters.");

    sope__buf_appends(&schema,
                      "{\"type\":\"object\",\"properties\":{"
                      "\"description\":{\"type\":\"string\",\"description\":\"A short (3-5 word) description of the "
                      "task\"},"
                      "\"prompt\":{\"type\":\"string\",\"description\":\"The task for the agent to perform\"},"
                      "\"subagent_type\":{\"type\":\"string\",\"description\":\"The type of agent to use; defaults "
                      "to general-purpose\",\"enum\":[");
    for (d = a->root->subagents; d; d = d->next) {
        sope__buf_append_json_string(&schema, d->name, strlen(d->name));
        if (d->next) sope__buf_appends(&schema, ",");
    }
    sope__buf_appends(&schema, "]}},\"required\":[\"description\",\"prompt\"]}");

    ok = !desc.oom && !schema.oom && add_spec(&a->turn, AGENT_TOOL, desc.ptr, schema.ptr);
    sope__buf_free(&desc);
    sope__buf_free(&schema);
    return ok;
}

/* Subagents see only the tools their type lists. */
static int filter_allows(const sope_agent_t *a, const char *name)
{
    size_t i;
    if (!a->tool_filter) return 1;
    for (i = 0; i < a->n_tool_filter; i++)
        if (!strcmp(a->tool_filter[i], name) || !strcmp(a->tool_filter[i], "*")) return 1;
    return 0;
}

/* Offers the built-in tools that no host tool replaces; *mu held. */
static int add_builtin_specs_locked(sope_agent_t *a)
{
    turn_state *t = &a->turn;
    size_t i;
    for (i = 0; i < sope__builtin_count(); i++) {
        const sope_builtin *b = sope__builtin_at(i);
        const tool_def *td;
        int replaced = 0;
        for (td = a->tools; td; td = td->next)
            if (!strcmp(td->name, b->name)) replaced = 1;
        if (replaced || !filter_allows(a, b->name)) continue;
        t->spec_builtin[t->n_specs] = b;
        if (!add_spec(t, b->name, b->description, b->schema)) return 0;
    }
    return 1;
}

static char *working_dir(const char *option)
{
    char buf[PATH_MAX];
    if (option && *option) return sope__strdup(option);
    return sope__strdup(getcwd(buf, sizeof buf) ? buf : "/");
}

static const sope_provider *find_provider(const char *name)
{
    size_t i;
    for (i = 0; i < sizeof providers / sizeof providers[0]; i++)
        if (!strcmp(providers[i]->name, name)) return providers[i];
    return NULL;
}

static void finish_turn(sope_agent_t *a, int32_t stop);

/* Takes the next queued message and prepares the turn. Returns 0 if none. */
static int begin_turn(sope_agent_t *a)
{
    turn_state *t = &a->turn;
    msg_node *m;
    char *provider = NULL, *rounds = NULL, *subagents = NULL, *threshold = NULL, *cwd = NULL, *permissions = NULL;
    size_t n_tools = 0;
    tool_def *td;
    int reset, ok = 1, offer_agent;
    sope_message *user;

    pthread_mutex_lock(a->mu);
    m = a->in_head;
    if (!m) {
        pthread_mutex_unlock(a->mu);
        return 0;
    }
    a->in_head = m->next;
    if (!a->in_head) a->in_tail = NULL;
    a->active_turn = m->turn_id;
    a->cancel_requested = 0;
    reset = a->reset_requested;
    a->reset_requested = 0;

    memset(t, 0, sizeof *t);
    t->active = 1;
    t->msg = m;
    t->phase = PHASE_START;
    provider = sope__option_dup_locked(a, "provider");
    rounds = sope__option_dup_locked(a, "max_rounds");
    subagents = sope__option_dup_locked(a, "subagents");
    threshold = sope__option_dup_locked(a, "compact.threshold");
    cwd = sope__option_dup_locked(a, "cwd");
    permissions = sope__option_dup_locked(a, "permissions");
    t->system = sope__option_dup_locked(a, "system");

    offer_agent = a->parent == NULL && a->root->subagents && !(subagents && !strcmp(subagents, "off"));
    for (td = a->tools; td; td = td->next) n_tools++;
    n_tools += sope__builtin_count() + 1; /* + agent */
    t->specs = calloc(n_tools, sizeof *t->specs);
    t->spec_builtin = calloc(n_tools, sizeof *t->spec_builtin);
    if (!t->specs || !t->spec_builtin) ok = 0;
    for (td = a->tools; ok && td; td = td->next) ok = add_spec(t, td->name, td->description, td->input_schema);
    if (ok) ok = add_builtin_specs_locked(a);
    if (ok && offer_agent) ok = add_agent_spec_locked(a);
    pthread_mutex_unlock(a->mu);

    t->permit = permissions && !strcmp(permissions, "allow")  ? PERMIT_ALLOW
                : permissions && !strcmp(permissions, "deny") ? PERMIT_DENY
                                                               : PERMIT_ASK;
    if (ok) ok = (t->cwd = working_dir(cwd)) != NULL;

    sope__push_event(a, SOPE_EVENT_TURN_START, m->turn_id, 0, 0, NULL, 0, NULL, 0);
    if (reset) {
        sope__history_clear(&a->history);
        sope__files_clear(a);
        a->context_tokens = 0;
    }

    t->max_rounds = rounds ? (int32_t)strtol(rounds, NULL, 10) : DEFAULT_MAX_ROUNDS;
    if (t->max_rounds <= 0) t->max_rounds = DEFAULT_MAX_ROUNDS;
    t->compact_threshold = threshold ? strtoull(threshold, NULL, 10) : 0;
    t->provider = find_provider(provider ? provider : "mock");
    if (!t->system && ok) ok = (t->system = sope__strdup(DEFAULT_SYSTEM)) != NULL;

    user = ok && !m->compact ? message_new(SOPE__MSG_USER, m->text, m->len) : NULL;
    if (!ok || (!m->compact && !user)) {
        sope__push_event(a, SOPE_EVENT_ERROR, m->turn_id, 0, SOPE_ENOMEM, NULL, 0, "out of memory", 13);
        finish_turn(a, SOPE_STOP_ERROR);
    } else {
        if (user) history_append(&a->history, user);
        if (!t->provider) {
            char msg[128];
            int n = snprintf(msg, sizeof msg, "unknown provider '%s'", provider);
            sope__push_event(a, SOPE_EVENT_ERROR, m->turn_id, 0, SOPE_ENOTFOUND, NULL, 0, msg, (size_t)n);
            finish_turn(a, SOPE_STOP_ERROR);
        }
    }
    free(provider);
    free(rounds);
    free(subagents);
    free(threshold);
    free(cwd);
    free(permissions);
    return 1;
}

static void call_free(sope_call *c)
{
    if (!c) return;
    sope__history_clear(&c->request);
    sope__buf_free(&c->text);
    tool_uses_free(c->uses, c->n_uses);
    free(c);
}

static void pending_free(pending_call *p)
{
    sope__tool_run_discard(p->run); /* still waiting for sope_permit */
    free(p->name);
    free(p->content);
    free(p);
}

/* Removes the pending calls of agent `a`, ending the tool calls the host
 * still sees as open; *mu held. */
static void drop_pending_locked(sope_agent_t *a)
{
    pending_call **pp = &a->root->pending;
    while (*pp) {
        pending_call *p = *pp;
        if (p->owner == a) {
            *pp = p->next;
            if (!p->done && p->kind != PENDING_SUBAGENT)
                sope__push_event_locked(a, SOPE_EVENT_TOOL_END, p->turn_id, p->call_id, 1, p->name, strlen(p->name),
                                        "Cancelled.", 10);
            pending_free(p);
        } else {
            pp = &p->next;
        }
    }
}

static void finish_turn(sope_agent_t *a, int32_t stop)
{
    turn_state *t = &a->turn;
    uint64_t id = turn_id(a);

    if (t->call) {
        if (t->call->state) t->provider->finish(t->call->state);
        call_free(t->call);
    }
    if (t->held) history_append(&a->history, t->held); /* cancelled while compacting */
    if (stop != SOPE_STOP_END_TURN) history_repair(&a->history);

    pthread_mutex_lock(a->mu);
    drop_pending_locked(a); /* late sope_tool_result calls now get ENOTFOUND */
    a->active_turn = 0;
    a->cancel_requested = 0;
    pthread_mutex_unlock(a->mu);

    free_specs(t);
    free(t->system);
    free(t->cwd);
    free(t->msg->text);
    free(t->msg);
    memset(t, 0, sizeof *t);
    a->last_stop = stop;
    a->turns_finished++;
    sope__push_event(a, SOPE_EVENT_TURN_END, id, 0, stop, NULL, 0, NULL, 0);
}

/* ------------------------------------------------------------------------ */
/* subagents                                                                 */
/* ------------------------------------------------------------------------ */

static void child_closed(sope_task *task);

static const sope_message *last_assistant(const sope_history *h)
{
    const sope_message *m, *last = NULL;
    for (m = h->head; m; m = m->next)
        if (m->role == SOPE__MSG_ASSISTANT) last = m;
    return last;
}

static int copy_options_locked(sope_agent_t *dst, const sope_agent_t *src)
{
    const option_kv *kv;
    for (kv = src->options; kv; kv = kv->next) {
        option_kv *c = calloc(1, sizeof *c);
        if (!c || !(c->key = sope__strdup(kv->key)) || !(c->value = sope__strdup(kv->value))) {
            if (c) free(c->key);
            free(c);
            return 0;
        }
        c->next = dst->options;
        dst->options = c;
    }
    return 1;
}

static int set_child_option(sope_agent_t *child, const char *key, const char *value)
{
    option_kv *kv;
    for (kv = child->options; kv; kv = kv->next)
        if (!strcmp(kv->key, key)) break;
    if (!kv) {
        if (!(kv = calloc(1, sizeof *kv)) || !(kv->key = sope__strdup(key))) {
            free(kv);
            return 0;
        }
        kv->next = child->options;
        child->options = kv;
    }
    free(kv->value);
    return (kv->value = sope__strdup(value)) != NULL;
}

static int def_allows(const subagent_def *d, const char *tool)
{
    size_t i;
    if (!d->tools) return 1;
    for (i = 0; i < d->n_tools; i++)
        if (!strcmp(d->tools[i], tool) || !strcmp(d->tools[i], "*")) return 1;
    return 0;
}

/* Builds and starts a child for one `agent` tool use. On failure returns a
 * static error message for the tool result. */
static const char *spawn_subagent(sope_agent_t *a, const sope_tool_use *u)
{
    sope_json *input = sope__json_parse(u->input, u->input_len);
    const char *prompt = sope__json_string(sope__json_get(input, "prompt"), NULL);
    const char *type = sope__json_string(sope__json_get(input, "subagent_type"), NULL);
    const char *err = NULL;
    sope_agent_t *child = NULL;
    const subagent_def *d;
    const tool_def *td;
    tool_def **tail;
    char rounds[16], name[65];

    if (!prompt) {
        sope__json_free(input);
        return "invalid input: \"prompt\" (string) is required";
    }
    if (!type || !*type) type = "general-purpose";

    pthread_mutex_lock(a->mu);
    for (d = a->root->subagents; d; d = d->next)
        if (!strcmp(d->name, type)) break;
    if (!d) {
        err = "unknown subagent_type";
        goto unlock;
    }
    snprintf(name, sizeof name, "%s", d->name); /* d may be replaced once we unlock */
    if (!(child = calloc(1, sizeof *child)) || !copy_options_locked(child, a) ||
        !set_child_option(child, "system", d->system_prompt) || (d->model && !set_child_option(child, "model", d->model)))
        goto oom;
    if (d->max_rounds > 0) {
        snprintf(rounds, sizeof rounds, "%d", (int)d->max_rounds);
        if (!set_child_option(child, "max_rounds", rounds)) goto oom;
    }
    if (d->tools) {
        size_t i;
        if (!(child->tool_filter = calloc(d->n_tools ? d->n_tools : 1, sizeof *child->tool_filter))) goto oom;
        for (i = 0; i < d->n_tools; i++) {
            if (!(child->tool_filter[i] = sope__strdup(d->tools[i]))) goto oom;
            child->n_tool_filter++;
        }
    }
    tail = &child->tools;
    for (td = a->tools; td; td = td->next) {
        tool_def *c;
        if (!def_allows(d, td->name)) continue;
        if (!(c = calloc(1, sizeof *c))) goto oom;
        *tail = c;
        tail = &c->next;
        if (!(c->name = sope__strdup(td->name)) || !(c->description = sope__strdup(td->description)) ||
            !(c->input_schema = sope__strdup(td->input_schema)))
            goto oom;
    }
    if (!(child->in_head = calloc(1, sizeof *child->in_head)) ||
        !(child->in_head->text = sope__strdup(prompt)))
        goto oom;
    goto unlock;

oom:
    err = "out of memory";
unlock:
    pthread_mutex_unlock(a->mu);
    if (err) {
        if (child) sope__agent_free_memory(child); /* root is NULL: freed as an unattached child */
        sope__json_free(input);
        return err;
    }

    child->root = a->root;
    child->parent = a;
    child->mu = a->mu;
    child->agent_id = u->call_id;
    child->parent_turn_id = turn_id(a);
    child->in_head->turn_id = child->next_turn_id = 1;
    child->in_head->len = strlen(prompt);
    child->in_tail = child->in_head;
    sope__task_init(&child->task, sope__agent_run, child);
    child->task.on_closed = child_closed;
    sope__json_free(input);

    sope__pool_acquire(); /* cannot fail: the pool is running */
    sope__push_event(a, SOPE_EVENT_SUBAGENT_START, turn_id(a), u->call_id, 0, name, strlen(name), u->input,
                     u->input_len);
    pthread_mutex_lock(a->mu);
    child->sibling = a->children;
    a->children = child;
    pthread_mutex_unlock(a->mu);
    sope__task_wake(&child->task);
    return NULL;
}

/* Runs on a pool thread once a child closed: hands its final message to the
 * parent as the `agent` tool result, then frees the child. */
static void child_closed(sope_task *task)
{
    sope_agent_t *child = task->owner, *parent = child->parent, **pp;
    const sope_message *last = last_assistant(&child->history);
    int32_t stop = child->turns_finished ? child->last_stop : SOPE_STOP_CANCELLED;
    sope_buf result = { 0 };
    pending_call *p;

    if (stop != SOPE_STOP_END_TURN)
        sope__buf_appends(&result, stop == SOPE_STOP_CANCELLED ? "Subagent was cancelled." : "Subagent failed.");
    if (last && last->content_len) {
        if (result.len) sope__buf_appends(&result, " Partial output:\n");
        sope__buf_append(&result, last->content, last->content_len);
    }
    if (!result.len) sope__buf_appends(&result, "(no output)");

    sope__push_event(parent, SOPE_EVENT_SUBAGENT_END, child->parent_turn_id, child->agent_id, stop, NULL, 0,
                     result.oom ? "" : result.ptr, result.oom ? 0 : result.len);

    pthread_mutex_lock(child->mu);
    for (p = child->root->pending; p; p = p->next)
        if (p->call_id == child->agent_id && p->kind == PENDING_SUBAGENT) break;
    if (p && !result.oom) {
        p->content = result.ptr; /* ownership moves to the pending entry */
        p->len = result.len;
        result.ptr = NULL;
    }
    if (p) {
        p->is_error = stop != SOPE_STOP_END_TURN || result.oom;
        p->done = 1;
    }
    for (pp = &parent->children; *pp; pp = &(*pp)->sibling)
        if (*pp == child) {
            *pp = child->sibling;
            break;
        }
    sope__task_wake(&parent->task);
    pthread_mutex_unlock(child->mu);

    sope__buf_free(&result);
    sope__agent_free_memory(child);
    sope__pool_release();
}

/* ------------------------------------------------------------------------ */
/* rounds                                                                    */
/* ------------------------------------------------------------------------ */

static void turn_error(sope_agent_t *a, int code, const char *msg)
{
    sope__push_event(a, SOPE_EVENT_ERROR, turn_id(a), 0, code, NULL, 0, msg, strlen(msg));
}

static sope_next start_compact(sope_agent_t *a);

static sope_next start_call(sope_agent_t *a)
{
    turn_state *t = &a->turn;
    sope_call *c;

    if (t->compact_threshold && a->context_tokens >= t->compact_threshold && !t->compact_tried)
        return start_compact(a);
    t->compact_tried = 0;

    if (++t->round > (uint64_t)t->max_rounds) {
        char msg[64];
        snprintf(msg, sizeof msg, "stopped after %d model rounds (max_rounds)", (int)t->max_rounds);
        turn_error(a, SOPE_ERROR, msg);
        finish_turn(a, SOPE_STOP_ERROR);
        return next(SOPE__NEXT_CONTINUE);
    }
    if (!(c = calloc(1, sizeof *c))) {
        turn_error(a, SOPE_ENOMEM, "out of memory");
        finish_turn(a, SOPE_STOP_ERROR);
        return next(SOPE__NEXT_CONTINUE);
    }
    c->agent = a;
    c->round = t->round;
    t->call = c;
    t->phase = PHASE_CALL;
    if (!(c->state = t->provider->start(c))) {
        if (!c->failed) turn_error(a, SOPE_ERROR, "provider failed to start");
        finish_turn(a, SOPE_STOP_ERROR);
    }
    return next(SOPE__NEXT_CONTINUE);
}

/* The model call finished: record the assistant message and dispatch its tool uses. */
static sope_next end_call(sope_agent_t *a, int32_t rc)
{
    turn_state *t = &a->turn;
    sope_call *c = t->call;
    sope_message *asst;
    size_t i;

    t->provider->finish(c->state);
    c->state = NULL;
    if (rc != SOPE_OK || c->failed) {
        if (!c->failed) turn_error(a, rc, sope_strerror(rc));
        finish_turn(a, SOPE_STOP_ERROR);
        return next(SOPE__NEXT_CONTINUE);
    }

    if (!(asst = message_new(SOPE__MSG_ASSISTANT, c->text.ptr, c->text.len))) {
        turn_error(a, SOPE_ENOMEM, "out of memory");
        finish_turn(a, SOPE_STOP_ERROR);
        return next(SOPE__NEXT_CONTINUE);
    }
    asst->tool_uses = c->uses;
    asst->n_tool_uses = c->n_uses;
    c->uses = NULL;
    c->n_uses = 0;
    call_free(c);
    t->call = NULL;
    history_append(&a->history, asst);

    if (!asst->n_tool_uses) {
        finish_turn(a, SOPE_STOP_END_TURN);
        return next(SOPE__NEXT_CONTINUE);
    }

    t->asst = asst;
    t->phase = PHASE_TOOLS;
    for (i = 0; i < asst->n_tool_uses; i++) {
        sope_tool_use *u = &asst->tool_uses[i];
        pending_call *p = calloc(1, sizeof *p);
        const sope_builtin *builtin = NULL;
        const char *err = NULL;
        char denied[256];
        int offered = 0, is_agent;
        size_t k;

        /* Models sometimes call tools they were not offered; answer those
         * ourselves instead of bothering the host. */
        for (k = 0; k < t->n_specs; k++)
            if (!strcmp(t->specs[k].name, u->name)) {
                offered = 1;
                builtin = t->spec_builtin[k];
            }
        is_agent = offered && !strcmp(u->name, AGENT_TOOL);

        pthread_mutex_lock(a->mu);
        u->call_id = ++a->root->next_call_id;
        if (p && (p->name = sope__strdup(u->name))) {
            p->call_id = u->call_id;
            p->turn_id = turn_id(a);
            p->owner = a;
            p->kind = is_agent ? PENDING_SUBAGENT : builtin ? PENDING_BUILTIN : PENDING_TOOL;
            p->next = a->root->pending;
            a->root->pending = p;
        } else if (p) {
            free(p);
            p = NULL;
        }
        pthread_mutex_unlock(a->mu);
        if (!p) {
            turn_error(a, SOPE_ENOMEM, "out of memory");
            finish_turn(a, SOPE_STOP_ERROR);
            return next(SOPE__NEXT_CONTINUE);
        }

        if (!*u->id) { /* some providers omit ids; they are needed to pair results */
            char id[32];
            snprintf(id, sizeof id, "call_%" PRIu64, u->call_id);
            free(u->id);
            u->id = sope__strdup(id);
        }

        if (!offered) {
            err = "no such tool is available";
        } else if (is_agent) {
            err = spawn_subagent(a, u);
        } else if (builtin) {
            tool_run *r;
            sope__push_event(a, SOPE_EVENT_TOOL_START, turn_id(a), u->call_id, 0, u->name, strlen(u->name), u->input,
                             u->input_len);
            if (!(r = sope__tool_run_new(a, builtin, u->call_id, u->input, u->input_len))) {
                err = "out of memory";
            } else if (!builtin->ask || t->permit == PERMIT_ALLOW) {
                sope__tool_run_start(r);
            } else if (t->permit == PERMIT_DENY) {
                sope__tool_run_discard(r);
                snprintf(denied, sizeof denied,
                         "%s is not allowed here (the host runs this agent with permissions=deny). Tell the user "
                         "what you would do instead.",
                         u->name);
                err = denied;
            } else {
                pthread_mutex_lock(a->mu);
                p->run = r; /* sope_permit starts or discards it */
                pthread_mutex_unlock(a->mu);
                sope__push_event(a, SOPE_EVENT_PERMISSION, turn_id(a), u->call_id, 0, u->name, strlen(u->name),
                                 u->input, u->input_len);
            }
            if (err) /* it was announced, so it ends like every built-in call */
                sope__push_event(a, SOPE_EVENT_TOOL_END, turn_id(a), u->call_id, 1, u->name, strlen(u->name), err,
                                 strlen(err));
        } else {
            sope__push_event(a, SOPE_EVENT_TOOL_CALL, turn_id(a), u->call_id, 0, u->name, strlen(u->name), u->input,
                             u->input_len);
        }
        if (err) { /* answer the model directly: it can fix its input and retry */
            pthread_mutex_lock(a->mu);
            p->content = sope__strdup(err);
            p->len = p->content ? strlen(err) : 0;
            p->is_error = 1;
            p->done = 1;
            pthread_mutex_unlock(a->mu);
        }
    }
    return next(SOPE__NEXT_CONTINUE);
}

/* Waits for every tool use of the last call, then feeds the results back. */
static sope_next collect_tools(sope_agent_t *a)
{
    turn_state *t = &a->turn;
    sope_message *asst = t->asst;
    pending_call *p;
    size_t i;

    pthread_mutex_lock(a->mu);
    for (i = 0; i < asst->n_tool_uses; i++) {
        for (p = a->root->pending; p; p = p->next)
            if (p->call_id == asst->tool_uses[i].call_id) break;
        if (p && !p->done) {
            pthread_mutex_unlock(a->mu);
            return next(SOPE__NEXT_WAIT);
        }
    }
    for (i = 0; i < asst->n_tool_uses; i++) {
        const sope_tool_use *u = &asst->tool_uses[i];
        pending_call **pp = &a->root->pending;
        sope_message *m;
        while (*pp && (*pp)->call_id != u->call_id) pp = &(*pp)->next;
        p = *pp;
        if (p) *pp = p->next;
        m = p ? tool_message(u, p->content ? p->content : "", p->len, p->is_error)
              : tool_message(u, "(no result)", 11, 1);
        if (m) history_append(&a->history, m);
        if (p) pending_free(p);
    }
    pthread_mutex_unlock(a->mu);

    t->asst = NULL;
    return start_call(a);
}


/* ------------------------------------------------------------------------ */
/* compaction                                                                */
/* ------------------------------------------------------------------------ */

static sope_next start_compact(sope_agent_t *a)
{
    turn_state *t = &a->turn;
    msg_node *m = t->msg;
    sope_message *req = NULL;
    sope_call *c;
    char *text;
    size_t len;

    t->compact_tried = 1;
    if (!a->history.count) { /* sope_compact on an empty conversation */
        finish_turn(a, SOPE_STOP_END_TURN);
        return next(SOPE__NEXT_CONTINUE);
    }
    if (!m->compact && t->round == 0 && a->history.count > 1) {
        /* Compacting before the turn's first call: summarize what came
         * before and keep the new request verbatim after the summary. */
        sope_message **pp = &a->history.head;
        while ((*pp)->next) pp = &(*pp)->next;
        t->held = *pp;
        *pp = NULL;
        a->history.count--;
        for (a->history.tail = a->history.head; a->history.tail->next;) a->history.tail = a->history.tail->next;
    }
    text = sope__compact_request(&a->history, m->compact ? m->text : NULL, m->compact ? m->len : 0, &len);
    if (text) req = message_new(SOPE__MSG_USER, text, len);
    free(text);
    if (!req || !(c = calloc(1, sizeof *c))) {
        message_free(req);
        turn_error(a, SOPE_ENOMEM, "out of memory");
        finish_turn(a, SOPE_STOP_ERROR);
        return next(SOPE__NEXT_CONTINUE);
    }
    c->agent = a;
    c->round = t->round;
    c->compaction = 1;
    history_append(&c->request, req);
    t->call = c;
    t->phase = PHASE_COMPACT;
    sope__push_event(a, SOPE_EVENT_LOG, turn_id(a), 0, SOPE_LOG_INFO, NULL, 0, "compacting the conversation",
                     strlen("compacting the conversation"));
    if (!(c->state = t->provider->start(c))) {
        if (!c->failed) turn_error(a, SOPE_ERROR, "provider failed to start");
        call_free(c);
        t->call = NULL;
        if (t->held) history_append(&a->history, t->held);
        t->held = NULL;
        if (m->compact) {
            finish_turn(a, SOPE_STOP_ERROR);
            return next(SOPE__NEXT_CONTINUE);
        }
        return start_call(a); /* carry on uncompacted; the call itself may still fit */
    }
    return next(SOPE__NEXT_CONTINUE);
}

/* The summary is in: it replaces the history. */
static sope_next end_compact(sope_agent_t *a, int32_t rc)
{
    turn_state *t = &a->turn;
    sope_call *c = t->call;
    int manual = t->msg->compact, ok;
    sope_message *summary = NULL;
    char *text = NULL;
    size_t len = 0;

    t->provider->finish(c->state);
    c->state = NULL;
    ok = rc == SOPE_OK && !c->failed;
    if (ok && !c->text.len) {
        turn_error(a, SOPE_ERROR, "compaction failed: the model returned an empty summary");
        ok = 0;
    } else if (!ok && !c->failed) {
        turn_error(a, rc, sope_strerror(rc));
    }
    if (ok) {
        text = sope__compact_summary(c->text.ptr, c->text.len, !manual && !t->held, &len);
        if (!text || !(summary = message_new(SOPE__MSG_USER, text, len))) {
            turn_error(a, SOPE_ENOMEM, "out of memory");
            ok = 0;
        }
    }
    if (ok) {
        sope__history_clear(&a->history);
        history_append(&a->history, summary);
    }
    if (t->held) history_append(&a->history, t->held);
    t->held = NULL;
    if (ok) {
        a->context_tokens = len / 4; /* rough until the next call reports usage */
        sope__push_event(a, SOPE_EVENT_COMPACT, turn_id(a), 0, 0, manual ? "manual" : "auto",
                         manual ? 6 : 4, c->text.ptr, c->text.len);
    }
    free(text);
    call_free(c);
    t->call = NULL;
    t->phase = PHASE_START;

    if (manual) {
        finish_turn(a, ok ? SOPE_STOP_END_TURN : SOPE_STOP_ERROR);
        return next(SOPE__NEXT_CONTINUE);
    }
    return start_call(a);
}

static sope_next step_turn(sope_agent_t *a)
{
    turn_state *t = &a->turn;
    sope_step s;

    switch (t->phase) {
    case PHASE_START: return t->msg->compact ? start_compact(a) : start_call(a);
    case PHASE_TOOLS: return collect_tools(a);
    case PHASE_CALL:
    case PHASE_COMPACT: break;
    }
    s = t->provider->step(t->call, t->call->state);
    switch (s.kind) {
    case SOPE__STEP_CONTINUE: return next(SOPE__NEXT_CONTINUE);
    case SOPE__STEP_SLEEP: return (sope_next){ SOPE__NEXT_SLEEP, s.value };
    case SOPE__STEP_WAIT: return next(SOPE__NEXT_WAIT);
    case SOPE__STEP_DONE: break;
    }
    return t->phase == PHASE_COMPACT ? end_compact(a, s.value) : end_call(a, s.value);
}

/* The turn was cancelled or the agent is closing: stop subagents and
 * running tools first, so that all of a turn's events precede its TURN_END. */
static sope_next abort_turn(sope_agent_t *a)
{
    sope_agent_t *c;
    tool_run *r;
    int waiting;

    if (a->turn.call) {
        if (a->turn.call->state) a->turn.provider->finish(a->turn.call->state);
        call_free(a->turn.call);
        a->turn.call = NULL;
    }
    pthread_mutex_lock(a->mu);
    for (c = a->children; c; c = c->sibling) {
        c->closing = 1;
        if (c->active_turn) c->cancel_requested = 1;
        sope__task_wake(&c->task);
    }
    for (r = a->runs; r; r = r->next) {
        r->cancel = 1;
        sope__task_wake(&r->task);
    }
    waiting = a->children != NULL || a->runs != NULL;
    pthread_mutex_unlock(a->mu);
    if (waiting) return next(SOPE__NEXT_WAIT); /* child_closed and finished runs wake us */

    finish_turn(a, SOPE_STOP_CANCELLED);
    return next(SOPE__NEXT_CONTINUE);
}

/* Ends every queued turn and marks the agent closed. */
static sope_next close_agent(sope_agent_t *a)
{
    msg_node *dropped;

    pthread_mutex_lock(a->mu);
    dropped = a->in_head;
    a->in_head = a->in_tail = NULL;
    pthread_mutex_unlock(a->mu);

    while (dropped) {
        msg_node *n = dropped->next;
        sope__push_event(a, SOPE_EVENT_TURN_END, dropped->turn_id, 0, SOPE_STOP_CANCELLED, NULL, 0, NULL, 0);
        free(dropped->text);
        free(dropped);
        dropped = n;
    }

    pthread_mutex_lock(a->mu);
    a->closed = 1;
    if (a->root == a) sope__signal_closed_locked(a);
    pthread_mutex_unlock(a->mu);
    return next(SOPE__NEXT_CLOSED);
}

sope_next sope__agent_run(sope_task *task)
{
    sope_agent_t *a = task->owner;
    int closing, stopped;

    pthread_mutex_lock(a->mu);
    closing = a->closing;
    stopped = closing || a->cancel_requested;
    pthread_mutex_unlock(a->mu);

    if (a->turn.active) return stopped ? abort_turn(a) : step_turn(a);

    /* A subagent lives for exactly one turn. */
    if (closing || (a->parent && a->turns_finished > 0)) return close_agent(a);
    if (!begin_turn(a)) return next(SOPE__NEXT_WAIT);
    return next(SOPE__NEXT_CONTINUE);
}

/* ------------------------------------------------------------------------ */
/* sope_call: the provider's view of a model call                            */
/* ------------------------------------------------------------------------ */

const sope_history *sope__call_history(sope_call *c)
{
    return c->compaction ? &c->request : &c->agent->history;
}

const char *sope__call_system(sope_call *c)
{
    return c->compaction ? sope__compact_system : c->agent->turn.system;
}

size_t sope__call_tool_count(sope_call *c)
{
    return c->compaction ? 0 : c->agent->turn.n_specs;
}

const sope_tool_spec *sope__call_tool(sope_call *c, size_t i)
{
    return i < sope__call_tool_count(c) ? &c->agent->turn.specs[i] : NULL;
}

int sope__call_has_tool(sope_call *c, const char *name)
{
    size_t i;
    if (!c) return 0;
    for (i = 0; i < sope__call_tool_count(c); i++)
        if (!strcmp(c->agent->turn.specs[i].name, name)) return 1;
    return 0;
}

char *sope__call_option(sope_call *c, const char *key)
{
    char *v;
    pthread_mutex_lock(c->agent->mu);
    v = sope__option_dup_locked(c->agent, key);
    pthread_mutex_unlock(c->agent->mu);
    return v;
}

sope_task *sope__call_task(sope_call *c)
{
    return &c->agent->task;
}

uint64_t sope__call_round(sope_call *c)
{
    return c->round;
}

int sope__call_is_compaction(sope_call *c)
{
    return c->compaction;
}

void sope__call_text(sope_call *c, const char *s, size_t n)
{
    if (!n) return;
    sope__buf_append(&c->text, s, n);
    if (c->compaction) return; /* the summary is delivered with SOPE_EVENT_COMPACT */
    sope__push_event(c->agent, SOPE_EVENT_TEXT_DELTA, turn_id(c->agent), 0, 0, NULL, 0, s, n);
}

void sope__call_thinking(sope_call *c, const char *s, size_t n)
{
    if (!n || c->compaction) return;
    sope__push_event(c->agent, SOPE_EVENT_THINKING_DELTA, turn_id(c->agent), 0, 0, NULL, 0, s, n);
}

int sope__call_tool_use(sope_call *c, const char *id, const char *name, const char *input, size_t input_len)
{
    sope_tool_use *u;
    if (c->n_uses == c->cap_uses) {
        size_t cap = c->cap_uses ? c->cap_uses * 2 : 4;
        sope_tool_use *uses = realloc(c->uses, cap * sizeof *uses);
        if (!uses) return SOPE_ENOMEM;
        c->uses = uses;
        c->cap_uses = cap;
    }
    u = &c->uses[c->n_uses];
    memset(u, 0, sizeof *u);
    u->id = sope__strdup(id ? id : "");
    u->name = sope__strdup(name);
    u->input = sope__strndup(input_len ? input : "{}", input_len ? input_len : 2);
    u->input_len = input_len ? input_len : 2;
    if (!u->id || !u->name || !u->input) {
        free(u->id);
        free(u->name);
        free(u->input);
        return SOPE_ENOMEM;
    }
    c->n_uses++;
    return SOPE_OK;
}

void sope__call_usage(sope_call *c, uint64_t input_tokens, uint64_t output_tokens)
{
    char buf[96];
    int n = snprintf(buf, sizeof buf, "{\"input_tokens\":%" PRIu64 ",\"output_tokens\":%" PRIu64 "}", input_tokens,
                     output_tokens);
    if (!c->compaction) c->agent->context_tokens = input_tokens + output_tokens;
    sope__push_event(c->agent, SOPE_EVENT_USAGE, turn_id(c->agent), 0, 0, NULL, 0, buf, (size_t)n);
}

static void push_formatted(sope_call *c, uint32_t type, int32_t code, const char *fmt, va_list ap)
{
    char buf[2048];
    int n = vsnprintf(buf, sizeof buf, fmt, ap);
    if (n < 0) n = 0;
    if ((size_t)n >= sizeof buf) n = (int)sizeof buf - 1;
    sope__push_event(c->agent, type, turn_id(c->agent), 0, code, NULL, 0, buf, (size_t)n);
}

void sope__call_log(sope_call *c, int level, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    push_formatted(c, SOPE_EVENT_LOG, level, fmt, ap);
    va_end(ap);
}

void sope__call_error(sope_call *c, int code, const char *fmt, ...)
{
    va_list ap;
    c->failed = 1;
    va_start(ap, fmt);
    push_formatted(c, SOPE_EVENT_ERROR, code, fmt, ap);
    va_end(ap);
}
