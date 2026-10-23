/* SPDX-License-Identifier: MIT */
/*
 * tool_web.c - web_fetch: an HTTP GET through http.c (so waiting holds
 * no pool thread) and an HTML-to-text conversion that keeps what a reader
 * needs: headings, paragraphs, lists, links (resolved to absolute URLs),
 * code blocks and table rows. Scripts, styles and markup are dropped.
 */
#define _POSIX_C_SOURCE 200809L

#include "tools.h"

#include <ctype.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>

#define FETCH_MAX_BODY (8 * 1024 * 1024)
#define FETCH_CHUNK 40000

static const char WEB_FETCH_DESC[] =
    "Fetches a URL and returns its content as text. HTML pages are converted to readable text with "
    "Markdown-style headings, lists and links; plain text and JSON come back as they are.\n\n"
    "Usage:\n"
    "- url must be a complete http:// or https:// URL. Redirects are followed.\n"
    "- An image URL (PNG, JPEG, GIF, WebP) comes back as the image itself. Images on HTML pages appear as "
    "![alt](url); fetch one to see it.\n"
    "- Long pages come back in parts of about 40000 characters; pass offset to read further.\n"
    "- Use it for documentation and pages the user points you to. For GitHub, prefer the gh CLI through "
    "bash.\n"
    "- The request leaves this machine: never put secrets or private data in the URL.";
static const char WEB_FETCH_SCHEMA[] =
    "{\"type\":\"object\",\"properties\":{"
    "\"url\":{\"type\":\"string\",\"description\":\"The URL to fetch\"},"
    "\"offset\":{\"type\":\"integer\",\"description\":\"Character offset to continue from (default 0)\"}},"
    "\"required\":[\"url\"]}";

/* ------------------------------------------------------------------------ */
/* HTML to text                                                              */
/* ------------------------------------------------------------------------ */

typedef struct {
    sope_buf *out;
    const char *base_url;
    int pre;          /* inside <pre> */
    int space;        /* whitespace seen since the last character */
    int in_head;
    int in_title;
    sope_buf title;
    char *href;       /* open <a> with a usable link */
    size_t link_start; /* out->len at its "[" */
    int row_cells;
} html_state;

static void put_utf8(sope_buf *b, unsigned long cp)
{
    char s[4];
    if (cp == 0 || cp > 0x10ffff || (cp >= 0xd800 && cp <= 0xdfff)) cp = 0xfffd;
    if (cp < 0x80) {
        s[0] = (char)cp;
        sope__buf_append(b, s, 1);
    } else if (cp < 0x800) {
        s[0] = (char)(0xc0 | cp >> 6);
        s[1] = (char)(0x80 | (cp & 0x3f));
        sope__buf_append(b, s, 2);
    } else if (cp < 0x10000) {
        s[0] = (char)(0xe0 | cp >> 12);
        s[1] = (char)(0x80 | ((cp >> 6) & 0x3f));
        s[2] = (char)(0x80 | (cp & 0x3f));
        sope__buf_append(b, s, 3);
    } else {
        s[0] = (char)(0xf0 | cp >> 18);
        s[1] = (char)(0x80 | ((cp >> 12) & 0x3f));
        s[2] = (char)(0x80 | ((cp >> 6) & 0x3f));
        s[3] = (char)(0x80 | (cp & 0x3f));
        sope__buf_append(b, s, 4);
    }
}

/* Decodes the entity at s[0] == '&' into b. Returns the bytes consumed, or 0. */
static size_t decode_entity(const char *s, size_t n, sope_buf *b)
{
    static const struct {
        const char *name;
        unsigned long cp;
    } named[] = {
        { "amp", '&' },      { "lt", '<' },        { "gt", '>' },        { "quot", '"' },     { "apos", '\'' },
        { "nbsp", ' ' },     { "copy", 0xa9 },     { "reg", 0xae },      { "trade", 0x2122 }, { "hellip", 0x2026 },
        { "mdash", 0x2014 }, { "ndash", 0x2013 },  { "lsquo", 0x2018 },  { "rsquo", 0x2019 }, { "ldquo", 0x201c },
        { "rdquo", 0x201d }, { "bull", 0x2022 },   { "middot", 0xb7 },   { "laquo", 0xab },   { "raquo", 0xbb },
        { "times", 0xd7 },   { "rarr", 0x2192 },   { "larr", 0x2190 },   { "deg", 0xb0 },     { "euro", 0x20ac },
    };
    size_t i, end;
    for (end = 1; end < n && end < 12 && s[end] != ';'; end++) {}
    if (end >= n || s[end] != ';') return 0;
    if (s[1] == '#') {
        unsigned long cp;
        char *stop;
        char num[12];
        memcpy(num, s + 2, end - 2);
        num[end - 2] = '\0';
        cp = (num[0] == 'x' || num[0] == 'X') ? strtoul(num + 1, &stop, 16) : strtoul(num, &stop, 10);
        if (*stop || stop == num) return 0;
        put_utf8(b, cp);
        return end + 1;
    }
    for (i = 0; i < sizeof named / sizeof named[0]; i++)
        if (strlen(named[i].name) == end - 1 && !memcmp(s + 1, named[i].name, end - 1)) {
            put_utf8(b, named[i].cp);
            return end + 1;
        }
    return 0;
}

static int at_line_start(const sope_buf *b)
{
    return !b->len || b->ptr[b->len - 1] == '\n';
}

/* Ends the current line and leaves at least `lines` line breaks. */
static void breaks(html_state *h, int lines)
{
    sope_buf *b = h->out;
    int have = 0;
    size_t i;
    while (b->len && b->ptr[b->len - 1] == ' ') b->ptr[--b->len] = '\0';
    if (!b->len) return;
    for (i = b->len; i > 0 && b->ptr[i - 1] == '\n'; i--) have++;
    while (have++ < lines) sope__buf_append(b, "\n", 1);
    h->space = 0;
}

static void text_char(html_state *h, const char *s, size_t n)
{
    sope_buf *b = h->in_title ? &h->title : h->out;
    if (h->in_head && !h->in_title) return;
    if (!h->pre && n == 1 && isspace((unsigned char)s[0])) {
        h->space = 1;
        return;
    }
    if (h->space && b->len && !at_line_start(b) && b->ptr[b->len - 1] != ' ' && b->ptr[b->len - 1] != '[')
        sope__buf_append(b, " ", 1);
    h->space = 0;
    sope__buf_append(b, s, n);
}

static void text_str(html_state *h, const char *s)
{
    text_char(h, s, strlen(s));
}

/* An absolute URL for href, or NULL when it is not worth showing. */
static char *resolve_url(const char *base, const char *href)
{
    sope_buf u = { 0 };
    const char *scheme_end, *host_end, *last_slash;
    while (*href == ' ') href++;
    if (!*href || *href == '#' || !strncmp(href, "javascript:", 11) || !strncmp(href, "data:", 5)) return NULL;
    if (!strncmp(href, "http://", 7) || !strncmp(href, "https://", 8) || !strncmp(href, "mailto:", 7))
        return sope__strdup(href);
    if (!base || !(scheme_end = strstr(base, "://"))) return sope__strdup(href);
    host_end = strchr(scheme_end + 3, '/');
    if (!host_end) host_end = base + strlen(base);
    if (href[0] == '/' && href[1] == '/') {
        sope__buf_append(&u, base, (size_t)(scheme_end - base) + 1);
        sope__buf_appends(&u, href);
    } else if (href[0] == '/') {
        sope__buf_append(&u, base, (size_t)(host_end - base));
        sope__buf_appends(&u, href);
    } else {
        const char *q = strpbrk(host_end, "?#");
        last_slash = host_end;
        for (const char *p = host_end; *p && (!q || p < q); p++)
            if (*p == '/') last_slash = p;
        sope__buf_append(&u, base, (size_t)(last_slash - base));
        sope__buf_appends(&u, "/");
        sope__buf_appends(&u, href);
    }
    if (u.oom) {
        sope__buf_free(&u);
        return NULL;
    }
    return u.ptr;
}

/* Value of attribute `name` in a tag's attribute text, entity-decoded. */
static char *attr_value(const char *attrs, size_t n, const char *name)
{
    size_t i = 0, nl = strlen(name);
    while (i < n) {
        size_t k, vstart, vend;
        while (i < n && (isspace((unsigned char)attrs[i]) || attrs[i] == '/')) i++;
        k = i;
        while (i < n && !isspace((unsigned char)attrs[i]) && attrs[i] != '=' && attrs[i] != '>') i++;
        if (i == k) break;
        {
            int is = i - k == nl && !strncasecmp(attrs + k, name, nl);
            while (i < n && isspace((unsigned char)attrs[i])) i++;
            if (i >= n || attrs[i] != '=') {
                if (is) return sope__strdup("");
                continue;
            }
            i++;
            while (i < n && isspace((unsigned char)attrs[i])) i++;
            if (i < n && (attrs[i] == '"' || attrs[i] == '\'')) {
                char q = attrs[i++];
                vstart = i;
                while (i < n && attrs[i] != q) i++;
                vend = i++;
            } else {
                vstart = i;
                while (i < n && !isspace((unsigned char)attrs[i]) && attrs[i] != '>') i++;
                vend = i;
            }
            if (is) {
                sope_buf v = { 0 };
                size_t j = vstart;
                while (j < vend) {
                    size_t used = attrs[j] == '&' ? decode_entity(attrs + j, vend - j, &v) : 0;
                    if (used) j += used;
                    else sope__buf_append(&v, attrs + j++, 1);
                }
                if (!v.ptr) sope__buf_append(&v, "", 0);
                return v.oom ? (sope__buf_free(&v), NULL) : v.ptr;
            }
        }
    }
    return NULL;
}

static int tag_is(const char *name, const char *const *list)
{
    for (; *list; list++)
        if (!strcmp(name, *list)) return 1;
    return 0;
}

static void open_tag(html_state *h, const char *name, const char *attrs, size_t alen)
{
    static const char *const para[] = { "p", "blockquote", "ul", "ol", "dl", "table", "figure", "form", NULL };
    static const char *const line[] = { "div", "section", "article", "header", "footer", "main", "nav", "aside",
                                        "tr", "dt", "dd", "br", "address", "details", "summary", "caption", NULL };
    if (!strcmp(name, "head")) h->in_head = 1;
    else if (!strcmp(name, "title")) h->in_title = 1;
    else if (h->in_head) return;
    else if (name[0] == 'h' && name[1] >= '1' && name[1] <= '6' && !name[2]) {
        breaks(h, 2);
        sope__buf_append(h->out, "######", (size_t)(name[1] - '0'));
        sope__buf_append(h->out, " ", 1);
    } else if (!strcmp(name, "li")) {
        breaks(h, 1);
        sope__buf_appends(h->out, "- ");
    } else if (!strcmp(name, "pre")) {
        breaks(h, 2);
        sope__buf_appends(h->out, "```\n");
        h->pre++;
    } else if (!strcmp(name, "code") && !h->pre) {
        text_str(h, "`");
    } else if (!strcmp(name, "hr")) {
        breaks(h, 2);
        sope__buf_appends(h->out, "---");
        breaks(h, 2);
    } else if (!strcmp(name, "tr")) {
        breaks(h, 1);
        h->row_cells = 0;
    } else if (!strcmp(name, "td") || !strcmp(name, "th")) {
        if (h->row_cells++) text_str(h, " |");
        h->space = 1;
    } else if (!strcmp(name, "a") && !h->href) {
        char *href = attr_value(attrs, alen, "href");
        h->href = href ? resolve_url(h->base_url, href) : NULL;
        free(href);
        if (h->href) {
            if (h->space && !at_line_start(h->out)) sope__buf_append(h->out, " ", 1);
            h->space = 0;
            h->link_start = h->out->len;
            sope__buf_append(h->out, "[", 1);
        }
    } else if (!strcmp(name, "img")) {
        /* ![alt](url): the model can web_fetch the image to see it. */
        char *alt = attr_value(attrs, alen, "alt"), *src = attr_value(attrs, alen, "src");
        char *abs = src && *src && strncmp(src, "data:", 5) ? resolve_url(h->base_url, src) : NULL;
        if ((alt && *alt) || abs) {
            text_str(h, "![");
            text_str(h, alt && *alt ? alt : "image");
            text_str(h, "]");
            if (abs) {
                text_str(h, "(");
                text_str(h, abs);
                text_str(h, ")");
            }
        }
        free(alt);
        free(src);
        free(abs);
    } else if (tag_is(name, para)) {
        breaks(h, 2);
    } else if (tag_is(name, line)) {
        breaks(h, 1);
    }
}

static void close_tag(html_state *h, const char *name)
{
    static const char *const para[] = { "p", "blockquote", "ul", "ol", "dl", "table", "figure", NULL };
    static const char *const line[] = { "div", "section", "article", "header", "footer", "main", "nav",
                                        "aside", "tr", "li", "dt", "dd", "details", "summary", NULL };
    if (!strcmp(name, "head")) h->in_head = 0;
    else if (!strcmp(name, "title")) h->in_title = 0;
    else if (h->in_head) return;
    else if (name[0] == 'h' && name[1] >= '1' && name[1] <= '6' && !name[2]) breaks(h, 2);
    else if (!strcmp(name, "pre") && h->pre) {
        h->pre--;
        if (!at_line_start(h->out)) sope__buf_append(h->out, "\n", 1);
        sope__buf_appends(h->out, "```");
        breaks(h, 2);
    } else if (!strcmp(name, "code") && !h->pre) {
        text_str(h, "`");
    } else if (!strcmp(name, "a") && h->href) {
        size_t i;
        int empty = 1;
        for (i = h->link_start + 1; i < h->out->len; i++)
            if (!isspace((unsigned char)h->out->ptr[i])) empty = 0;
        if (empty) {
            h->out->len = h->link_start; /* nothing to click on: drop the link */
            if (h->out->ptr) h->out->ptr[h->out->len] = '\0';
        } else {
            sope__buf_appendf(h->out, "](%s)", h->href);
        }
        free(h->href);
        h->href = NULL;
    } else if (tag_is(name, para)) {
        breaks(h, 2);
    } else if (tag_is(name, line)) {
        breaks(h, 1);
    }
}

/* Skips to just past "</name...>", case-insensitively. */
static size_t skip_raw(const char *s, size_t n, size_t i, const char *name)
{
    size_t nl = strlen(name);
    for (; i + 2 + nl <= n; i++)
        if (s[i] == '<' && s[i + 1] == '/' && !strncasecmp(s + i + 2, name, nl)) {
            const char *gt = memchr(s + i, '>', n - i);
            return gt ? (size_t)(gt - s) + 1 : n;
        }
    return n;
}

/* Collapses runs of blank lines and trims each line's trailing spaces. */
static void tidy(sope_buf *b)
{
    size_t r = 0, w = 0, blank = 0;
    char *s = b->ptr;
    if (!s) return;
    while (r < b->len && (s[r] == '\n' || s[r] == ' ')) r++;
    while (r < b->len) {
        if (s[r] == '\n') {
            while (w > 0 && s[w - 1] == ' ') w--;
            if (++blank <= 2) s[w++] = '\n';
            r++;
            continue;
        }
        if (blank && s[r] == ' ') { /* a line of nothing but spaces counts as blank */
            size_t k = r;
            while (k < b->len && s[k] == ' ') k++;
            if (k == b->len || s[k] == '\n') {
                r = k;
                continue;
            }
        }
        blank = 0;
        s[w++] = s[r++];
    }
    while (w > 0 && (s[w - 1] == '\n' || s[w - 1] == ' ')) w--;
    b->len = w;
    s[w] = '\0';
}

static void html_to_text(const char *s, size_t n, const char *base_url, sope_buf *out)
{
    html_state h = { 0 };
    sope_buf body = { 0 };
    size_t i = 0;

    h.out = &body;
    h.base_url = base_url;
    while (i < n) {
        if (s[i] == '<') {
            size_t j = i + 1, name_start, name_len, attrs_start;
            int closing = 0;
            char name[16];
            const char *gt;
            if (!strncmp(s + i, "<!--", 4)) {
                const char *end = NULL;
                size_t k;
                for (k = i + 4; k + 3 <= n; k++)
                    if (!memcmp(s + k, "-->", 3)) {
                        end = s + k;
                        break;
                    }
                i = end ? (size_t)(end - s) + 3 : n;
                continue;
            }
            if (j < n && (s[j] == '!' || s[j] == '?')) {
                gt = memchr(s + j, '>', n - j);
                i = gt ? (size_t)(gt - s) + 1 : n;
                continue;
            }
            if (j < n && s[j] == '/') closing = 1, j++;
            name_start = j;
            while (j < n && (isalnum((unsigned char)s[j]) || s[j] == '-')) j++;
            name_len = j - name_start;
            if (!name_len) { /* a literal '<' */
                text_char(&h, "<", 1);
                i++;
                continue;
            }
            attrs_start = j;
            /* the tag ends at the first '>' outside quotes */
            {
                char q = 0;
                while (j < n && (q || s[j] != '>')) {
                    if (q && s[j] == q) q = 0;
                    else if (!q && (s[j] == '"' || s[j] == '\'')) q = s[j];
                    j++;
                }
            }
            if (name_len < sizeof name) {
                size_t k;
                for (k = 0; k < name_len; k++) name[k] = (char)tolower((unsigned char)s[name_start + k]);
                name[name_len] = '\0';
                if (closing) {
                    close_tag(&h, name);
                } else if (!strcmp(name, "script") || !strcmp(name, "style") || !strcmp(name, "noscript") ||
                           !strcmp(name, "svg") || !strcmp(name, "template") || !strcmp(name, "iframe")) {
                    i = skip_raw(s, n, j < n ? j + 1 : n, name);
                    continue;
                } else {
                    open_tag(&h, name, s + attrs_start, j - attrs_start);
                }
            }
            i = j < n ? j + 1 : n;
        } else if (s[i] == '&') {
            sope_buf ent = { 0 };
            size_t used = decode_entity(s + i, n - i, &ent);
            if (used && ent.len) {
                if (ent.len == 1 && ent.ptr[0] == ' ' && !h.pre) h.space = 1;
                else text_char(&h, ent.ptr, ent.len);
                i += used;
            } else {
                text_char(&h, "&", 1);
                i++;
            }
            sope__buf_free(&ent);
        } else {
            size_t len = 1;
            unsigned char c = (unsigned char)s[i];
            if (c >= 0x80) len = c >= 0xf0 ? 4 : c >= 0xe0 ? 3 : c >= 0xc0 ? 2 : 1;
            if (i + len > n) len = n - i;
            if (c == '\r') {
                i++;
                continue;
            }
            text_char(&h, s + i, len);
            i += len;
        }
    }
    tidy(&h.title);
    tidy(&body);
    if (h.title.len) sope__buf_appendf(out, "# %s\n\n", h.title.ptr);
    if (body.len) sope__buf_append(out, body.ptr, body.len);
    free(h.href);
    sope__buf_free(&h.title);
    sope__buf_free(&body);
}

void sope__html_to_text(const char *html, size_t n, sope_buf *out)
{
    html_to_text(html, n, NULL, out);
}

/* ------------------------------------------------------------------------ */
/* the tool                                                                  */
/* ------------------------------------------------------------------------ */

static void web_fetch_cancel(tool_run *r)
{
    sope__http_release(r->http);
    r->http = NULL;
}

static int contains_ci(const char *hay, const char *needle)
{
    size_t n = strlen(needle);
    for (; *hay; hay++)
        if (!strncasecmp(hay, needle, n)) return 1;
    return 0;
}

static sope_next tool_web_fetch(tool_run *r)
{
    const char *url = sope__arg_string(r, "url");
    int64_t offset = sope__arg_int(r, "offset", 0);
    char err[256], ctype[256], final_url[2048];
    sope_buf text = { 0 };
    long status = 0;
    const char *image;
    int done, html;
    size_t start, end;

    if (!r->http) {
        if (!url || (strncmp(url, "http://", 7) && strncmp(url, "https://", 8)))
            return sope__run_fail(r, "url must be a complete http:// or https:// URL");
        if (!sope__http_available()) return sope__run_fail(r, "web_fetch is unavailable: sope was built without libcurl");
        if (!(r->http = sope__http_get(url, r->ca_file, &r->task)))
            return sope__run_fail(r, "cannot start the request: %s", sope_last_error());
        return (sope_next){ SOPE__NEXT_WAIT, 0 };
    }

    done = sope__http_take(r->http, &r->body, &status, err, sizeof err);
    if (r->body.len > FETCH_MAX_BODY || r->body.oom) {
        web_fetch_cancel(r);
        return sope__run_fail(r, "%s: the response is larger than %d MB", url, FETCH_MAX_BODY / (1024 * 1024));
    }
    if (!done) return (sope_next){ SOPE__NEXT_WAIT, 0 };
    sope__http_info(r->http, ctype, sizeof ctype, final_url, sizeof final_url);
    web_fetch_cancel(r);
    if (err[0]) return sope__run_fail(r, "fetching %s failed: %s", url, err);

    html = contains_ci(ctype, "html") ||
           (!ctype[0] && r->body.len && memchr(r->body.ptr, '<', r->body.len < 512 ? r->body.len : 512));
    if (html) {
        html_to_text(r->body.ptr ? r->body.ptr : "", r->body.len, final_url[0] ? final_url : url, &text);
    } else if (!strncasecmp(ctype, "image/", 6) && (image = sope__image_type(r->body.ptr, r->body.len))) {
        if (r->body.len > SOPE__MAX_IMAGE_BYTES)
            return sope__run_fail(r, "%s is an image of %zu bytes, over the %u byte limit for images", url, r->body.len,
                                  SOPE__MAX_IMAGE_BYTES);
        if (!sope__run_add_image(r, image, r->body.ptr, r->body.len)) return sope__run_fail(r, "out of memory");
        sope__buf_free(&text);
        sope__buf_appendf(&r->out, "Fetched an image from %s (%s, %zu KB), attached for you to look at.",
                          final_url[0] ? final_url : url, image + 6, (r->body.len + 1023) / 1024);
        return sope__run_done(r);
    } else if (!ctype[0] || !strncasecmp(ctype, "text/", 5) || contains_ci(ctype, "json") ||
               contains_ci(ctype, "xml") || contains_ci(ctype, "javascript")) {
        sope__buf_append(&text, r->body.ptr ? r->body.ptr : "", r->body.len);
        sope__buf_sanitize(&text, 0);
    } else {
        sope__buf_free(&text);
        return sope__run_fail(r, "%s returned %s content (%zu bytes), which web_fetch cannot show as text", url, ctype,
                              r->body.len);
    }
    if (text.oom) {
        sope__buf_free(&text);
        return sope__run_fail(r, "out of memory");
    }

    if (final_url[0] && strcmp(final_url, url)) sope__buf_appendf(&r->out, "Redirected to: %s\n", final_url);
    if (status >= 400) {
        sope__buf_appendf(&r->out, "HTTP %ld\n", status);
        r->is_error = 1;
    }
    start = offset > 0 ? (size_t)offset : 0;
    if (start > text.len) start = text.len;
    while (start < text.len && ((unsigned char)text.ptr[start] & 0xc0) == 0x80) start++;
    end = start + FETCH_CHUNK < text.len ? start + FETCH_CHUNK : text.len;
    while (end < text.len && ((unsigned char)text.ptr[end] & 0xc0) == 0x80) end++;
    if (r->out.len) sope__buf_appends(&r->out, "\n");
    if (start == end) sope__buf_appends(&r->out, text.len ? "(no content past this offset)" : "(the page has no text)");
    else sope__buf_append(&r->out, text.ptr + start, end - start);
    if (end < text.len || start > 0)
        sope__buf_appendf(&r->out, "\n\n[showing bytes %zu-%zu of %zu%s]", start, end, text.len,
                          end < text.len ? "; call web_fetch again with the next offset for more" : "");
    if (end < text.len) {
        r->out.len -= 1; /* fold the offset hint into the bracket */
        sope__buf_appendf(&r->out, " (offset %zu)]", end);
    }
    sope__buf_free(&text);
    return sope__run_done(r);
}

const sope_builtin sope__builtin_web_fetch = { "web_fetch", WEB_FETCH_DESC, WEB_FETCH_SCHEMA, 1, tool_web_fetch,
                                               web_fetch_cancel };
