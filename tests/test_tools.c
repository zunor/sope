/* SPDX-License-Identifier: MIT */
/* test_tools.c - the built-in tools through the public ABI, driven by the mock provider. */
#define _POSIX_C_SOURCE 200809L
#if defined(__APPLE__)
#  define _DARWIN_C_SOURCE /* mkdtemp */
#else
#  define _DEFAULT_SOURCE
#endif

#include "sope.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <time.h>
#include <unistd.h>

static int failures;

#define CHECK(cond)                                                                \
    do {                                                                           \
        if (!(cond)) {                                                             \
            fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #cond); \
            failures++;                                                            \
        }                                                                          \
    } while (0)

#define MAX_CALLS 8

typedef struct {
    int n;                         /* TOOL_END events */
    char name[MAX_CALLS][32];
    char result[MAX_CALLS][40000];
    int is_error[MAX_CALLS];
    int starts, permissions, host_calls, unmatched_ends;
    uint64_t open_ids[MAX_CALLS];
    int32_t stop;
    char text[8192];
} run_log;

/* What to answer SOPE_EVENT_PERMISSION with. */
enum { NO_ANSWER, ALLOW, DENY };

static char dir[256];

static double now_seconds(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

static sope_agent_t *new_agent(const char *permissions)
{
    sope_agent_t *a = NULL;
    CHECK(sope_agent_new(&a) == SOPE_OK);
    CHECK(sope_agent_set_option(a, "mock.delay_ms", "0") == SOPE_OK);
    CHECK(sope_agent_set_option(a, "cwd", dir) == SOPE_OK);
    if (permissions) CHECK(sope_agent_set_option(a, "permissions", permissions) == SOPE_OK);
    return a;
}

static void track_open(run_log *log, uint64_t id)
{
    int i;
    for (i = 0; i < MAX_CALLS; i++)
        if (!log->open_ids[i]) {
            log->open_ids[i] = id;
            return;
        }
}

static void track_close(run_log *log, uint64_t id)
{
    int i;
    for (i = 0; i < MAX_CALLS; i++)
        if (log->open_ids[i] == id) {
            log->open_ids[i] = 0;
            return;
        }
    log->unmatched_ends++;
}

/* Sends one mock command and polls until its TURN_END. */
static void run(sope_agent_t *a, const char *cmd, run_log *log, int answer, const char *deny_message)
{
    sope_event_t ev;
    int i;
    memset(log, 0, sizeof *log);
    CHECK(sope_send(a, cmd, strlen(cmd), NULL) == SOPE_OK);
    for (;;) {
        memset(&ev, 0, sizeof ev);
        ev.size = sizeof ev;
        if (sope_poll(a, &ev, 10000) != 1) {
            CHECK(!"turn did not finish");
            return;
        }
        switch (ev.type) {
        case SOPE_EVENT_TOOL_START:
            log->starts++;
            track_open(log, ev.call_id);
            break;
        case SOPE_EVENT_TOOL_CALL:
            log->host_calls++;
            track_open(log, ev.call_id);
            CHECK(sope_tool_result(a, ev.call_id, 0, "host result", 11) == SOPE_OK);
            break;
        case SOPE_EVENT_PERMISSION:
            log->permissions++;
            if (answer == ALLOW) CHECK(sope_permit(a, ev.call_id, 1, NULL, 0) == SOPE_OK);
            if (answer == DENY)
                CHECK(sope_permit(a, ev.call_id, 0, deny_message, deny_message ? strlen(deny_message) : 0) ==
                      SOPE_OK);
            break;
        case SOPE_EVENT_TOOL_END:
            track_close(log, ev.call_id);
            if (log->n < MAX_CALLS) {
                snprintf(log->name[log->n], sizeof log->name[0], "%.*s", (int)ev.name_len, ev.name);
                snprintf(log->result[log->n], sizeof log->result[0], "%.*s", (int)ev.data_len, ev.data);
                log->is_error[log->n] = ev.code;
                log->n++;
            }
            break;
        case SOPE_EVENT_TEXT_DELTA:
            if (!ev.agent_id && strlen(log->text) + ev.data_len < sizeof log->text)
                strncat(log->text, ev.data, ev.data_len);
            break;
        case SOPE_EVENT_TURN_END:
            if (ev.agent_id) break;
            log->stop = ev.code;
            for (i = 0; i < MAX_CALLS; i++) CHECK(log->open_ids[i] == 0); /* every call was closed */
            CHECK(log->unmatched_ends == 0);
            return;
        default: break;
        }
    }
}

static void write_file(const char *rel, const char *content)
{
    char path[512];
    FILE *f;
    snprintf(path, sizeof path, "%s/%s", dir, rel);
    f = fopen(path, "w");
    CHECK(f != NULL);
    if (!f) return;
    fputs(content, f);
    fclose(f);
}

static char *slurp(const char *rel)
{
    static char buf[8192];
    char path[512];
    FILE *f;
    size_t n;
    snprintf(path, sizeof path, "%s/%s", dir, rel);
    if (!(f = fopen(path, "r"))) return NULL;
    n = fread(buf, 1, sizeof buf - 1, f);
    buf[n] = '\0';
    fclose(f);
    return buf;
}

static void mkdir_in(const char *rel)
{
    char path[512];
    snprintf(path, sizeof path, "%s/%s", dir, rel);
    mkdir(path, 0777);
}

/* ---- files ------------------------------------------------------------- */

static void test_read_image(void)
{
    static const unsigned char png[] = { 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0, 0, 0, 0 };
    sope_agent_t *a = new_agent("allow");
    static run_log log;
    const char *json;
    char path[512];
    FILE *f;

    snprintf(path, sizeof path, "%s/shot.png", dir);
    CHECK((f = fopen(path, "wb")) != NULL);
    if (f) {
        fwrite(png, 1, sizeof png, f);
        fclose(f);
    }
    run(a, "!read {\"file_path\":\"shot.png\"}", &log, NO_ANSWER, NULL);
    CHECK(log.n == 1 && !log.is_error[0] && !strcmp(log.result[0], "Image shot.png (png, 1 KB), attached for you to look at."));
    CHECK(strstr(log.text, "[1 image]") != NULL); /* the next round saw it */
    CHECK(sope_agent_history(a, &json, NULL) == SOPE_OK);
    CHECK(strstr(json, "\"role\":\"tool\"") && strstr(json, "\"images\":[{\"media_type\":\"image/png\",\"data\":\"iVBORw0KGgoAAAAA\"}]"));
    sope_agent_free(a);
}

static void test_read_write_edit(void)
{
    sope_agent_t *a = new_agent("allow");
    static run_log log;

    run(a, "!read {\"file_path\":\"missing.txt\"}", &log, NO_ANSWER, NULL);
    CHECK(log.n == 1 && log.is_error[0] && strstr(log.result[0], "does not exist"));
    CHECK(log.permissions == 0); /* allow: never asks */

    run(a, "!write {\"file_path\":\"sub/new.txt\",\"content\":\"one\\ntwo\\n\"}", &log, NO_ANSWER, NULL);
    CHECK(log.n == 1 && !log.is_error[0] && strstr(log.result[0], "Created sub/new.txt (2 lines)"));
    CHECK(slurp("sub/new.txt") && !strcmp(slurp("sub/new.txt"), "one\ntwo\n"));

    run(a, "!read {\"file_path\":\"sub/new.txt\"}", &log, NO_ANSWER, NULL);
    CHECK(log.n == 1 && !log.is_error[0] && !strcmp(log.result[0], "     1\tone\n     2\ttwo\n"));

    /* A file the agent never read cannot be edited or overwritten. */
    write_file("theirs.txt", "alpha beta alpha\n");
    run(a, "!edit {\"file_path\":\"theirs.txt\",\"old_string\":\"beta\",\"new_string\":\"BETA\"}", &log, NO_ANSWER,
        NULL);
    CHECK(log.n == 1 && log.is_error[0] && strstr(log.result[0], "has not been read"));
    run(a, "!write {\"file_path\":\"theirs.txt\",\"content\":\"x\"}", &log, NO_ANSWER, NULL);
    CHECK(log.n == 1 && log.is_error[0] && strstr(log.result[0], "has not been read"));

    run(a, "!read {\"file_path\":\"theirs.txt\"}", &log, NO_ANSWER, NULL);
    run(a, "!edit {\"file_path\":\"theirs.txt\",\"old_string\":\"alpha\",\"new_string\":\"A\"}", &log, NO_ANSWER,
        NULL);
    CHECK(log.n == 1 && log.is_error[0] && strstr(log.result[0], "occurs 2 times"));
    run(a, "!edit {\"file_path\":\"theirs.txt\",\"old_string\":\"gamma\",\"new_string\":\"G\"}", &log, NO_ANSWER,
        NULL);
    CHECK(log.n == 1 && log.is_error[0] && strstr(log.result[0], "not found"));
    run(a, "!edit {\"file_path\":\"theirs.txt\",\"old_string\":\"beta\",\"new_string\":\"BETA\"}", &log, NO_ANSWER,
        NULL);
    CHECK(log.n == 1 && !log.is_error[0] && strstr(log.result[0], "1\talpha BETA alpha"));
    run(a, "!edit {\"file_path\":\"theirs.txt\",\"old_string\":\"alpha\",\"new_string\":\"A\",\"replace_all\":true}",
        &log, NO_ANSWER, NULL);
    CHECK(log.n == 1 && !log.is_error[0] && strstr(log.result[0], "replaced 2 occurrences"));
    CHECK(!strcmp(slurp("theirs.txt"), "A BETA A\n"));

    /* Someone else changes it: the agent must read it again. */
    sleep(1); /* a different mtime even on coarse file systems */
    write_file("theirs.txt", "changed elsewhere\n");
    run(a, "!edit {\"file_path\":\"theirs.txt\",\"old_string\":\"A\",\"new_string\":\"B\"}", &log, NO_ANSWER, NULL);
    CHECK(log.n == 1 && log.is_error[0] && strstr(log.result[0], "modified since"));

    /* offset/limit, and a directory */
    write_file("lines.txt", "1\n2\n3\n4\n5\n");
    run(a, "!read {\"file_path\":\"lines.txt\",\"offset\":2,\"limit\":2}", &log, NO_ANSWER, NULL);
    CHECK(log.n == 1 && strstr(log.result[0], "     2\t2\n     3\t3\n") && strstr(log.result[0], "lines 2-3 of 5"));
    run(a, "!read {\"file_path\":\"sub\"}", &log, NO_ANSWER, NULL);
    CHECK(log.n == 1 && log.is_error[0] && strstr(log.result[0], "is a directory"));
    run(a, "!read {}", &log, NO_ANSWER, NULL);
    CHECK(log.n == 1 && log.is_error[0] && strstr(log.result[0], "file_path is required"));
    run(a, "!read not json", &log, NO_ANSWER, NULL); /* {"input": "not json"}: no file_path */
    CHECK(log.n == 1 && log.is_error[0]);

    /* reset forgets what was read */
    run(a, "!read {\"file_path\":\"lines.txt\"}", &log, NO_ANSWER, NULL);
    CHECK(sope_agent_reset(a) == SOPE_OK);
    run(a, "!write {\"file_path\":\"lines.txt\",\"content\":\"x\"}", &log, NO_ANSWER, NULL);
    CHECK(log.n == 1 && log.is_error[0] && strstr(log.result[0], "has not been read"));
    sope_agent_free(a);
}

/* ---- permissions --------------------------------------------------------- */

static void test_permissions(void)
{
    sope_agent_t *a = new_agent(NULL); /* ask */
    static run_log log;

    run(a, "!write {\"file_path\":\"asked.txt\",\"content\":\"ok\"}", &log, ALLOW, NULL);
    CHECK(log.starts == 1 && log.permissions == 1 && log.n == 1 && !log.is_error[0]);
    CHECK(slurp("asked.txt") && !strcmp(slurp("asked.txt"), "ok"));

    run(a, "!write {\"file_path\":\"refused.txt\",\"content\":\"no\"}", &log, DENY, "use edit instead");
    CHECK(log.permissions == 1 && log.n == 1 && log.is_error[0]);
    CHECK(strstr(log.result[0], "denied") && strstr(log.result[0], "use edit instead"));
    CHECK(slurp("refused.txt") == NULL);
    CHECK(strstr(log.text, "`write` failed")); /* the model saw the refusal */

    /* Read-only tools never ask. */
    run(a, "!read {\"file_path\":\"asked.txt\"}", &log, NO_ANSWER, NULL);
    CHECK(log.permissions == 0 && log.n == 1 && !log.is_error[0]);

    CHECK(sope_permit(a, 999999, 1, NULL, 0) == SOPE_ENOTFOUND);

    /* Cancelling while the host thinks about it closes the call. */
    {
        sope_event_t ev;
        uint64_t asked = 0;
        int ended = 0;
        const char *cmd = "!bash {\"command\":\"echo hi\"}";
        CHECK(sope_send(a, cmd, strlen(cmd), NULL) == SOPE_OK);
        for (;;) {
            memset(&ev, 0, sizeof ev);
            ev.size = sizeof ev;
            if (sope_poll(a, &ev, 5000) != 1) break;
            if (ev.type == SOPE_EVENT_PERMISSION) {
                asked = ev.call_id;
                CHECK(sope_cancel(a) == SOPE_OK);
            }
            if (ev.type == SOPE_EVENT_TOOL_END && ev.call_id == asked) ended = 1;
            if (ev.type == SOPE_EVENT_TURN_END) {
                CHECK(ev.code == SOPE_STOP_CANCELLED);
                break;
            }
        }
        CHECK(asked && ended);
        CHECK(sope_permit(a, asked, 1, NULL, 0) == SOPE_ENOTFOUND);
    }
    sope_agent_free(a);

    a = new_agent("deny");
    run(a, "!write {\"file_path\":\"denied.txt\",\"content\":\"no\"} ;; !read {\"file_path\":\"asked.txt\"}", &log,
        NO_ANSWER, NULL);
    CHECK(log.permissions == 0 && log.n == 2);
    CHECK(slurp("denied.txt") == NULL);
    CHECK(!strcmp(log.name[0], "write") ? log.is_error[0] && !log.is_error[1] : log.is_error[1] && !log.is_error[0]);
    sope_agent_free(a);
}

static void test_host_tool_replaces_builtin(void)
{
    sope_agent_t *a = new_agent("allow");
    static run_log log;
    CHECK(sope_tool_register(a, "read", "Host read.", NULL) == SOPE_OK);
    run(a, "!read {\"file_path\":\"asked.txt\"}", &log, NO_ANSWER, NULL);
    CHECK(log.host_calls == 1 && log.starts == 0 && log.n == 1 && !strcmp(log.result[0], "host result"));
    sope_agent_free(a);
}

/* ---- search -------------------------------------------------------------- */

static void test_glob_grep(void)
{
    sope_agent_t *a = new_agent("allow");
    static run_log log;

    mkdir_in("tree");
    mkdir_in("tree/src");
    mkdir_in("tree/src/deep");
    mkdir_in("tree/.hidden");
    mkdir_in("tree/node_modules");
    mkdir_in("tree/build");
    mkdir_in("tree/.git"); /* the tree is a repository: its .gitignore applies */
    write_file("tree/.gitignore", "build/\n*.log\n!keep.log\n");
    write_file("tree/main.c", "int main(void) { return 0; }\n");
    write_file("tree/src/util.c", "// TODO: speed up\nint add(int a, int b) { return a + b; }\nint answer = 42;\n");
    write_file("tree/src/util.h", "int add(int a, int b);\n");
    write_file("tree/src/deep/x.c", "int deep = 7;\n");
    write_file("tree/.hidden/h.c", "int hidden;\n");
    write_file("tree/node_modules/m.c", "int module;\n");
    write_file("tree/build/out.c", "int built;\n");
    write_file("tree/debug.log", "TODO in a log\n");
    write_file("tree/keep.log", "kept\n");

    run(a, "!glob {\"pattern\":\"**/*.c\",\"path\":\"tree\"}", &log, NO_ANSWER, NULL);
    CHECK(log.n == 1 && !log.is_error[0]);
    CHECK(strstr(log.result[0], "tree/main.c") && strstr(log.result[0], "tree/src/util.c") &&
          strstr(log.result[0], "tree/src/deep/x.c"));
    CHECK(!strstr(log.result[0], "h.c") && !strstr(log.result[0], "m.c") && !strstr(log.result[0], "out.c"));

    run(a, "!glob {\"pattern\":\"*.c\",\"path\":\"tree\"}", &log, NO_ANSWER, NULL); /* top level only */
    CHECK(strstr(log.result[0], "tree/main.c") && !strstr(log.result[0], "util.c"));
    run(a, "!glob {\"pattern\":\"tree/src/*.{c,h}\"}", &log, NO_ANSWER, NULL);
    CHECK(strstr(log.result[0], "tree/src/util.c") && strstr(log.result[0], "tree/src/util.h") &&
          !strstr(log.result[0], "x.c"));
    run(a, "!glob {\"pattern\":\"*.log\",\"path\":\"tree\"}", &log, NO_ANSWER, NULL);
    CHECK(strstr(log.result[0], "keep.log") && !strstr(log.result[0], "debug.log"));
    run(a, "!glob {\"pattern\":\"**/*.zig\",\"path\":\"tree\"}", &log, NO_ANSWER, NULL);
    CHECK(!strcmp(log.result[0], "No files found"));

    run(a, "!grep {\"pattern\":\"int \\\\w+\\\\(\",\"path\":\"tree\"}", &log, NO_ANSWER, NULL);
    CHECK(log.n == 1 && !log.is_error[0]);
    CHECK(strstr(log.result[0], "tree/main.c") && strstr(log.result[0], "tree/src/util.c") &&
          strstr(log.result[0], "tree/src/util.h") && !strstr(log.result[0], "x.c"));

    run(a, "!grep {\"pattern\":\"= \\\\d+;\",\"path\":\"tree\",\"output_mode\":\"content\"}", &log, NO_ANSWER, NULL);
    CHECK(strstr(log.result[0], "tree/src/util.c:3:int answer = 42;") &&
          strstr(log.result[0], "tree/src/deep/x.c:1:int deep = 7;") && !strstr(log.result[0], "built"));

    run(a, "!grep {\"pattern\":\"todo\",\"path\":\"tree\",\"case_insensitive\":true,\"output_mode\":\"count\"}", &log,
        NO_ANSWER, NULL);
    CHECK(!strcmp(log.result[0], "tree/src/util.c:1\n")); /* debug.log is ignored */

    run(a, "!grep {\"pattern\":\"int\",\"path\":\"tree\",\"glob\":\"*.h\"}", &log, NO_ANSWER, NULL);
    CHECK(!strcmp(log.result[0], "tree/src/util.h\n"));

    run(a, "!grep {\"pattern\":\"add\",\"path\":\"tree/src/util.c\",\"output_mode\":\"content\",\"context\":1}", &log,
        NO_ANSWER, NULL);
    CHECK(strstr(log.result[0], "util.c-1-// TODO") && strstr(log.result[0], "util.c:2:int add") &&
          strstr(log.result[0], "util.c-3-int answer"));

    run(a, "!grep {\"pattern\":\"(unclosed\"}", &log, NO_ANSWER, NULL);
    CHECK(log.is_error[0] && strstr(log.result[0], "invalid regular expression"));
    sope_agent_free(a);
}

/* ---- bash ---------------------------------------------------------------- */

static void test_bash(void)
{
    sope_agent_t *a = new_agent("allow");
    static run_log log;
    double t0;

    run(a, "!bash {\"command\":\"echo out; echo err >&2; pwd\"}", &log, NO_ANSWER, NULL);
    CHECK(log.n == 1 && !log.is_error[0]);
    CHECK(strstr(log.result[0], "out\nerr\n") && strstr(log.result[0], dir) && strstr(log.result[0], "[exit code 0]"));

    run(a, "!bash {\"command\":\"printf 'no newline'; exit 3\"}", &log, NO_ANSWER, NULL);
    CHECK(log.is_error[0] && !strncmp(log.result[0], "no newline\n", 11) && strstr(log.result[0], "Full output:") && strstr(log.result[0], "[exit code 3]"));

    run(a, "!bash {\"command\":\"read x; echo got:$x\"}", &log, NO_ANSWER, NULL); /* stdin is closed */
    CHECK(strstr(log.result[0], "got:") != NULL);

    t0 = now_seconds();
    run(a, "!bash {\"command\":\"sleep 20\",\"timeout\":300}", &log, NO_ANSWER, NULL);
    CHECK(log.is_error[0] && strstr(log.result[0], "timed out after 300 ms"));
    CHECK(now_seconds() - t0 < 5);

    /* Parallel calls run in parallel, though the pool has two threads. */
    t0 = now_seconds();
    run(a, "!bash {\"command\":\"sleep 1; echo a\"} ;; !bash {\"command\":\"sleep 1; echo b\"} ;; !bash "
           "{\"command\":\"sleep 1; echo c\"}",
        &log, NO_ANSWER, NULL);
    CHECK(log.n == 3);
    CHECK(now_seconds() - t0 < 2.5);

    /* Cancelling kills the command (and its children) promptly. */
    {
        sope_event_t ev;
        int cancelled = 0;
        const char *cmd = "!bash {\"command\":\"sleep 30 & sleep 30; echo never\"}";
        t0 = now_seconds();
        CHECK(sope_send(a, cmd, strlen(cmd), NULL) == SOPE_OK);
        for (;;) {
            memset(&ev, 0, sizeof ev);
            ev.size = sizeof ev;
            if (sope_poll(a, &ev, 5000) != 1) break;
            if (ev.type == SOPE_EVENT_TOOL_START) {
                usleep(200000);
                CHECK(sope_cancel(a) == SOPE_OK);
            }
            if (ev.type == SOPE_EVENT_TOOL_END) cancelled = ev.code == 1 && strstr(ev.data, "Cancelled") != NULL;
            if (ev.type == SOPE_EVENT_TURN_END) break;
        }
        CHECK(cancelled);
        CHECK(now_seconds() - t0 < 3);
    }

    /* Long output keeps its start and end. */
    run(a, "!bash {\"command\":\"seq 1 100000\"}", &log, NO_ANSWER, NULL);
    CHECK(!strncmp(log.result[0], "1\n2\n3\n", 6) && strstr(log.result[0], "bytes omitted") &&
          strstr(log.result[0], "100000\n") && strstr(log.result[0], "Full output:") && strstr(log.result[0], "[exit code 0]"));
    sope_agent_free(a);
}

static void test_background_shell(void)
{
    sope_agent_t *a = new_agent("allow");
    static run_log log;

    run(a, "!bash {\"command\":\"echo first; sleep 0.3; echo second; sleep 30\",\"run_in_background\":true}", &log,
        NO_ANSWER, NULL);
    CHECK(log.n == 1 && !log.is_error[0] && strstr(log.result[0], "shell 1"));
    usleep(700000);
    run(a, "!bash_output {\"shell_id\":\"1\"}", &log, NO_ANSWER, NULL);
    CHECK(strstr(log.result[0], "is running") && strstr(log.result[0], "first\nsecond"));
    run(a, "!bash_output {\"shell_id\":\"1\"}", &log, NO_ANSWER, NULL); /* only what is new */
    CHECK(strstr(log.result[0], "(no new output)"));
    run(a, "!bash_kill {\"shell_id\":\"1\"}", &log, NO_ANSWER, NULL);
    CHECK(strstr(log.result[0], "Killed shell 1"));
    run(a, "!bash_output {\"shell_id\":\"1\"}", &log, NO_ANSWER, NULL);
    CHECK(log.is_error[0] && strstr(log.result[0], "no background shell 1"));

    /* Freeing the agent kills what is still running. */
    run(a, "!bash {\"command\":\"sleep 60\",\"run_in_background\":true}", &log, NO_ANSWER, NULL);
    CHECK(strstr(log.result[0], "shell 2"));
    sope_agent_free(a);
}

/* ---- the rest -------------------------------------------------------------- */

static void test_todo_and_subagents(void)
{
    sope_agent_t *a = new_agent("allow");
    static run_log log;
    const char *def = "{\"name\":\"reader\",\"description\":\"Reads.\",\"system_prompt\":\"Read.\",\"tools\":[\"read\"]}";

    run(a, "!todo_write {\"todos\":[{\"content\":\"Do it\",\"activeForm\":\"Doing it\",\"status\":\"in_progress\"},"
           "{\"content\":\"Then this\",\"activeForm\":\"Doing this\",\"status\":\"pending\"}]}",
        &log, NO_ANSWER, NULL);
    CHECK(log.n == 1 && !log.is_error[0] && strstr(log.result[0], "1 pending, 1 in progress, 0 completed"));
    run(a, "!todo_write {\"todos\":[{\"content\":\"x\",\"status\":\"maybe\"}]}", &log, NO_ANSWER, NULL);
    CHECK(log.is_error[0]);

    /* A subagent type limited to read cannot run bash. */
    CHECK(sope_subagent_register(a, def, strlen(def)) == SOPE_OK);
    run(a, "!agent:reader !bash {\"command\":\"echo hi\"}", &log, NO_ANSWER, NULL);
    CHECK(log.n == 0 && strstr(log.text, "no tool named `bash`"));
    run(a, "!agent:reader !read {\"file_path\":\"asked.txt\"}", &log, NO_ANSWER, NULL);
    CHECK(log.n == 1 && !strcmp(log.name[0], "read") && !log.is_error[0]);
    sope_agent_free(a);
}

int main(void)
{
    char tmpl[] = "/tmp/sope-tools-XXXXXX";
    char *made = mkdtemp(tmpl);
    char resolved[256];
    CHECK(made != NULL);
    if (!made) return 1;
    /* macOS: /tmp is a symlink, and pwd reports the real path */
    snprintf(dir, sizeof dir, "%s", realpath(made, resolved) ? resolved : made);
    CHECK(sope_set_threads(2) == SOPE_OK);

    test_read_image();
    test_read_write_edit();
    test_permissions();
    test_host_tool_replaces_builtin();
    test_glob_grep();
    test_bash();
    test_background_shell();
    test_todo_and_subagents();

    CHECK(sope_shutdown() == SOPE_OK);
    {
        char cmd[512];
        snprintf(cmd, sizeof cmd, "rm -rf '%s'", dir);
        if (system(cmd) != 0) fprintf(stderr, "could not remove %s\n", dir);
    }
    if (failures) {
        fprintf(stderr, "%d check(s) failed\n", failures);
        return 1;
    }
    printf("all tests passed\n");
    return 0;
}
