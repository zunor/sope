#include "sope_internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* ---- version ---- */

uint32_t sope_version_number(void)
{
    return SOPE_VERSION_NUMBER;
}

const char *sope_version(void)
{
    return SOPE_VERSION_STRING;
}

/* ---- errors ---- */

static _Thread_local char tls_error[512];

int sope__set_error(int code, const char *fmt, ...)
{
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(tls_error, sizeof tls_error, fmt, ap);
    va_end(ap);
    return code;
}

const char *sope_last_error(void)
{
    return tls_error;
}

const char *sope_strerror(int code)
{
    switch (code) {
    case SOPE_OK: return "ok";
    case SOPE_ERROR: return "error";
    case SOPE_EINVAL: return "invalid argument";
    case SOPE_ENOMEM: return "out of memory";
    case SOPE_ENOTFOUND: return "not found";
    case SOPE_ECLOSED: return "agent is closed";
    case SOPE_ECANCELLED: return "cancelled";
    case SOPE_EBUSY: return "busy";
    default: return "unknown error";
    }
}

/* ---- strings ---- */

char *sope__strndup(const char *s, size_t n)
{
    char *p = malloc(n + 1);
    if (!p) return NULL;
    if (n) memcpy(p, s, n);
    p[n] = '\0';
    return p;
}

char *sope__strdup(const char *s)
{
    return sope__strndup(s, strlen(s));
}

/* ---- buffers ---- */

void sope__buf_append(sope_buf *b, const char *s, size_t n)
{
    if (b->oom) return;
    if (b->len + n + 1 > b->cap) {
        size_t cap = b->cap ? b->cap : 64;
        char *p;
        while (cap < b->len + n + 1) cap *= 2;
        p = realloc(b->ptr, cap);
        if (!p) {
            b->oom = 1;
            return;
        }
        b->ptr = p;
        b->cap = cap;
    }
    if (n) memcpy(b->ptr + b->len, s, n);
    b->len += n;
    b->ptr[b->len] = '\0';
}

void sope__buf_appends(sope_buf *b, const char *s)
{
    sope__buf_append(b, s, strlen(s));
}

void sope__buf_appendf(sope_buf *b, const char *fmt, ...)
{
    char small[256];
    va_list ap;
    int n;

    va_start(ap, fmt);
    n = vsnprintf(small, sizeof small, fmt, ap);
    va_end(ap);
    if (n < 0) return;
    if ((size_t)n < sizeof small) {
        sope__buf_append(b, small, (size_t)n);
        return;
    }
    {
        char *big = malloc((size_t)n + 1);
        if (!big) {
            b->oom = 1;
            return;
        }
        va_start(ap, fmt);
        vsnprintf(big, (size_t)n + 1, fmt, ap);
        va_end(ap);
        sope__buf_append(b, big, (size_t)n);
        free(big);
    }
}

void sope__buf_consume(sope_buf *b, size_t n)
{
    if (n >= b->len) {
        b->len = 0;
    } else {
        memmove(b->ptr, b->ptr + n, b->len - n);
        b->len -= n;
    }
    if (b->ptr) b->ptr[b->len] = '\0';
}

void sope__buf_append_json_string(sope_buf *b, const char *s, size_t n)
{
    static const char hex[] = "0123456789abcdef";
    size_t i, run = 0;

    sope__buf_append(b, "\"", 1);
    for (i = 0; i < n; i++) {
        unsigned char c = (unsigned char)s[i];
        if (c >= 0x20 && c != '"' && c != '\\') continue; /* part of a plain run */
        sope__buf_append(b, s + run, i - run);
        run = i + 1;
        switch (c) {
        case '"': sope__buf_append(b, "\\\"", 2); break;
        case '\\': sope__buf_append(b, "\\\\", 2); break;
        case '\n': sope__buf_append(b, "\\n", 2); break;
        case '\r': sope__buf_append(b, "\\r", 2); break;
        case '\t': sope__buf_append(b, "\\t", 2); break;
        case '\b': sope__buf_append(b, "\\b", 2); break;
        case '\f': sope__buf_append(b, "\\f", 2); break;
        default: {
            char esc[6] = { '\\', 'u', '0', '0', hex[c >> 4], hex[c & 0xf] };
            sope__buf_append(b, esc, sizeof esc);
        }
        }
    }
    sope__buf_append(b, s + run, n - run);
    sope__buf_append(b, "\"", 1);
}

void sope__buf_free(sope_buf *b)
{
    free(b->ptr);
    b->ptr = NULL;
    b->len = b->cap = 0;
    b->oom = 0;
}
