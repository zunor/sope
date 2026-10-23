/* SPDX-License-Identifier: MIT */
/*
 * provider_openai.c - OpenAI-compatible Chat Completions with streaming.
 *
 * Works with any server implementing POST {base_url}/chat/completions with
 * "stream": true (OpenAI, GLM, DeepSeek, Qwen, vLLM, ...). Handles streamed
 * text, `reasoning_content` thinking, parallel tool calls assembled from
 * fragments by `index`, and the final usage chunk.
 *
 * Options: openai.base_url (default https://api.openai.com/v1),
 * openai.api_key, model (required), openai.max_tokens.
 */
#include "sope_internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define MAX_TOOL_CALLS 64
#define MAX_ERROR_BODY 1500
#define MAX_ATTEMPTS 3

typedef struct {
    sope_buf id, name, args;
    int used;
} tool_call_acc;

typedef struct {
    sope_buf url, body, auth; /* kept for retries */
    char *ca_file;            /* option tls.ca_file, or NULL */
    sope_http *http;          /* NULL while waiting to retry */
    int attempts;
    int emitted; /* output reached the host: retrying would duplicate it */
    sope_buf in; /* received bytes not yet parsed */
    long status;
    int saw_done; /* data: [DONE] */
    tool_call_acc calls[MAX_TOOL_CALLS];
} oa_state;

static void put_key(sope_buf *b, const char *key)
{
    sope__buf_append_json_string(b, key, strlen(key));
    sope__buf_appends(b, ":");
}

static void put_string(sope_buf *b, const char *key, const char *s, size_t n)
{
    put_key(b, key);
    sope__buf_append_json_string(b, s, n);
}

/* "content" as an array: the text, then each image as a data URL. */
static void put_parts(sope_buf *b, const char *text, size_t len, const sope_image *images, size_t n)
{
    size_t i;
    put_key(b, "content");
    sope__buf_appends(b, "[{\"type\":\"text\",");
    put_string(b, "text", text, len);
    sope__buf_appends(b, "}");
    for (i = 0; i < n; i++) {
        sope__buf_appendf(b, ",{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:%s;base64,", images[i].media_type);
        sope__buf_append(b, images[i].data, images[i].len);
        sope__buf_appends(b, "\"}}");
    }
    sope__buf_appends(b, "]");
}

/* Tool messages carry text only, so the images of a round's results
 * [from, to] follow them in one user message, each after its tool's name. */
static void append_tool_images(sope_buf *b, const sope_message *from, const sope_message *to)
{
    const sope_message *m;
    size_t i;
    int any = 0;
    for (m = from; m && !any; m = m == to ? NULL : m->next) any = m->n_images != 0;
    if (!any) return;
    sope__buf_appends(b, ",{\"role\":\"user\",\"content\":[{\"type\":\"text\",\"text\":"
                         "\"(Images returned by the tool calls above.)\"}");
    for (m = from; m; m = m == to ? NULL : m->next) {
        if (!m->n_images) continue;
        sope__buf_appends(b, ",{\"type\":\"text\",");
        put_key(b, "text");
        {
            sope_buf label = { 0 };
            sope__buf_appendf(&label, "From %s (%s):", m->tool_name, m->tool_use_id);
            sope__buf_append_json_string(b, label.ptr ? label.ptr : "", label.len);
            sope__buf_free(&label);
        }
        sope__buf_appends(b, "}");
        for (i = 0; i < m->n_images; i++) {
            sope__buf_appendf(b, ",{\"type\":\"image_url\",\"image_url\":{\"url\":\"data:%s;base64,", m->images[i].media_type);
            sope__buf_append(b, m->images[i].data, m->images[i].len);
            sope__buf_appends(b, "\"}}");
        }
    }
    sope__buf_appends(b, "]}");
}

static int history_has_images(const sope_history *h)
{
    const sope_message *m;
    for (m = h->head; m; m = m->next)
        if (m->n_images) return 1;
    return 0;
}

static void build_body(sope_call *c, sope_buf *b, const char *model, const char *max_tokens)
{
    const sope_history *h = sope__call_history(c);
    const char *system = sope__call_system(c);
    const sope_message *m, *tools = NULL; /* first tool result of the current round */
    sope_msg_role prev_role = SOPE__MSG_USER;
    size_t i, n = sope__call_tool_count(c);
    int first = 1;

    sope__buf_appends(b, "{");
    put_string(b, "model", model, strlen(model));
    sope__buf_appends(b, ",\"stream\":true,\"stream_options\":{\"include_usage\":true}");
    if (max_tokens) sope__buf_appendf(b, ",\"max_tokens\":%ld", strtol(max_tokens, NULL, 10));

    sope__buf_appends(b, ",\"messages\":[");
    if (system && *system) {
        sope__buf_appends(b, "{\"role\":\"system\",");
        put_string(b, "content", system, strlen(system));
        sope__buf_appends(b, "}");
        first = 0;
    }
    for (m = h->head; m; m = m->next) {
        if (!first) sope__buf_appends(b, ",");
        first = 0;
        if (m->role == SOPE__MSG_TOOL && (!tools || prev_role != SOPE__MSG_TOOL)) tools = m;
        prev_role = m->role;
        switch (m->role) {
        case SOPE__MSG_USER:
            sope__buf_appends(b, "{\"role\":\"user\",");
            if (m->n_images)
                put_parts(b, m->content, m->content_len, m->images, m->n_images);
            else
                put_string(b, "content", m->content, m->content_len);
            break;
        case SOPE__MSG_TOOL:
            sope__buf_appends(b, "{\"role\":\"tool\",");
            put_string(b, "tool_call_id", m->tool_use_id, strlen(m->tool_use_id));
            sope__buf_appends(b, ",");
            put_string(b, "content", m->content, m->content_len);
            break;
        case SOPE__MSG_ASSISTANT:
            sope__buf_appends(b, "{\"role\":\"assistant\",");
            if (m->content_len)
                put_string(b, "content", m->content, m->content_len);
            else
                sope__buf_appends(b, "\"content\":null");
            if (m->n_tool_uses) {
                sope__buf_appends(b, ",\"tool_calls\":[");
                for (i = 0; i < m->n_tool_uses; i++) {
                    const sope_tool_use *u = &m->tool_uses[i];
                    if (i) sope__buf_appends(b, ",");
                    sope__buf_appends(b, "{");
                    put_string(b, "id", u->id, strlen(u->id));
                    sope__buf_appends(b, ",\"type\":\"function\",\"function\":{");
                    put_string(b, "name", u->name, strlen(u->name));
                    sope__buf_appends(b, ",");
                    put_string(b, "arguments", u->input, u->input_len); /* a JSON string, per the API */
                    sope__buf_appends(b, "}}");
                }
                sope__buf_appends(b, "]");
            }
            break;
        }
        sope__buf_appends(b, "}");
        if (m->role == SOPE__MSG_TOOL && (!m->next || m->next->role != SOPE__MSG_TOOL)) append_tool_images(b, tools, m);
    }
    sope__buf_appends(b, "]");

    if (n) {
        sope__buf_appends(b, ",\"tools\":[");
        for (i = 0; i < n; i++) {
            const sope_tool_spec *t = sope__call_tool(c, i);
            if (i) sope__buf_appends(b, ",");
            sope__buf_appends(b, "{\"type\":\"function\",\"function\":{");
            put_string(b, "name", t->name, strlen(t->name));
            sope__buf_appends(b, ",");
            put_string(b, "description", t->description, strlen(t->description));
            sope__buf_appends(b, ",\"parameters\":");
            sope__buf_appends(b, t->input_schema); /* validated JSON, embedded as is */
            sope__buf_appends(b, "}}");
        }
        sope__buf_appends(b, "]");
    }
    sope__buf_appends(b, "}");
}

static sope_http *post(sope_call *c, oa_state *s)
{
    const char *headers[3];
    size_t n = 0;
    headers[n++] = "Content-Type: application/json";
    headers[n++] = "Accept: text/event-stream";
    if (s->auth.len) headers[n++] = s->auth.ptr;
    s->attempts++;
    return sope__http_post(s->url.ptr, headers, n, s->body.ptr, s->body.len, s->ca_file, sope__call_task(c));
}

static void oa_free(oa_state *s)
{
    size_t i;
    sope__http_release(s->http);
    sope__buf_free(&s->url);
    sope__buf_free(&s->body);
    sope__buf_free(&s->auth);
    free(s->ca_file);
    sope__buf_free(&s->in);
    for (i = 0; i < MAX_TOOL_CALLS; i++) {
        sope__buf_free(&s->calls[i].id);
        sope__buf_free(&s->calls[i].name);
        sope__buf_free(&s->calls[i].args);
    }
    free(s);
}

static void *oa_start(sope_call *c)
{
    char *base = sope__call_option(c, "openai.base_url");
    char *key = sope__call_option(c, "openai.api_key");
    char *model = sope__call_option(c, "model");
    char *image_model = sope__call_option(c, "image_model");
    char *max_tokens = sope__call_option(c, "openai.max_tokens");
    oa_state *s = NULL;
    size_t base_len;

    if (!model) {
        sope__call_error(c, SOPE_EINVAL, "openai: option \"model\" is not set");
        goto done;
    }
    if (!sope__http_available()) {
        sope__call_error(c, SOPE_ERROR, "openai: this build of sope has no HTTP support (libcurl)");
        goto done;
    }
    if (!(s = calloc(1, sizeof *s))) {
        sope__call_error(c, SOPE_ENOMEM, "openai: out of memory");
        goto done;
    }
    sope__buf_appends(&s->url, base ? base : "https://api.openai.com/v1");
    base_len = s->url.len;
    while (base_len && s->url.ptr[base_len - 1] == '/') base_len--;
    s->url.len = base_len;
    sope__buf_appends(&s->url, "/chat/completions");
    /* A model that reads images takes over once the conversation has any. */
    build_body(c, &s->body, image_model && *image_model && history_has_images(sope__call_history(c)) ? image_model : model,
               max_tokens);
    if (key && *key) sope__buf_appendf(&s->auth, "Authorization: Bearer %s", key);
    s->ca_file = sope__call_option(c, "tls.ca_file");
    if (s->url.oom || s->body.oom || s->auth.oom) {
        sope__call_error(c, SOPE_ENOMEM, "openai: out of memory");
        oa_free(s);
        s = NULL;
        goto done;
    }

    sope__call_log(c, SOPE_LOG_DEBUG, "openai: round %llu, POST %s (model %s, %zu tools, %zu bytes)",
                   (unsigned long long)sope__call_round(c), s->url.ptr, model, sope__call_tool_count(c),
                   s->body.len);
    if (!(s->http = post(c, s))) {
        sope__call_error(c, SOPE_ERROR, "openai: %s", sope_last_error());
        oa_free(s);
        s = NULL;
    }

done:
    free(base);
    free(key);
    free(model);
    free(image_model);
    free(max_tokens);
    return s;
}

static void accumulate_tool_call(oa_state *s, const sope_json *tc, size_t position)
{
    const sope_json *fn = sope__json_get(tc, "function");
    const char *str;
    size_t n;
    double idx = sope__json_number(sope__json_get(tc, "index"), (double)position);
    tool_call_acc *acc;

    if (idx < 0 || idx >= MAX_TOOL_CALLS) return;
    acc = &s->calls[(size_t)idx];
    acc->used = 1;
    if ((str = sope__json_string(sope__json_get(tc, "id"), &n)) && n && !acc->id.len) sope__buf_append(&acc->id, str, n);
    if ((str = sope__json_string(sope__json_get(fn, "name"), &n))) sope__buf_append(&acc->name, str, n);
    if ((str = sope__json_string(sope__json_get(fn, "arguments"), &n))) sope__buf_append(&acc->args, str, n);
}

/* Handles one `data:` payload. Returns 0 if the server reported an error. */
static int handle_chunk(sope_call *c, oa_state *s, const char *data, size_t n)
{
    sope_json *root = sope__json_parse(data, n);
    const sope_json *err, *delta, *calls, *usage;
    const char *str;
    size_t len, i;

    if (!root) {
        sope__call_log(c, SOPE_LOG_WARN, "openai: skipping malformed chunk: %.*s", (int)(n > 200 ? 200 : n), data);
        return 1;
    }
    if ((err = sope__json_get(root, "error"))) {
        str = sope__json_string(sope__json_get(err, "message"), &len);
        sope__call_error(c, SOPE_ERROR, "openai: %.*s", str ? (int)len : (int)n, str ? str : data);
        sope__json_free(root);
        return 0;
    }

    delta = sope__json_get(sope__json_at(sope__json_get(root, "choices"), 0), "delta");
    if ((str = sope__json_string(sope__json_get(delta, "reasoning_content"), &len)) ||
        (str = sope__json_string(sope__json_get(delta, "reasoning"), &len))) {
        sope__call_thinking(c, str, len);
        s->emitted |= len > 0;
    }
    if ((str = sope__json_string(sope__json_get(delta, "content"), &len))) {
        sope__call_text(c, str, len);
        s->emitted |= len > 0;
    }
    if ((calls = sope__json_get(delta, "tool_calls")) && calls->type == SOPE_JSON_ARRAY) {
        const sope_json *tc;
        for (tc = calls->child, i = 0; tc; tc = tc->next, i++) accumulate_tool_call(s, tc, i);
    }
    if ((usage = sope__json_get(root, "usage")) && usage->type == SOPE_JSON_OBJECT)
        sope__call_usage(c, (uint64_t)sope__json_number(sope__json_get(usage, "prompt_tokens"), 0),
                         (uint64_t)sope__json_number(sope__json_get(usage, "completion_tokens"), 0));
    sope__json_free(root);
    return 1;
}

/* Parses complete SSE lines from s->in. Returns 0 on a server-reported error. */
static int parse_lines(sope_call *c, oa_state *s, int final)
{
    for (;;) {
        char *nl = s->in.len ? memchr(s->in.ptr, '\n', s->in.len) : NULL;
        size_t len, consumed;
        const char *line;

        if (!nl && !(final && s->in.len)) return 1;
        len = nl ? (size_t)(nl - s->in.ptr) : s->in.len;
        consumed = nl ? len + 1 : len;
        line = s->in.ptr;
        if (len && line[len - 1] == '\r') len--;

        if (len >= 5 && !memcmp(line, "data:", 5)) {
            const char *data = line + 5;
            size_t n = len - 5;
            while (n && *data == ' ') data++, n--;
            if (n == 6 && !memcmp(data, "[DONE]", 6)) s->saw_done = 1;
            else if (n && !handle_chunk(c, s, data, n)) return 0;
        }
        sope__buf_consume(&s->in, consumed);
    }
}

/* Transient failures before any output reached the host are retried. */
static int should_retry(const oa_state *s, const char *err)
{
    if (s->emitted || s->attempts >= MAX_ATTEMPTS) return 0;
    return s->status == 429 || s->status >= 500 || (s->status == 0 && err[0]);
}

static sope_step retry(sope_call *c, oa_state *s, const char *why)
{
    int32_t delay = 1000 << (s->attempts - 1); /* 1 s, 2 s */
    sope__call_log(c, SOPE_LOG_WARN, "openai: %s; retrying in %d ms (attempt %d of %d)", why, (int)delay,
                   s->attempts + 1, MAX_ATTEMPTS);
    sope__http_release(s->http);
    s->http = NULL;
    s->in.len = 0;
    s->status = 0;
    s->saw_done = 0;
    return (sope_step){ SOPE__STEP_SLEEP, delay };
}

static sope_step oa_step(sope_call *c, void *state)
{
    oa_state *s = state;
    char err[256];
    int finished;
    size_t i;

    if (!s->http) { /* back from a retry delay */
        if (!(s->http = post(c, s))) {
            sope__call_error(c, SOPE_ERROR, "openai: %s", sope_last_error());
            return (sope_step){ SOPE__STEP_DONE, SOPE_ERROR };
        }
        return (sope_step){ SOPE__STEP_WAIT, 0 };
    }
    finished = sope__http_take(s->http, &s->in, &s->status, err, sizeof err);

    if (s->in.oom) {
        sope__call_error(c, SOPE_ENOMEM, "openai: out of memory");
        return (sope_step){ SOPE__STEP_DONE, SOPE_ENOMEM };
    }
    if (s->status >= 400) { /* the body is an error document, not a stream */
        if (!finished) return (sope_step){ SOPE__STEP_WAIT, 0 };
        if (should_retry(s, err)) {
            char why[32];
            snprintf(why, sizeof why, "HTTP %ld", s->status);
            return retry(c, s, why);
        }
        sope__call_error(c, SOPE_ERROR, "openai: HTTP %ld: %.*s", s->status,
                         (int)(s->in.len > MAX_ERROR_BODY ? MAX_ERROR_BODY : s->in.len), s->in.ptr ? s->in.ptr : "");
        return (sope_step){ SOPE__STEP_DONE, SOPE_ERROR };
    }
    if (!parse_lines(c, s, finished)) return (sope_step){ SOPE__STEP_DONE, SOPE_ERROR };
    if (!finished && !s->saw_done) return (sope_step){ SOPE__STEP_WAIT, 0 };
    if (!s->saw_done && err[0]) {
        if (should_retry(s, err)) return retry(c, s, err);
        sope__call_error(c, SOPE_ERROR, "openai: request failed: %s", err);
        return (sope_step){ SOPE__STEP_DONE, SOPE_ERROR };
    }

    for (i = 0; i < MAX_TOOL_CALLS; i++) {
        tool_call_acc *acc = &s->calls[i];
        if (!acc->used || !acc->name.len) continue;
        if (acc->id.oom || acc->name.oom || acc->args.oom ||
            sope__call_tool_use(c, acc->id.ptr, acc->name.ptr, acc->args.ptr, acc->args.len) != SOPE_OK) {
            sope__call_error(c, SOPE_ENOMEM, "openai: out of memory");
            return (sope_step){ SOPE__STEP_DONE, SOPE_ENOMEM };
        }
    }
    return (sope_step){ SOPE__STEP_DONE, SOPE_OK };
}

static void oa_finish(void *state)
{
    oa_free(state);
}

const sope_provider sope__provider_openai = { "openai", oa_start, oa_step, oa_finish };
