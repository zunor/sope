/* SPDX-License-Identifier: MIT */
/* test_json.c - unit tests for internal helpers: the JSON parser, strings,
 * glob patterns and HTML to text. */
#include "../src/tools.h"

#include <stdio.h>
#include <string.h>

static int failures;

#define CHECK(cond)                                                                \
    do {                                                                           \
        if (!(cond)) {                                                             \
            fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #cond); \
            failures++;                                                            \
        }                                                                          \
    } while (0)

static sope_json *parse(const char *s)
{
    return sope__json_parse(s, strlen(s));
}

static void test_values(void)
{
    sope_json *v = parse(" {\"a\": [1, -2.5e1, true, false, null], \"b\": {\"c\": \"d\"}, \"\": \"\"} ");
    const sope_json *a;
    CHECK(v && v->type == SOPE_JSON_OBJECT && v->count == 3);
    a = sope__json_get(v, "a");
    CHECK(a && a->type == SOPE_JSON_ARRAY && a->count == 5);
    CHECK(sope__json_number(sope__json_at(a, 0), 0) == 1);
    CHECK(sope__json_number(sope__json_at(a, 1), 0) == -25);
    CHECK(sope__json_at(a, 2)->boolean == 1);
    CHECK(sope__json_at(a, 4)->type == SOPE_JSON_NULL);
    CHECK(sope__json_at(a, 5) == NULL);
    CHECK(!strcmp(sope__json_string(sope__json_get(sope__json_get(v, "b"), "c"), NULL), "d"));
    CHECK(sope__json_string(sope__json_get(v, ""), NULL)[0] == '\0');
    CHECK(sope__json_get(v, "missing") == NULL);
    sope__json_free(v);
}

static void test_strings(void)
{
    size_t n;
    sope_json *v = parse("\"tab\\t quote\\\" \\u4f60\\u597d \\ud83d\\ude00 \\/\"");
    const char *s = sope__json_string(v, &n);
    CHECK(s && !strcmp(s, "tab\t quote\" 你好 😀 /"));
    CHECK(n == strlen(s));
    sope__json_free(v);

    v = parse("\"\\u0000x\""); /* embedded NUL keeps its length */
    CHECK(v && v->len == 2 && v->str[1] == 'x');
    sope__json_free(v);
}

static void test_malformed(void)
{
    static const char *bad[] = { "", "{", "[1,]", "{\"a\" 1}", "\"unterminated", "tru", "{} x", "\"\\q\"",
                                 "\"raw\nnewline\"", "01x" };
    size_t i;
    for (i = 0; i < sizeof bad / sizeof bad[0]; i++) {
        sope_json *v = parse(bad[i]);
        if (v) fprintf(stderr, "accepted: %s\n", bad[i]);
        CHECK(v == NULL);
        sope__json_free(v);
    }
}

static void test_depth_limit(void)
{
    char deep[300];
    memset(deep, '[', 200);
    memset(deep + 200, ']', 1);
    deep[201] = '\0';
    CHECK(parse(deep) == NULL);
}

static void test_escape_roundtrip(void)
{
    static const char raw[] = "a\"b\\c\n\x01 你好";
    sope_buf b = { 0 };
    sope_json *v;
    sope__buf_append_json_string(&b, raw, sizeof raw - 1);
    CHECK(!strcmp(b.ptr, "\"a\\\"b\\\\c\\n\\u0001 你好\""));
    v = sope__json_parse(b.ptr, b.len);
    CHECK(v && v->len == sizeof raw - 1 && !memcmp(v->str, raw, v->len));
    sope__json_free(v);
    sope__buf_free(&b);
}

static int text_is(sope_buf *b, const char *want)
{
    int ok = b->ptr && !strcmp(b->ptr, want);
    if (!ok) fprintf(stderr, "got: [%s]\nwant: [%s]\n", b->ptr ? b->ptr : "(null)", want);
    sope__buf_free(b);
    return ok;
}

static void test_sanitize(void)
{
    sope_buf b = { 0 };
    sope__buf_appends(&b, "ok\x1b[31mred\x1b[0m\r\nbad\xff\xc3(\x01tab\there\rnext \xe4\xb8\xad");
    sope__buf_sanitize(&b, 0);
    CHECK(text_is(&b, "okred\nbad\xef\xbf\xbd\xef\xbf\xbd(tab\there\nnext \xe4\xb8\xad"));

    sope__buf_appends(&b, "keep \x1b]0;title\x07this");
    sope__buf_sanitize(&b, 5); /* only from byte 5 on */
    CHECK(text_is(&b, "keep this"));
}

static void test_clip(void)
{
    sope_buf b = { 0 };
    size_t i;
    for (i = 0; i < 1000; i++) sope__buf_appends(&b, "\xe4\xb8\xad"); /* 3000 bytes */
    sope__buf_clip_middle(&b, 1000);
    CHECK(b.len < 1100 && strstr(b.ptr, "bytes omitted"));
    sope__buf_sanitize(&b, 0); /* the cuts fell on character boundaries */
    CHECK(!strstr(b.ptr, "\xef\xbf\xbd"));
    sope__buf_free(&b);
}

static void test_glob(void)
{
    CHECK(sope__glob_match("*.c", "main.c"));
    CHECK(!sope__glob_match("*.c", "src/main.c"));
    CHECK(sope__glob_match("**/*.c", "main.c"));
    CHECK(sope__glob_match("**/*.c", "a/b/c/main.c"));
    CHECK(sope__glob_match("src/**", "src/a/b"));
    CHECK(sope__glob_match("src/**/test_*.c", "src/test_x.c"));
    CHECK(sope__glob_match("src/**/test_*.c", "src/a/b/test_x.c"));
    CHECK(!sope__glob_match("src/**/test_*.c", "lib/test_x.c"));
    CHECK(sope__glob_match("*.{ts,tsx}", "app.tsx"));
    CHECK(sope__glob_match("{src,lib}/**/*.{c,h}", "lib/x/y.h"));
    CHECK(!sope__glob_match("*.{ts,tsx}", "app.js"));
    CHECK(sope__glob_match("file?.[ch]", "file1.h"));
    CHECK(!sope__glob_match("file?.[!ch]", "file1.h"));
    CHECK(sope__glob_match("[a-c]x", "bx"));
    CHECK(sope__glob_match("?.txt", "\xe4\xb8\xad.txt")); /* ? is one character, not one byte */
    CHECK(sope__glob_match("a\\*b", "a*b") && !sope__glob_match("a\\*b", "axb"));
}

static void test_html(void)
{
    sope_buf b = { 0 };
    const char *page =
        "<!doctype html><html><head><title>The &amp; Title</title><style>p{color:red}</style>"
        "<script>var x = '<p>no</p>';</script></head><body>"
        "<h1>Main   heading</h1><p>Some <b>bold</b>\n text with a <a href=\"https://e.com/x\">link</a>"
        " and <a href=\"#top\">an anchor</a>.</p>"
        "<ul><li>one</li><li>two &lt;3&gt;</li></ul>"
        "<pre>code\n  indented</pre>"
        "<table><tr><th>a</th><th>b</th></tr><tr><td>1</td><td>2</td></tr></table>"
        "<!-- hidden --><p>caf&#233; &#x4e2d;&nbsp;end</p></body></html>";
    sope__html_to_text(page, strlen(page), &b);
    CHECK(text_is(&b, "# The & Title\n\n"
                      "# Main heading\n\n"
                      "Some bold text with a [link](https://e.com/x) and an anchor.\n\n"
                      "- one\n- two <3>\n\n"
                      "```\ncode\n  indented\n```\n\n"
                      "a | b\n1 | 2\n\n"
                      "caf\xc3\xa9 \xe4\xb8\xad end"));
}

int main(void)
{
    test_sanitize();
    test_clip();
    test_glob();
    test_html();
    test_values();
    test_strings();
    test_malformed();
    test_depth_limit();
    test_escape_roundtrip();
    if (failures) {
        fprintf(stderr, "%d check(s) failed\n", failures);
        return 1;
    }
    printf("all tests passed\n");
    return 0;
}
