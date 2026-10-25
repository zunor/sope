/* SPDX-License-Identifier: MIT */
#define _POSIX_C_SOURCE 200809L
#include "sope_internal.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

/* Open without waiting for a FIFO peer, then verify the opened inode rather
 * than an earlier pathname stat. Tools cannot consume devices or pipes. */
int sope__open_regular_read(const char *path)
{
    int fd = open(path, O_RDONLY | O_CLOEXEC | O_NONBLOCK);
    if (fd < 0) return -1;
    struct stat st;
    int error = fstat(fd, &st) != 0 ? errno : S_ISREG(st.st_mode) ? 0 : EINVAL;
    if (error) { close(fd); errno = error; return -1; }
    return fd;
}

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
    case SOPE_ECONFLICT: return "conflict";
    case SOPE_ETIMEOUT: return "timeout";
    case SOPE_EOUTPUT_LIMIT: return "output limit exhausted";
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

/* Length of the valid UTF-8 sequence at s (n bytes available), or 0. */
static size_t utf8_valid(const unsigned char *s, size_t n)
{
    size_t len, i;
    uint32_t cp;
    if (s[0] < 0x80) return 1;
    if (s[0] >= 0xc2 && s[0] <= 0xdf) len = 2, cp = s[0] & 0x1f;
    else if (s[0] >= 0xe0 && s[0] <= 0xef) len = 3, cp = s[0] & 0x0f;
    else if (s[0] >= 0xf0 && s[0] <= 0xf4) len = 4, cp = s[0] & 0x07;
    else return 0;
    if (n < len) return 0;
    for (i = 1; i < len; i++) {
        if ((s[i] & 0xc0) != 0x80) return 0;
        cp = cp << 6 | (s[i] & 0x3f);
    }
    if ((len == 3 && cp < 0x800) || (len == 4 && (cp < 0x10000 || cp > 0x10ffff)) || (cp >= 0xd800 && cp <= 0xdfff))
        return 0;
    return len;
}

int sope__utf8_valid(const char *text, size_t size)
{
    for (size_t i = 0; i < size;) {
        size_t n = utf8_valid((const unsigned char *)text + i, size - i);
        if (!n) return 0;
        i += n;
    }
    return 1;
}

void sope__buf_sanitize(sope_buf *b, size_t from)
{
    sope_buf out = { 0 };
    const unsigned char *s;
    size_t i, n;

    if (b->oom || from >= b->len) return;
    s = (const unsigned char *)b->ptr;
    n = b->len;
    for (i = from; i < n; i++) { /* the common case: nothing to change */
        if (s[i] >= 0x80 ? !utf8_valid(s + i, n - i) : (s[i] < 0x20 && s[i] != '\n' && s[i] != '\t') || s[i] == 0x7f)
            break;
        if (s[i] >= 0x80) i += utf8_valid(s + i, n - i) - 1;
    }
    if (i == n) return;

    sope__buf_append(&out, b->ptr, i);
    while (i < n) {
        unsigned char c = s[i];
        size_t len;
        if (c == 0x1b) { /* ANSI escape: CSI ... final byte, OSC ... BEL/ST, or ESC + one char */
            i++;
            if (i < n && s[i] == '[') {
                for (i++; i < n && !(s[i] >= 0x40 && s[i] <= 0x7e); i++) {}
                i++;
            } else if (i < n && s[i] == ']') {
                for (i++; i < n && s[i] != 0x07 && !(s[i] == 0x1b && i + 1 < n && s[i + 1] == '\\'); i++) {}
                i += i < n && s[i] == 0x1b ? 2 : 1;
            } else if (i < n) {
                i++;
            }
            continue;
        }
        if (c == '\r') {
            if (i + 1 >= n || s[i + 1] != '\n') sope__buf_append(&out, "\n", 1);
            i++;
            continue;
        }
        if (c < 0x80) {
            if (c >= 0x20 || c == '\n' || c == '\t') sope__buf_append(&out, (const char *)s + i, 1);
            i++;
            continue;
        }
        if ((len = utf8_valid(s + i, n - i))) {
            sope__buf_append(&out, (const char *)s + i, len);
            i += len;
        } else {
            sope__buf_append(&out, "\xef\xbf\xbd", 3);
            i++;
        }
    }
    if (out.oom) {
        sope__buf_free(&out);
        return;
    }
    sope__buf_free(b);
    *b = out;
}

void sope__buf_clip_middle(sope_buf *b, size_t max)
{
    size_t head, tail_start, omitted;
    char note[96];
    sope_buf out = { 0 };

    if (b->len <= max || max < 200) return;
    head = max / 2;
    while (head > 0 && ((unsigned char)b->ptr[head] & 0xc0) == 0x80) head--;
    tail_start = b->len - max / 2;
    while (tail_start < b->len && ((unsigned char)b->ptr[tail_start] & 0xc0) == 0x80) tail_start++;
    omitted = tail_start - head;
    snprintf(note, sizeof note, "\n\n[... %zu bytes omitted ...]\n\n", omitted);
    sope__buf_append(&out, b->ptr, head);
    sope__buf_appends(&out, note);
    sope__buf_append(&out, b->ptr + tail_start, b->len - tail_start);
    if (out.oom) {
        sope__buf_free(&out);
        return;
    }
    sope__buf_free(b);
    *b = out;
}

char *sope__base64(const void *data, size_t n, size_t *out_len)
{
    static const char abc[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    const unsigned char *p = data;
    size_t len = (n + 2) / 3 * 4, i, o = 0;
    char *out = malloc(len + 1);
    if (!out) return NULL;
    for (i = 0; i + 2 < n; i += 3) {
        uint32_t v = (uint32_t)p[i] << 16 | (uint32_t)p[i + 1] << 8 | p[i + 2];
        out[o++] = abc[v >> 18];
        out[o++] = abc[(v >> 12) & 63];
        out[o++] = abc[(v >> 6) & 63];
        out[o++] = abc[v & 63];
    }
    if (i < n) {
        uint32_t v = (uint32_t)p[i] << 16 | (i + 1 < n ? (uint32_t)p[i + 1] << 8 : 0);
        out[o++] = abc[v >> 18];
        out[o++] = abc[(v >> 12) & 63];
        out[o++] = i + 1 < n ? abc[(v >> 6) & 63] : '=';
        out[o++] = '=';
    }
    out[o] = '\0';
    if (out_len) *out_len = o;
    return out;
}

const char *sope__image_type(const void *data, size_t n)
{
    const unsigned char *p = data;
    if (n >= 8 && !memcmp(p, "\x89PNG\r\n\x1a\n", 8)) return "image/png";
    if (n >= 3 && p[0] == 0xff && p[1] == 0xd8 && p[2] == 0xff) return "image/jpeg";
    if (n >= 6 && (!memcmp(p, "GIF87a", 6) || !memcmp(p, "GIF89a", 6))) return "image/gif";
    if (n >= 12 && !memcmp(p, "RIFF", 4) && !memcmp(p + 8, "WEBP", 4)) return "image/webp";
    return NULL;
}

void sope__images_free(sope_image *v, size_t n)
{
    size_t i;
    for (i = 0; i < n; i++) {
        free(v[i].media_type);
        free(v[i].data);
    }
    free(v);
}

int sope__image_init(sope_image *img, const char *media_type, const void *data, size_t n)
{
    img->media_type = sope__strdup(media_type);
    img->data = img->media_type ? sope__base64(data, n, &img->len) : NULL;
    if (img->data) return 1;
    free(img->media_type);
    img->media_type = NULL;
    return 0;
}
