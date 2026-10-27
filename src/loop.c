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
 * COMPACT runs before a CALL when the full request reaches its budget,
 * or as the whole turn for sope_compact. A complete summary replaces the
 * older prefix; a budgeted recent suffix stays verbatim.
 */
#define _POSIX_C_SOURCE 200809L

#include "tools.h"

#include <inttypes.h>
#include <ctype.h>
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
static int add_agent_spec_locked(sope_agent_t *a, turn_state *t)
{
    sope_buf desc = { 0 }, schema = { 0 };
    int ok = sope__subagent_spec_locked(a, &desc, &schema) && add_spec(t, SOPE__AGENT_TOOL, desc.ptr, schema.ptr);
    sope__buf_free(&desc);
    sope__buf_free(&schema);
    return ok;
}

/* Subagents see only the tools their type lists. */
static int filter_allows(const sope_agent_t *a, const char *name)
{
    size_t i;
    if (!sope__policy_allows(a, name)) return 0;
    if (!a->tool_filter) return 1;
    for (i = 0; i < a->n_tool_filter; i++)
        if (!strcmp(a->tool_filter[i], name) || !strcmp(a->tool_filter[i], "*")) return 1;
    return 0;
}

/* Offers the built-in tools that no host tool replaces; *mu held. */
static int add_builtin_specs_locked(sope_agent_t *a, turn_state *t)
{
    size_t i;
    for (i = 0; i < sope__builtin_count(); i++) {
        const sope_builtin *b = sope__builtin_at(i);
        if (!strcmp(b->name, "report")) {
            char *contract = sope__option_dup_locked(a, "acceptance.contract");
            int enabled = contract || sope__harness_contract(a);
            free(contract);
            if (!enabled) continue;
        }
        const tool_def *td;
        int replaced = 0;
        for (td = a->tools; td; td = td->next)
            if (!strcmp(td->name, b->name)) replaced = 1;
        if (replaced || !filter_allows(a, b->name)) continue;
        t->spec_builtin[t->n_specs] = sope__policy_external(a, b->name) ? NULL : b;
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

void sope__turn_offer_free(turn_state *t)
{
    free_specs(t);
    free(t->system);
    t->system = NULL;
}

int sope__turn_offer_locked(sope_agent_t *a, turn_state *t)
{
    char *subagents = sope__option_dup_locked(a, "subagents");
    int ok = 1, offer_agent = a->parent == NULL && filter_allows(a, SOPE__AGENT_TOOL) && a->root->subagents &&
                              !(subagents && !strcmp(subagents, "off"));
    size_t n_tools = sope__builtin_count() + 1; /* + agent */
    tool_def *td;

    free(subagents);
    t->system = sope__option_dup_locked(a, "system");
    if (!t->system) ok = (t->system = sope__strdup(DEFAULT_SYSTEM)) != NULL;
    for (td = a->tools; td; td = td->next) n_tools++;
    t->specs = calloc(n_tools, sizeof *t->specs);
    t->spec_builtin = calloc(n_tools, sizeof *t->spec_builtin);
    if (!t->specs || !t->spec_builtin) ok = 0;
    for (td = a->tools; ok && td; td = td->next)
        if (filter_allows(a, td->name)) ok = add_spec(t, td->name, td->description, td->input_schema);
    if (ok) ok = add_builtin_specs_locked(a, t);
    if (ok && offer_agent) ok = add_agent_spec_locked(a, t);
    return ok;
}

static void finish_turn(sope_agent_t *a, int32_t stop);

/* Takes the next queued message and prepares the turn. Returns 0 if none. */
static int begin_turn(sope_agent_t *a)
{
    turn_state *t = &a->turn;
    msg_node *m;
    char *provider = NULL, *rounds = NULL, *cwd = NULL, *permissions = NULL;
    int reset, ok;
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
    t->round = m->resume_round;
    t->phase = PHASE_START;
    provider = sope__option_dup_locked(a, "provider");
    rounds = sope__option_dup_locked(a, "max_rounds");
    cwd = sope__option_dup_locked(a, "cwd");
    permissions = sope__option_dup_locked(a, "permissions");
    ok = sope__turn_offer_locked(a, t);
    pthread_mutex_unlock(a->mu);

    t->permit = permissions && !strcmp(permissions, "allow")  ? PERMIT_ALLOW
                : permissions && !strcmp(permissions, "deny") ? PERMIT_DENY
                                                               : PERMIT_ASK;
    if (ok) ok = (t->cwd = working_dir(cwd)) != NULL;

    sope__push_event(a, SOPE_EVENT_TURN_START, m->turn_id, 0, 0, NULL, 0, NULL, 0);
    if (reset) {
        pthread_mutex_lock(a->mu);
        sope__harness_clear(a);
        pthread_mutex_unlock(a->mu);
        sope__history_clear(&a->history);
        sope__files_clear(a);
        a->context_tokens = 0;
        a->context_estimate = 0;
    }

    t->max_rounds = rounds ? (int32_t)strtol(rounds, NULL, 10) : DEFAULT_MAX_ROUNDS;
    if (t->max_rounds <= 0) t->max_rounds = DEFAULT_MAX_ROUNDS;
    t->provider = find_provider(provider ? provider : "mock");

    user = ok && !m->compact && !m->resume ? sope__message_new(SOPE__MSG_USER, m->text, m->len) : NULL;
    if (user) { /* the attached images move into the message */
        user->images = m->images;
        user->n_images = m->n_images;
        m->images = NULL;
        m->n_images = 0;
    }
    if (!ok || (!m->compact && !m->resume && !user)) {
        sope__push_event(a, SOPE_EVENT_ERROR, m->turn_id, 0, SOPE_ENOMEM, NULL, 0, "out of memory", 13);
        finish_turn(a, SOPE_STOP_ERROR);
    } else {
        if (user) sope__history_append(&a->history, user);
        if (!t->provider) {
            char msg[128];
            int n = snprintf(msg, sizeof msg, "unknown provider '%s'", provider);
            sope__push_event(a, SOPE_EVENT_ERROR, m->turn_id, 0, SOPE_ENOTFOUND, NULL, 0, msg, (size_t)n);
            finish_turn(a, SOPE_STOP_ERROR);
        } else if (!sope__context_configure(a)) {
            finish_turn(a, SOPE_STOP_ERROR);
        }
    }
    if (t->active) {
        pthread_mutex_lock(a->mu);
        ok = sope__journal_checkpoint(a, "begin", 0);
        pthread_mutex_unlock(a->mu);
        if (!ok) finish_turn(a, SOPE_STOP_ERROR);
    }
    if (t->active) sope__context_publish(a, 0);
    free(provider);
    free(rounds);
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
            if (!p->done && !p->reported && p->kind != PENDING_SUBAGENT)
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
    pthread_mutex_lock(a->mu);
    /* Keep committed results even when another call in the batch is cancelled. */
    const sope_message *asst = sope__history_last(&a->history, SOPE__MSG_ASSISTANT);
    if (asst) for (size_t i = 0; i < asst->n_tool_uses; i++) {
        const sope_tool_use *u = &asst->tool_uses[i];
        int answered = 0;
        for (const sope_message *m = asst->next; m; m = m->next)
            if (m->role == SOPE__MSG_TOOL && !strcmp(m->tool_use_id, u->id)) answered = 1;
        if (answered) continue;
        for (pending_call *p = a->root->pending; p; p = p->next) if (p->call_id == u->call_id && p->done) {
            sope_message *result = sope__tool_message(u, p->content, p->len, p->is_error);
            if (result) {
                result->images = p->images; result->n_images = p->n_images;
                p->images = NULL; p->n_images = 0;
                sope__history_append(&a->history, result);
            }
        }
    }
    if (stop != SOPE_STOP_END_TURN) sope__history_repair(&a->history);
    a->last_stop = stop;
    if (!t->terminal_committed && !sope__journal_checkpoint(a, "end", 1)) stop = SOPE_STOP_ERROR;
    drop_pending_locked(a); /* late sope_tool_result calls now get ENOTFOUND */
    sope__push_event_locked(a, SOPE_EVENT_TURN_END, id, 0, stop, NULL, 0, NULL, 0);
    sope__shells_detach_locked(a, stop != SOPE_STOP_END_TURN);
    a->active_turn = 0;
    a->cancel_requested = 0;
    /* Hosts may inspect context or reset the journal as soon as TURN_END is
     * visible. Retire all turn-owned state before releasing that boundary. */
    free_specs(t);
    free(t->system);
    free(t->cwd);
    free(t->work_context);
    sope__msg_node_free(t->msg);
    memset(t, 0, sizeof *t);
    a->last_stop = stop;
    a->turns_finished++;
    pthread_mutex_unlock(a->mu);
}

/* ------------------------------------------------------------------------ */
/* rounds                                                                    */
/* ------------------------------------------------------------------------ */

static void turn_error(sope_agent_t *a, int code, const char *msg)
{
    sope__push_event(a, SOPE_EVENT_ERROR, sope__turn_id(a), 0, code, NULL, 0, msg, strlen(msg));
}

/* Deliver the committed native report without depending on another successful
 * model request. asst is supplied only when replacing a model-only response. */
static sope_next finish_report(sope_agent_t *a, sope_message *asst)
{
    pthread_mutex_lock(a->mu);
    const char *report = sope__harness_report(a);
    sope_message *final = report ? sope__message_new(SOPE__MSG_ASSISTANT, report, strlen(report)) : NULL;
    pthread_mutex_unlock(a->mu);
    if (!final) {
        turn_error(a, SOPE_ENOMEM, "Cannot materialize the committed acceptance report.");
        finish_turn(a, SOPE_STOP_ERROR);
        return next(SOPE__NEXT_CONTINUE);
    }
    if (asst) {
        free(asst->content); asst->content = final->content; asst->content_len = final->content_len;
        final->content = NULL; sope__message_free(final);
        free(asst->response_items); asst->response_items = NULL;
        final = asst;
    } else sope__history_append(&a->history, final);
    sope__push_event(a, SOPE_EVENT_TEXT_DELTA, sope__turn_id(a), 0, 0, NULL, 0, final->content, final->content_len);
    finish_turn(a, SOPE_STOP_END_TURN);
    return next(SOPE__NEXT_CONTINUE);
}

static sope_next start_compact(sope_agent_t *a);

static int turn_cancelled(sope_agent_t *a)
{
    int cancelled;
    pthread_mutex_lock(a->mu);
    cancelled = a->cancel_requested || a->closing;
    pthread_mutex_unlock(a->mu);
    return cancelled;
}

static sope_next start_call(sope_agent_t *a)
{
    turn_state *t = &a->turn;
    sope_call *c;

    if (turn_cancelled(a)) return next(SOPE__NEXT_CONTINUE);
    int background_pending;
    if (sope__shells_collect(a, &background_pending) < 0) {
        finish_turn(a, SOPE_STOP_ERROR);
        return next(SOPE__NEXT_CONTINUE);
    }
    pthread_mutex_lock(a->mu);
    int context_ok = sope__harness_context(a);
    pthread_mutex_unlock(a->mu);
    if (!context_ok) {
        turn_error(a, SOPE_ENOMEM, "Cannot render runtime working state.");
        finish_turn(a, SOPE_STOP_ERROR);
        return next(SOPE__NEXT_CONTINUE);
    }
    pthread_mutex_lock(a->mu);
    int ready = t->report_mode && sope__harness_ready(a);
    pthread_mutex_unlock(a->mu);
    if (ready && !turn_cancelled(a)) {
        if (background_pending) { t->phase = PHASE_BACKGROUND; return next(SOPE__NEXT_CONTINUE); }
        return finish_report(a, NULL);
    }
    if (t->round >= (uint64_t)t->max_rounds) {
        char msg[64];
        snprintf(msg, sizeof msg, "stopped after %d model rounds (max_rounds)", (int)t->max_rounds);
        turn_error(a, SOPE_ERROR, msg);
        finish_turn(a, SOPE_STOP_ERROR);
        return next(SOPE__NEXT_CONTINUE);
    }
    uint64_t tokens = sope__context_tokens(a), limit = sope__context_limit(a);
    uint64_t threshold = t->compact_threshold < limit ? t->compact_threshold : limit;

    if (t->compact_threshold && tokens >= threshold && !t->compact_tried && !t->compact_failed && (t->round || a->history.count > 1))
        return start_compact(a);
    t->compact_tried = 0;
    if (tokens > limit) {
        turn_error(a, SOPE_ERROR, "request exceeds context.window after reserving output; history preserved");
        finish_turn(a, SOPE_STOP_ERROR);
        return next(SOPE__NEXT_CONTINUE);
    }

    t->round++;
    pthread_mutex_lock(a->mu);
    int committed = sope__journal_checkpoint(a, "round", 0);
    pthread_mutex_unlock(a->mu);
    if (!committed) { finish_turn(a, SOPE_STOP_ERROR); return next(SOPE__NEXT_CONTINUE); }
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
    permit_mode permit = sope__policy_authorize(a) ? PERMIT_ALLOW : a->turn.permit;
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

static int launch_pending(sope_agent_t *a, pending_call *p, sope_tool_use *u)
{
    const sope_builtin *builtin = NULL;
    const char *err = NULL;
    char why[256];
    int offered = 0, is_agent;
    for (size_t k = 0; k < a->turn.n_specs; k++) if (!strcmp(a->turn.specs[k].name, u->name)) {
        offered = 1; builtin = a->turn.spec_builtin[k];
    }
    is_agent = offered && !strcmp(u->name, SOPE__AGENT_TOOL);
    if (!*u->id) { /* some providers omit ids; they are needed to pair results */
        char id[32];
        snprintf(id, sizeof id, "call_%" PRIu64, u->call_id);
        free(u->id);
        u->id = sope__strdup(id);
    }

    sope_json *arguments = sope__json_parse(u->input, u->input_len);
    int valid_input = arguments && arguments->type == SOPE_JSON_OBJECT;
    sope__json_free(arguments);
    if (!offered) {
        err = "no such tool is available";
    } else if (!valid_input) {
        err = "invalid tool input: expected a JSON object with unique keys";
    } else if (is_agent) {
        err = sope__subagent_spawn(a, u);
    } else if (builtin) {
        if (sope__push_event(a, SOPE_EVENT_TOOL_START, sope__turn_id(a), u->call_id, 0, u->name, strlen(u->name),
                            u->input, u->input_len) != SOPE_OK) {
            pthread_mutex_lock(a->mu);
            sope__storage_fail_locked(a, "Cannot publish tool start; execution stopped before dispatch.");
            pthread_mutex_unlock(a->mu);
            return 1;
        }
        err = start_builtin(a, p, u, builtin, why, sizeof why);
    } else {
        sope__push_event(a, SOPE_EVENT_TOOL_CALL, sope__turn_id(a), u->call_id, 0, u->name, strlen(u->name),
                         u->input, u->input_len);
    }
    if (err) { /* answer the model directly: it can fix its input and retry */
        pthread_mutex_lock(a->mu);
        p->content = sope__strdup(err);
        p->len = p->content ? strlen(err) : 0;
        p->is_error = 1;
        p->done = sope__journal_result(a, p);
        pthread_mutex_unlock(a->mu);
    }
    return 1;
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

    pthread_mutex_lock(a->mu);
    if (!sope__harness_admit(a, p, u)) {
        sope__storage_fail_locked(a, "Cannot retain operation identity; execution stopped.");
        pthread_mutex_unlock(a->mu);
        return 1;
    }
    if (p->harness_blocked) {
        sope__push_event_locked(a, SOPE_EVENT_TOOL_START, p->turn_id, p->call_id, 0, u->name, strlen(u->name), u->input, u->input_len);
        p->done = sope__journal_result(a, p);
        pthread_mutex_unlock(a->mu);
        return 1;
    }
    if (!sope__journal_harness(a)) {
        pthread_mutex_unlock(a->mu);
        return 1;
    }
    int suspended = a->root->suspending || a->root->journal_failed || a->closing;
    if (offered && sope__policy_authorize(a) && !suspended) {
        p->permission = 1;
        sope__push_event_locked(a, SOPE_EVENT_PERMISSION, p->turn_id, p->call_id, 0, u->name, strlen(u->name), u->input, u->input_len);
        pthread_mutex_unlock(a->mu);
        return 1;
    }
    pthread_mutex_unlock(a->mu);
    if (suspended) return 1; /* committed intent remains unknown until reconciled */
    return launch_pending(a, p, u);
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
        if (c->context_exceeded && !c->text.len && !c->n_uses && t->compact_threshold &&
            !t->overflow_retried && a->history.count > 1) {
            t->overflow_retried = 1;
            t->round--; /* retry the same round, preserving a new user input at turn start */
            sope__call_free(c);
            t->call = NULL;
            return start_compact(a);
        }
        if (!c->failed) turn_error(a, rc, sope_strerror(rc));
        finish_turn(a, SOPE_STOP_ERROR);
        return next(SOPE__NEXT_CONTINUE);
    }

    if (!(asst = sope__message_new(SOPE__MSG_ASSISTANT, c->text.ptr, c->text.len))) {
        turn_error(a, SOPE_ENOMEM, "out of memory");
        finish_turn(a, SOPE_STOP_ERROR);
        return next(SOPE__NEXT_CONTINUE);
    }
    asst->response_items = c->response_items; c->response_items = NULL;
    asst->reasoning = c->reasoning.ptr;
    asst->reasoning_len = c->reasoning.len;
    memset(&c->reasoning, 0, sizeof c->reasoning);
    asst->reasoning_identity = c->reasoning_identity; c->reasoning_identity = NULL;
    asst->tool_uses = c->uses;
    asst->n_tool_uses = c->n_uses;
    c->uses = NULL;
    c->n_uses = 0;
    sope__history_append(&a->history, asst);
    /* Missing usage is not evidence that the previous calibration was wrong. */
    a->context_tokens = c->has_usage ? c->usage_tokens : sope__context_tokens(a);
    a->context_estimate = sope__request_tokens(a);
    sope__context_publish(a, 0);
    t->overflow_retried = 0;
    sope__call_free(c);
    t->call = NULL;

    if (!asst->n_tool_uses) {
        int pending;
        int delivered = sope__shells_collect(a, &pending);
        if (delivered < 0) { finish_turn(a, SOPE_STOP_ERROR); return next(SOPE__NEXT_CONTINUE); }
        if (delivered) return start_call(a);
        if (pending) {
            t->phase = PHASE_BACKGROUND;
            return next(SOPE__NEXT_CONTINUE);
        }
        pthread_mutex_lock(a->mu);
        int closure = sope__harness_finish(a);
        pthread_mutex_unlock(a->mu);
        if (closure) {
            sope__push_event(a, SOPE_EVENT_LOG, sope__turn_id(a), 0, SOPE_LOG_INFO, NULL, 0,
                "{\"event\":\"work.closure\",\"outstanding\":1}", strlen("{\"event\":\"work.closure\",\"outstanding\":1}"));
            if (closure < 0) {
                turn_error(a, SOPE_ERROR, "Task plan or acceptance report still has outstanding items after two completion reconciliations; completion not established.");
                finish_turn(a, SOPE_STOP_ERROR);
                return next(SOPE__NEXT_CONTINUE);
            }
            return start_call(a);
        }
        if (t->report_mode) return finish_report(a, asst);
        /* Receipts remain queryable through evidence; they are not assistant prose. */
        finish_turn(a, SOPE_STOP_END_TURN);
        return next(SOPE__NEXT_CONTINUE);
    }

    t->asst = asst;
    t->phase = PHASE_TOOLS;
    /* Allocate all IDs and commit the entire batch before any tool can run. */
    pthread_mutex_lock(a->mu);
    for (i = 0; i < asst->n_tool_uses; i++) {
        sope_tool_use *u = &asst->tool_uses[i];
        u->call_id = ++a->root->next_call_id;
        if (!*u->id) {
            char id[32];
            snprintf(id, sizeof id, "call_%" PRIu64, u->call_id);
            free(u->id); u->id = sope__strdup(id);
        }
    }
    int committed = sope__journal_checkpoint(a, "model", 0);
    pthread_mutex_unlock(a->mu);
    if (!committed) { finish_turn(a, SOPE_STOP_ERROR); return next(SOPE__NEXT_CONTINUE); }
    for (i = 0; i < asst->n_tool_uses; i++)
        if (!dispatch(a, &asst->tool_uses[i])) {
            turn_error(a, SOPE_ENOMEM, "out of memory");
            pthread_mutex_lock(a->mu);
            t->failed = 1;
            a->cancel_requested = 1;
            pthread_mutex_unlock(a->mu);
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
    for (p = a->root->pending; p; p = p->next) {
        if (p->owner != a || p->done || p->permission != 2 || a->root->suspending) continue;
        p->permission = 0;
        for (i = 0; i < asst->n_tool_uses; i++) if (asst->tool_uses[i].call_id == p->call_id) {
            pthread_mutex_unlock(a->mu);
            launch_pending(a, p, &asst->tool_uses[i]);
            return next(SOPE__NEXT_CONTINUE);
        }
    }
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
        if (!m) {
            if (p) { p->next = a->root->pending; a->root->pending = p; }
            sope__storage_fail_locked(a, "Cannot materialize committed tool results; execution stopped for recovery.");
            pthread_mutex_unlock(a->mu);
            return next(SOPE__NEXT_CONTINUE);
        }
        if (m && p && p->n_images) {
            m->images = p->images;
            m->n_images = p->n_images;
            p->images = NULL;
            p->n_images = 0;
        }
        sope__history_append(&a->history, m);
        if (p) sope__pending_free(p);
    }
    pthread_mutex_unlock(a->mu);

    t->asst = NULL;
    pthread_mutex_lock(a->mu);
    int exhausted = sope__harness_exhausted(a);
    pthread_mutex_unlock(a->mu);
    if (exhausted) {
        turn_error(a, SOPE_ERROR, "harness: execution stopped after three blocked operations; task completion is not established.");
        finish_turn(a, SOPE_STOP_ERROR);
        return next(SOPE__NEXT_CONTINUE);
    }
    return start_call(a);
}

/* ------------------------------------------------------------------------ */
/* compaction                                                                */
/* ------------------------------------------------------------------------ */

static sope_next start_compact_attempt(sope_agent_t *a);

static sope_next start_compact(sope_agent_t *a)
{
    a->turn.compact_retries = 0; /* each new compaction owns its retry budget */
    return start_compact_attempt(a);
}

static sope_next start_compact_attempt(sope_agent_t *a)
{
    turn_state *t = &a->turn;
    msg_node *m = t->msg;
    sope_message *req = NULL;
    sope_call *c;
    char *text;
    size_t len;
    int rc;
    uint64_t budget, retain;

    if (turn_cancelled(a)) return next(SOPE__NEXT_CONTINUE);
    t->compact_before = sope__request_tokens(a) + (t->held ? sope__message_tokens(t->held) : 0);
    t->compact_tried = 1;
    if (!a->history.count) { /* sope_compact on an empty conversation */
        finish_turn(a, SOPE_STOP_END_TURN);
        return next(SOPE__NEXT_CONTINUE);
    }
    if (!m->compact && !t->held && t->round == 0 && a->history.count > 1) {
        /* Compacting before the turn's first call: summarize what came
         * before and keep the new request verbatim after the summary. */
        t->held = sope__history_pop(&a->history);
    }
    budget = t->compact_retries ? t->compact_request_budget / 2 : t->compact_input_tokens;
    if (t->context_window && budget > t->context_window - t->summary_tokens)
        budget = t->context_window - t->summary_tokens;
    t->compact_request_budget = budget;
    retain = sope__history_tokens(&a->history) / 4;
    if (retain > t->retain_tokens) retain = t->retain_tokens;
    if (t->compact_threshold && retain > t->compact_threshold / 4) retain = t->compact_threshold / 4;
    if (retain > sope__context_limit(a) / 4) retain = sope__context_limit(a) / 4;
    /* Reserve room for the new checkpoint, its wrapper and the current input
     * before choosing a suffix that the summarizer will not see. */
    uint64_t fixed = sope__request_tokens(a) - sope__history_tokens(&a->history);
    if (t->held) fixed += sope__message_tokens(t->held);
    fixed += t->summary_tokens + 128;
    uint64_t available = sope__context_limit(a) > fixed ? sope__context_limit(a) - fixed : 0;
    if (retain > available) retain = available;
    t->compact_keep = sope__compact_suffix(&a->history, retain);
    rc = sope__compact_request(&a->history, t->compact_keep, m->compact ? m->text : NULL,
                               m->compact ? m->len : 0, budget, &text, &len);
    if (rc != SOPE_OK) {
        t->compact_failed = 1;
        turn_error(a, rc, rc == SOPE_ENOMEM ? "out of memory" : "compaction instructions and transcript cannot fit input budget");
        if (t->held) sope__history_append(&a->history, t->held);
        t->held = NULL;
        if (m->compact || t->overflow_retried) { finish_turn(a, SOPE_STOP_ERROR); return next(SOPE__NEXT_CONTINUE); }
        return start_call(a);
    }
    t->compact_request_budget = sope__text_tokens(text, len) +
                                sope__text_tokens(sope__compact_system, strlen(sope__compact_system)) + 24;
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
        if (m->compact || t->overflow_retried) {
            finish_turn(a, SOPE_STOP_ERROR);
            return next(SOPE__NEXT_CONTINUE);
        }
        t->compact_failed = 1;
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
    if (turn_cancelled(a)) return next(SOPE__NEXT_CONTINUE); /* abort_turn owns cleanup */
    if (c->context_exceeded && t->compact_retries < 2 && t->compact_request_budget > 1) {
        t->compact_retries++;
        sope__call_free(c);
        t->call = NULL;
        return start_compact_attempt(a);
    }
    ok = rc == SOPE_OK && !c->failed;
    size_t nonspace = 0;
    while (nonspace < c->text.len && isspace((unsigned char)c->text.ptr[nonspace])) nonspace++;
    if (ok && (!c->complete || c->n_uses || nonspace == c->text.len)) {
        turn_error(a, SOPE_ERROR, "compaction failed: incomplete or empty summary");
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
        sope_history suffix = { .head = t->compact_keep };
        uint64_t candidate = sope__request_tokens(a) - sope__history_tokens(&a->history) +
                             sope__message_tokens(summary) + sope__history_tokens(&suffix);
        if (t->held) candidate += sope__message_tokens(t->held);
        if (candidate > sope__context_limit(a) || (!manual && candidate >= t->compact_before)) {
            turn_error(a, SOPE_ERROR, "compaction did not produce a smaller history within the context budget");
            sope__message_free(summary);
            summary = NULL;
            ok = 0;
        }
    }
    /* Cancellation and checkpoint installation have one ordering under the
     * same lock as sope_cancel. Never publish a checkpoint after cancellation
     * has already won; abort_turn restores held input and frees the call. */
    pthread_mutex_lock(a->mu);
    if (a->cancel_requested || a->closing) {
        pthread_mutex_unlock(a->mu);
        sope__message_free(summary);
        free(text);
        return next(SOPE__NEXT_CONTINUE);
    }
    if (ok) {
        while (a->history.head != t->compact_keep) {
            sope_message *old = a->history.head;
            a->history.head = old->next;
            a->history.count--;
            sope__message_free(old);
        }
        summary->is_summary = 1;
        summary->next = a->history.head;
        a->history.head = summary;
        if (!summary->next) a->history.tail = summary;
        a->history.count++;
    }
    t->compact_keep = NULL;
    if (t->held) sope__history_append(&a->history, t->held);
    t->held = NULL;
    if (ok) {
        a->context_tokens = 0;
        a->context_estimate = 0; /* new window: measure summary, retained messages and current input */
        if (manual) a->last_stop = SOPE_STOP_END_TURN;
        sope__context_publish(a, 1);
        ok = sope__journal_checkpoint(a, "compact", manual);
        t->terminal_committed = manual && ok;
        if (ok) sope__push_event_locked(a, SOPE_EVENT_COMPACT, sope__turn_id(a), 0, 0, manual ? "manual" : "auto",
                         manual ? 6 : 4, c->text.ptr, c->text.len);
    }
    pthread_mutex_unlock(a->mu);
    free(text);
    sope__call_free(c);
    t->call = NULL;
    t->phase = PHASE_START;

    if (!ok) t->compact_failed = 1;
    if (manual || (!ok && t->overflow_retried)) {
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
    case PHASE_BACKGROUND: {
        int pending;
        int delivered = sope__shells_collect(a, &pending);
        if (delivered < 0) { finish_turn(a, SOPE_STOP_ERROR); return next(SOPE__NEXT_CONTINUE); }
        if (delivered || !pending) return start_call(a);
        return next(SOPE__NEXT_WAIT);
    }
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

    finish_turn(a, a->turn.failed ? SOPE_STOP_ERROR : SOPE_STOP_CANCELLED);
    return next(SOPE__NEXT_CONTINUE);
}

/* Ends every queued turn and marks the agent closed. */
static sope_next close_agent(sope_agent_t *a)
{
    msg_node *dropped;

    pthread_mutex_lock(a->mu);
    /* Closing a recovered-but-not-resumed session must not consume its inbox. */
    if (a->recovering || a->suspended || a->journal_failed) {
        a->closed = 1;
        if (a->root == a) sope__signal_closed_locked(a);
        pthread_mutex_unlock(a->mu);
        return next(SOPE__NEXT_CLOSED);
    }
    dropped = a->in_head;
    a->in_head = a->in_tail = NULL;
    pthread_mutex_unlock(a->mu);

    while (dropped) {
        msg_node *n = dropped->next;
        a->turn.active = 1; a->turn.msg = dropped;
        pthread_mutex_lock(a->mu);
        a->last_stop = SOPE_STOP_CANCELLED;
        sope__journal_checkpoint(a, "cancel_queued", 1);
        pthread_mutex_unlock(a->mu);
        memset(&a->turn, 0, sizeof a->turn);
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

/* Drain admitted built-ins; host operations without a receipt remain unknown.
 * Reload committed state instead of manufacturing cancellation tool results. */
static sope_next suspend_agent(sope_agent_t *a)
{
    turn_state *t = &a->turn;
    if (t->call) {
        if (t->call->state) t->provider->finish(t->call->state);
        sope__call_free(t->call); t->call = NULL;
    }
    pthread_mutex_lock(a->mu);
    for (sope_agent_t *c = a->children; c; c = c->sibling) {
        c->closing = 1;
        sope__task_wake(&c->task);
    }
    if (a->children || a->runs) { pthread_mutex_unlock(a->mu); return next(SOPE__NEXT_WAIT); }
    pthread_mutex_unlock(a->mu);
    sope__shells_free(a);
    free_specs(t); free(t->system); free(t->cwd);
    free(t->work_context);
    if (t->held) sope__message_free(t->held);
    sope__msg_node_free(t->msg);
    memset(t, 0, sizeof *t);
    pthread_mutex_lock(a->mu);
    while (a->pending) { pending_call *p = a->pending; a->pending = p->next; sope__pending_free(p); }
    while (a->in_head) { msg_node *m = a->in_head; a->in_head = m->next; sope__msg_node_free(m); }
    a->in_tail = NULL;
    sope__history_clear(&a->history);
    sope__files_clear(a);
    a->active_turn = 0;
    if (!sope__journal_restore(a)) sope__storage_fail_locked(a, "Cannot reload suspended execution checkpoint");
    a->suspending = 0; a->suspended = 1;
    int closing = a->closing;
    pthread_cond_broadcast(&a->poll_cv);
    pthread_mutex_unlock(a->mu);
    return next(closing ? SOPE__NEXT_CONTINUE : SOPE__NEXT_WAIT);
}

sope_next sope__agent_run(sope_task *task)
{
    sope_agent_t *a = task->owner;
    int closing, stopped, paused, suspend;

    pthread_mutex_lock(a->mu);
    closing = a->closing;
    stopped = closing || a->cancel_requested;
    paused = a->recovering || a->suspended || a->root->journal_failed;
    suspend = a->suspending;
    pthread_mutex_unlock(a->mu);

    if (suspend) return suspend_agent(a);
    if (a->turn.active) return stopped ? abort_turn(a) : step_turn(a);

    if (!closing && paused) return next(SOPE__NEXT_WAIT);

    /* A subagent lives for exactly one turn. */
    if (closing || (a->parent && a->turns_finished > 0)) return close_agent(a);
    if (!begin_turn(a)) return next(SOPE__NEXT_WAIT);
    return next(SOPE__NEXT_CONTINUE);
}
