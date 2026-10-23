/* SPDX-License-Identifier: MIT */
/*
 * tool_file.c - read, write and edit.
 *
 * The tools keep a per-agent record of what the model has seen (path,
 * mtime, size). write and edit refuse to touch an existing file the model
 * has not read, or one that changed since: the model would otherwise edit
 * from a stale picture and silently undo someone else's change.
 */
#if defined(__APPLE__)
#  define _DARWIN_C_SOURCE
#else
#  define _GNU_SOURCE
#endif

#include "tools.h"

#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

#define READ_MAX_LINES 2000
#define READ_MAX_LINE 2000          /* bytes per line before truncation */
#define READ_MAX_BYTES (256 * 1024) /* of output */
#define SNIPPET_CONTEXT 3

#if defined(__APPLE__)
#  define MTIME_SEC(st) ((int64_t)(st).st_mtimespec.tv_sec)
#  define MTIME_NSEC(st) ((int64_t)(st).st_mtimespec.tv_nsec)
#else
#  define MTIME_SEC(st) ((int64_t)(st).st_mtim.tv_sec)
#  define MTIME_NSEC(st) ((int64_t)(st).st_mtim.tv_nsec)
#endif

static const char READ_DESC[] =
    "Reads a file from the local filesystem.\n\n"
    "Usage:\n"
    "- file_path may be absolute or relative to the working directory.\n"
    "- By default it reads up to 2000 lines from the start. When you know which part you need, pass offset "
    "(1-based line number) and limit; read long files in chunks.\n"
    "- Output uses `cat -n` format: the line number, a tab, then the line. Lines longer than 2000 characters "
    "are truncated.\n"
    "- It reads files, not directories: use glob, or ls through bash, for those.\n"
    "- Images (PNG, JPEG, GIF, WebP) are shown to you as images, so you can read screenshots and diagrams.\n"
    "- You must read a file before changing it with edit or write.\n"
    "- Read several files at once with parallel calls when you need several.";
static const char READ_SCHEMA[] =
    "{\"type\":\"object\",\"properties\":{"
    "\"file_path\":{\"type\":\"string\",\"description\":\"The file to read\"},"
    "\"offset\":{\"type\":\"integer\",\"description\":\"The line number to start reading from (1-based)\"},"
    "\"limit\":{\"type\":\"integer\",\"description\":\"The number of lines to read\"}},"
    "\"required\":[\"file_path\"]}";

static const char WRITE_DESC[] =
    "Writes a file, creating parent directories as needed and overwriting the file if it exists.\n\n"
    "Usage:\n"
    "- If the file exists, read it first: this tool fails on a file you have not read, or one that changed "
    "since you read it.\n"
    "- Prefer edit for changing existing files, since it sends only the change. Use write for new files or "
    "complete rewrites.\n"
    "- Never create documentation files (*.md) or READMEs unless the user asks for them.";
static const char WRITE_SCHEMA[] =
    "{\"type\":\"object\",\"properties\":{"
    "\"file_path\":{\"type\":\"string\",\"description\":\"The file to write\"},"
    "\"content\":{\"type\":\"string\",\"description\":\"The complete new content of the file\"}},"
    "\"required\":[\"file_path\",\"content\"]}";

static const char EDIT_DESC[] =
    "Replaces exact text in a file.\n\n"
    "Usage:\n"
    "- Read the file first: edit fails on a file you have not read, or one that changed since you read it.\n"
    "- old_string must match the file exactly, including indentation. Copy it from the read output without "
    "the line-number prefix (the number and the tab before the content).\n"
    "- The edit fails if old_string occurs more than once. Include more surrounding lines to make it unique, "
    "or set replace_all to change every occurrence, e.g. to rename a variable.\n"
    "- An empty old_string creates a new file whose content is new_string.\n"
    "- Prefer editing existing files to creating new ones.";
static const char EDIT_SCHEMA[] =
    "{\"type\":\"object\",\"properties\":{"
    "\"file_path\":{\"type\":\"string\",\"description\":\"The file to modify\"},"
    "\"old_string\":{\"type\":\"string\",\"description\":\"The exact text to replace\"},"
    "\"new_string\":{\"type\":\"string\",\"description\":\"The text to replace it with (must differ from "
    "old_string)\"},"
    "\"replace_all\":{\"type\":\"boolean\",\"description\":\"Replace every occurrence (default false)\"}},"
    "\"required\":[\"file_path\",\"old_string\",\"new_string\"]}";

/* ------------------------------------------------------------------------ */
/* files                                                                    */
/* ------------------------------------------------------------------------ */

/* Creates the directories leading to path. */
static int make_parents(const char *path)
{
    char *dir = sope__strdup(path), *p;
    int ok = 1;
    if (!dir) return 0;
    for (p = dir + 1; *p && ok; p++) {
        if (*p != '/') continue;
        *p = '\0';
        if (mkdir(dir, 0777) != 0 && errno != EEXIST) ok = 0;
        *p = '/';
    }
    free(dir);
    return ok;
}

static int read_all(const char *path, sope_buf *out)
{
    char buf[65536];
    ssize_t n;
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return 0;
    while ((n = read(fd, buf, sizeof buf)) != 0) {
        if (n < 0) {
            if (errno == EINTR) continue;
            close(fd);
            return 0;
        }
        sope__buf_append(out, buf, (size_t)n);
    }
    close(fd);
    if (!out->ptr) sope__buf_append(out, "", 0);
    return !out->oom;
}

static int write_all(const char *path, const char *s, size_t n)
{
    int fd = open(path, O_WRONLY | O_CREAT | O_TRUNC | O_CLOEXEC, 0666);
    if (fd < 0) return 0;
    while (n) {
        ssize_t w = write(fd, s, n);
        if (w < 0) {
            if (errno == EINTR) continue;
            close(fd);
            return 0;
        }
        s += w;
        n -= (size_t)w;
    }
    return close(fd) == 0;
}

static size_t count_lines(const char *s, size_t n)
{
    size_t lines = 0, i;
    if (!n) return 0;
    for (i = 0; i < n; i++)
        if (s[i] == '\n') lines++;
    return s[n - 1] == '\n' ? lines : lines + 1;
}

static int is_binary(const char *s, size_t n)
{
    return memchr(s, '\0', n < 8192 ? n : 8192) != NULL;
}

/* ---- what the model has seen ---- */

void sope__files_clear(sope_agent_t *a)
{
    while (a->files) {
        file_state *f = a->files;
        a->files = f->next;
        free(f->path);
        free(f);
    }
}

/* 1: read and unchanged since, 0: never read, -1: changed since. */
static int files_check(tool_run *r, const char *path, const struct stat *st)
{
    sope_agent_t *a = r->agent;
    file_state *f;
    int rc = 0;
    pthread_mutex_lock(a->mu);
    for (f = a->files; f; f = f->next)
        if (!strcmp(f->path, path)) {
            rc = f->mtime_sec == MTIME_SEC(*st) && f->mtime_nsec == MTIME_NSEC(*st) && f->size == (int64_t)st->st_size
                     ? 1
                     : -1;
            break;
        }
    pthread_mutex_unlock(a->mu);
    return rc;
}

static void files_record(tool_run *r, const char *path)
{
    sope_agent_t *a = r->agent;
    struct stat st;
    file_state *f;
    if (stat(path, &st) != 0) return;
    pthread_mutex_lock(a->mu);
    for (f = a->files; f; f = f->next)
        if (!strcmp(f->path, path)) break;
    if (!f && (f = calloc(1, sizeof *f))) {
        if ((f->path = sope__strdup(path))) {
            f->next = a->files;
            a->files = f;
        } else {
            free(f);
            f = NULL;
        }
    }
    if (f) {
        f->mtime_sec = MTIME_SEC(st);
        f->mtime_nsec = MTIME_NSEC(st);
        f->size = (int64_t)st.st_size;
    }
    pthread_mutex_unlock(a->mu);
}

static sope_next stale_file(tool_run *r, const char *shown, int state)
{
    if (state == 0)
        return sope__run_fail(r, "%s has not been read yet. Read it before changing it.", shown);
    return sope__run_fail(r,
                          "%s was modified since you last read it, by the user or another program (a formatter, "
                          "for example). Read it again before changing it.",
                          shown);
}

/* ------------------------------------------------------------------------ */
/* read                                                                     */
/* ------------------------------------------------------------------------ */

static sope_next tool_read(tool_run *r)
{
    const char *arg = sope__arg_string(r, "file_path"), *shown;
    int64_t offset = sope__arg_int(r, "offset", 1), limit = sope__arg_int(r, "limit", READ_MAX_LINES);
    sope_buf data = { 0 };
    struct stat st;
    char *path;
    const char *image;
    size_t pos = 0, line_no = 0, shown_from = 0, shown_to = 0, total;
    int stopped = 0;

    if (!arg || !*arg) return sope__run_fail(r, "file_path is required");
    if (!(path = sope__run_path(r, arg))) return sope__run_fail(r, "out of memory");
    shown = sope__display_path(r, path);
    if (stat(path, &st) != 0) {
        int err = errno;
        sope__run_fail(r, err == ENOENT ? "File does not exist: %s" : "Cannot read %s: %s", shown, strerror(err));
        free(path);
        return sope__run_done(r);
    }
    if (S_ISDIR(st.st_mode)) {
        sope__run_fail(r, "%s is a directory. Use glob, or ls through bash, to list it.", shown);
        free(path);
        return sope__run_done(r);
    }
    if (!read_all(path, &data)) {
        sope__run_fail(r, "Cannot read %s: %s", shown, strerror(errno));
        free(path);
        sope__buf_free(&data);
        return sope__run_done(r);
    }
    if ((image = sope__image_type(data.ptr, data.len))) {
        if (data.len > SOPE__MAX_IMAGE_BYTES)
            sope__run_fail(r, "%s is an image of %zu bytes, over the %u byte limit for images.", shown, data.len,
                           SOPE__MAX_IMAGE_BYTES);
        else if (!sope__run_add_image(r, image, data.ptr, data.len))
            sope__run_fail(r, "out of memory");
        else
            sope__buf_appendf(&r->out, "Image %s (%s, %zu KB), attached for you to look at.", shown, image + 6,
                              (data.len + 1023) / 1024);
        free(path);
        sope__buf_free(&data);
        return sope__run_done(r);
    }
    if (is_binary(data.ptr, data.len)) {
        sope__run_fail(r, "%s is a binary file (%lld bytes). Inspect it through bash, e.g. with file or xxd.",
                       shown, (long long)st.st_size);
        free(path);
        sope__buf_free(&data);
        return sope__run_done(r);
    }
    if (offset < 1) offset = 1;
    if (limit < 1) limit = READ_MAX_LINES;
    total = count_lines(data.ptr, data.len);

    while (pos < data.len) {
        const char *line = data.ptr + pos, *nl = memchr(line, '\n', data.len - pos);
        size_t len = nl ? (size_t)(nl - line) : data.len - pos;
        pos += len + (nl ? 1 : 0);
        line_no++;
        if ((int64_t)line_no < offset) continue;
        if ((int64_t)(line_no - (size_t)offset) >= limit || r->out.len >= READ_MAX_BYTES) {
            stopped = 1;
            break;
        }
        if (len && line[len - 1] == '\r') len--;
        if (!shown_from) shown_from = line_no;
        shown_to = line_no;
        sope__buf_appendf(&r->out, "%6zu\t", line_no);
        if (len > READ_MAX_LINE) {
            size_t cut = READ_MAX_LINE;
            while (cut > 0 && ((unsigned char)line[cut] & 0xc0) == 0x80) cut--;
            sope__buf_append(&r->out, line, cut);
            sope__buf_appends(&r->out, "… [line truncated]");
        } else {
            sope__buf_append(&r->out, line, len);
        }
        sope__buf_appends(&r->out, "\n");
    }

    if (!data.len) {
        sope__buf_appends(&r->out, "(the file is empty)");
    } else if (!shown_from) {
        sope__buf_appendf(&r->out, "(the file has %zu lines; offset %lld is past the end)", total,
                          (long long)offset);
    } else if (stopped || shown_from > 1) {
        sope__buf_appendf(&r->out, "\n(showing lines %zu-%zu of %zu%s)", shown_from, shown_to, total,
                          stopped ? "; pass offset to read more" : "");
    }
    files_record(r, path);
    free(path);
    sope__buf_free(&data);
    return sope__run_done(r);
}

/* ------------------------------------------------------------------------ */
/* write                                                                    */
/* ------------------------------------------------------------------------ */

static sope_next tool_write(tool_run *r)
{
    const char *arg = sope__arg_string(r, "file_path"), *shown;
    const sope_json *content = sope__json_get(r->input, "content");
    struct stat st;
    int exists, state;
    char *path;

    if (!arg || !*arg) return sope__run_fail(r, "file_path is required");
    if (!content || content->type != SOPE_JSON_STRING) return sope__run_fail(r, "content (a string) is required");
    if (!(path = sope__run_path(r, arg))) return sope__run_fail(r, "out of memory");
    shown = sope__display_path(r, path);
    exists = stat(path, &st) == 0;
    if (exists && S_ISDIR(st.st_mode)) {
        sope__run_fail(r, "%s is a directory", shown);
    } else if (exists && (state = files_check(r, path, &st)) != 1) {
        stale_file(r, shown, state);
    } else if (!make_parents(path) || !write_all(path, content->str, content->len)) {
        sope__run_fail(r, "Cannot write %s: %s", shown, strerror(errno));
    } else {
        files_record(r, path);
        sope__buf_appendf(&r->out, "%s %s (%zu lines)", exists ? "Wrote" : "Created", shown,
                          count_lines(content->str, content->len));
    }
    free(path);
    return sope__run_done(r);
}

/* ------------------------------------------------------------------------ */
/* edit                                                                     */
/* ------------------------------------------------------------------------ */

static const char *find_bytes(const char *hay, size_t n, const char *needle, size_t m)
{
    size_t i;
    if (!m || m > n) return NULL;
    for (i = 0; i + m <= n; i++) {
        const char *p = memchr(hay + i, needle[0], n - m - i + 1);
        if (!p) return NULL;
        i = (size_t)(p - hay);
        if (!memcmp(p, needle, m)) return p;
    }
    return NULL;
}

/* Numbered lines of s around bytes [from, to). */
static void snippet(sope_buf *out, const char *s, size_t n, size_t from, size_t to)
{
    size_t i, line = 1, first, last, pos = 0;
    size_t from_line = 1, to_line = 1;
    for (i = 0; i < n && i < to; i++) {
        if (i == from) from_line = line;
        if (s[i] == '\n') line++;
    }
    if (from >= n) from_line = line;
    to_line = line;
    first = from_line > SNIPPET_CONTEXT ? from_line - SNIPPET_CONTEXT : 1;
    last = to_line + SNIPPET_CONTEXT;
    if (last - first > 40) last = first + 40;
    for (line = 1; pos < n && line <= last; line++) {
        const char *nl = memchr(s + pos, '\n', n - pos);
        size_t len = nl ? (size_t)(nl - (s + pos)) : n - pos;
        if (line >= first) {
            sope__buf_appendf(out, "%6zu\t", line);
            sope__buf_append(out, s + pos, len > READ_MAX_LINE ? READ_MAX_LINE : len);
            sope__buf_appends(out, "\n");
        }
        pos += len + 1;
    }
}

static sope_next tool_edit(tool_run *r)
{
    const char *arg = sope__arg_string(r, "file_path"), *shown;
    const sope_json *old_j = sope__json_get(r->input, "old_string"), *new_j = sope__json_get(r->input, "new_string");
    int all = sope__arg_bool(r, "replace_all"), exists, state;
    sope_buf data = { 0 }, result = { 0 };
    const char *old_s, *new_s, *p, *first = NULL;
    size_t old_n, new_n, count = 0, first_at = 0;
    struct stat st;
    char *path;

    if (!arg || !*arg) return sope__run_fail(r, "file_path is required");
    if (!old_j || old_j->type != SOPE_JSON_STRING || !new_j || new_j->type != SOPE_JSON_STRING)
        return sope__run_fail(r, "old_string and new_string (strings) are required");
    old_s = old_j->str, old_n = old_j->len, new_s = new_j->str, new_n = new_j->len;
    if (old_n == new_n && !memcmp(old_s, new_s, old_n))
        return sope__run_fail(r, "old_string and new_string are the same: there is nothing to change.");
    if (!(path = sope__run_path(r, arg))) return sope__run_fail(r, "out of memory");
    shown = sope__display_path(r, path);
    exists = stat(path, &st) == 0;

    if (!old_n) { /* create */
        if (exists && st.st_size > 0) {
            sope__run_fail(r, "%s already exists. To change it, pass the text to replace as old_string.", shown);
        } else if (!make_parents(path) || !write_all(path, new_s, new_n)) {
            sope__run_fail(r, "Cannot write %s: %s", shown, strerror(errno));
        } else {
            files_record(r, path);
            sope__buf_appendf(&r->out, "Created %s (%zu lines)", shown, count_lines(new_s, new_n));
        }
        free(path);
        return sope__run_done(r);
    }

    if (!exists) {
        sope__run_fail(r, "File does not exist: %s", shown);
        goto out;
    }
    if (S_ISDIR(st.st_mode)) {
        sope__run_fail(r, "%s is a directory", shown);
        goto out;
    }
    if ((state = files_check(r, path, &st)) != 1) {
        stale_file(r, shown, state);
        goto out;
    }
    if (!read_all(path, &data)) {
        sope__run_fail(r, "Cannot read %s: %s", shown, strerror(errno));
        goto out;
    }
    for (p = data.ptr; (p = find_bytes(p, data.len - (size_t)(p - data.ptr), old_s, old_n)); p += old_n) {
        if (!first) first = p;
        count++;
    }
    if (!count) {
        sope__run_fail(r,
                       "old_string was not found in %s. It must match the file exactly, including whitespace and "
                       "indentation; read the file again if unsure.",
                       shown);
        goto out;
    }
    if (count > 1 && !all) {
        sope__run_fail(r,
                       "old_string occurs %zu times in %s. Include more surrounding lines to make it unique, or set "
                       "replace_all to replace every occurrence.",
                       count, shown);
        goto out;
    }
    first_at = (size_t)(first - data.ptr);
    for (p = data.ptr;;) {
        const char *hit = find_bytes(p, data.len - (size_t)(p - data.ptr), old_s, old_n);
        if (!hit) break;
        sope__buf_append(&result, p, (size_t)(hit - p));
        sope__buf_append(&result, new_s, new_n);
        p = hit + old_n;
        if (!all) break;
    }
    sope__buf_append(&result, p, data.len - (size_t)(p - data.ptr));
    if (result.oom) {
        sope__run_fail(r, "out of memory");
        goto out;
    }
    if (!write_all(path, result.ptr ? result.ptr : "", result.len)) {
        sope__run_fail(r, "Cannot write %s: %s", shown, strerror(errno));
        goto out;
    }
    files_record(r, path);
    if (count > 1)
        sope__buf_appendf(&r->out, "Edited %s: replaced %zu occurrences. The first one now reads:\n", shown, count);
    else
        sope__buf_appendf(&r->out, "Edited %s. The changed part now reads:\n", shown);
    snippet(&r->out, result.ptr ? result.ptr : "", result.len, first_at, first_at + new_n);

out:
    free(path);
    sope__buf_free(&data);
    sope__buf_free(&result);
    return sope__run_done(r);
}

const sope_builtin sope__builtin_read = { "read", READ_DESC, READ_SCHEMA, 0, tool_read, NULL };
const sope_builtin sope__builtin_write = { "write", WRITE_DESC, WRITE_SCHEMA, 1, tool_write, NULL };
const sope_builtin sope__builtin_edit = { "edit", EDIT_DESC, EDIT_SCHEMA, 1, tool_edit, NULL };
