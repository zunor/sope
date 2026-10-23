/* SPDX-License-Identifier: MIT */
/*
 * history.c - the conversation: messages, the history list, and its JSON
 * form (sope_agent_history, sope_agent_load_history).
 *
 * The history is plain data owned by whoever holds it: the agent's task
 * during a turn, the host between turns, a compaction call for its request.
 * Nothing here locks.
 */
#include "sope_internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ------------------------------------------------------------------------ */
/* messages                                                                  */
/* ------------------------------------------------------------------------ */

void sope__tool_uses_free(sope_tool_use *uses, size_t n)
{
    size_t i;
    for (i = 0; i < n; i++) {
        free(uses[i].id);
        free(uses[i].name);
        free(uses[i].input);
    }
    free(uses);
}

void sope__message_free(sope_message *m)
{
    if (!m) return;
    sope__images_free(m->images, m->n_images);
    free(m->content);
    sope__tool_uses_free(m->tool_uses, m->n_tool_uses);
    free(m->tool_use_id);
    free(m->tool_name);
    free(m);
}

sope_message *sope__message_new(sope_msg_role role, const char *content, size_t len)
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

sope_message *sope__tool_message(const sope_tool_use *u, const char *content, size_t len, int is_error)
{
    sope_message *m = sope__message_new(SOPE__MSG_TOOL, content, len);
    if (!m) return NULL;
    m->is_error = is_error;
    if (!(m->tool_use_id = sope__strdup(u->id)) || !(m->tool_name = sope__strdup(u->name))) {
        sope__message_free(m);
        return NULL;
    }
    return m;
}

/* ------------------------------------------------------------------------ */
/* the history                                                               */
/* ------------------------------------------------------------------------ */

void sope__history_append(sope_history *h, sope_message *m)
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
        sope__message_free(m);
    }
    h->tail = NULL;
    h->count = 0;
}

sope_message *sope__history_pop(sope_history *h)
{
    sope_message *m = h->tail, *prev = NULL, *p;
    if (!m) return NULL;
    for (p = h->head; p != m; p = p->next) prev = p;
    if (prev)
        prev->next = NULL;
    else
        h->head = NULL;
    h->tail = prev;
    h->count--;
    return m;
}

const sope_message *sope__history_last(const sope_history *h, sope_msg_role role)
{
    const sope_message *m, *last = NULL;
    for (m = h->head; m; m = m->next)
        if (m->role == role) last = m;
    return last;
}

/* A turn that ends early may leave tool uses unanswered, which providers
 * reject on the next request; answer them so the history stays valid. */
void sope__history_repair(sope_history *h)
{
    const sope_message *asst = sope__history_last(h, SOPE__MSG_ASSISTANT), *m;
    sope_message *answer;
    size_t i;
    if (!asst || !asst->n_tool_uses) return;
    for (i = 0; i < asst->n_tool_uses; i++) {
        const sope_tool_use *u = &asst->tool_uses[i];
        int answered = 0;
        for (m = asst->next; m; m = m->next)
            if (m->role == SOPE__MSG_TOOL && !strcmp(m->tool_use_id, u->id)) answered = 1;
        if (!answered && (answer = sope__tool_message(u, "cancelled", 9, 1))) sope__history_append(h, answer);
    }
}

/* ------------------------------------------------------------------------ */
/* JSON                                                                      */
/* ------------------------------------------------------------------------ */

static const char *const ROLE_NAMES[] = { "user", "assistant", "tool" };

static void append_message_json(sope_buf *b, const sope_message *m)
{
    size_t i;
    sope__buf_appendf(b, "{\"role\":\"%s\",\"content\":", ROLE_NAMES[m->role]);
    sope__buf_append_json_string(b, m->content, m->content_len);
    if (m->role == SOPE__MSG_ASSISTANT && m->n_tool_uses) {
        sope__buf_appends(b, ",\"tool_uses\":[");
        for (i = 0; i < m->n_tool_uses; i++) {
            const sope_tool_use *u = &m->tool_uses[i];
            sope__buf_appends(b, i ? ",{\"id\":" : "{\"id\":");
            sope__buf_append_json_string(b, u->id, strlen(u->id));
            sope__buf_appends(b, ",\"name\":");
            sope__buf_append_json_string(b, u->name, strlen(u->name));
            sope__buf_appends(b, ",\"input\":");
            sope__buf_append_json_string(b, u->input, u->input_len);
            sope__buf_appends(b, "}");
        }
        sope__buf_appends(b, "]");
    }
    if (m->role == SOPE__MSG_TOOL) {
        sope__buf_appends(b, ",\"tool_use_id\":");
        sope__buf_append_json_string(b, m->tool_use_id, strlen(m->tool_use_id));
        sope__buf_appends(b, ",\"name\":");
        sope__buf_append_json_string(b, m->tool_name, strlen(m->tool_name));
        sope__buf_appends(b, m->is_error ? ",\"is_error\":true" : ",\"is_error\":false");
    }
    if (m->n_images) {
        sope__buf_appends(b, ",\"images\":[");
        for (i = 0; i < m->n_images; i++) {
            sope__buf_appends(b, i ? ",{\"media_type\":" : "{\"media_type\":");
            sope__buf_append_json_string(b, m->images[i].media_type, strlen(m->images[i].media_type));
            sope__buf_appends(b, ",\"data\":\"");
            sope__buf_append(b, m->images[i].data, m->images[i].len); /* base64 needs no escaping */
            sope__buf_appends(b, "\"}");
        }
        sope__buf_appends(b, "]");
    }
    sope__buf_appends(b, "}");
}

char *sope__history_json(const sope_history *h, size_t *len)
{
    sope_buf b = { 0 };
    const sope_message *m;
    sope__buf_appends(&b, "[");
    for (m = h->head; m; m = m->next) {
        if (m != h->head) sope__buf_appends(&b, ",");
        append_message_json(&b, m);
    }
    sope__buf_appends(&b, "]");
    if (b.oom) {
        sope__buf_free(&b);
        return NULL;
    }
    *len = b.len;
    return b.ptr;
}

/* A string member, copied; NULL if missing or not a string. */
static char *dup_member(const sope_json *obj, const char *key, size_t *len)
{
    size_t n;
    const char *v = sope__json_string(sope__json_get(obj, key), &n);
    if (len) *len = v ? n : 0;
    return v ? sope__strndup(v, n) : NULL;
}

/* One message of a history array; SOPE_EINVAL with err filled when it is
 * not one. */
static int message_from_json(const sope_json *v, size_t index, sope_message **out, char *err, size_t cap)
{
    const sope_json *uses, *u, *flag;
    const char *role, *content;
    size_t content_len = 0, i;
    sope_message *m;

    *out = NULL;
    role = v->type == SOPE_JSON_OBJECT ? sope__json_string(sope__json_get(v, "role"), NULL) : NULL;
    content = role ? sope__json_string(sope__json_get(v, "content"), &content_len) : NULL;
    if (!role) {
        snprintf(err, cap, "message %zu: expected an object with a \"role\"", index);
        return SOPE_EINVAL;
    }
    if (!strcmp(role, "user"))
        m = sope__message_new(SOPE__MSG_USER, content, content_len);
    else if (!strcmp(role, "assistant"))
        m = sope__message_new(SOPE__MSG_ASSISTANT, content, content_len);
    else if (!strcmp(role, "tool"))
        m = sope__message_new(SOPE__MSG_TOOL, content, content_len);
    else {
        snprintf(err, cap, "message %zu: unknown role \"%s\"", index, role);
        return SOPE_EINVAL;
    }
    if (!m) return SOPE_ENOMEM;

    if (m->role == SOPE__MSG_ASSISTANT && (uses = sope__json_get(v, "tool_uses")) && uses->count) {
        if (uses->type != SOPE_JSON_ARRAY || !(m->tool_uses = calloc(uses->count, sizeof *m->tool_uses))) {
            sope__message_free(m);
            if (uses->type == SOPE_JSON_ARRAY) return SOPE_ENOMEM;
            snprintf(err, cap, "message %zu: \"tool_uses\" must be an array", index);
            return SOPE_EINVAL;
        }
        for (u = uses->child, i = 0; u; u = u->next, i++) {
            sope_tool_use *t = &m->tool_uses[i];
            m->n_tool_uses = i + 1;
            t->id = dup_member(u, "id", NULL);
            t->name = dup_member(u, "name", NULL);
            t->input = dup_member(u, "input", &t->input_len);
            if (!t->id || !t->name || !t->input) {
                sope__message_free(m);
                snprintf(err, cap, "message %zu: tool use %zu needs string \"id\", \"name\" and \"input\"", index, i);
                return SOPE_EINVAL;
            }
        }
    }
    if ((uses = sope__json_get(v, "images")) && uses->count && m->role != SOPE__MSG_ASSISTANT) {
        if (uses->type != SOPE_JSON_ARRAY || !(m->images = calloc(uses->count, sizeof *m->images))) {
            sope__message_free(m);
            if (uses->type == SOPE_JSON_ARRAY) return SOPE_ENOMEM;
            snprintf(err, cap, "message %zu: \"images\" must be an array", index);
            return SOPE_EINVAL;
        }
        for (u = uses->child, i = 0; u; u = u->next, i++) {
            sope_image *img = &m->images[i];
            m->n_images = i + 1;
            img->media_type = dup_member(u, "media_type", NULL);
            img->data = dup_member(u, "data", &img->len);
            if (!img->media_type || !img->data) {
                sope__message_free(m);
                snprintf(err, cap, "message %zu: image %zu needs string \"media_type\" and \"data\" (base64)", index, i);
                return SOPE_EINVAL;
            }
        }
    }
    if (m->role == SOPE__MSG_TOOL) {
        m->tool_use_id = dup_member(v, "tool_use_id", NULL);
        m->tool_name = dup_member(v, "name", NULL);
        flag = sope__json_get(v, "is_error");
        m->is_error = flag && flag->type == SOPE_JSON_BOOL && flag->boolean;
        if (!m->tool_use_id || !m->tool_name) {
            sope__message_free(m);
            snprintf(err, cap, "message %zu: a tool result needs string \"tool_use_id\" and \"name\"", index);
            return SOPE_EINVAL;
        }
    }
    *out = m;
    return SOPE_OK;
}

int sope__history_parse(sope_history *out, const char *json, size_t len, char *err, size_t cap)
{
    sope_json *root = sope__json_parse(json, len);
    const sope_json *v;
    size_t i = 0;
    int rc = SOPE_OK;

    memset(out, 0, sizeof *out);
    if (!root || root->type != SOPE_JSON_ARRAY) {
        snprintf(err, cap, "expected a JSON array of messages");
        sope__json_free(root);
        return SOPE_EINVAL;
    }
    for (v = root->child; v && rc == SOPE_OK; v = v->next, i++) {
        sope_message *m;
        if ((rc = message_from_json(v, i, &m, err, cap)) == SOPE_OK) sope__history_append(out, m);
    }
    sope__json_free(root);
    if (rc != SOPE_OK) {
        if (rc == SOPE_ENOMEM) snprintf(err, cap, "out of memory");
        sope__history_clear(out);
        return rc;
    }
    sope__history_repair(out); /* a history saved mid-turn may end in unanswered tool uses */
    return SOPE_OK;
}
