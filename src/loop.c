/* SPDX-License-Identifier: MIT */
/*
 * loop.c - turn execution: the agent loop.
 *
 * A turn (one sope_send) runs as a state machine on the pool:
 *
 *   START ─▶ CALL ─(model wants tools)─▶ TOOLS ─(all results in)─▶ CALL ─▶ ...
 *              └──(no tool use)──▶ end_turn
 *
 * CALL streams one model call (call.c) through a provider; TOOLS waits for
 * the tool calls of that response: built-in tools (tools.c, each a task of
 * its own, maybe after the host's sope_permit), host tools
 * (sope_tool_result) and subagents (subagent.c). Each step returns instead
 * of blocking, so waiting costs no thread.
 *
 * COMPACT runs before a CALL once the last call reported more input tokens
 * than compact.threshold, or as the whole turn for sope_compact: one model
 * call summarizes the history (prompts in compact.c), and the summary
 * replaces it.
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

static const char DEFAULT_SYSTEM[] =
    "You are sope, a capable assistant embedded in a host application. Use the provided tools when they help. "
    "Be concise and accurate.";

static const sope_provider *const providers[] = { &sope__provider_mock, &sope__provider_openai };

static sope_next next(sope_next_kind kind)
{
    return (sope_next){ kind, 0 };
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

/* Offers `agent`, describing the subagent types; *mu held. */
static int add_agent_spec_locked(sope_agent_t *a)
{
    sope_buf desc = { 0 }, schema = { 0 };
    int ok = sope__subagent_spec_locked(a, &desc, &schema) && add_spec(&a->turn, SOPE__AGENT_TOOL, desc.ptr, schema.ptr);
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

    user = ok && !m->compact ? sope__message_new(SOPE__MSG_USER, m->text, m->len) : NULL;
    if (user) { /* the attached images move into the message */
        user->images = m->images;
        user->n_images = m->n_images;
        m->images = NULL;
        m->n_images = 0;
    }
    if (!ok || (!m->compact && !user)) {
        sope__push_event(a, SOPE_EVENT_ERROR, m->turn_id, 0, SOPE_ENOMEM, NULL, 0, "out of memory", 13);
        finish_turn(a, SOPE_STOP_ERROR);
    } else {
        if (user) sope__history_append(&a->history, user);
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
            sope__pending_free(p);
        } else {
            pp = &p->next;
        }
    }
}

static void finish_turn(sope_agent_t *a, int32_t stop)
{
    turn_state *t = &a->turn;
    uint64_t id = sope__turn_id(a);

    if (t->call) {
        if (t->call->state) t->provider->finish(t->call->state);
        sope__call_free(t->call);
    }
    if (t->held) sope__history_append(&a->history, t->held); /* cancelled while compacting */
    if (stop != SOPE_STOP_END_TURN) sope__history_repair(&a->history);

    pthread_mutex_lock(a->mu);
    drop_pending_locked(a); /* late sope_tool_result calls now get ENOTFOUND */
    a->active_turn = 0;
    a->cancel_requested = 0;
    pthread_mutex_unlock(a->mu);

    free_specs(t);
    free(t->system);
    free(t->cwd);
    sope__msg_node_free(t->msg);
    memset(t, 0, sizeof *t);
    a->last_stop = stop;
    a->turns_finished++;
    sope__push_event(a, SOPE_EVENT_TURN_END, id, 0, stop, NULL, 0, NULL, 0);
}

/* ------------------------------------------------------------------------ */
/* rounds                                                                    */
/* ------------------------------------------------------------------------ */

static void turn_error(sope_agent_t *a, int code, const char *msg)
{
    sope__push_event(a, SOPE_EVENT_ERROR, sope__turn_id(a), 0, code, NULL, 0, msg, strlen(msg));
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
    if (!(c = sope__call_new(a, t->round, 0))) {
        turn_error(a, SOPE_ENOMEM, "out of memory");
        finish_turn(a, SOPE_STOP_ERROR);
        return next(SOPE__NEXT_CONTINUE);
    }
    t->call = c;
    t->phase = PHASE_CALL;
    if (!(c->state = t->provider->start(c))) {
        if (!c->failed) turn_error(a, SOPE_ERROR, "provider failed to start");
        finish_turn(a, SOPE_STOP_ERROR);
    }
    return next(SOPE__NEXT_CONTINUE);
}

/* Runs built-in call u, or asks the host first (p->run waits for
 * sope_permit). Returns NULL, or why it did not run (in `why` if not static). */
static const char *start_builtin(sope_agent_t *a, pending_call *p, const sope_tool_use *u, const sope_builtin *b,
                                 char *why, size_t cap)
{
    permit_mode permit = a->turn.permit;
    tool_run *r = sope__tool_run_new(a, b, u->call_id, u->input, u->input_len);

    if (!r) return "out of memory";
    if (!b->ask || permit == PERMIT_ALLOW) {
        sope__tool_run_start(r);
    } else if (permit == PERMIT_DENY) {
        sope__tool_run_discard(r);
        snprintf(why, cap,
                 "%s is not allowed here (the host runs this agent with permissions=deny). Tell the user what you "
                 "would do instead.",
                 u->name);
        return why;
    } else {
        pthread_mutex_lock(a->mu);
        p->run = r; /* sope_permit starts or discards it */
        pthread_mutex_unlock(a->mu);
        sope__push_event(a, SOPE_EVENT_PERMISSION, sope__turn_id(a), u->call_id, 0, u->name, strlen(u->name),
                         u->input, u->input_len);
    }
    return NULL;
}

/* Sets one tool use of the model's response going, as a pending call the
 * turn waits for: a built-in runs as a task, `agent` spawns a subagent, a
 * host tool goes to the host (SOPE_EVENT_TOOL_CALL). Returns 0 on out of
 * memory. */
static int dispatch(sope_agent_t *a, sope_tool_use *u)
{
    turn_state *t = &a->turn;
    pending_call *p = calloc(1, sizeof *p);
    const sope_builtin *builtin = NULL;
    const char *err = NULL;
    char why[256];
    int offered = 0, is_agent;
    size_t k;

    /* Models sometimes call tools they were not offered; answer those
     * ourselves instead of bothering the host. */
    for (k = 0; k < t->n_specs; k++)
        if (!strcmp(t->specs[k].name, u->name)) {
            offered = 1;
            builtin = t->spec_builtin[k];
        }
    is_agent = offered && !strcmp(u->name, SOPE__AGENT_TOOL);

    pthread_mutex_lock(a->mu);
    u->call_id = ++a->root->next_call_id;
    if (p && (p->name = sope__strdup(u->name))) {
        p->call_id = u->call_id;
        p->turn_id = sope__turn_id(a);
        p->owner = a;
        p->kind = is_agent ? PENDING_SUBAGENT : builtin ? PENDING_BUILTIN : PENDING_TOOL;
        p->next = a->root->pending;
        a->root->pending = p;
    } else if (p) {
        free(p);
        p = NULL;
    }
    pthread_mutex_unlock(a->mu);
    if (!p) return 0;

    if (!*u->id) { /* some providers omit ids; they are needed to pair results */
        char id[32];
        snprintf(id, sizeof id, "call_%" PRIu64, u->call_id);
        free(u->id);
        u->id = sope__strdup(id);
    }

    if (!offered) {
        err = "no such tool is available";
    } else if (is_agent) {
        err = sope__subagent_spawn(a, u);
    } else if (builtin) {
        sope__push_event(a, SOPE_EVENT_TOOL_START, sope__turn_id(a), u->call_id, 0, u->name, strlen(u->name),
                         u->input, u->input_len);
        if ((err = start_builtin(a, p, u, builtin, why, sizeof why))) /* announced: it ends like every built-in */
            sope__push_event(a, SOPE_EVENT_TOOL_END, sope__turn_id(a), u->call_id, 1, u->name, strlen(u->name), err,
                             strlen(err));
    } else {
        sope__push_event(a, SOPE_EVENT_TOOL_CALL, sope__turn_id(a), u->call_id, 0, u->name, strlen(u->name),
                         u->input, u->input_len);
    }
    if (err) { /* answer the model directly: it can fix its input and retry */
        pthread_mutex_lock(a->mu);
        p->content = sope__strdup(err);
        p->len = p->content ? strlen(err) : 0;
        p->is_error = 1;
        p->done = 1;
        pthread_mutex_unlock(a->mu);
    }
    return 1;
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

    if (!(asst = sope__message_new(SOPE__MSG_ASSISTANT, c->text.ptr, c->text.len))) {
        turn_error(a, SOPE_ENOMEM, "out of memory");
        finish_turn(a, SOPE_STOP_ERROR);
        return next(SOPE__NEXT_CONTINUE);
    }
    asst->tool_uses = c->uses;
    asst->n_tool_uses = c->n_uses;
    c->uses = NULL;
    c->n_uses = 0;
    sope__call_free(c);
    t->call = NULL;
    sope__history_append(&a->history, asst);

    if (!asst->n_tool_uses) {
        finish_turn(a, SOPE_STOP_END_TURN);
        return next(SOPE__NEXT_CONTINUE);
    }

    t->asst = asst;
    t->phase = PHASE_TOOLS;
    for (i = 0; i < asst->n_tool_uses; i++)
        if (!dispatch(a, &asst->tool_uses[i])) {
            turn_error(a, SOPE_ENOMEM, "out of memory");
            finish_turn(a, SOPE_STOP_ERROR);
            return next(SOPE__NEXT_CONTINUE);
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
        m = p ? sope__tool_message(u, p->content ? p->content : "", p->len, p->is_error)
              : sope__tool_message(u, "(no result)", 11, 1);
        if (m && p && p->n_images) {
            m->images = p->images;
            m->n_images = p->n_images;
            p->images = NULL;
            p->n_images = 0;
        }
        if (m) sope__history_append(&a->history, m);
        if (p) sope__pending_free(p);
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
        t->held = sope__history_pop(&a->history);
    }
    text = sope__compact_request(&a->history, m->compact ? m->text : NULL, m->compact ? m->len : 0, &len);
    if (text) req = sope__message_new(SOPE__MSG_USER, text, len);
    free(text);
    if (!req || !(c = sope__call_new(a, t->round, 1))) {
        sope__message_free(req);
        turn_error(a, SOPE_ENOMEM, "out of memory");
        finish_turn(a, SOPE_STOP_ERROR);
        return next(SOPE__NEXT_CONTINUE);
    }
    sope__history_append(&c->request, req);
    t->call = c;
    t->phase = PHASE_COMPACT;
    sope__push_event(a, SOPE_EVENT_LOG, sope__turn_id(a), 0, SOPE_LOG_INFO, NULL, 0, "compacting the conversation",
                     strlen("compacting the conversation"));
    if (!(c->state = t->provider->start(c))) {
        if (!c->failed) turn_error(a, SOPE_ERROR, "provider failed to start");
        sope__call_free(c);
        t->call = NULL;
        if (t->held) sope__history_append(&a->history, t->held);
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
        if (!text || !(summary = sope__message_new(SOPE__MSG_USER, text, len))) {
            turn_error(a, SOPE_ENOMEM, "out of memory");
            ok = 0;
        }
    }
    if (ok) {
        sope__history_clear(&a->history);
        sope__history_append(&a->history, summary);
    }
    if (t->held) sope__history_append(&a->history, t->held);
    t->held = NULL;
    if (ok) {
        a->context_tokens = len / 4; /* rough until the next call reports usage */
        sope__push_event(a, SOPE_EVENT_COMPACT, sope__turn_id(a), 0, 0, manual ? "manual" : "auto",
                         manual ? 6 : 4, c->text.ptr, c->text.len);
    }
    free(text);
    sope__call_free(c);
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
        sope__call_free(a->turn.call);
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
        sope__msg_node_free(dropped);
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
