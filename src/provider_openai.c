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
#include "agent.h"

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
    int responses;
    int attempts;
    int emitted; /* output reached the host: retrying would duplicate it */
    sope_buf in; /* received bytes not yet parsed */
    long status;
    int saw_done; /* data: [DONE] */
    int finish; /* 1: stop, 2: tool_calls; other reasons fail the call */
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

static void build_body(sope_call *c, sope_buf *b, const char *model)
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
    sope__buf_appendf(b, ",\"max_tokens\":%llu", (unsigned long long)sope__call_max_tokens(c));

    char *effort = sope__call_option(c, "reasoning.effort");
    if (effort) { sope__buf_appends(b, ","); put_string(b, "reasoning_effort", effort, strlen(effort)); }
    free(effort);
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

/* Stateless Responses requests replay complete output items. In particular,
 * encrypted reasoning is opaque provider state and must survive tool rounds,
 * history serialization and crash recovery without being summarized in place. */
static void response_parts(sope_buf *b, const sope_message *m)
{
    sope__buf_appends(b, "[{\"type\":\"input_text\",");
    put_string(b, "text", m->content, m->content_len);
    sope__buf_appends(b, "}");
    for (size_t i = 0; i < m->n_images; i++) {
        sope__buf_appendf(b, ",{\"type\":\"input_image\",\"image_url\":\"data:%s;base64,", m->images[i].media_type);
        sope__buf_append(b, m->images[i].data, m->images[i].len);
        sope__buf_appends(b, "\"}");
    }
    sope__buf_appends(b, "]");
}
static void build_responses(sope_call *c, sope_buf *b, const char *model)
{
    sope__buf_appends(b, "{"); put_string(b, "model", model, strlen(model));
    sope__buf_appendf(b, ",\"stream\":true,\"store\":false,\"include\":[\"reasoning.encrypted_content\"],\"max_output_tokens\":%llu",
                     (unsigned long long)sope__call_max_tokens(c));
    const char *system = sope__call_system(c);
    if (system && *system) { sope__buf_appends(b, ","); put_string(b, "instructions", system, strlen(system)); }
    char *effort = sope__call_option(c, "reasoning.effort");
    if (effort) { sope__buf_appends(b, ",\"reasoning\":{"); put_string(b, "effort", effort, strlen(effort)); sope__buf_appends(b, "}"); }
    free(effort);
    sope__buf_appends(b, ",\"input\":[");
    int first = 1;
    for (const sope_message *m = sope__call_history(c)->head; m; m = m->next) {
        if (m->response_items) {
            size_t len = strlen(m->response_items);
            if (len > 2) {
                if (!first) sope__buf_appends(b, ","); first = 0;
                sope__buf_append(b, m->response_items + 1, len - 2);
            }
            continue;
        }
        if (!first) sope__buf_appends(b, ","); first = 0;
        if (m->role == SOPE__MSG_TOOL) {
            sope__buf_appends(b, "{\"type\":\"function_call_output\",");
            put_string(b, "call_id", m->tool_use_id, strlen(m->tool_use_id));
            sope__buf_appends(b, ",\"output\":");
            if (m->n_images) response_parts(b, m);
            else sope__buf_append_json_string(b, m->content, m->content_len);
            sope__buf_appends(b, "}");
        } else {
            sope__buf_appendf(b, "{\"role\":\"%s\",\"content\":", m->role == SOPE__MSG_ASSISTANT ? "assistant" : "user");
            if (m->n_images) response_parts(b, m);
            else sope__buf_append_json_string(b, m->content, m->content_len);
            sope__buf_appends(b, "}");
            for (size_t i = 0; i < m->n_tool_uses; i++) {
                const sope_tool_use *u = &m->tool_uses[i];
                sope__buf_appends(b, ",{\"type\":\"function_call\",");
                put_string(b, "call_id", u->id, strlen(u->id)); sope__buf_appends(b, ",");
                put_string(b, "name", u->name, strlen(u->name)); sope__buf_appends(b, ",");
                put_string(b, "arguments", u->input, u->input_len); sope__buf_appends(b, "}");
            }
        }
    }
    sope__buf_appends(b, "]");
    size_t n = sope__call_tool_count(c);
    if (n) {
        sope__buf_appends(b, ",\"tools\":[");
        for (size_t i = 0; i < n; i++) {
            const sope_tool_spec *t = sope__call_tool(c, i);
            sope__buf_appends(b, i ? ",{\"type\":\"function\",\"strict\":false," : "{\"type\":\"function\",\"strict\":false,");
            put_string(b, "name", t->name, strlen(t->name)); sope__buf_appends(b, ",");
            put_string(b, "description", t->description, strlen(t->description));
            sope__buf_appends(b, ",\"parameters\":"); sope__buf_appends(b, t->input_schema); sope__buf_appends(b, "}");
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
    char *wire = sope__call_option(c, "openai.wire_api");
    char *image_model = sope__call_option(c, "image_model");
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
    if (wire && strcmp(wire, "chat") && strcmp(wire, "responses")) {
        sope__call_error(c, SOPE_EINVAL, "openai.wire_api must be chat or responses"); oa_free(s); s = NULL; goto done;
    }
    if (key && (strchr(key, '\r') || strchr(key, '\n'))) {
        sope__call_error(c, SOPE_EINVAL, "credential contains a line break"); oa_free(s); s = NULL; goto done;
    }
    s->responses = wire && !strcmp(wire, "responses");
    sope__buf_appends(&s->url, base ? base : "https://api.openai.com/v1");
    base_len = s->url.len;
    while (base_len && s->url.ptr[base_len - 1] == '/') base_len--;
    s->url.len = base_len;
    sope__buf_appends(&s->url, s->responses ? "/responses" : "/chat/completions");
    /* A model that reads images takes over once the conversation has any. */
    (s->responses ? build_responses : build_body)(c, &s->body, image_model && *image_model && history_has_images(sope__call_history(c)) ? image_model : model);
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
    free(wire);
    free(base);
    free(key);
    free(model);
    free(image_model);
    return s;
}

static int accumulate_tool_call(oa_state *s, const sope_json *tc, size_t position)
{
    const sope_json *fn = sope__json_get(tc, "function");
    const char *str;
    size_t n;
    double idx = sope__json_number(sope__json_get(tc, "index"), (double)position);
    tool_call_acc *acc;

    if (!(idx >= 0 && idx < MAX_TOOL_CALLS) || (double)(size_t)idx != idx) return 0;
    acc = &s->calls[(size_t)idx];
    acc->used = 1;
    if ((str = sope__json_string(sope__json_get(tc, "id"), &n)) && n && !acc->id.len) sope__buf_append(&acc->id, str, n);
    if ((str = sope__json_string(sope__json_get(fn, "name"), &n))) sope__buf_append(&acc->name, str, n);
    if ((str = sope__json_string(sope__json_get(fn, "arguments"), &n))) sope__buf_append(&acc->args, str, n);
    return 1;
}

/* Handles one `data:` payload. Returns 0 if the server reported an error. */
static void classify_error(sope_call *c, const sope_json *error)
{
    const char *code = sope__json_string(sope__json_get(error, "code"), NULL);
    if (code && (!strcmp(code, "context_length_exceeded") || !strcmp(code, "context_window_exceeded")))
        sope__call_context_exceeded(c);
}

static int usage_count(const sope_json *usage, const char *key, uint64_t *out)
{
    const sope_json *v = sope__json_get(usage, key);
    double n = sope__json_number(v, -1);
    /* Also rejects NaN, infinity, negatives and values outside uint64_t before
     * conversion. Empty/partial usage objects must not reset calibration. */
    if (!v || v->type != SOPE_JSON_NUMBER || !(n >= 0 && n < 0x1p64)) return 0;
    *out = (uint64_t)n;
    return (double)*out == n;
}

static int response_chunk(sope_call *c, oa_state *s, const sope_json *root)
{
    const char *type = sope__json_string(sope__json_get(root, "type"), NULL);
    if (!type) goto invalid;
    if (!strcmp(type, "response.output_text.delta")) {
        size_t n; const char *text = sope__json_string(sope__json_get(root, "delta"), &n);
        if (!text) goto invalid;
        sope__call_text(c, text, n); s->emitted |= n > 0;
    } else if (!strcmp(type, "response.reasoning_summary_text.delta")) {
        size_t n; const char *text = sope__json_string(sope__json_get(root, "delta"), &n);
        if (!text) goto invalid;
        sope__call_thinking(c, text, n); s->emitted |= n > 0;
    } else if (!strcmp(type, "response.completed")) {
        const sope_json *response = sope__json_get(root, "response");
        const char *status = sope__json_string(sope__json_get(response, "status"), NULL);
        const sope_json *output = sope__json_get(response, "output");
        if (!status || strcmp(status, "completed") || !output || output->type != SOPE_JSON_ARRAY) goto invalid;
        sope_buf text = {0}, items = {0};
        int ok = sope__json_canonical(&items, output, 0);
        size_t calls = 0;
        for (const sope_json *v = output->child; ok && v; v = v->next) {
            const char *kind = sope__json_string(sope__json_get(v, "type"), NULL);
            const sope_json *item_status = sope__json_get(v, "status");
            if (!kind || (item_status && item_status->type != SOPE_JSON_NULL &&
                (item_status->type != SOPE_JSON_STRING || strcmp(item_status->str, "completed")))) { ok = 0; break; }
            if (!strcmp(kind, "function_call")) {
                const char *id = sope__json_string(sope__json_get(v, "call_id"), NULL);
                const char *name = sope__json_string(sope__json_get(v, "name"), NULL);
                size_t len; const char *args = sope__json_string(sope__json_get(v, "arguments"), &len);
                sope_json *arguments = args ? sope__json_parse(args, len) : NULL;
                const sope_json *name_value = sope__json_get(v, "name"), *id_value = sope__json_get(v, "call_id");
                ok = id && *id && strlen(id) == id_value->len && name &&
                     sope__valid_name(name, name_value->len) && arguments && arguments->type == SOPE_JSON_OBJECT &&
                     ++calls <= MAX_TOOL_CALLS && !sope__call_is_compaction(c);
                for (size_t i = 0; ok && i < c->n_uses; i++) if (!strcmp(c->uses[i].id, id)) ok = 0;
                if (ok) ok = sope__call_tool_use(c, id, name, args, len) == SOPE_OK;
                sope__json_free(arguments);
            } else if (!strcmp(kind, "message")) {
                const sope_json *content = sope__json_get(v, "content");
                if (!content || content->type != SOPE_JSON_ARRAY) { ok = 0; break; }
                for (const sope_json *part = content->child; part; part = part->next) {
                    const char *part_type = sope__json_string(sope__json_get(part, "type"), NULL);
                    size_t len; const char *value = sope__json_string(sope__json_get(part, "text"), &len);
                    if (!part_type || strcmp(part_type, "output_text") || !value) { ok = 0; break; }
                    sope__buf_append(&text, value, len);
                }
            } else if (!strcmp(kind, "reasoning")) {
                const char *encrypted = sope__json_string(sope__json_get(v, "encrypted_content"), NULL);
                if (!encrypted || !*encrypted) { ok = 0; break; }
            } else { ok = 0; break; }
        }
        /* Completion is authoritative; a mismatch means a corrupt/partial
         * stream. Never dispatch a tool from an incomplete model response. */
        if (c->text.len && (c->text.len != text.len || memcmp(c->text.ptr, text.ptr, text.len))) ok = 0;
        if (ok && !text.oom && !items.oom) {
            if (!c->text.len && text.len) sope__call_text(c, text.ptr, text.len);
            c->response_items = items.ptr; items.ptr = NULL;
            s->finish = calls ? 2 : 1; s->saw_done = 1;
            const sope_json *usage = sope__json_get(response, "usage");
            uint64_t input, out;
            if (usage_count(usage, "input_tokens", &input) && usage_count(usage, "output_tokens", &out)) sope__call_usage(c, input, out);
        } else ok = 0;
        sope__buf_free(&text); sope__buf_free(&items);
        if (!ok) goto invalid;
    } else if (!strcmp(type, "response.failed") || !strcmp(type, "response.incomplete") || !strcmp(type, "error")) {
        classify_error(c, sope__json_get(sope__json_get(root, "response"), "error"));
        sope__call_error(c, SOPE_ERROR, "openai: %s", type); return 0;
    }
    return 1;
invalid:
    sope__call_error(c, SOPE_ERROR, "openai: invalid or incomplete Responses output");
    return 0;
}
static int handle_chunk(sope_call *c, oa_state *s, const char *data, size_t n)
{
    sope_json *root = sope__json_parse(data, n);
    const sope_json *err, *delta, *calls, *usage, *choice;
    const char *str;
    size_t len, i;

    if (!root) {
        sope__call_error(c, SOPE_ERROR, "openai: malformed stream chunk");
        return 0;
    }
    if ((err = sope__json_get(root, "error"))) {
        classify_error(c, err);
        str = sope__json_string(sope__json_get(err, "message"), &len);
        sope__call_error(c, SOPE_ERROR, "openai: %.*s", str ? (int)len : (int)n, str ? str : data);
        sope__json_free(root);
        return 0;
    }

    if (s->responses) { int ok = response_chunk(c, s, root); sope__json_free(root); return ok; }
    choice = sope__json_at(sope__json_get(root, "choices"), 0);
    if (choice && s->finish) {
        sope__call_error(c, SOPE_ERROR, "openai: response content after finish_reason");
        sope__json_free(root);
        return 0;
    }
    delta = sope__json_get(choice, "delta");
    calls = sope__json_get(delta, "tool_calls");
    str = sope__json_string(sope__json_get(delta, "refusal"), &len);
    if (sope__call_is_compaction(c) && ((str && len) ||
        (calls && calls->type != SOPE_JSON_NULL && (calls->type != SOPE_JSON_ARRAY || calls->count)))) {
        sope__call_error(c, SOPE_ERROR, "openai: compaction returned a refusal or tool call");
        sope__json_free(root);
        return 0;
    }
    str = sope__json_string(sope__json_get(choice, "finish_reason"), NULL);
    if (str) {
        if (!strcmp(str, "stop")) s->finish = 1;
        else if (!strcmp(str, "tool_calls") && !sope__call_is_compaction(c)) s->finish = 2;
        else {
            sope__call_error(c, SOPE_ERROR, "openai: incomplete response (finish_reason=%s)", str);
            sope__json_free(root);
            return 0;
        }
    }
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
        for (tc = calls->child, i = 0; tc; tc = tc->next, i++) {
            if (!accumulate_tool_call(s, tc, i)) {
                sope__call_error(c, SOPE_ERROR, "openai: invalid tool call index");
                sope__json_free(root);
                return 0;
            }
        }
    }
    if ((usage = sope__json_get(root, "usage")) && usage->type == SOPE_JSON_OBJECT) {
        uint64_t input, output;
        if (usage_count(usage, "prompt_tokens", &input) && usage_count(usage, "completion_tokens", &output))
            sope__call_usage(c, input, output);
    }
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
            if (s->saw_done || (n == 6 && !memcmp(data, "[DONE]", 6) && !s->finish)) {
                sope__call_error(c, SOPE_ERROR, "openai: out-of-order stream terminator");
                return 0;
            }
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
    s->finish = 0;
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
        sope_json *body = sope__json_parse(s->in.ptr, s->in.len);
        classify_error(c, sope__json_get(body, "error"));
        sope__json_free(body);
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

    if (!s->saw_done || !s->finish) {
        sope__call_error(c, SOPE_ERROR, "openai: incomplete stream (missing finish_reason or [DONE])");
        return (sope_step){ SOPE__STEP_DONE, SOPE_ERROR };
    }
    size_t used = 0;
    for (i = 0; i < MAX_TOOL_CALLS; i++) {
        tool_call_acc *acc = &s->calls[i];
        if (!acc->used) continue;
        used++;
        if (sope__call_is_compaction(c)) {
            sope__call_error(c, SOPE_ERROR, "openai: compaction returned a tool call");
            return (sope_step){ SOPE__STEP_DONE, SOPE_ERROR };
        }
        if (acc->id.oom || acc->name.oom || acc->args.oom) {
            sope__call_error(c, SOPE_ENOMEM, "openai: out of memory");
            return (sope_step){ SOPE__STEP_DONE, SOPE_ENOMEM };
        }
        sope_json *args = sope__json_parse(acc->args.len ? acc->args.ptr : "{}", acc->args.len ? acc->args.len : 2);
        int valid = s->finish == 2 && sope__valid_name(acc->name.ptr, acc->name.len) &&
                    (!acc->id.len || strlen(acc->id.ptr) == acc->id.len) && args && args->type == SOPE_JSON_OBJECT;
        sope__json_free(args);
        for (size_t j = 0; valid && j < i; j++)
            if (acc->id.len && s->calls[j].id.len && !strcmp(acc->id.ptr, s->calls[j].id.ptr)) valid = 0;
        if (!valid) {
            sope__call_error(c, SOPE_ERROR, "openai: invalid or incomplete tool batch");
            return (sope_step){ SOPE__STEP_DONE, SOPE_ERROR };
        }
    }
    if (!s->responses && s->finish == 2 && !used) {
        sope__call_error(c, SOPE_ERROR, "openai: empty tool batch");
        return (sope_step){ SOPE__STEP_DONE, SOPE_ERROR };
    }
    /* Validate the entire batch before making any of it executable. */
    for (i = 0; i < MAX_TOOL_CALLS; i++) {
        tool_call_acc *acc = &s->calls[i];
        if (acc->used && sope__call_tool_use(c, acc->id.ptr, acc->name.ptr, acc->args.ptr, acc->args.len) != SOPE_OK) {
            sope__call_error(c, SOPE_ENOMEM, "openai: out of memory");
            return (sope_step){ SOPE__STEP_DONE, SOPE_ENOMEM };
        }
    }
    sope__call_complete(c);
    return (sope_step){ SOPE__STEP_DONE, SOPE_OK };
}

static void oa_finish(void *state)
{
    oa_free(state);
}

const sope_provider sope__provider_openai = { "openai", oa_start, oa_step, oa_finish };
