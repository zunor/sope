/* SPDX-License-Identifier: MIT */
/*
 * tool_search.c - glob and grep, over the files walk.c finds (patterns,
 * .gitignore and the walk itself are there).
 *
 * Regexes are POSIX extended, after rewriting the Perl-isms models reach
 * for: \d \w \s (and capitals), (?i), (?:...) and lazy quantifiers.
 */
#if defined(__APPLE__)
#  define _DARWIN_C_SOURCE /* REG_ENHANCED */
#else
#  define _DEFAULT_SOURCE
#endif

#include "tools.h"

#include <fcntl.h>
#include <regex.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <strings.h>
#include <sys/stat.h>
#include <unistd.h>

#define GLOB_LIMIT 100
#define GREP_DEFAULT_LIMIT 250
#define GREP_MAX_FILE (20 * 1024 * 1024)

static const char GLOB_DESC[] =
    "Finds files by path pattern, such as \"**/*.ts\" or \"src/**/test_*.c\".\n\n"
    "Usage:\n"
    "- Patterns support *, ?, [abc], {a,b} and ** (any number of directories). A pattern without a slash, "
    "such as \"*.c\", matches files directly in the search directory only; use \"**/*.c\" to search below it.\n"
    "- Returns matching paths, most recently modified first, at most 100.\n"
    "- Hidden files and paths ignored by .gitignore are skipped.\n"
    "- Use it instead of find or ls -R. For open-ended searches that need several rounds of glob and grep, "
    "use the agent tool.";
static const char GLOB_SCHEMA[] =
    "{\"type\":\"object\",\"properties\":{"
    "\"pattern\":{\"type\":\"string\",\"description\":\"The pattern to match paths against\"},"
    "\"path\":{\"type\":\"string\",\"description\":\"The directory to search (default: the working "
    "directory)\"}},"
    "\"required\":[\"pattern\"]}";

static const char GREP_DESC[] =
    "Searches file contents with a regular expression.\n\n"
    "Usage:\n"
    "- Use it for content search instead of running grep or rg through bash.\n"
    "- The pattern is an extended regular expression (POSIX ERE) with \\d, \\w and \\s shorthands, e.g. "
    "\"log.*Error\" or \"func\\s+\\w+\". Escape literal braces, brackets and parentheses.\n"
    "- Narrow the search with path (a file or directory) and glob (e.g. \"*.c\" or \"src/**/*.{ts,tsx}\").\n"
    "- output_mode: \"files_with_matches\" (default) lists matching files, most recently modified first; "
    "\"content\" shows matching lines as path:line:text, with context lines when context > 0; \"count\" "
    "shows the number of matching lines per file.\n"
    "- Hidden files, binary files and paths ignored by .gitignore are skipped.\n"
    "- For open-ended searches that need several rounds, use the agent tool.";
static const char GREP_SCHEMA[] =
    "{\"type\":\"object\",\"properties\":{"
    "\"pattern\":{\"type\":\"string\",\"description\":\"The regular expression to search for\"},"
    "\"path\":{\"type\":\"string\",\"description\":\"File or directory to search (default: the working "
    "directory)\"},"
    "\"glob\":{\"type\":\"string\",\"description\":\"Only search files whose path matches this pattern\"},"
    "\"output_mode\":{\"type\":\"string\",\"enum\":[\"files_with_matches\",\"content\",\"count\"]},"
    "\"case_insensitive\":{\"type\":\"boolean\"},"
    "\"context\":{\"type\":\"integer\",\"description\":\"Lines of context around each match (content "
    "mode)\"},"
    "\"head_limit\":{\"type\":\"integer\",\"description\":\"Return at most this many lines or files "
    "(default 250)\"}},"
    "\"required\":[\"pattern\"]}";

/* ------------------------------------------------------------------------ */
/* results                                                                   */
/* ------------------------------------------------------------------------ */

typedef struct {
    char *path;
    int64_t mtime;
    size_t count;
} found;

typedef struct {
    found *items;
    size_t n, cap;
} found_list;

static void found_add(found_list *l, const char *path, const struct stat *st, size_t count)
{
    if (l->n == l->cap) {
        size_t cap = l->cap ? l->cap * 2 : 64;
        found *items = realloc(l->items, cap * sizeof *items);
        if (!items) return;
        l->items = items;
        l->cap = cap;
    }
    if (!(l->items[l->n].path = sope__strdup(path))) return;
    l->items[l->n].mtime = (int64_t)st->st_mtime;
    l->items[l->n].count = count;
    l->n++;
}

static int newest_first(const void *a, const void *b)
{
    const found *x = a, *y = b;
    if (x->mtime != y->mtime) return x->mtime < y->mtime ? 1 : -1;
    return strcmp(x->path, y->path);
}

static void found_free(found_list *l)
{
    size_t i;
    for (i = 0; i < l->n; i++) free(l->items[i].path);
    free(l->items);
}

/* ------------------------------------------------------------------------ */
/* glob                                                                      */
/* ------------------------------------------------------------------------ */

typedef struct {
    const char *base;
    char **patterns;
    size_t n_patterns;
    found_list found;
} glob_ctx;

static void glob_file(sope_walk *w, const char *path, const struct stat *st)
{
    glob_ctx *g = w->ctx;
    size_t blen = strlen(g->base), i;
    const char *rel = path + (blen > 1 ? blen + 1 : 1);
    for (i = 0; i < g->n_patterns; i++)
        if (sope__glob_match_one(g->patterns[i], rel)) {
            found_add(&g->found, path, st, 0);
            return;
        }
}

static int has_wildcard(const char *s, size_t n)
{
    size_t i;
    for (i = 0; i < n; i++)
        if (strchr("*?[{", s[i])) return 1;
    return 0;
}

static sope_next tool_glob(tool_run *r)
{
    const char *pattern = sope__arg_string(r, "pattern"), *dir_arg = sope__arg_string(r, "path"), *rest;
    char *base = NULL, *patterns[SOPE__MAX_PATTERNS];
    glob_ctx g = { 0 };
    sope_walk w = { 0 };
    sope_buf prefix = { 0 };
    struct stat st;
    size_t i, shown;
    int deep = 0;

    if (!pattern || !*pattern) return sope__run_fail(r, "pattern is required");
    /* Literal leading segments narrow the walk: "src/lib/x/[pattern]" walks src/lib/x. */
    rest = pattern;
    if (*rest == '/') sope__buf_appends(&prefix, "/");
    for (;;) {
        const char *slash = strchr(rest, '/');
        if (!slash || has_wildcard(rest, (size_t)(slash - rest))) break;
        sope__buf_append(&prefix, rest, (size_t)(slash - rest + 1));
        rest = slash + 1;
    }
    if (*pattern == '/') {
        base = sope__run_path(r, prefix.ptr);
    } else {
        sope_buf joined = { 0 };
        sope__buf_appends(&joined, dir_arg && *dir_arg ? dir_arg : ".");
        if (prefix.len) sope__buf_appendf(&joined, "/%s", prefix.ptr);
        base = joined.oom ? NULL : sope__run_path(r, joined.ptr);
        sope__buf_free(&joined);
    }
    sope__buf_free(&prefix);
    if (!base) return sope__run_fail(r, "out of memory");
    if (stat(base, &st) != 0 || !S_ISDIR(st.st_mode)) {
        sope__run_fail(r, "%s is not a directory", sope__display_path(r, base));
        free(base);
        return sope__run_done(r);
    }

    g.base = base;
    g.n_patterns = sope__glob_expand(*rest ? rest : "*", patterns, SOPE__MAX_PATTERNS);
    g.patterns = patterns;
    w.max_depth = 0;
    for (i = 0; i < g.n_patterns; i++) {
        const char *p;
        int slashes = 0;
        if (strstr(patterns[i], "**")) deep = 1;
        for (p = patterns[i]; *p; p++) slashes += *p == '/';
        if (slashes > w.max_depth) w.max_depth = slashes;
    }
    if (deep) w.max_depth = -1;
    w.on_file = glob_file;
    w.ctx = &g;
    sope__walk_ignores_above(&w, base);
    sope__walk(&w, base);

    if (g.found.n) qsort(g.found.items, g.found.n, sizeof *g.found.items, newest_first);
    shown = g.found.n < GLOB_LIMIT ? g.found.n : GLOB_LIMIT;
    for (i = 0; i < shown; i++) sope__buf_appendf(&r->out, "%s\n", sope__display_path(r, g.found.items[i].path));
    if (!g.found.n) sope__buf_appends(&r->out, "No files found");
    if (g.found.n > shown)
        sope__buf_appendf(&r->out, "(%zu more files not shown; use a more specific pattern or path)",
                          g.found.n - shown);
    if (w.stop) sope__buf_appends(&r->out, "\n(the search stopped early: the tree is very large)");

    for (i = 0; i < g.n_patterns; i++) free(patterns[i]);
    found_free(&g.found);
    sope__walk_free(&w);
    free(base);
    return sope__run_done(r);
}

/* ------------------------------------------------------------------------ */
/* grep                                                                      */
/* ------------------------------------------------------------------------ */

/* Rewrites Perl-style syntax into POSIX ERE. */
static char *translate_regex(const char *p, int *icase)
{
    sope_buf out = { 0 };
    int in_class = 0;

    if (!strncmp(p, "(?i)", 4)) {
        *icase = 1;
        p += 4;
    }
    while (*p) {
        char c = *p;
        if (in_class) {
            if (c == ']' && in_class > 1) {
                in_class = 0;
                sope__buf_append(&out, "]", 1);
                p++;
                continue;
            }
            in_class++;
            if (c == '\\' && p[1]) {
                const char *cls = NULL;
                switch (p[1]) {
                case 'd': cls = "0-9"; break;
                case 'w': cls = "[:alnum:]_"; break;
                case 's': cls = "[:space:]"; break;
                case 't': cls = "\t"; break;
                case 'n': cls = "\n"; break;
                }
                if (cls) sope__buf_appends(&out, cls);
                else sope__buf_append(&out, p + 1, 1);
                p += 2;
                continue;
            }
            sope__buf_append(&out, p, 1);
            p++;
            continue;
        }
        if (c == '[') {
            in_class = 1;
            sope__buf_append(&out, "[", 1);
            p++;
            if (*p == '^') {
                sope__buf_append(&out, "^", 1);
                p++;
            }
            continue;
        }
        if (c == '\\' && p[1]) {
            const char *cls = NULL;
            switch (p[1]) {
            case 'd': cls = "[0-9]"; break;
            case 'D': cls = "[^0-9]"; break;
            case 'w': cls = "[[:alnum:]_]"; break;
            case 'W': cls = "[^[:alnum:]_]"; break;
            case 's': cls = "[[:space:]]"; break;
            case 'S': cls = "[^[:space:]]"; break;
            case 't': cls = "\t"; break;
            }
            if (cls) sope__buf_appends(&out, cls);
            else sope__buf_append(&out, p, 2);
            p += 2;
            continue;
        }
        if (c == '(' && p[1] == '?' && p[2] == ':') {
            sope__buf_append(&out, "(", 1);
            p += 3;
            continue;
        }
        if ((c == '*' || c == '+' || c == '?' || c == '}') && p[1] == '?') { /* lazy: no POSIX equivalent */
            sope__buf_append(&out, p, 1);
            p += 2;
            continue;
        }
        sope__buf_append(&out, p, 1);
        p++;
    }
    if (out.oom) {
        sope__buf_free(&out);
        return NULL;
    }
    return out.ptr ? out.ptr : sope__strdup("");
}

typedef enum { MODE_FILES, MODE_CONTENT, MODE_COUNT } grep_mode;

typedef struct {
    tool_run *r;
    regex_t re;
    grep_mode mode;
    int context;
    size_t limit;
    const char *base; /* for glob filters */
    char **globs;
    size_t n_globs;
    int globs_have_slash;
    found_list files;
    size_t lines; /* content lines written */
    int truncated;
    int archive_fd;
    int archive_failed;
    char *archive_path;
    uint64_t archive_bytes;
} grep_ctx;

static int glob_allows(grep_ctx *g, const char *path)
{
    size_t blen = strlen(g->base), i;
    const char *rel = !strncmp(path, g->base, blen) && path[blen] == '/' ? path + blen + 1 : path;
    const char *name = strrchr(path, '/');
    name = name ? name + 1 : path;
    if (!g->n_globs) return 1;
    for (i = 0; i < g->n_globs; i++)
        if (sope__glob_match_one(g->globs[i], strchr(g->globs[i], '/') ? rel : name)) return 1;
    return 0;
}

static void emit_line(grep_ctx *g, const char *shown, size_t no, char sep, const char *s, size_t n)
{
    if (g->lines >= g->limit) {
        g->truncated = 1;
        return;
    }
    if (g->archive_failed) return;
    sope_buf prefix = {0};
    sope__buf_appendf(&prefix, "%s%c%zu%c", shown, sep, no, sep);
    if (prefix.oom) { g->archive_failed = 1; sope__buf_free(&prefix); return; }
    sope_buf *out = &g->r->out;
    /* Stream large matching output instead of accumulating long lines in RAM.
     * Explicit query limits still determine which matches belong to the result. */
    if (g->archive_fd < 0 && out->len + prefix.len + n + 1 > 30000) {
        g->archive_fd = sope__artifact_create(g->r->agent, "grep", &g->archive_path);
        if (g->archive_fd < 0 || !sope__write_fd(g->archive_fd, out->ptr, out->len)) g->archive_failed = 1;
        g->archive_bytes = out->len;
    }
    if (g->archive_fd >= 0 && !g->archive_failed) {
        if (!sope__write_fd(g->archive_fd, prefix.ptr, prefix.len) ||
            !sope__write_fd(g->archive_fd, s, n) || !sope__write_fd(g->archive_fd, "\n", 1)) g->archive_failed = 1;
        g->archive_bytes += prefix.len + n + 1;
    }
    if (out->len + prefix.len < 30000) {
        sope__buf_append(out, prefix.ptr, prefix.len);
        size_t room = 30000 - out->len;
        sope__buf_append(out, s, n < room ? n : room);
        if (n < room) sope__buf_appends(out, "\n");
    }
    sope__buf_free(&prefix);
    g->lines++;
}

static void grep_file(sope_walk *w, const char *path, const struct stat *st)
{
    grep_ctx *g = w->ctx;
    if (g->archive_failed) { w->stop = 1; return; }
    sope_buf data = { 0 };
    char buf[65536];
    ssize_t got;
    size_t pos = 0, no = 0, matches = 0, last_printed = 0, last_match = 0;
    size_t *starts = NULL; /* content mode with context: offsets of recent lines */
    size_t ring = (size_t)g->context + 1;
    int fd;
    const char *shown = sope__display_path(g->r, path);

    if (!glob_allows(g, path) || st->st_size > GREP_MAX_FILE) return;
    if (g->mode == MODE_CONTENT && g->lines >= g->limit) {
        g->truncated = 1;
        w->stop = 1;
        return;
    }
    if ((fd = sope__open_regular_read(path)) < 0) return;
    while ((got = read(fd, buf, sizeof buf)) > 0) {
        if ((size_t)got > GREP_MAX_FILE - data.len) { close(fd); sope__buf_free(&data); return; }
        sope__buf_append(&data, buf, (size_t)got);
        if (data.oom) break;
    }
    close(fd);
    if (!data.len || data.oom || memchr(data.ptr, '\0', data.len < 8192 ? data.len : 8192)) {
        sope__buf_free(&data);
        return;
    }
    if (g->mode == MODE_CONTENT && g->context > 0 && !(starts = calloc(ring, sizeof *starts))) {
        sope__buf_free(&data);
        return;
    }

    while (pos < data.len) {
        char *line = data.ptr + pos, *nl = memchr(line, '\n', data.len - pos);
        size_t len = nl ? (size_t)(nl - line) : data.len - pos, end = len;
        char saved;
        int hit;
        no++;
        if (end && line[end - 1] == '\r') end--;
        saved = line[end];
        line[end] = '\0';
        hit = regexec(&g->re, line, 0, NULL, 0) == 0;
        line[end] = saved;
        if (starts) starts[no % ring] = pos;

        if (hit) {
            matches++;
            if (g->mode == MODE_FILES) break;
            if (g->mode == MODE_CONTENT) {
                size_t from = no > (size_t)g->context ? no - (size_t)g->context : 1, k;
                if (last_printed && from <= last_printed) from = last_printed + 1;
                else if (last_printed && from > last_printed + 1 && g->context > 0)
                    sope__buf_appends(&g->r->out, "--\n");
                for (k = from; k < no && starts; k++) { /* leading context */
                    const char *cl = data.ptr + starts[k % ring];
                    const char *cnl = memchr(cl, '\n', data.len - (size_t)(cl - data.ptr));
                    size_t clen = cnl ? (size_t)(cnl - cl) : data.len - (size_t)(cl - data.ptr);
                    if (clen && cl[clen - 1] == '\r') clen--;
                    emit_line(g, shown, k, '-', cl, clen);
                }
                emit_line(g, shown, no, ':', line, end);
                last_printed = last_match = no;
            }
        } else if (g->mode == MODE_CONTENT && last_match && no <= last_match + (size_t)g->context &&
                   no == last_printed + 1) { /* trailing context */
            emit_line(g, shown, no, '-', line, end);
            last_printed = no;
        }
        if (g->truncated) break;
        pos += len + (nl ? 1 : 0);
    }
    if (matches && g->mode != MODE_CONTENT) found_add(&g->files, path, st, matches);
    free(starts);
    sope__buf_free(&data);
}

static sope_next tool_grep(tool_run *r)
{
    const char *pattern = sope__arg_string(r, "pattern"), *path_arg = sope__arg_string(r, "path");
    const char *mode = sope__arg_string(r, "output_mode"), *glob = sope__arg_string(r, "glob");
    int icase = sope__arg_bool(r, "case_insensitive"), flags = REG_EXTENDED | REG_NOSUB, rc;
    int64_t limit = sope__arg_int(r, "head_limit", GREP_DEFAULT_LIMIT);
    char *re_src, *base, *globs[SOPE__MAX_PATTERNS];
    size_t n_globs;
    grep_ctx g = { .archive_fd = -1 };
    sope_walk w = { 0 };
    struct stat st;
    size_t i;

    if (!pattern || !*pattern) return sope__run_fail(r, "pattern is required");
    g.mode = !mode || !strcmp(mode, "files_with_matches") ? MODE_FILES
             : !strcmp(mode, "content")                  ? MODE_CONTENT
             : !strcmp(mode, "count")                    ? MODE_COUNT
                                                         : (grep_mode)-1;
    if ((int)g.mode < 0) return sope__run_fail(r, "output_mode must be files_with_matches, content or count");
    if (!(re_src = translate_regex(pattern, &icase))) return sope__run_fail(r, "out of memory");
    if (icase) flags |= REG_ICASE;
#ifdef REG_ENHANCED
    flags |= REG_ENHANCED; /* \b and friends on macOS; glibc has them as GNU extensions */
#endif
    if ((rc = regcomp(&g.re, re_src, flags)) != 0) {
        char msg[256];
        regerror(rc, &g.re, msg, sizeof msg);
        free(re_src);
        return sope__run_fail(r, "invalid regular expression: %s", msg);
    }
    free(re_src);
    if (!(base = sope__run_path(r, path_arg && *path_arg ? path_arg : "."))) {
        regfree(&g.re);
        return sope__run_fail(r, "out of memory");
    }

    g.r = r;
    g.context = (int)sope__arg_int(r, "context", 0);
    if (g.context < 0) g.context = 0;
    if (g.context > 20) g.context = 20;
    if (g.mode != MODE_CONTENT) g.context = 0;
    g.limit = limit > 0 ? (size_t)limit : GREP_DEFAULT_LIMIT;
    g.base = base;
    g.n_globs = n_globs = glob && *glob ? sope__glob_expand(glob, globs, SOPE__MAX_PATTERNS) : 0;
    g.globs = globs;
    w.max_depth = -1;
    w.on_file = grep_file;
    w.ctx = &g;

    if (stat(base, &st) != 0) {
        sope__run_fail(r, "%s does not exist", sope__display_path(r, base));
    } else if (S_ISDIR(st.st_mode)) {
        sope__walk_ignores_above(&w, base);
        sope__walk(&w, base);
    } else if (!S_ISREG(st.st_mode)) {
        sope__run_fail(r, "%s is not a regular file", sope__display_path(r, base));
    } else {
        g.n_globs = 0; /* an explicit file is searched whatever its name */
        grep_file(&w, base, &st);
    }

    if (!r->is_error) {
        if (g.mode == MODE_CONTENT) {
            if (!g.lines) sope__buf_appends(&r->out, "No matches found");
            if (g.truncated)
                sope__buf_appendf(&r->out, "(stopped after %zu lines; narrow the search or raise head_limit)",
                                  g.limit);
        } else {
            size_t shown = g.files.n < g.limit ? g.files.n : g.limit;
            if (g.mode == MODE_FILES && g.files.n)
                qsort(g.files.items, g.files.n, sizeof *g.files.items, newest_first);
            for (i = 0; i < shown; i++) {
                const char *p = sope__display_path(r, g.files.items[i].path);
                if (g.mode == MODE_COUNT) sope__buf_appendf(&r->out, "%s:%zu\n", p, g.files.items[i].count);
                else sope__buf_appendf(&r->out, "%s\n", p);
            }
            if (!g.files.n) sope__buf_appends(&r->out, "No matches found");
            if (g.files.n > shown)
                sope__buf_appendf(&r->out, "(%zu more files not shown; narrow the search or raise head_limit)",
                                  g.files.n - shown);
        }
        if (w.stop && !g.truncated) sope__buf_appends(&r->out, "\n(the search stopped early: the tree is very large)");
    }

    if (g.archive_fd >= 0) {
        if (fsync(g.archive_fd) != 0) g.archive_failed = 1;
        if (close(g.archive_fd) != 0) g.archive_failed = 1;
        pthread_mutex_lock(r->agent->mu);
        if (!g.archive_failed && !sope__journal_artifact(r->agent, r->call_id, g.archive_path)) g.archive_failed = 1;
        pthread_mutex_unlock(r->agent->mu);
        if (!g.archive_failed) sope__buf_appendf(&r->out, "\n[Full output: %s (%llu bytes). Use artifact_read for omitted matches.]", g.archive_path, (unsigned long long)g.archive_bytes);
    }
    if (g.archive_failed) {
        pthread_mutex_lock(r->agent->mu);
        sope__storage_fail_locked(r->agent, "Search output archive failed; execution stopped.");
        pthread_mutex_unlock(r->agent->mu);
        sope__run_fail(r, "Cannot archive complete search output.");
    }
    free(g.archive_path);
    for (i = 0; i < n_globs; i++) free(globs[i]);
    found_free(&g.files);
    sope__walk_free(&w);
    regfree(&g.re);
    free(base);
    return sope__run_done(r);
}

const sope_builtin sope__builtin_glob = { "glob", GLOB_DESC, GLOB_SCHEMA, 0, tool_glob, NULL };
const sope_builtin sope__builtin_grep = { "grep", GREP_DESC, GREP_SCHEMA, 0, tool_grep, NULL };
