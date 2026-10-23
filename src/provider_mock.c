/* SPDX-License-Identifier: MIT */
/*
 * provider_mock.c - a deterministic stand-in for a model, for tests and
 * offline debugging. It reads the history like a real model and drives the
 * same agent loop:
 *
 *   <text>                     streams a reply quoting the input
 *   !<tool> [arg]              calls a tool with {"input": arg}
 *   !<tool> {json}             calls a tool with that JSON as its input
 *   !<tool> {json} ;; !<t2> .. several tool calls in one response
 *   !agent[:type] t1 | t2 ...  spawns one subagent per task, in parallel
 *   !history                   reports how many messages the history holds
 *   !panic                     fails the call
 *
 * Asked to compact, it replies with a summary listing the user messages.
 *
 * After tool results it reports them. Text streams in small chunks with
 * option mock.delay_ms between them (default 25).
 */
#include "sope_internal.h"

#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_TOOL_NAME 64

typedef struct {
    int32_t delay;
    sope_buf text; /* streamed from `pos` */
    size_t pos;
    sope_buf uses; /* pending tool uses: name \0 input \0 ... */
    size_t n_uses;
} mock_state;

static size_t utf8_len(unsigned char c)
{
    if (c < 0x80) return 1;
    if ((c >> 5) == 0x6) return 2;
    if ((c >> 4) == 0xe) return 3;
    if ((c >> 3) == 0x1e) return 4;
    return 1;
}

/* One word, or a few code points of a run without spaces (e.g. CJK). */
static size_t next_chunk(const char *s, size_t n)
{
    size_t j = 0;
    while (j < n) {
        unsigned char c = (unsigned char)s[j];
        size_t cl = utf8_len(c);
        j = j + cl > n ? n : j + cl;
        if (c == ' ' || c == '\n') break;
        if (c >= 0x80 && j >= 9) break;
    }
    return j;
}

static void add_use(mock_state *s, const char *name, const sope_buf *input)
{
    sope__buf_append(&s->uses, name, strlen(name) + 1);
    sope__buf_append(&s->uses, input->ptr, input->len + 1);
    s->n_uses++;
}

static void plan_tool_results(sope_call *c, mock_state *s)
{
    const sope_message *m, *asst = NULL;
    for (m = sope__call_history(c)->head; m; m = m->next)
        if (m->role == SOPE__MSG_ASSISTANT) asst = m;
    for (m = asst; m; m = m->next) {
        if (m->role != SOPE__MSG_TOOL) continue;
        if (s->text.len) sope__buf_appends(&s->text, "\n");
        sope__buf_appendf(&s->text, "`%s` %s: ", m->tool_name, m->is_error ? "failed" : "returned");
        sope__buf_append(&s->text, m->content, m->content_len);
        if (m->n_images) sope__buf_appendf(&s->text, " [%zu image%s]", m->n_images, m->n_images > 1 ? "s" : "");
    }
}

static void plan_agents(sope_call *c, mock_state *s, const char *arg, size_t len)
{
    const char *type = NULL, *end = arg + len;
    size_t type_len = 0, n = 0;
    (void)c;

    if (len && *arg == ':') { /* !agent:<type> tasks */
        type = ++arg;
        while (arg < end && *arg != ' ') arg++;
        type_len = (size_t)(arg - type);
    }
    while (arg < end && *arg == ' ') arg++;
    while (arg < end) {
        const char *sep = arg;
        sope_buf input = { 0 };
        while (sep < end && !(sep + 3 <= end && !memcmp(sep, " | ", 3))) sep++;
        sope__buf_appendf(&input, "{\"description\":\"mock task %zu\",\"prompt\":", ++n);
        sope__buf_append_json_string(&input, arg, (size_t)(sep - arg));
        if (type) {
            sope__buf_appends(&input, ",\"subagent_type\":");
            sope__buf_append_json_string(&input, type, type_len);
        }
        sope__buf_appends(&input, "}");
        add_use(s, "agent", &input);
        sope__buf_free(&input);
        arg = sep < end ? sep + 3 : end;
    }
    sope__buf_appendf(&s->text, "Delegating to %zu subagent%s.\n", n, n == 1 ? "" : "s");
}

/* "!name arg ;; !name2 {json} ..." -> one tool use per part. */
static void plan_calls(sope_call *c, mock_state *s, const char *in, size_t len)
{
    const char *end = in + len, *p = in;
    while (p < end) {
        const char *sep = p, *arg, *name_end;
        char name[MAX_TOOL_NAME + 1];
        sope_buf input = { 0 };
        size_t n;
        while (sep < end && !(sep + 4 <= end && !memcmp(sep, " ;; ", 4))) sep++;
        if (*p == '!') p++;
        for (name_end = p; name_end < sep && *name_end != ' '; name_end++) {}
        n = (size_t)(name_end - p);
        if (n && n <= MAX_TOOL_NAME) {
            memcpy(name, p, n);
            name[n] = '\0';
            arg = name_end < sep ? name_end + 1 : sep;
            if (arg < sep && *arg == '{') {
                sope__buf_append(&input, arg, (size_t)(sep - arg));
            } else {
                sope__buf_appends(&input, "{\"input\":");
                sope__buf_append_json_string(&input, arg, (size_t)(sep - arg));
                sope__buf_appends(&input, "}");
            }
            if (sope__call_has_tool(c, name)) {
                sope__buf_appendf(&s->text, "Calling `%s`.\n", name);
                add_use(s, name, &input);
            } else {
                sope__buf_appendf(&s->text, "mock: no tool named `%s` is available.\n", name);
            }
        }
        sope__buf_free(&input);
        p = sep < end ? sep + 4 : end;
    }
}

static void *mock_start(sope_call *c)
{
    static const char tail[] =
        "\n\nThis is the sope mock provider. It streams this reply in small chunks so you can watch the event "
        "flow. Try `!echo hello`, `!clock`, `!sleep 3`, `!agent <task>` or `!panic`.";
    const sope_history *h = sope__call_history(c);
    const sope_message *last = h->tail;
    mock_state *s = calloc(1, sizeof *s);
    char *v = sope__call_option(c, "mock.delay_ms");
    const char *in;
    size_t len;

    if (!s) {
        free(v);
        return NULL;
    }
    s->delay = 25;
    if (v) {
        char *end;
        long ms = strtol(v, &end, 10);
        if (*v && !*end && ms >= 0 && ms <= 10000) s->delay = (int32_t)ms;
        free(v);
    }

    if (sope__call_is_compaction(c)) { /* one line per user message of the transcript */
        const char *p = last ? last->content : "", *end = p + (last ? last->content_len : 0);
        sope__buf_appends(&s->text, "mock summary:");
        while ((p = strstr(p, "\n[user]\n")) && p < end) {
            const char *q;
            p += 8;
            q = memchr(p, '\n', (size_t)(end - p));
            sope__buf_appends(&s->text, "\n- ");
            sope__buf_append(&s->text, p, (size_t)((q ? q : end) - p));
        }
        return s;
    }
    if (last && last->role == SOPE__MSG_TOOL) {
        plan_tool_results(c, s);
        return s;
    }
    in = last ? last->content : "";
    len = last ? last->content_len : 0;
    sope__call_log(c, SOPE_LOG_DEBUG, "mock: round %" PRIu64 ", %zu bytes of input, %d ms per chunk",
                   sope__call_round(c), len, (int)s->delay);

    if (len == 0 || in[0] != '!') {
        sope__buf_appends(&s->text, "You said: ");
        sope__buf_append(&s->text, in, len);
        if (last && last->n_images) sope__buf_appendf(&s->text, " (with %zu image%s)", last->n_images, last->n_images > 1 ? "s" : "");
        sope__buf_append(&s->text, tail, sizeof tail - 1);
    } else if (len == 6 && !memcmp(in, "!panic", 6)) {
        sope__call_error(c, SOPE_ERROR, "mock: simulated provider failure");
        free(s);
        return NULL;
    } else if (len == 8 && !memcmp(in, "!history", 8)) {
        sope__buf_appendf(&s->text, "history: %zu messages", h->count);
    } else if (len >= 6 && !memcmp(in, "!agent", 6) && (len == 6 || in[6] == ' ' || in[6] == ':') &&
               sope__call_has_tool(c, "agent")) {
        plan_agents(c, s, in + 6, len - 6);
    } else {
        char name[MAX_TOOL_NAME + 1];
        size_t n = 0;
        while (n + 1 < len && in[n + 1] != ' ') n++;
        if (n == 0 || n > MAX_TOOL_NAME) {
            sope__buf_appends(&s->text, "mock: expected `!<tool> [input]`.");
        } else {
            memcpy(name, in + 1, n);
            name[n] = '\0';
            if (!sope__call_has_tool(c, name)) {
                sope__buf_appendf(&s->text, "mock: no tool named `%s` is available.", name);
            } else {
                plan_calls(c, s, in, len);
            }
        }
    }
    return s;
}

static sope_step mock_step(sope_call *c, void *state)
{
    mock_state *s = state;
    const char *p;
    size_t i;

    if (s->text.oom || s->uses.oom) {
        sope__call_error(c, SOPE_ENOMEM, "mock: out of memory");
        return (sope_step){ SOPE__STEP_DONE, SOPE_ENOMEM };
    }
    if (s->pos < s->text.len) {
        size_t n = next_chunk(s->text.ptr + s->pos, s->text.len - s->pos);
        sope__call_text(c, s->text.ptr + s->pos, n);
        s->pos += n;
        if (s->pos < s->text.len)
            return s->delay > 0 ? (sope_step){ SOPE__STEP_SLEEP, s->delay } : (sope_step){ SOPE__STEP_CONTINUE, 0 };
    }

    for (i = 0, p = s->uses.ptr; i < s->n_uses; i++) {
        const char *name = p, *input = p + strlen(p) + 1;
        char id[48];
        snprintf(id, sizeof id, "mock_%" PRIu64 "_%zu", sope__call_round(c), i);
        if (sope__call_tool_use(c, id, name, input, strlen(input)) != SOPE_OK) {
            sope__call_error(c, SOPE_ENOMEM, "mock: out of memory");
            return (sope_step){ SOPE__STEP_DONE, SOPE_ENOMEM };
        }
        p = input + strlen(input) + 1;
    }
    sope__call_usage(c, sope__call_history(c)->count * 10, s->text.len / 4);
    return (sope_step){ SOPE__STEP_DONE, SOPE_OK };
}

static void mock_finish(void *state)
{
    mock_state *s = state;
    sope__buf_free(&s->text);
    sope__buf_free(&s->uses);
    free(s);
}

const sope_provider sope__provider_mock = { "mock", mock_start, mock_step, mock_finish };
