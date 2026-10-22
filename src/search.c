/* SPDX-License-Identifier: MIT */
/*
 * search.c - the glob and grep tools: walking a tree the way a developer
 * expects (hidden files, .git, node_modules and .gitignore'd paths are
 * skipped), glob patterns, and a regex dialect close to what models write.
 *
 * Patterns: * and ? stay within one path segment, ** spans any number of
 * them ("**" + "/" also matches no directory at all), [...] is a character
 * class and {a,b} alternatives (nesting allowed).
 *
 * .gitignore support covers what real projects use: comments, negation (!),
 * directory-only rules (trailing /), anchored rules (containing /) and the
 * files of every directory from the repository root down.
 *
 * Regexes are POSIX extended, after rewriting the Perl-isms models reach
 * for: \d \w \s (and capitals), (?i), (?:...) and lazy quantifiers.
 */
#if defined(__APPLE__)
#  define _DARWIN_C_SOURCE /* REG_ENHANCED, d_type */
#else
#  define _DEFAULT_SOURCE /* d_type */
#endif

#include "tools.h"

#include <dirent.h>
#include <errno.h>
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
#define GREP_MAX_LINE 500
#define WALK_MAX_ENTRIES 500000
#define MAX_PATTERNS 64

/* ------------------------------------------------------------------------ */
/* glob patterns                                                             */
/* ------------------------------------------------------------------------ */

static size_t utf8_seq(unsigned char c)
{
    return c < 0x80 ? 1 : (c >> 5) == 0x6 ? 2 : (c >> 4) == 0xe ? 3 : (c >> 3) == 0x1e ? 4 : 1;
}

/* Matches a [...] class at *pp against c; advances *pp past it. -1: not a
 * class (no closing bracket). */
static int match_class(const char **pp, unsigned char c)
{
    const char *p = *pp + 1;
    int negate = 0, hit = 0;
    if (*p == '!' || *p == '^') negate = 1, p++;
    if (*p == ']') {
        hit = c == ']';
        p++;
    }
    while (*p && *p != ']') {
        unsigned char lo = (unsigned char)*p, hi = lo;
        if (lo == '\\' && p[1]) lo = hi = (unsigned char)*++p;
        if (p[1] == '-' && p[2] && p[2] != ']') {
            hi = (unsigned char)p[2];
            p += 2;
        }
        if (c >= lo && c <= hi) hit = 1;
        p++;
    }
    if (*p != ']') return -1;
    *pp = p + 1;
    return hit != negate;
}

static int match(const char *p, const char *s)
{
    for (;;) {
        if (!*p) return !*s;
        if (p[0] == '*' && p[1] == '*') {
            const char *rest = p + 2;
            if (*rest == '/') {
                rest++;
                if (match(rest, s)) return 1; /* no directory */
                for (; *s; s++)
                    if (*s == '/' && match(rest, s + 1)) return 1;
                return 0;
            }
            for (;; s++) {
                if (match(rest, s)) return 1;
                if (!*s) return 0;
            }
        }
        if (*p == '*') {
            p++;
            for (;; s++) {
                if (match(p, s)) return 1;
                if (!*s || *s == '/') return 0;
            }
        }
        if (!*s) return 0;
        if (*p == '?') {
            if (*s == '/') return 0;
            p++;
            s += utf8_seq((unsigned char)*s);
            continue;
        }
        if (*p == '[' && *s != '/') {
            const char *q = p;
            int m = match_class(&q, (unsigned char)*s);
            if (m >= 0) {
                if (!m) return 0;
                p = q;
                s++;
                continue;
            }
        }
        if (*p == '\\' && p[1]) p++;
        if (*p != *s) return 0;
        p++;
        s++;
    }
}

/* Expands the first {a,b} group of `pat` (recursively). Returns the number
 * of patterns added to out[], each malloc'd. */
static size_t expand_braces(const char *pat, char **out, size_t room)
{
    const char *open = NULL, *close = NULL, *p, *start;
    int depth = 0;
    size_t n = 0;

    for (p = pat; *p; p++) {
        if (*p == '\\' && p[1]) {
            p++;
        } else if (*p == '{') {
            if (depth++ == 0) open = p;
        } else if (*p == '}' && depth > 0) {
            if (--depth == 0) {
                close = p;
                break;
            }
        }
    }
    if (!open || !close) {
        if (room && (out[0] = sope__strdup(pat))) return 1;
        return 0;
    }
    for (start = open + 1, p = start, depth = 0; p <= close && n < room; p++) {
        if (*p == '{') depth++;
        else if (*p == '}' && depth > 0 && p != close) depth--;
        else if ((*p == ',' && depth == 0) || p == close) {
            sope_buf alt = { 0 };
            sope__buf_append(&alt, pat, (size_t)(open - pat));
            sope__buf_append(&alt, start, (size_t)(p - start));
            sope__buf_appends(&alt, close + 1);
            if (!alt.oom) n += expand_braces(alt.ptr, out + n, room - n);
            sope__buf_free(&alt);
            start = p + 1;
        }
    }
    return n;
}

int sope__glob_match(const char *pattern, const char *path)
{
    char *pats[MAX_PATTERNS];
    size_t n = expand_braces(pattern, pats, MAX_PATTERNS), i;
    int hit = 0;
    for (i = 0; i < n; i++) {
        if (!hit && match(pats[i], path)) hit = 1;
        free(pats[i]);
    }
    return hit;
}

/* ------------------------------------------------------------------------ */
/* walking                                                                   */
/* ------------------------------------------------------------------------ */

typedef struct {
    char *pattern;
    char *base; /* directory of the .gitignore */
    int negate, dir_only, anchored;
} ignore_rule;

typedef struct walk walk;
struct walk {
    tool_run *r;
    ignore_rule *rules;
    size_t n_rules, cap_rules;
    size_t visited;
    int max_depth; /* -1: unlimited */
    int stop;
    void (*on_file)(walk *w, const char *path, const struct stat *st);
    void *ctx;
};

static void load_ignore(walk *w, const char *dir)
{
    sope_buf path = { 0 };
    FILE *f;
    char line[1024];

    sope__buf_appendf(&path, "%s/.gitignore", dir);
    f = path.oom ? NULL : fopen(path.ptr, "r");
    sope__buf_free(&path);
    if (!f) return;
    while (fgets(line, sizeof line, f)) {
        size_t len = strcspn(line, "\r\n");
        char *p = line;
        ignore_rule *rule;
        line[len] = '\0';
        while (len && (line[len - 1] == ' ' || line[len - 1] == '\t')) line[--len] = '\0';
        if (!len || line[0] == '#') continue;
        if (w->n_rules == w->cap_rules) {
            size_t cap = w->cap_rules ? w->cap_rules * 2 : 32;
            ignore_rule *rules = realloc(w->rules, cap * sizeof *rules);
            if (!rules) break;
            w->rules = rules;
            w->cap_rules = cap;
        }
        rule = &w->rules[w->n_rules];
        memset(rule, 0, sizeof *rule);
        if (*p == '!') rule->negate = 1, p++;
        else if (*p == '\\') p++; /* \# and \! */
        len = strlen(p);
        if (len && p[len - 1] == '/') rule->dir_only = 1, p[--len] = '\0';
        if (!len) continue;
        rule->anchored = strchr(p, '/') != NULL;
        if (*p == '/') p++;
        if (!(rule->pattern = sope__strdup(p)) || !(rule->base = sope__strdup(dir))) {
            free(rule->pattern);
            free(rule->base);
            continue;
        }
        w->n_rules++;
    }
    fclose(f);
}

static void pop_rules(walk *w, size_t keep)
{
    while (w->n_rules > keep) {
        ignore_rule *rule = &w->rules[--w->n_rules];
        free(rule->pattern);
        free(rule->base);
    }
}

static int ignored(walk *w, const char *path, const char *name, int is_dir)
{
    size_t i;
    int out = 0;
    for (i = 0; i < w->n_rules; i++) {
        const ignore_rule *rule = &w->rules[i];
        size_t blen = strlen(rule->base);
        const char *rel;
        if (rule->dir_only && !is_dir) continue;
        if (strncmp(path, rule->base, blen) || path[blen] != '/') continue;
        rel = path + blen + 1;
        if (rule->anchored ? sope__glob_match(rule->pattern, rel) : sope__glob_match(rule->pattern, name))
            out = !rule->negate;
    }
    return out;
}

static int by_name(const void *a, const void *b)
{
    return strcmp(*(char *const *)a, *(char *const *)b);
}

static void walk_dir(walk *w, const char *dir, int depth)
{
    DIR *d = opendir(dir);
    struct dirent *e;
    char **names = NULL;
    size_t n = 0, cap = 0, i, keep = w->n_rules;

    if (!d) return;
    while ((e = readdir(d))) {
        if (e->d_name[0] == '.') continue; /* hidden, and . and .. */
        if (!strcmp(e->d_name, "node_modules")) continue;
        if (n == cap) {
            char **grown = realloc(names, (cap = cap ? cap * 2 : 64) * sizeof *names);
            if (!grown) break;
            names = grown;
        }
        if ((names[n] = sope__strdup(e->d_name))) n++;
    }
    closedir(d);
    if (n) qsort(names, n, sizeof *names, by_name);
    load_ignore(w, dir);

    for (i = 0; i < n; i++) {
        sope_buf path = { 0 };
        struct stat st;
        int is_dir;
        if (w->stop || ++w->visited > WALK_MAX_ENTRIES) {
            w->stop = 1;
            free(names[i]);
            continue;
        }
        sope__buf_appendf(&path, "%s%s%s", dir, dir[1] ? "/" : "", names[i]);
        if (!path.oom && lstat(path.ptr, &st) == 0) {
            if (S_ISLNK(st.st_mode) && stat(path.ptr, &st) != 0) st.st_mode = 0;
            is_dir = S_ISDIR(st.st_mode);
            if (!ignored(w, path.ptr, names[i], is_dir)) {
                struct stat lst;
                /* follow symlinked files, but not symlinked directories (cycles) */
                if (is_dir && (w->max_depth < 0 || depth < w->max_depth) && lstat(path.ptr, &lst) == 0 &&
                    !S_ISLNK(lst.st_mode))
                    walk_dir(w, path.ptr, depth + 1);
                else if (S_ISREG(st.st_mode))
                    w->on_file(w, path.ptr, &st);
            }
        }
        sope__buf_free(&path);
        free(names[i]);
    }
    free(names);
    pop_rules(w, keep);
}

/* Loads the .gitignore files above `dir` up to the repository root, top down. */
static void load_parent_ignores(walk *w, const char *dir)
{
    char *chain[64];
    size_t n = 0;
    char *cur = sope__strdup(dir);

    while (cur && n < 64) {
        sope_buf git = { 0 };
        struct stat st;
        char *slash;
        int is_root;
        sope__buf_appendf(&git, "%s/.git", cur);
        is_root = !git.oom && stat(git.ptr, &st) == 0;
        sope__buf_free(&git);
        if (is_root) break;
        slash = strrchr(cur, '/');
        if (!slash || slash == cur) {
            free(cur);
            cur = NULL;
            n = 0; /* not inside a repository: only the walk's own files count */
            break;
        }
        *slash = '\0';
        chain[n++] = sope__strdup(cur);
    }
    if (cur) {
        size_t i;
        for (i = n; i-- > 0;) {
            if (chain[i]) load_ignore(w, chain[i]);
        }
    }
    while (n) free(chain[--n]);
    free(cur);
}

static void walk_free(walk *w)
{
    pop_rules(w, 0);
    free(w->rules);
}

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

static void glob_file(walk *w, const char *path, const struct stat *st)
{
    glob_ctx *g = w->ctx;
    size_t blen = strlen(g->base), i;
    const char *rel = path + (blen > 1 ? blen + 1 : 1);
    for (i = 0; i < g->n_patterns; i++)
        if (match(g->patterns[i], rel)) {
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

sope_next sope__tool_glob(tool_run *r)
{
    const char *pattern = sope__arg_string(r, "pattern"), *dir_arg = sope__arg_string(r, "path"), *rest;
    char *base = NULL, *patterns[MAX_PATTERNS];
    glob_ctx g = { 0 };
    walk w = { 0 };
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
    g.n_patterns = expand_braces(*rest ? rest : "*", patterns, MAX_PATTERNS);
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
    w.r = r;
    w.on_file = glob_file;
    w.ctx = &g;
    load_parent_ignores(&w, base);
    walk_dir(&w, base, 0);

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
    walk_free(&w);
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
} grep_ctx;

static int glob_allows(grep_ctx *g, const char *path)
{
    size_t blen = strlen(g->base), i;
    const char *rel = !strncmp(path, g->base, blen) && path[blen] == '/' ? path + blen + 1 : path;
    const char *name = strrchr(path, '/');
    name = name ? name + 1 : path;
    if (!g->n_globs) return 1;
    for (i = 0; i < g->n_globs; i++)
        if (match(g->globs[i], strchr(g->globs[i], '/') ? rel : name)) return 1;
    return 0;
}

static void emit_line(grep_ctx *g, const char *shown, size_t no, char sep, const char *s, size_t n)
{
    if (g->lines >= g->limit) {
        g->truncated = 1;
        return;
    }
    if (n > GREP_MAX_LINE) {
        while (n > GREP_MAX_LINE || (n > 0 && ((unsigned char)s[n] & 0xc0) == 0x80)) n--;
        sope__buf_appendf(&g->r->out, "%s%c%zu%c%.*s…\n", shown, sep, no, sep, (int)n, s);
    } else {
        sope__buf_appendf(&g->r->out, "%s%c%zu%c%.*s\n", shown, sep, no, sep, (int)n, s);
    }
    g->lines++;
}

static void grep_file(walk *w, const char *path, const struct stat *st)
{
    grep_ctx *g = w->ctx;
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
    if ((fd = open(path, O_RDONLY | O_CLOEXEC)) < 0) return;
    while ((got = read(fd, buf, sizeof buf)) > 0) sope__buf_append(&data, buf, (size_t)got);
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

sope_next sope__tool_grep(tool_run *r)
{
    const char *pattern = sope__arg_string(r, "pattern"), *path_arg = sope__arg_string(r, "path");
    const char *mode = sope__arg_string(r, "output_mode"), *glob = sope__arg_string(r, "glob");
    int icase = sope__arg_bool(r, "case_insensitive"), flags = REG_EXTENDED | REG_NOSUB, rc;
    int64_t limit = sope__arg_int(r, "head_limit", GREP_DEFAULT_LIMIT);
    char *re_src, *base, *globs[MAX_PATTERNS];
    size_t n_globs;
    grep_ctx g = { 0 };
    walk w = { 0 };
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
    g.n_globs = n_globs = glob && *glob ? expand_braces(glob, globs, MAX_PATTERNS) : 0;
    g.globs = globs;
    w.r = r;
    w.max_depth = -1;
    w.on_file = grep_file;
    w.ctx = &g;

    if (stat(base, &st) != 0) {
        sope__run_fail(r, "%s does not exist", sope__display_path(r, base));
    } else if (S_ISDIR(st.st_mode)) {
        load_parent_ignores(&w, base);
        walk_dir(&w, base, 0);
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

    for (i = 0; i < n_globs; i++) free(globs[i]);
    found_free(&g.files);
    walk_free(&w);
    regfree(&g.re);
    free(base);
    return sope__run_done(r);
}
