/* SPDX-License-Identifier: MIT */
/* test_json.c - unit tests for the internal JSON parser and string helpers. */
#include "../src/sope_internal.h"

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

int main(void)
{
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
