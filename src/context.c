/* SPDX-License-Identifier: MIT */
/* Request budgets are independent of transport usage reports. Estimates also
 * cover restored histories and the messages/tools added since the last call. */
#include "agent.h"

#include <errno.h>
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

uint64_t sope__message_tokens(const sope_message *m)
{
    size_t i;
    uint64_t tokens = add(12, sope__text_tokens(m->content, m->content_len));
    for (i = 0; i < m->n_tool_uses; i++) {
        const sope_tool_use *u = &m->tool_uses[i];
        tokens = add(tokens, add(16, sope__text_tokens(u->input, u->input_len)));
        tokens = add(tokens, sope__text_tokens(u->id, strlen(u->id)));
        tokens = add(tokens, sope__text_tokens(u->name, strlen(u->name)));
    }
    if (m->tool_use_id) tokens = add(tokens, sope__text_tokens(m->tool_use_id, strlen(m->tool_use_id)));
    /* Without model-specific image metadata, deliberately overestimate encoded
     * images rather than treating them as free. This is not a tokenizer. */
    for (i = 0; i < m->n_images; i++) tokens = add(tokens, add(1024, m->images[i].len / 4));
    return tokens;
}

uint64_t sope__history_tokens(const sope_history *h)
{
    const sope_message *m;
    uint64_t tokens = 0;
    for (m = h->head; m; m = m->next) tokens = add(tokens, sope__message_tokens(m));
    return tokens;
}

uint64_t sope__request_tokens(const sope_agent_t *a)
{
    const turn_state *t = &a->turn;
    size_t i;
    uint64_t tokens = add(12, sope__history_tokens(&a->history));
    if (t->system) tokens = add(tokens, sope__text_tokens(t->system, strlen(t->system)));
    for (i = 0; i < t->n_specs; i++) {
        const sope_tool_spec *s = &t->specs[i];
        tokens = add(tokens, add(16, sope__text_tokens(s->name, strlen(s->name))));
        tokens = add(tokens, sope__text_tokens(s->description, strlen(s->description)));
        tokens = add(tokens, sope__text_tokens(s->input_schema, strlen(s->input_schema)));
    }
    return tokens;
}

uint64_t sope__context_tokens(const sope_agent_t *a)
{
    uint64_t estimate = sope__request_tokens(a);
    uint64_t reported = add(a->context_tokens, estimate > a->context_estimate ? estimate - a->context_estimate : 0);
    return estimate > reported ? estimate : reported;
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
