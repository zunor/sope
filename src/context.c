/* SPDX-License-Identifier: MIT */
/* Request budgets are independent of transport usage reports. Estimates also
 * cover restored histories and the messages/tools added since the last call. */
#include "agent.h"

#include <errno.h>
#include <inttypes.h>
#include <stdlib.h>
#include <string.h>

static uint64_t add(uint64_t a, uint64_t b)
{
    return a > UINT64_MAX - b ? UINT64_MAX : a + b;
}

uint64_t sope__text_tokens(const char *s, size_t n)
{
    size_t i;
    uint64_t ascii = 0, other = 0;
    /* ASCII averages about four bytes/token. Charge non-ASCII bytes separately
     * so CJK is not underestimated by the old unconditional bytes/4 rule. */
    for (i = 0; i < n; i++) {
        if ((unsigned char)s[i] < 128) ascii++;
        else other++;
    }
    return add(ascii / 4 + (ascii % 4 != 0), other);
}

/* Without model-specific image metadata, deliberately overestimate encoded
 * images rather than treating them as free. This is not a tokenizer. */
static uint64_t image_tokens(const sope_message *m)
{
    size_t i;
    uint64_t tokens = 0;
    for (i = 0; i < m->n_images; i++) tokens = add(tokens, add(1024, m->images[i].len / 4));
    return tokens;
}

/* A message without its images. */
static uint64_t text_part_tokens(const sope_message *m)
{
    size_t i;
    uint64_t tokens = add(12, sope__text_tokens(m->content, m->content_len));
    if (m->response_items) tokens = add(tokens, sope__text_tokens(m->response_items, strlen(m->response_items)));
    for (i = 0; i < m->n_tool_uses; i++) {
        const sope_tool_use *u = &m->tool_uses[i];
        tokens = add(tokens, add(16, sope__text_tokens(u->input, u->input_len)));
        tokens = add(tokens, sope__text_tokens(u->id, strlen(u->id)));
        tokens = add(tokens, sope__text_tokens(u->name, strlen(u->name)));
    }
    if (m->tool_use_id) tokens = add(tokens, sope__text_tokens(m->tool_use_id, strlen(m->tool_use_id)));
    return tokens;
}

uint64_t sope__message_tokens(const sope_message *m)
{
    return add(text_part_tokens(m), image_tokens(m));
}

uint64_t sope__history_tokens(const sope_history *h)
{
    const sope_message *m;
    uint64_t tokens = 0;
    for (m = h->head; m; m = m->next) tokens = add(tokens, sope__message_tokens(m));
    return tokens;
}

/* The request's own framing and the system prompt. */
static uint64_t system_tokens(const char *system)
{
    return add(12, system ? sope__text_tokens(system, strlen(system)) : 0);
}

static uint64_t specs_tokens(const sope_tool_spec *specs, size_t n)
{
    size_t i;
    uint64_t tokens = 0;
    for (i = 0; i < n; i++) {
        const sope_tool_spec *s = &specs[i];
        tokens = add(tokens, add(16, sope__text_tokens(s->name, strlen(s->name))));
        tokens = add(tokens, sope__text_tokens(s->description, strlen(s->description)));
        tokens = add(tokens, sope__text_tokens(s->input_schema, strlen(s->input_schema)));
    }
    return tokens;
}

uint64_t sope__request_tokens(const sope_agent_t *a)
{
    const turn_state *t = &a->turn;
    return add(add(system_tokens(t->system), specs_tokens(t->specs, t->n_specs)), sope__history_tokens(&a->history));
}

/* The provider's count of the last request, plus what was added since. */
static uint64_t calibrated(const sope_agent_t *a, uint64_t estimate)
{
    uint64_t reported = add(a->context_tokens, estimate > a->context_estimate ? estimate - a->context_estimate : 0);
    return estimate > reported ? estimate : reported;
}

uint64_t sope__context_tokens(const sope_agent_t *a)
{
    return calibrated(a, sope__request_tokens(a));
}

uint64_t sope__context_limit(const sope_agent_t *a)
{
    return a->turn.context_window ? a->turn.context_window - a->turn.output_reserve : UINT64_MAX;
}

/* Configuration is snapshotted with the turn. Bound values so all budgets and
 * subsequent conversions fit size_t on the supported 64-bit platforms. */
static int option(sope_agent_t *a, const char *key, uint64_t fallback, int zero, uint64_t *out)
{
    char *s, *end;
    unsigned long long value;
    int ok;
    pthread_mutex_lock(a->mu);
    s = sope__option_dup_locked(a, key);
    pthread_mutex_unlock(a->mu);
    if (!s) { *out = fallback; return 1; }
    errno = 0;
    value = strtoull(s, &end, 10);
    ok = s[0] >= '0' && s[0] <= '9' && !*end && !errno && value <= UINT32_MAX && (zero || value > 0);
    free(s);
    if (!ok) {
        sope__push_event(a, SOPE_EVENT_ERROR, sope__turn_id(a), 0, SOPE_EINVAL, NULL, 0, key, strlen(key));
        return 0;
    }
    *out = value;
    return 1;
}

int sope__context_configure(sope_agent_t *a)
{
    turn_state *t = &a->turn;
    uint64_t max_output;
    if (!option(a, "compact.threshold", 0, 1, &t->compact_threshold) ||
        !option(a, "context.window", 0, 1, &t->context_window) ||
        !option(a, "context.reserve", 4096, 0, &t->output_reserve) ||
        !option(a, "openai.max_tokens", t->output_reserve, 0, &max_output) ||
        !option(a, "compact.max_tokens", 2048, 0, &t->summary_tokens) ||
        !option(a, "compact.retain_tokens", 8000, 1, &t->retain_tokens) ||
        !option(a, "compact.input_tokens", 64000, 0, &t->compact_input_tokens)) return 0;
    if (max_output > t->output_reserve) t->output_reserve = max_output;
    t->output_limit = max_output;
    if (t->context_window && (t->output_reserve >= t->context_window || t->summary_tokens >= t->context_window)) {
        const char *error = "context.window must exceed both output and summary reserves";
        sope__push_event(a, SOPE_EVENT_ERROR, sope__turn_id(a), 0, SOPE_EINVAL, NULL, 0, error, strlen(error));
        return 0;
    }
    return 1;
}

/* ------------------------------------------------------------------------ */
/* sope_agent_context                                                        */
/* ------------------------------------------------------------------------ */

#define LARGEST 3
#define LARGEST_INPUT 1024 /* longer tool inputs are left out of the report */

typedef struct {
    const sope_message *result;
    const sope_tool_use *use; /* the call it answers; NULL if not found */
    uint64_t tokens;
} large_result;

static const sope_tool_use *answered_use(const sope_message *asst, const char *id)
{
    size_t i;
    if (!asst || !id) return NULL;
    for (i = 0; i < asst->n_tool_uses; i++)
        if (!strcmp(asst->tool_uses[i].id, id)) return &asst->tool_uses[i];
    return NULL;
}

/* Measures a request the way compaction does and reports it by part. The
 * parts add up to "estimate"; "used" also trusts the provider's last count. */
static void context_json(const sope_agent_t *a, const sope_history *h, const char *system,
                         const sope_tool_spec *specs, size_t n_specs, uint64_t window, uint64_t reserve,
                         uint64_t threshold, const char *state, sope_buf *b)
{
    const sope_message *m, *asst = NULL;
    uint64_t sys = system_tokens(system), tools = specs_tokens(specs, n_specs);
    uint64_t summary = 0, messages = 0, results = 0, images = 0, estimate;
    size_t n_messages = 0, n_results = 0, n_images = 0, i, j;
    large_result top[LARGEST] = { { 0 } };

    for (m = h->head; m; m = m->next) {
        uint64_t text = text_part_tokens(m);
        images = add(images, image_tokens(m));
        n_images += m->n_images;
        if (m->is_summary) {
            summary = add(summary, text);
        } else if (m->role == SOPE__MSG_TOOL) {
            results = add(results, text);
            n_results++;
            for (i = 0; i < LARGEST && top[i].result && top[i].tokens >= text; i++) {}
            if (i < LARGEST) {
                memmove(&top[i + 1], &top[i], (LARGEST - 1 - i) * sizeof top[0]);
                top[i] = (large_result){ m, answered_use(asst, m->tool_use_id), text };
            }
        } else {
            messages = add(messages, text);
            n_messages++;
            if (m->role == SOPE__MSG_ASSISTANT) asst = m;
        }
    }
    estimate = add(add(add(sys, tools), add(summary, messages)), add(results, images));
    sope__buf_appendf(b,
        "{\"state\":\"%s\",\"used\":%" PRIu64 ",\"estimate\":%" PRIu64 ",\"window\":%" PRIu64
        ",\"reserve\":%" PRIu64 ",\"threshold\":%" PRIu64 ",\"parts\":{\"system\":%" PRIu64 ",\"tools\":%" PRIu64
        ",\"summary\":%" PRIu64 ",\"messages\":%" PRIu64 ",\"tool_results\":%" PRIu64 ",\"images\":%" PRIu64
        "},\"counts\":{\"tools\":%zu,\"messages\":%zu,\"tool_results\":%zu,\"images\":%zu},\"largest\":[",
        state, a ? calibrated(a, estimate) : estimate, estimate, window, window ? reserve : 0, threshold,
        sys, tools, summary, messages, results, images, n_specs, n_messages, n_results, n_images);
    for (j = 0; j < LARGEST && top[j].result; j++) {
        const sope_message *r = top[j].result;
        const char *name = r->tool_name ? r->tool_name : top[j].use ? top[j].use->name : "";
        sope__buf_appends(b, j ? ",{\"name\":" : "{\"name\":");
        sope__buf_append_json_string(b, name, strlen(name));
        if (top[j].use && top[j].use->input_len <= LARGEST_INPUT) {
            sope__buf_appends(b, ",\"input\":");
            sope__buf_append_json_string(b, top[j].use->input, top[j].use->input_len);
        }
        sope__buf_appendf(b, ",\"tokens\":%" PRIu64 "}", top[j].tokens);
    }
    sope__buf_appends(b, "]}");
}

void sope__context_publish(sope_agent_t *a, int locked)
{
    const turn_state *t = &a->turn;
    sope_buf b = { 0 };
    if (a->parent) return; /* only the root reports its context */
    context_json(a, &a->history, t->system, t->specs, t->n_specs, t->context_window, t->output_reserve,
                 t->compact_threshold, "running", &b);
    if (!locked) pthread_mutex_lock(a->mu);
    if (b.oom) {
        sope__buf_free(&b);
    } else {
        free(a->context_json);
        a->context_json = b.ptr;
    }
    if (!locked) pthread_mutex_unlock(a->mu);
}

/* A numeric option as the next turn will read it; *mu held. Invalid values
 * read as `fallback` here: the turn reports them when it starts. */
static uint64_t option_locked(sope_agent_t *a, const char *key, uint64_t fallback)
{
    char *s = sope__option_dup_locked(a, key), *end;
    unsigned long long value;
    if (!s) return fallback;
    errno = 0;
    value = strtoull(s, &end, 10);
    if (!(s[0] >= '0' && s[0] <= '9') || *end || errno || value > UINT32_MAX) value = fallback;
    free(s);
    return value;
}

int sope__context_measure_locked(sope_agent_t *a, const turn_state *offer, sope_buf *b)
{
    static const sope_history empty = { 0 };
    uint64_t reserve = option_locked(a, "context.reserve", 4096);
    uint64_t max_output = option_locked(a, "openai.max_tokens", reserve);
    if (max_output > reserve) reserve = max_output;
    /* A reset takes effect when the next turn starts: report what it will send. */
    context_json(a->reset_requested ? NULL : a, a->reset_requested ? &empty : &a->history, offer->system,
                 offer->specs, offer->n_specs, option_locked(a, "context.window", 0), reserve,
                 option_locked(a, "compact.threshold", 0), "idle", b);
    return !b->oom;
}
