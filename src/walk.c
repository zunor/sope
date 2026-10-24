/* SPDX-License-Identifier: MIT */
/*
 * walk.c - finding files the way a developer expects, for glob and grep:
 * glob patterns, .gitignore, and a tree walk that skips hidden files, .git,
 * node_modules and ignored paths.
 *
 * Patterns: * and ? stay within one path segment, ** spans any number of
 * them ("**" + "/" also matches no directory at all), [...] is a character
 * class and {a,b} alternatives (nesting allowed).
 *
 * .gitignore support covers what real projects use: comments, negation (!),
 * directory-only rules (trailing /), anchored rules (containing /) and the
 * files of every directory from the repository root down.
 */
#if defined(__APPLE__)
#  define _DARWIN_C_SOURCE /* d_type */
#else
#  define _DEFAULT_SOURCE /* d_type */
#endif

#include "tools.h"

#include <dirent.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define WALK_MAX_ENTRIES 500000

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

int sope__glob_match_one(const char *p, const char *s)
{
    for (;;) {
        if (!*p) return !*s;
        if (p[0] == '*' && p[1] == '*') {
            const char *rest = p + 2;
            if (*rest == '/') {
                rest++;
                if (sope__glob_match_one(rest, s)) return 1; /* no directory */
                for (; *s; s++)
                    if (*s == '/' && sope__glob_match_one(rest, s + 1)) return 1;
                return 0;
            }
            for (;; s++) {
                if (sope__glob_match_one(rest, s)) return 1;
                if (!*s) return 0;
            }
        }
        if (*p == '*') {
            p++;
            for (;; s++) {
                if (sope__glob_match_one(p, s)) return 1;
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

/* Expands the first {a,b} group of `pat`, then the rest recursively. */
size_t sope__glob_expand(const char *pat, char **out, size_t room)
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
            if (!alt.oom) n += sope__glob_expand(alt.ptr, out + n, room - n);
            sope__buf_free(&alt);
            start = p + 1;
        }
    }
    return n;
}

int sope__glob_match(const char *pattern, const char *path)
{
    char *pats[SOPE__MAX_PATTERNS];
    size_t n = sope__glob_expand(pattern, pats, SOPE__MAX_PATTERNS), i;
    int hit = 0;
    for (i = 0; i < n; i++) {
        if (!hit && sope__glob_match_one(pats[i], path)) hit = 1;
        free(pats[i]);
    }
    return hit;
}

/* ------------------------------------------------------------------------ */
/* walking                                                                   */
/* ------------------------------------------------------------------------ */

typedef struct sope_ignore_rule {
    char *pattern;
    char *base; /* directory of the .gitignore */
    int negate, dir_only, anchored;
} ignore_rule;

typedef sope_walk walk;

static void load_ignore(walk *w, const char *dir)
{
    sope_buf path = { 0 };
    FILE *f;
    char line[1024];

    sope__buf_appendf(&path, "%s/.gitignore", dir);
    int fd = path.oom ? -1 : sope__open_regular_read(path.ptr);
    f = fd < 0 ? NULL : fdopen(fd, "r");
    if (!f && fd >= 0) close(fd);
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
void sope__walk_ignores_above(walk *w, const char *dir)
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
            /* No repository: skip loading ancestors, but retain the count
             * so their allocated paths are still freed below. */
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

void sope__walk(walk *w, const char *dir)
{
    walk_dir(w, dir, 0);
}

void sope__walk_free(walk *w)
{
    pop_rules(w, 0);
    free(w->rules);
}
