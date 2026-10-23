/* SPDX-License-Identifier: MIT */
/*
 * json.c - a small DOM-style JSON parser.
 *
 * Enough for provider responses, tool schemas and subagent definitions:
 * full RFC 8259 syntax, \u escapes (including surrogate pairs) decoded to
 * UTF-8, numbers as double, nesting limited to SOPE_JSON_MAX_DEPTH.
 */
#include "sope_internal.h"

#include <stdlib.h>
#include <string.h>

#define SOPE_JSON_MAX_DEPTH 64

typedef struct {
    const char *s;
    size_t n;
    size_t i;
} parser;

static sope_json *parse_value(parser *p, int depth);

static void skip_ws(parser *p)
{
    while (p->i < p->n && (p->s[p->i] == ' ' || p->s[p->i] == '\t' || p->s[p->i] == '\n' || p->s[p->i] == '\r'))
        p->i++;
}

static sope_json *new_node(sope_json_type type)
{
    sope_json *v = calloc(1, sizeof *v);
    if (v) v->type = type;
    return v;
}

static int hex4(parser *p, unsigned *out)
{
    unsigned v = 0;
    size_t k;
    if (p->i + 4 > p->n) return 0;
    for (k = 0; k < 4; k++) {
        char c = p->s[p->i++];
        v <<= 4;
        if (c >= '0' && c <= '9') v |= (unsigned)(c - '0');
        else if (c >= 'a' && c <= 'f') v |= (unsigned)(c - 'a' + 10);
        else if (c >= 'A' && c <= 'F') v |= (unsigned)(c - 'A' + 10);
        else return 0;
    }
    *out = v;
    return 1;
}

static void put_utf8(sope_buf *b, unsigned cp)
{
    char out[4];
    size_t n;
    if (cp < 0x80) {
        out[0] = (char)cp;
        n = 1;
    } else if (cp < 0x800) {
        out[0] = (char)(0xc0 | (cp >> 6));
        out[1] = (char)(0x80 | (cp & 0x3f));
        n = 2;
    } else if (cp < 0x10000) {
        out[0] = (char)(0xe0 | (cp >> 12));
        out[1] = (char)(0x80 | ((cp >> 6) & 0x3f));
        out[2] = (char)(0x80 | (cp & 0x3f));
        n = 3;
    } else {
        out[0] = (char)(0xf0 | (cp >> 18));
        out[1] = (char)(0x80 | ((cp >> 12) & 0x3f));
        out[2] = (char)(0x80 | ((cp >> 6) & 0x3f));
        out[3] = (char)(0x80 | (cp & 0x3f));
        n = 4;
    }
    sope__buf_append(b, out, n);
}

/* Parses a string literal at p->i (which must be '"') into b. */
static int parse_string_into(parser *p, sope_buf *b)
{
    p->i++; /* opening quote */
    for (;;) {
        size_t start = p->i;
        while (p->i < p->n && p->s[p->i] != '"' && p->s[p->i] != '\\') {
            if ((unsigned char)p->s[p->i] < 0x20) return 0;
            p->i++;
        }
        sope__buf_append(b, p->s + start, p->i - start);
        if (p->i >= p->n) return 0;
        if (p->s[p->i] == '"') {
            p->i++;
            if (!b->ptr) sope__buf_append(b, "", 0); /* empty string still gets a buffer */
            return !b->oom;
        }
        p->i++; /* backslash */
        if (p->i >= p->n) return 0;
        switch (p->s[p->i++]) {
        case '"': sope__buf_append(b, "\"", 1); break;
        case '\\': sope__buf_append(b, "\\", 1); break;
        case '/': sope__buf_append(b, "/", 1); break;
        case 'b': sope__buf_append(b, "\b", 1); break;
        case 'f': sope__buf_append(b, "\f", 1); break;
        case 'n': sope__buf_append(b, "\n", 1); break;
        case 'r': sope__buf_append(b, "\r", 1); break;
        case 't': sope__buf_append(b, "\t", 1); break;
        case 'u': {
            unsigned cp, lo;
            if (!hex4(p, &cp)) return 0;
            if (cp >= 0xd800 && cp <= 0xdbff) {
                if (p->i + 6 <= p->n && p->s[p->i] == '\\' && p->s[p->i + 1] == 'u') {
                    p->i += 2;
                    if (!hex4(p, &lo)) return 0;
                    if (lo >= 0xdc00 && lo <= 0xdfff)
                        cp = 0x10000 + ((cp - 0xd800) << 10) + (lo - 0xdc00);
                    else
                        cp = 0xfffd;
                } else {
                    cp = 0xfffd;
                }
            } else if (cp >= 0xdc00 && cp <= 0xdfff) {
                cp = 0xfffd;
            }
            put_utf8(b, cp);
            break;
        }
        default: return 0;
        }
    }
}

static sope_json *parse_string(parser *p)
{
    sope_buf b = { 0 };
    sope_json *v;
    if (!parse_string_into(p, &b)) {
        sope__buf_free(&b);
        return NULL;
    }
    if (!(v = new_node(SOPE_JSON_STRING))) {
        sope__buf_free(&b);
        return NULL;
    }
    v->str = b.ptr;
    v->len = b.len;
    return v;
}

static sope_json *parse_number(parser *p)
{
    size_t start = p->i;
    char tmp[64];
    sope_json *v;
    if (p->i < p->n && p->s[p->i] == '-') p->i++;
    if (p->i >= p->n || p->s[p->i] < '0' || p->s[p->i] > '9') return NULL;
    while (p->i < p->n && ((p->s[p->i] >= '0' && p->s[p->i] <= '9') || p->s[p->i] == '.' || p->s[p->i] == 'e' ||
                           p->s[p->i] == 'E' || p->s[p->i] == '+' || p->s[p->i] == '-'))
        p->i++;
    if (p->i - start >= sizeof tmp) return NULL;
    memcpy(tmp, p->s + start, p->i - start);
    tmp[p->i - start] = '\0';
    if (!(v = new_node(SOPE_JSON_NUMBER))) return NULL;
    v->num = strtod(tmp, NULL);
    return v;
}

static int literal(parser *p, const char *word)
{
    size_t n = strlen(word);
    if (p->i + n > p->n || memcmp(p->s + p->i, word, n) != 0) return 0;
    p->i += n;
    return 1;
}

static int cmp_member(const void *a, const void *b);
static int unique_keys(const sope_json *v)
{
    if (v->type != SOPE_JSON_OBJECT || v->count < 2) return 1;
    const sope_json **keys = malloc(v->count * sizeof *keys);
    if (!keys) return 0;
    size_t n = 0;
    for (const sope_json *p = v->child; p; p = p->next) keys[n++] = p;
    qsort(keys, n, sizeof *keys, cmp_member);
    int ok = 1;
    for (size_t i = 1; i < n; i++) if (!cmp_member(&keys[i-1], &keys[i])) { ok = 0; break; }
    free(keys);
    return ok;
}

static sope_json *parse_container(parser *p, int depth, int is_object)
{
    sope_json *v = new_node(is_object ? SOPE_JSON_OBJECT : SOPE_JSON_ARRAY);
    sope_json **tail;
    char close = is_object ? '}' : ']';

    if (!v) return NULL;
    tail = &v->child;
    p->i++;
    skip_ws(p);
    if (p->i < p->n && p->s[p->i] == close) {
        p->i++;
        return v;
    }
    for (;;) {
        sope_json *item;
        sope_buf key = { 0 };

        skip_ws(p);
        if (is_object) {
            if (p->i >= p->n || p->s[p->i] != '"' || !parse_string_into(p, &key)) goto fail_key;
            skip_ws(p);
            if (p->i >= p->n || p->s[p->i] != ':') goto fail_key;
            p->i++;
        }
        if (!(item = parse_value(p, depth + 1))) goto fail_key;
        item->key = key.ptr;
        item->key_len = key.len;
        *tail = item;
        tail = &item->next;
        v->count++;

        skip_ws(p);
        if (p->i >= p->n) goto fail;
        if (p->s[p->i] == ',') {
            p->i++;
            continue;
        }
        if (p->s[p->i] == close) {
            p->i++;
            /* A host authorizer and native executor must not interpret the
             * same object differently (first-key versus last-key wins). */
            if (!unique_keys(v)) goto fail;
            return v;
        }
        goto fail;
    fail_key:
        sope__buf_free(&key);
        goto fail;
    }
fail:
    sope__json_free(v);
    return NULL;
}

static sope_json *parse_value(parser *p, int depth)
{
    sope_json *v;
    if (depth > SOPE_JSON_MAX_DEPTH) return NULL;
    skip_ws(p);
    if (p->i >= p->n) return NULL;
    switch (p->s[p->i]) {
    case '{': return parse_container(p, depth, 1);
    case '[': return parse_container(p, depth, 0);
    case '"': return parse_string(p);
    case 't':
        if (!literal(p, "true") || !(v = new_node(SOPE_JSON_BOOL))) return NULL;
        v->boolean = 1;
        return v;
    case 'f':
        if (!literal(p, "false")) return NULL;
        return new_node(SOPE_JSON_BOOL);
    case 'n':
        if (!literal(p, "null")) return NULL;
        return new_node(SOPE_JSON_NULL);
    default: return parse_number(p);
    }
}

sope_json *sope__json_parse(const char *s, size_t n)
{
    parser p = { s, n, 0 };
    sope_json *v = parse_value(&p, 0);
    if (!v) return NULL;
    skip_ws(&p);
    if (p.i != p.n) {
        sope__json_free(v);
        return NULL;
    }
    return v;
}

void sope__json_free(sope_json *v)
{
    while (v) {
        sope_json *next = v->next;
        sope__json_free(v->child);
        free(v->key);
        free(v->str);
        free(v);
        v = next;
    }
}

const sope_json *sope__json_get(const sope_json *obj, const char *key)
{
    const sope_json *c;
    size_t n = strlen(key);
    if (!obj || obj->type != SOPE_JSON_OBJECT) return NULL;
    for (c = obj->child; c; c = c->next)
        if (c->key_len == n && memcmp(c->key, key, n) == 0) return c;
    return NULL;
}

const sope_json *sope__json_at(const sope_json *arr, size_t index)
{
    const sope_json *c;
    if (!arr || arr->type != SOPE_JSON_ARRAY) return NULL;
    for (c = arr->child; c && index; c = c->next) index--;
    return c;
}

const char *sope__json_string(const sope_json *v, size_t *len)
{
    if (!v || v->type != SOPE_JSON_STRING) return NULL;
    if (len) *len = v->len;
    return v->str;
}

double sope__json_number(const sope_json *v, double fallback)
{
    return v && v->type == SOPE_JSON_NUMBER ? v->num : fallback;
}

static int cmp_member(const void *a, const void *b)
{
    const sope_json *const *x = a, *const *y = b;
    size_t n = (*x)->key_len < (*y)->key_len ? (*x)->key_len : (*y)->key_len;
    int rc = memcmp((*x)->key, (*y)->key, n);
    return rc ? rc : (*x)->key_len < (*y)->key_len ? -1 : (*x)->key_len != (*y)->key_len;
}
/* Canonical objects, preserving array order. Refuse duplicate keys rather than
 * allowing the binding and C parser to disagree about the effective policy. */
int sope__json_canonical(sope_buf *b, const sope_json *v, int hide_env)
{
    if (!v) return 0;
    switch (v->type) {
    case SOPE_JSON_NULL: sope__buf_appends(b, "null"); break;
    case SOPE_JSON_BOOL: sope__buf_appends(b, v->boolean ? "true" : "false"); break;
    case SOPE_JSON_NUMBER: sope__buf_appendf(b, "%.17g", v->num); break;
    case SOPE_JSON_STRING: sope__buf_append_json_string(b, v->str, v->len); break;
    case SOPE_JSON_ARRAY:
        sope__buf_appends(b, "[");
        for (const sope_json *p = v->child; p; p = p->next) {
            if (p != v->child) sope__buf_appends(b, ",");
            if (!sope__json_canonical(b, p, 0)) return 0;
        }
        sope__buf_appends(b, "]"); break;
    case SOPE_JSON_OBJECT: {
        const sope_json **items = calloc(v->count + 1, sizeof *items);
        if (!items) return 0;
        size_t n = 0;
        for (const sope_json *p = v->child; p; p = p->next) items[n++] = p;
        qsort(items, n, sizeof *items, cmp_member);
        sope__buf_appends(b, "{");
        for (size_t i = 0; i < n; i++) {
            const sope_json *p = items[i];
            if (i && !cmp_member(&items[i], &items[i-1])) { free(items); return 0; }
            if (i) sope__buf_appends(b, ",");
            sope__buf_append_json_string(b, p->key, p->key_len);
            sope__buf_appends(b, ":");
            if (hide_env == 2) sope__buf_appends(b, "null");
            else if (!sope__json_canonical(b, p, hide_env && !strcmp(p->key, "environment") ? 2 : 0)) { free(items); return 0; }
        }
        free(items); sope__buf_appends(b, "}"); break;
    }
    }
    return !b->oom;
}
