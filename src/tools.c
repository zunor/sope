/* SPDX-License-Identifier: MIT */
/*
 * tools.c - the built-in tool registry, the task that runs one call, and
 * the file, shell and todo tools. See tools.h for the overall design.
 *
 * File tools keep a per-agent record of what the model has seen (path,
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
#include <inttypes.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

#define READ_MAX_LINES 2000
#define READ_MAX_LINE 2000          /* bytes per line before truncation */
#define READ_MAX_BYTES (256 * 1024) /* of output */
#define BASH_DEFAULT_MS 120000
#define BASH_MAX_MS 600000
#define BASH_MAX_OUTPUT 30000
#define RESULT_MAX (512 * 1024)
#define SNIPPET_CONTEXT 3

#if defined(__APPLE__)
#  define MTIME_SEC(st) ((int64_t)(st).st_mtimespec.tv_sec)
#  define MTIME_NSEC(st) ((int64_t)(st).st_mtimespec.tv_nsec)
#else
#  define MTIME_SEC(st) ((int64_t)(st).st_mtim.tv_sec)
#  define MTIME_NSEC(st) ((int64_t)(st).st_mtim.tv_nsec)
#endif

/* ------------------------------------------------------------------------ */
/* descriptions                                                              */
/* ------------------------------------------------------------------------ */

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

static const char BASH_DESC[] =
    "Runs a shell command with bash -c in the working directory and returns its combined stdout and stderr "
    "and its exit code.\n\n"
    "Usage:\n"
    "- Commands run without a terminal and with stdin closed. Avoid interactive programs (editors, pagers, "
    "git rebase -i) and pass flags such as -y where a command would prompt.\n"
    "- Every call starts a fresh shell in the working directory, so cd does not carry over: use `cd dir && "
    "cmd` or absolute paths.\n"
    "- Prefer the dedicated tools: read instead of cat, head or tail; edit or write instead of sed or echo "
    "redirection; glob instead of find; grep instead of grep or rg.\n"
    "- timeout is in milliseconds (default 120000, at most 600000). When the output is long, its beginning "
    "and end are kept.\n"
    "- Use run_in_background for long-running processes such as dev servers and watchers: you get a shell id "
    "right away, read its output with bash_output and stop it with bash_kill. Do not append & yourself.\n"
    "- Run independent commands as parallel tool calls; chain dependent ones with &&.\n"
    "- Never run destructive commands (rm -rf, git reset --hard, git push --force, ...) unless the user "
    "asked for them.";
static const char BASH_SCHEMA[] =
    "{\"type\":\"object\",\"properties\":{"
    "\"command\":{\"type\":\"string\",\"description\":\"The command to run\"},"
    "\"description\":{\"type\":\"string\",\"description\":\"What the command does, in 5-10 words\"},"
    "\"timeout\":{\"type\":\"integer\",\"description\":\"Timeout in milliseconds (max 600000)\"},"
    "\"run_in_background\":{\"type\":\"boolean\",\"description\":\"Run in the background and return a shell "
    "id at once\"}},"
    "\"required\":[\"command\"]}";

static const char BASH_OUTPUT_DESC[] =
    "Returns the output a background shell (started by bash with run_in_background) produced since the last "
    "call, and whether it is still running.";
static const char BASH_KILL_DESC[] = "Stops a background shell and every process it started.";
static const char SHELL_ID_SCHEMA[] =
    "{\"type\":\"object\",\"properties\":{"
    "\"shell_id\":{\"type\":\"string\",\"description\":\"The id bash returned\"}},"
    "\"required\":[\"shell_id\"]}";

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

static const char TODO_DESC[] =
    "Creates and updates a task list for the current work. It keeps you on track through multi-step tasks "
    "and shows the user your progress.\n\n"
    "When to use it:\n"
    "- Work with 3 or more distinct steps, or when the user gives you several tasks at once.\n"
    "- Right after receiving new instructions: capture the requirements as todos.\n"
    "Skip it for a single trivial task or a purely conversational request.\n\n"
    "How to use it:\n"
    "- Send the whole list every time; it replaces the previous one.\n"
    "- Each todo has content (imperative, e.g. \"Run the tests\"), activeForm (present continuous, e.g. "
    "\"Running the tests\") and a status: pending, in_progress or completed.\n"
    "- Keep exactly one todo in_progress while you work. Mark it completed as soon as it is done, not in "
    "batches, and only when it is really done (tests pass, nothing left half-finished).\n"
    "- Add follow-up tasks you discover and remove ones that no longer apply.";
static const char TODO_SCHEMA[] =
    "{\"type\":\"object\",\"properties\":{\"todos\":{\"type\":\"array\",\"description\":\"The updated todo "
    "list\",\"items\":{\"type\":\"object\",\"properties\":{"
    "\"content\":{\"type\":\"string\"},"
    "\"activeForm\":{\"type\":\"string\"},"
    "\"status\":{\"type\":\"string\",\"enum\":[\"pending\",\"in_progress\",\"completed\"]}},"
    "\"required\":[\"content\",\"status\",\"activeForm\"]}}},"
    "\"required\":[\"todos\"]}";

/* ------------------------------------------------------------------------ */
/* helpers                                                                   */
/* ------------------------------------------------------------------------ */

static int64_t now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

const char *sope__arg_string(tool_run *r, const char *key)
{
    return sope__json_string(sope__json_get(r->input, key), NULL);
}

int64_t sope__arg_int(tool_run *r, const char *key, int64_t fallback)
{
    const sope_json *v = sope__json_get(r->input, key);
    if (v && v->type == SOPE_JSON_NUMBER) return (int64_t)v->num;
    if (v && v->type == SOPE_JSON_STRING && v->len) {
        char *end;
        long long n = strtoll(v->str, &end, 10);
        if (!*end) return (int64_t)n;
    }
    return fallback;
}

int sope__arg_bool(tool_run *r, const char *key)
{
    const sope_json *v = sope__json_get(r->input, key);
    if (v && v->type == SOPE_JSON_BOOL) return v->boolean;
    return v && v->type == SOPE_JSON_STRING && !strcmp(v->str, "true");
}

sope_next sope__run_done(tool_run *r)
{
    (void)r;
    return (sope_next){ SOPE__NEXT_CLOSED, 0 };
}

sope_next sope__run_fail(tool_run *r, const char *fmt, ...)
{
    char buf[1024];
    va_list ap;
    va_start(ap, fmt);
    vsnprintf(buf, sizeof buf, fmt, ap);
    va_end(ap);
    r->out.len = 0;
    sope__buf_appends(&r->out, buf);
    r->is_error = 1;
    return sope__run_done(r);
}

/* Resolves "." and ".." in an absolute path. */
static char *normalize(const char *p)
{
    size_t n = strlen(p), o = 1;
    char *out = malloc(n + 2);
    if (!out) return NULL;
    out[0] = '/';
    while (*p) {
        const char *e;
        size_t len;
        while (*p == '/') p++;
        for (e = p; *e && *e != '/'; e++) {}
        len = (size_t)(e - p);
        if (!len) break;
        if (len == 2 && p[0] == '.' && p[1] == '.') {
            while (o > 1 && out[o - 1] != '/') o--;
            if (o > 1) o--;
        } else if (!(len == 1 && p[0] == '.')) {
            if (o > 1) out[o++] = '/';
            memcpy(out + o, p, len);
            o += len;
        }
        p = e;
    }
    out[o] = '\0';
    return out;
}

char *sope__run_path(tool_run *r, const char *path)
{
    const char *home = getenv("HOME");
    sope_buf b = { 0 };
    char *norm;
    if (path[0] == '~' && (path[1] == '/' || !path[1]) && home && *home) {
        sope__buf_appends(&b, home);
        sope__buf_appends(&b, "/");
        sope__buf_appends(&b, path + 1);
    } else if (path[0] != '/') {
        sope__buf_appends(&b, r->cwd);
        sope__buf_appends(&b, "/");
        sope__buf_appends(&b, path);
    } else {
        sope__buf_appends(&b, path);
    }
    norm = b.oom ? NULL : normalize(b.ptr);
    sope__buf_free(&b);
    return norm;
}

const char *sope__display_path(tool_run *r, const char *path)
{
    size_t n = strlen(r->cwd);
    if (n == 1 && r->cwd[0] == '/') return path[1] ? path + 1 : path;
    if (!strncmp(path, r->cwd, n)) {
        if (!path[n]) return ".";
        if (path[n] == '/') return path + n + 1;
    }
    return path;
}

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
/* read, write, edit                                                         */
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

/* ------------------------------------------------------------------------ */
/* bash and background shells                                                */
/* ------------------------------------------------------------------------ */

static void bash_result(tool_run *r, int status)
{
    size_t start = r->out.len;
    sope__proc_output(r->proc, 0, &r->out);
    sope__buf_sanitize(&r->out, start);
    while (r->out.len > start && r->out.ptr[r->out.len - 1] == '\n') r->out.ptr[--r->out.len] = '\0';
    sope__buf_clip_middle(&r->out, BASH_MAX_OUTPUT);
    if (r->out.len) sope__buf_appends(&r->out, "\n");
    if (r->timed_out) {
        sope__buf_appendf(&r->out, "[timed out after %lld ms; the command was killed]", (long long)r->timeout_ms);
        r->is_error = 1;
    } else {
        sope__buf_appendf(&r->out, "[exit code %d]", status);
        r->is_error = status != 0;
    }
}

static sope_next tool_bash(tool_run *r)
{
    int status;
    int64_t left;

    if (!r->proc) {
        const char *cmd = sope__arg_string(r, "command");
        int background = sope__arg_bool(r, "run_in_background");
        char err[256];
        if (!cmd || !*cmd) return sope__run_fail(r, "command is required");
        r->timeout_ms = sope__arg_int(r, "timeout", BASH_DEFAULT_MS);
        if (r->timeout_ms <= 0) r->timeout_ms = BASH_DEFAULT_MS;
        if (r->timeout_ms > BASH_MAX_MS) r->timeout_ms = BASH_MAX_MS;
        if (!(r->proc = sope__proc_start(cmd, r->cwd, background ? NULL : &r->task, err, sizeof err)))
            return sope__run_fail(r, "%s", err);
        if (background) {
            sope_agent_t *root = r->agent->root;
            bg_shell *sh = calloc(1, sizeof *sh);
            if (!sh || !(sh->command = sope__strdup(cmd))) {
                free(sh);
                return sope__run_fail(r, "out of memory"); /* run_free kills the process */
            }
            sh->proc = r->proc;
            r->proc = NULL;
            pthread_mutex_lock(r->agent->mu);
            sh->id = ++root->next_shell_id;
            sh->next = root->shells;
            root->shells = sh;
            pthread_mutex_unlock(r->agent->mu);
            sope__buf_appendf(&r->out,
                              "Started in the background as shell %u. Read its output with bash_output "
                              "(shell_id \"%u\") and stop it with bash_kill.",
                              (unsigned)sh->id, (unsigned)sh->id);
            return sope__run_done(r);
        }
        r->deadline_ms = now_ms() + r->timeout_ms;
    }

    if (sope__proc_done(r->proc, &status)) {
        bash_result(r, status);
        return sope__run_done(r);
    }
    if (r->timed_out) return (sope_next){ SOPE__NEXT_WAIT, 0 }; /* killed; the reaper wakes us */
    left = r->deadline_ms - now_ms();
    if (left <= 0) {
        r->timed_out = 1;
        sope__proc_kill(r->proc);
        return (sope_next){ SOPE__NEXT_WAIT, 0 };
    }
    return (sope_next){ SOPE__NEXT_SLEEP, left > INT32_MAX ? INT32_MAX : (int32_t)left };
}

static void bash_cancel(tool_run *r)
{
    sope__proc_release(r->proc);
    r->proc = NULL;
}

static uint32_t shell_id_arg(tool_run *r)
{
    const char *s = sope__arg_string(r, "shell_id");
    if (!s) return (uint32_t)sope__arg_int(r, "shell_id", 0);
    while (*s && (*s < '0' || *s > '9')) s++; /* accepts "3", "shell 3", "bash_3" */
    return (uint32_t)strtoul(s, NULL, 10);
}

static sope_next tool_bash_output(tool_run *r)
{
    uint32_t id = shell_id_arg(r);
    sope_agent_t *root = r->agent->root;
    sope_buf fresh = { 0 };
    bg_shell *sh;
    int status, done;

    pthread_mutex_lock(r->agent->mu); /* lock order: agent, then proc.c */
    for (sh = root->shells; sh; sh = sh->next)
        if (sh->id == id) break;
    if (!sh) {
        pthread_mutex_unlock(r->agent->mu);
        return sope__run_fail(r, "There is no background shell %u.", (unsigned)id);
    }
    done = sope__proc_done(sh->proc, &status);
    sh->read_pos = sope__proc_output(sh->proc, sh->read_pos, &fresh);
    pthread_mutex_unlock(r->agent->mu);

    sope__buf_sanitize(&fresh, 0);
    sope__buf_clip_middle(&fresh, BASH_MAX_OUTPUT);
    if (done)
        sope__buf_appendf(&r->out, "Shell %u exited with code %d.\n", (unsigned)id, status);
    else
        sope__buf_appendf(&r->out, "Shell %u is running.\n", (unsigned)id);
    if (fresh.len)
        sope__buf_append(&r->out, fresh.ptr, fresh.len);
    else
        sope__buf_appends(&r->out, "(no new output)");
    sope__buf_free(&fresh);
    return sope__run_done(r);
}

static void shell_free(bg_shell *sh)
{
    sope__proc_release(sh->proc);
    free(sh->command);
    free(sh);
}

static sope_next tool_bash_kill(tool_run *r)
{
    uint32_t id = shell_id_arg(r);
    bg_shell **pp, *sh = NULL;
    int status, done;

    pthread_mutex_lock(r->agent->mu);
    for (pp = &r->agent->root->shells; *pp; pp = &(*pp)->next)
        if ((*pp)->id == id) {
            sh = *pp;
            *pp = sh->next;
            break;
        }
    pthread_mutex_unlock(r->agent->mu);
    if (!sh) return sope__run_fail(r, "There is no background shell %u.", (unsigned)id);
    done = sope__proc_done(sh->proc, &status);
    if (done)
        sope__buf_appendf(&r->out, "Shell %u had already exited with code %d; it is gone now.", (unsigned)id, status);
    else
        sope__buf_appendf(&r->out, "Killed shell %u (%s).", (unsigned)id, sh->command);
    shell_free(sh);
    return sope__run_done(r);
}

void sope__shells_free(sope_agent_t *root)
{
    while (root->shells) {
        bg_shell *sh = root->shells;
        root->shells = sh->next;
        shell_free(sh);
    }
}

/* ------------------------------------------------------------------------ */
/* todo_write                                                                */
/* ------------------------------------------------------------------------ */

static sope_next tool_todo_write(tool_run *r)
{
    const sope_json *todos = sope__json_get(r->input, "todos"), *t;
    size_t pending = 0, active = 0, completed = 0, i = 0;

    if (!todos || todos->type != SOPE_JSON_ARRAY) return sope__run_fail(r, "todos (an array) is required");
    for (t = todos->child; t; t = t->next, i++) {
        const char *content = sope__json_string(sope__json_get(t, "content"), NULL);
        const char *status = sope__json_string(sope__json_get(t, "status"), NULL);
        if (!content || !*content) return sope__run_fail(r, "todo %zu has no content", i + 1);
        if (!status) status = "pending";
        if (!strcmp(status, "pending")) pending++;
        else if (!strcmp(status, "in_progress")) active++;
        else if (!strcmp(status, "completed")) completed++;
        else
            return sope__run_fail(r, "todo %zu has status \"%s\"; use pending, in_progress or completed", i + 1,
                                  status);
    }
    sope__buf_appendf(&r->out,
                      "Todo list updated: %zu pending, %zu in progress, %zu completed. Keep it current as you "
                      "work, and mark each task completed as soon as it is done.",
                      pending, active, completed);
    if (active > 1) sope__buf_appends(&r->out, " Keep only one task in progress at a time.");
    return sope__run_done(r);
}

/* ------------------------------------------------------------------------ */
/* registry                                                                  */
/* ------------------------------------------------------------------------ */

static const sope_builtin BUILTINS[] = {
    { "read", READ_DESC, READ_SCHEMA, 0, tool_read, NULL },
    { "write", WRITE_DESC, WRITE_SCHEMA, 1, tool_write, NULL },
    { "edit", EDIT_DESC, EDIT_SCHEMA, 1, tool_edit, NULL },
    { "glob", GLOB_DESC, GLOB_SCHEMA, 0, sope__tool_glob, NULL },
    { "grep", GREP_DESC, GREP_SCHEMA, 0, sope__tool_grep, NULL },
    { "bash", BASH_DESC, BASH_SCHEMA, 1, tool_bash, bash_cancel },
    { "bash_output", BASH_OUTPUT_DESC, SHELL_ID_SCHEMA, 0, tool_bash_output, NULL },
    { "bash_kill", BASH_KILL_DESC, SHELL_ID_SCHEMA, 0, tool_bash_kill, NULL },
    { "web_fetch", WEB_FETCH_DESC, WEB_FETCH_SCHEMA, 1, sope__tool_web_fetch, sope__tool_web_fetch_cancel },
    { "todo_write", TODO_DESC, TODO_SCHEMA, 0, tool_todo_write, NULL },
};

size_t sope__builtin_count(void)
{
    return sizeof BUILTINS / sizeof BUILTINS[0];
}

const sope_builtin *sope__builtin_at(size_t i)
{
    return i < sope__builtin_count() ? &BUILTINS[i] : NULL;
}

const sope_builtin *sope__builtin_find(const char *name)
{
    size_t i;
    for (i = 0; i < sope__builtin_count(); i++)
        if (!strcmp(BUILTINS[i].name, name)) return &BUILTINS[i];
    return NULL;
}

/* ------------------------------------------------------------------------ */
/* the run task                                                              */
/* ------------------------------------------------------------------------ */

int sope__run_add_image(tool_run *r, const char *media_type, const void *data, size_t n)
{
    sope_image *grown = realloc(r->images, (r->n_images + 1) * sizeof *grown);
    if (!grown) return 0;
    r->images = grown;
    if (!sope__image_init(&r->images[r->n_images], media_type, data, n)) return 0;
    r->n_images++;
    return 1;
}

static void run_free(tool_run *r)
{
    sope__images_free(r->images, r->n_images);
    sope__json_free(r->input);
    free(r->cwd);
    free(r->ca_file);
    sope__buf_free(&r->out);
    sope__buf_free(&r->body);
    if (r->proc) sope__proc_release(r->proc);
    if (r->http) sope__http_release(r->http);
    free(r);
}

static sope_next run_step(sope_task *task)
{
    tool_run *r = task->owner;
    int cancel;

    pthread_mutex_lock(r->agent->mu);
    cancel = r->cancel;
    pthread_mutex_unlock(r->agent->mu);
    if (cancel) {
        if (r->tool->cancel) r->tool->cancel(r);
        return sope__run_fail(r, "Cancelled.");
    }
    if (!r->input || r->input->type != SOPE_JSON_OBJECT)
        return sope__run_fail(r, "invalid input: expected a JSON object with the tool's arguments");
    return r->tool->run(r);
}

/* On a pool thread once the run's task closed: report the result and hand
 * it to the waiting turn. */
static void run_closed(sope_task *task)
{
    tool_run *r = task->owner;
    sope_agent_t *a = r->agent;
    pending_call *p;
    tool_run **pp;

    sope__buf_sanitize(&r->out, 0);
    sope__buf_clip_middle(&r->out, RESULT_MAX);
    if (r->out.oom) {
        sope__buf_free(&r->out);
        sope__buf_appends(&r->out, "out of memory");
        r->is_error = 1;
    } else if (!r->out.len) {
        sope__buf_appends(&r->out, "(no output)");
    }
    sope__push_event(a, SOPE_EVENT_TOOL_END, r->turn_id, r->call_id, r->is_error, r->tool->name,
                     strlen(r->tool->name), r->out.ptr, r->out.len);

    pthread_mutex_lock(a->mu);
    for (p = a->root->pending; p; p = p->next)
        if (p->call_id == r->call_id && p->kind == PENDING_BUILTIN) break;
    if (p) {
        p->content = r->out.ptr; /* ownership moves to the pending call */
        p->len = r->out.len;
        p->is_error = r->is_error;
        p->images = r->images;
        p->n_images = r->n_images;
        r->images = NULL;
        r->n_images = 0;
        p->done = 1;
        r->out.ptr = NULL;
        r->out.len = r->out.cap = 0;
    }
    for (pp = &a->runs; *pp; pp = &(*pp)->next)
        if (*pp == r) {
            *pp = r->next;
            break;
        }
    sope__task_wake(&a->task);
    pthread_mutex_unlock(a->mu);

    run_free(r);
    sope__pool_release();
}

tool_run *sope__tool_run_new(sope_agent_t *a, const sope_builtin *b, uint64_t call_id, const char *input,
                             size_t len)
{
    tool_run *r = calloc(1, sizeof *r);
    if (!r) return NULL;
    r->agent = a;
    r->tool = b;
    r->call_id = call_id;
    r->turn_id = a->turn.msg->turn_id;
    r->input = sope__json_parse(input, len); /* NULL: the run reports bad input */
    r->cwd = sope__strdup(a->turn.cwd);
    pthread_mutex_lock(a->mu);
    r->ca_file = sope__option_dup_locked(a, "tls.ca_file");
    pthread_mutex_unlock(a->mu);
    if (!r->cwd) {
        run_free(r);
        return NULL;
    }
    sope__task_init(&r->task, run_step, r);
    r->task.on_closed = run_closed;
    return r;
}

void sope__tool_run_start_locked(tool_run *r)
{
    r->next = r->agent->runs;
    r->agent->runs = r;
    sope__pool_acquire(); /* cannot fail: the pool is running */
    sope__task_wake(&r->task);
}

void sope__tool_run_start(tool_run *r)
{
    pthread_mutex_lock(r->agent->mu);
    sope__tool_run_start_locked(r);
    pthread_mutex_unlock(r->agent->mu);
}

void sope__tool_run_discard(tool_run *r)
{
    if (r) run_free(r);
}
