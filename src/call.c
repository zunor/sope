/* SPDX-License-Identifier: MIT */
/*
 * call.c - sope_call: one model call as a provider sees it.
 *
 * The loop creates a call per round (or per compaction); the provider reads
 * its inputs (history, system prompt, tools, options) and reports what the
 * model produces. Text and thinking stream to the host as events at once;
 * tool uses are collected for the loop to dispatch when the call is done.
 * A compaction call summarizes its own `request` instead of the agent's
 * history, offers no tools, and keeps its text out of the event stream.
 */
#include "agent.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

sope_call *sope__call_new(sope_agent_t *a, uint64_t round, int compaction)
{
    sope_call *c = calloc(1, sizeof *c);
    if (!c) return NULL;
    c->agent = a;
    c->round = round;
    c->compaction = compaction;
    return c;
}

void sope__call_free(sope_call *c)
{
    if (!c) return;
    sope__history_clear(&c->request);
    sope__buf_free(&c->text);
    sope__tool_uses_free(c->uses, c->n_uses);
    free(c);
}

/* ------------------------------------------------------------------------ */
/* inputs                                                                    */
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

uint64_t sope__call_max_tokens(sope_call *c)
{
    return c->compaction ? c->agent->turn.summary_tokens : c->agent->turn.output_limit;
}

void sope__call_complete(sope_call *c)
{
    c->complete = 1;
}

void sope__call_context_exceeded(sope_call *c)
{
    c->context_exceeded = 1;
}

/* ------------------------------------------------------------------------ */
/* outputs                                                                   */
/* ------------------------------------------------------------------------ */

void sope__call_text(sope_call *c, const char *s, size_t n)
{
    if (!n) return;
    sope__buf_append(&c->text, s, n);
    if (c->text.oom) {
        if (!c->failed) sope__call_error(c, SOPE_ENOMEM, "out of memory while collecting model output");
        return;
    }
    if (c->compaction) return; /* the summary is delivered with SOPE_EVENT_COMPACT */
    sope__push_event(c->agent, SOPE_EVENT_TEXT_DELTA, sope__turn_id(c->agent), 0, 0, NULL, 0, s, n);
}

void sope__call_thinking(sope_call *c, const char *s, size_t n)
{
    if (!n || c->compaction) return;
    sope__push_event(c->agent, SOPE_EVENT_THINKING_DELTA, sope__turn_id(c->agent), 0, 0, NULL, 0, s, n);
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
    c->has_usage = 1;
    c->usage_tokens = input_tokens > UINT64_MAX - output_tokens ? UINT64_MAX : input_tokens + output_tokens;
    sope__push_event(c->agent, SOPE_EVENT_USAGE, sope__turn_id(c->agent), 0, 0, NULL, 0, buf, (size_t)n);
}

static void push_formatted(sope_call *c, uint32_t type, int32_t code, const char *fmt, va_list ap)
{
    char buf[2048];
    int n = vsnprintf(buf, sizeof buf, fmt, ap);
    if (n < 0) n = 0;
    if ((size_t)n >= sizeof buf) n = (int)sizeof buf - 1;
    sope__push_event(c->agent, type, sope__turn_id(c->agent), 0, code, NULL, 0, buf, (size_t)n);
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
