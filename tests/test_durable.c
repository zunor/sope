/* SPDX-License-Identifier: MIT */
#define _POSIX_C_SOURCE 200809L
#if defined(__APPLE__)
#define _DARWIN_C_SOURCE
#else
#define _DEFAULT_SOURCE
#endif
#include "sope.h"
#include "sope_sqlite.h"
#include <errno.h>
#include <fcntl.h>
#include <glob.h>
#include <time.h>
#include <signal.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <sys/wait.h>
#include <unistd.h>

#define REQUIRE(x) do { if (!(x)) { fprintf(stderr, "%s:%d: %s (%s)\n", __FILE__, __LINE__, #x, sope_last_error()); exit(1); } } while (0)
static char executable[4096];
static char root[4096];

static sope_agent_t *open_agent(const char *path)
{
    sope_agent_t *a = NULL;
    REQUIRE(sope_agent_open(&a, path) == SOPE_OK);
    REQUIRE(sope_agent_set_option(a, "mock.delay_ms", "0") == SOPE_OK);
    REQUIRE(sope_agent_set_option(a, "permissions", "allow") == SOPE_OK);
    REQUIRE(sope_tool_register(a, "first", "", "{}") == SOPE_OK);
    REQUIRE(sope_tool_register(a, "second", "", "{}") == SOPE_OK);
    return a;
}

static sope_event_t poll_event(sope_agent_t *a)
{
    sope_event_t ev = { .size = sizeof ev };
    REQUIRE(sope_poll(a, &ev, 10000) == 1);
    return ev;
}

static void send_text(sope_agent_t *a, const char *text)
{
    REQUIRE(sope_send(a, text, strlen(text), NULL) == SOPE_OK);
}

static const char *recovery(sope_agent_t *a)
{
    const char *json;
    REQUIRE(sope_agent_recovery(a, &json, NULL) == SOPE_OK);
    return json;
}

static void atomic_child(const char *dir)
{
    sope_agent_t *a = open_agent(dir);
    char target[8192], prompt[20000];
    snprintf(target, sizeof target, "%s/target", dir);
    int fd = open(target, O_CREAT | O_WRONLY | O_TRUNC, 0600);
    REQUIRE(fd >= 0 && write(fd, "original", 8) == 8); close(fd);
    snprintf(prompt, sizeof prompt, "!read {\"file_path\":\"%s\"}", target);
    send_text(a, prompt);
    while (poll_event(a).type != SOPE_EVENT_TURN_END) {}
    size_t bytes = 8 * 1024 * 1024;
    char *command = malloc(bytes + strlen(target) + 100);
    REQUIRE(command != NULL);
    size_t prefix = (size_t)sprintf(command, "!write {\"file_path\":\"%s\",\"content\":\"", target);
    memset(command + prefix, 'A', bytes);
    strcpy(command + prefix + bytes, "\"}");
    /* Multiple writes make the test robust on very fast filesystems. The parent
     * kills only after observing a staging file, not after a timing guess. */
    for (int i = 0; i < 50; i++) {
        send_text(a, command);
        while (poll_event(a).type != SOPE_EVENT_TURN_END) {}
    }
    free(command); sope_agent_free(a); exit(3);
}

static void parallel_child(const char *mode, const char *dir)
{
    sope_agent_t *a = open_agent(dir);
    char target[8192], prompt[20000], ready[8192], go[8192];
    snprintf(target, sizeof target, "%s/../shared", dir);
    snprintf(ready, sizeof ready, "%s/ready", dir);
    snprintf(go, sizeof go, "%s/../go", dir);
    snprintf(prompt, sizeof prompt, "!read {\"file_path\":\"%s\"}", target);
    send_text(a, prompt);
    while (poll_event(a).type != SOPE_EVENT_TURN_END) {}
    int fd = open(ready, O_CREAT | O_WRONLY, 0600); REQUIRE(fd >= 0); close(fd);
    while (access(go, F_OK) != 0) { struct timespec pause = {0, 1000000}; nanosleep(&pause, NULL); }
    snprintf(prompt, sizeof prompt, "!write {\"file_path\":\"%s\",\"content\":\"%s\"}", target, mode);
    send_text(a, prompt);
    int failed = 0;
    for (;;) {
        sope_event_t ev = poll_event(a);
        if (ev.type == SOPE_EVENT_TOOL_END) failed = ev.code != 0;
        if (ev.type == SOPE_EVENT_TURN_END) break;
    }
    sope_agent_free(a);
    exit(failed ? 10 : 0);
}

static void crash_child(const char *mode, const char *dir)
{
    if (!strcmp(mode, "atomic")) atomic_child(dir);
    if (!strncmp(mode, "parallel-", 9)) parallel_child(mode, dir);
    sope_agent_t *a = open_agent(dir);
    if (!strcmp(mode, "shell")) {
        char prompt[20000];
        snprintf(prompt, sizeof prompt, "!bash {\"command\":\"echo $$ > '%s/pid'; printf RAW_PARTIAL_EVIDENCE; sleep 30\"}", dir);
        send_text(a, prompt);
        for (;;) (void)poll_event(a);
    }
    if (!strcmp(mode, "compact")) {
        const char *history;
        REQUIRE(sope_agent_history(a, &history, NULL) == SOPE_OK);
        if (!strcmp(history, "[]")) {
            send_text(a, "original goal; immutable constraint: no deployment");
            while (poll_event(a).type != SOPE_EVENT_TURN_END) {}
        }
        REQUIRE(sope_compact(a, NULL, 0, NULL) == SOPE_OK);
        while (poll_event(a).type != SOPE_EVENT_COMPACT) {}
        kill(getpid(), SIGKILL);
    }
    if (!strcmp(mode, "resolve")) {
        REQUIRE(strstr(recovery(a), "second"));
        REQUIRE(sope_agent_resolve(a, 2, 0, "verified: external mutation occurred once", strlen("verified: external mutation occurred once")) == SOPE_OK);
        kill(getpid(), SIGKILL);
    }
    if (!strcmp(mode, "queued")) {
        REQUIRE(sope_agent_set_option(a, "mock.delay_ms", "1000") == SOPE_OK);
        send_text(a, "original goal, do not change ABI; original constraint");
        send_text(a, "queued instruction must survive");
        kill(getpid(), SIGKILL);
    }
    send_text(a, "!first {\"goal\":\"original goal\",\"constraint\":\"do not change ABI\"} ;; !second {}");
    send_text(a, "queued goal also survives");
    for (;;) {
        sope_event_t ev = poll_event(a);
        if (ev.type != SOPE_EVENT_TOOL_CALL) continue;
        if (!strcmp(ev.name, "first")) {
            REQUIRE(sope_tool_result(a, ev.call_id, 0, "critical evidence: p95=172; limit=180", strlen("critical evidence: p95=172; limit=180")) == SOPE_OK);
        } else {
            /* Side effect succeeds, but there is no durable result receipt. */
            char path[8192]; snprintf(path, sizeof path, "%s/effect", dir);
            int fd = open(path, O_CREAT | O_APPEND | O_WRONLY, 0600);
            REQUIRE(fd >= 0 && write(fd, "once\n", 5) == 5 && fsync(fd) == 0);
            close(fd);
            kill(getpid(), SIGKILL);
        }
    }
}

static void run_crash(const char *mode, const char *dir)
{
    pid_t child = fork();
    REQUIRE(child >= 0);
    if (!child) { execl(executable, executable, mode, dir, (char *)NULL); _exit(127); }
    int status;
    REQUIRE(waitpid(child, &status, 0) == child);
    REQUIRE(WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL);
}

static void finish(sope_agent_t *a, int turns)
{
    while (turns) {
        sope_event_t ev = poll_event(a);
        REQUIRE(ev.type != SOPE_EVENT_TOOL_CALL && ev.type != SOPE_EVENT_TOOL_START);
        REQUIRE(ev.type != SOPE_EVENT_ERROR);
        if (ev.type == SOPE_EVENT_TURN_END) { REQUIRE(ev.code == SOPE_STOP_END_TURN); turns--; }
    }
}

static void test_crash_recovery(void)
{
    char dir[8192]; snprintf(dir, sizeof dir, "%s/crash", root);
    run_crash("pending", dir);
    sope_agent_t *a = open_agent(dir);
    const char *state = recovery(a);
    REQUIRE(strstr(state, "\"pending\":true") && strstr(state, "second") && !strstr(state, "first"));
    REQUIRE(sope_agent_resume(a) == SOPE_EBUSY);
    REQUIRE(sope_send(a, "must not skip unresolved tool", 29, NULL) == SOPE_EBUSY);
    sope_agent_t *other = NULL;
    REQUIRE(sope_agent_open(&other, dir) == SOPE_EBUSY && other == NULL);
    sope_agent_free(a); /* inspecting and closing must not consume work */
    run_crash("resolve", dir); /* reconciliation itself survives another SIGKILL */
    a = open_agent(dir);
    REQUIRE(!strstr(recovery(a), "second"));
    REQUIRE(sope_agent_resume(a) == SOPE_OK);
    finish(a, 2);
    const char *history;
    REQUIRE(sope_agent_history(a, &history, NULL) == SOPE_OK);
    REQUIRE(strstr(history, "original goal") && strstr(history, "do not change ABI"));
    REQUIRE(strstr(history, "critical evidence: p95=172; limit=180"));
    REQUIRE(strstr(history, "verified: external mutation occurred once"));
    REQUIRE(strstr(history, "queued goal also survives"));
    char path[8192], bytes[16] = {0}; snprintf(path, sizeof path, "%s/effect", dir);
    int fd = open(path, O_RDONLY); REQUIRE(fd >= 0);
    REQUIRE(read(fd, bytes, sizeof bytes) == 5 && !strcmp(bytes, "once\n")); close(fd);
    send_text(a, "!first {}");
    for (;;) {
        sope_event_t ev = poll_event(a);
        if (ev.type == SOPE_EVENT_TOOL_CALL) {
            REQUIRE(ev.call_id > 2);
            REQUIRE(sope_tool_result(a, ev.call_id, 0, "next", 4) == SOPE_OK);
        }
        if (ev.type == SOPE_EVENT_TURN_END) break;
    }
    sope_agent_free(a);
    a = open_agent(dir);
    REQUIRE(strstr(recovery(a), "\"pending\":false"));
    REQUIRE(sope_agent_history(a, &history, NULL) == SOPE_OK && strstr(history, "critical evidence"));
    sope_agent_free(a);
}

static void test_compaction_commit(void)
{
    char dir[8192]; snprintf(dir, sizeof dir, "%s/compact", root);
    for (int i = 0; i < 2; i++) {
        run_crash("compact", dir);
        sope_agent_t *a = open_agent(dir);
        REQUIRE(strstr(recovery(a), "\"pending\":false"));
        const char *history;
        REQUIRE(sope_agent_history(a, &history, NULL) == SOPE_OK);
        REQUIRE(strstr(history, "\"summary\":true") && strstr(history, "mock summary"));
        /* This deterministic provider only summarizes user lines. Test storage
         * atomicity and the independent original evidence log, not its recall. */
        char path[8192]; snprintf(path, sizeof path, "%s/execution.sqlite", dir);
        sqlite3 *db; sqlite3_stmt *stmt;
        REQUIRE(sqlite3_open(path, &db) == SQLITE_OK);
        REQUIRE(sqlite3_prepare_v2(db, "SELECT history=(SELECT payload FROM events WHERE kind='compact' ORDER BY seq DESC LIMIT 1) FROM state", -1, &stmt, NULL) == SQLITE_OK);
        REQUIRE(sqlite3_step(stmt) == SQLITE_ROW && sqlite3_column_int(stmt, 0) == 1);
        sqlite3_finalize(stmt);
        REQUIRE(sqlite3_prepare_v2(db, "SELECT COUNT(*) FROM events WHERE kind='input' AND payload LIKE '%immutable constraint: no deployment%'", -1, &stmt, NULL) == SQLITE_OK);
        REQUIRE(sqlite3_step(stmt) == SQLITE_ROW && sqlite3_column_int(stmt, 0) == 1);
        sqlite3_finalize(stmt); sqlite3_close(db);
        sope_agent_free(a);
    }
}

static void test_admission(void)
{
    char dir[8192]; snprintf(dir, sizeof dir, "%s/queued", root);
    run_crash("queued", dir);
    sope_agent_t *a = open_agent(dir);
    REQUIRE(sope_agent_resume(a) == SOPE_OK);
    finish(a, 2);
    const char *history;
    REQUIRE(sope_agent_history(a, &history, NULL) == SOPE_OK);
    REQUIRE(strstr(history, "original constraint") && strstr(history, "queued instruction"));
    sope_agent_free(a);
}

static void test_failed_intent_commit(void)
{
    char dir[8192], dbpath[8192], target[8192], prompt[20000];
    snprintf(dir, sizeof dir, "%s/iofailure", root);
    sope_agent_t *a = open_agent(dir);
    snprintf(dbpath, sizeof dbpath, "%s/execution.sqlite", dir);
    sqlite3 *db;
    REQUIRE(sqlite3_open(dbpath, &db) == SQLITE_OK);
    REQUIRE(sqlite3_exec(db, "CREATE TRIGGER fail_intent BEFORE INSERT ON events WHEN NEW.kind='intent' BEGIN SELECT RAISE(ABORT,'injected commit failure'); END", NULL, NULL, NULL) == SQLITE_OK);
    snprintf(target, sizeof target, "%s/must-not-exist", dir);
    snprintf(prompt, sizeof prompt, "!write {\"file_path\":\"%s\",\"content\":\"bad\"}", target);
    send_text(a, prompt);
    for (;;) {
        sope_event_t ev = poll_event(a);
        REQUIRE(ev.type != SOPE_EVENT_TOOL_START);
        if (ev.type == SOPE_EVENT_TURN_END) { REQUIRE(ev.code == SOPE_STOP_ERROR); break; }
    }
    REQUIRE(access(target, F_OK) != 0);
    sope_agent_free(a);
    REQUIRE(sqlite3_exec(db, "DROP TRIGGER fail_intent", NULL, NULL, NULL) == SQLITE_OK);
    sqlite3_close(db);
    a = open_agent(dir);
    REQUIRE(strstr(recovery(a), "\"pending\":true"));
    sope_agent_free(a);
}

static void test_failed_start_commit(void)
{
    char dir[8192], dbpath[8192], target[8192], prompt[20000];
    snprintf(dir, sizeof dir, "%s/startfailure", root);
    sope_agent_t *a = open_agent(dir);
    snprintf(dbpath, sizeof dbpath, "%s/execution.sqlite", dir);
    sqlite3 *db; REQUIRE(sqlite3_open(dbpath, &db) == SQLITE_OK);
    REQUIRE(sqlite3_exec(db, "CREATE TRIGGER fail_start BEFORE INSERT ON stream WHEN NEW.type=12 BEGIN SELECT RAISE(ABORT,'injected'); END", NULL, NULL, NULL) == SQLITE_OK);
    snprintf(target, sizeof target, "%s/must-not-exist", dir);
    snprintf(prompt, sizeof prompt, "!write {\"file_path\":\"%s\",\"content\":\"bad\"}", target);
    send_text(a, prompt);
    for (;;) {
        sope_event_t ev = poll_event(a);
        REQUIRE(ev.type != SOPE_EVENT_TOOL_START);
        if (ev.type == SOPE_EVENT_TURN_END) { REQUIRE(ev.code == SOPE_STOP_ERROR); break; }
    }
    REQUIRE(access(target, F_OK) != 0);
    sope_agent_free(a);
    REQUIRE(sqlite3_exec(db, "DROP TRIGGER fail_start", NULL, NULL, NULL) == SQLITE_OK);
    sqlite3_close(db);
    a = open_agent(dir); REQUIRE(strstr(recovery(a), "write"));
    REQUIRE(sope_agent_resume(a) == SOPE_EBUSY); sope_agent_free(a);
}

static void test_failed_result_commit(void)
{
    char dir[8192], path[8192]; snprintf(dir, sizeof dir, "%s/resultfailure", root);
    sope_agent_t *a = open_agent(dir);
    snprintf(path, sizeof path, "%s/execution.sqlite", dir);
    sqlite3 *db; REQUIRE(sqlite3_open(path, &db) == SQLITE_OK);
    REQUIRE(sqlite3_exec(db, "CREATE TRIGGER fail_result BEFORE INSERT ON results BEGIN SELECT RAISE(ABORT,'injected failure'); END", NULL, NULL, NULL) == SQLITE_OK);
    send_text(a, "!todo_write {\"todos\":[]}");
    int ends = 0;
    for (;;) {
        sope_event_t ev = poll_event(a);
        if (ev.type == SOPE_EVENT_TOOL_END) { ends++; REQUIRE(ev.code != 0); }
        if (ev.type == SOPE_EVENT_TURN_END) { REQUIRE(ev.code == SOPE_STOP_ERROR); break; }
    }
    REQUIRE(ends == 0); /* A failed commit is unknown, not a completed tool. */
    sope_agent_free(a);
    REQUIRE(sqlite3_exec(db, "DROP TRIGGER fail_result", NULL, NULL, NULL) == SQLITE_OK);
    sqlite3_close(db);
    a = open_agent(dir);
    REQUIRE(strstr(recovery(a), "todo_write"));
    REQUIRE(sope_agent_resume(a) == SOPE_EBUSY);
    sope_agent_free(a);
}

static void test_atomic_kill(void)
{
    char dir[8192], pattern[8192], target[8192];
    snprintf(dir, sizeof dir, "%s/atomic", root);
    snprintf(pattern, sizeof pattern, "%s/target.sope-*", dir);
    snprintf(target, sizeof target, "%s/target", dir);
    pid_t child = fork(); REQUIRE(child >= 0);
    if (!child) { execl(executable, executable, "atomic", dir, (char *)NULL); _exit(127); }
    int observed = 0, status;
    for (int i = 0; i < 100000; i++) {
        glob_t matches = {0};
        if (glob(pattern, 0, NULL, &matches) == 0 && matches.gl_pathc) observed = 1;
        globfree(&matches);
        if (observed) break;
        struct timespec pause = {0, 100000}; nanosleep(&pause, NULL);
    }
    REQUIRE(kill(child, SIGKILL) == 0);
    REQUIRE(waitpid(child, &status, 0) == child && WIFSIGNALED(status) && WTERMSIG(status) == SIGKILL);
    REQUIRE(observed);
    struct stat st; REQUIRE(stat(target, &st) == 0);
    REQUIRE(st.st_size == 8 || st.st_size == 8 * 1024 * 1024);
    int fd = open(target, O_RDONLY); REQUIRE(fd >= 0);
    char data[65536]; ssize_t n;
    if (st.st_size == 8) REQUIRE(read(fd, data, sizeof data) == 8 && !memcmp(data, "original", 8));
    else while ((n = read(fd, data, sizeof data)) > 0) for (ssize_t i = 0; i < n; i++) REQUIRE(data[i] == 'A');
    close(fd);
    sope_agent_t *a = open_agent(dir);
    REQUIRE(strstr(recovery(a), "write"));
    REQUIRE(sope_agent_resume(a) == SOPE_EBUSY);
    sope_agent_free(a);
}

static void test_partial_shell_archive(void)
{
    char dir[8192], pattern[8192], path[8192] = {0}, pidfile[8192];
    snprintf(dir, sizeof dir, "%s/partial-shell", root);
    snprintf(pattern, sizeof pattern, "%s/artifacts/shell-*", dir);
    snprintf(pidfile, sizeof pidfile, "%s/pid", dir);
    pid_t child = fork(); REQUIRE(child >= 0);
    if (!child) { execl(executable, executable, "shell", dir, (char *)NULL); _exit(127); }
    int found = 0;
    for (int i = 0; i < 10000; i++) {
        glob_t matches = {0};
        if (glob(pattern, 0, NULL, &matches) == 0 && matches.gl_pathc) {
            char data[64] = {0};
            int fd = open(matches.gl_pathv[0], O_RDONLY);
            ssize_t n = fd >= 0 ? read(fd, data, sizeof data - 1) : -1;
            if (fd >= 0) close(fd);
            if (n > 0 && strstr(data, "RAW_PARTIAL_EVIDENCE")) {
                REQUIRE(realpath(matches.gl_pathv[0], path) != NULL); found = 1;
            }
        }
        globfree(&matches);
        if (found) break;
        struct timespec pause = {0, 1000000}; nanosleep(&pause, NULL);
    }
    REQUIRE(kill(child, SIGKILL) == 0);
    int status; REQUIRE(waitpid(child, &status, 0) == child && WIFSIGNALED(status));
    /* Shells are independent OS jobs: explicitly clean up the test process group. */
    FILE *pids = fopen(pidfile, "r"); long shell = 0;
    REQUIRE(pids && fscanf(pids, "%ld", &shell) == 1 && shell > 1); fclose(pids);
    kill(-(pid_t)shell, SIGKILL);
    REQUIRE(found);
    sope_agent_t *a = open_agent(dir);
    const char *state = recovery(a);
    REQUIRE(strstr(state, "bash") && strstr(state, path));
    REQUIRE(sope_agent_resume(a) == SOPE_EBUSY);
    sope_agent_free(a);
    int fd = open(path, O_RDONLY); char data[64] = {0};
    REQUIRE(fd >= 0 && read(fd, data, sizeof data - 1) > 0 && strstr(data, "RAW_PARTIAL_EVIDENCE")); close(fd);
}

static void test_process_isolation(void)
{
    char parent[8192], target[8192], dirs[2][8192], ready[2][8192], go[8192];
    snprintf(parent, sizeof parent, "%s/parallel", root); REQUIRE(mkdir(parent, 0700) == 0);
    snprintf(target, sizeof target, "%s/shared", parent);
    int fd = open(target, O_CREAT | O_WRONLY, 0600); REQUIRE(fd >= 0 && write(fd, "original", 8) == 8); close(fd);
    pid_t children[2];
    for (int i = 0; i < 2; i++) {
        snprintf(dirs[i], sizeof dirs[i], "%s/session%d", parent, i);
        snprintf(ready[i], sizeof ready[i], "%s/ready", dirs[i]);
        children[i] = fork(); REQUIRE(children[i] >= 0);
        if (!children[i]) { execl(executable, executable, i ? "parallel-B" : "parallel-A", dirs[i], (char *)NULL); _exit(127); }
    }
    int both = 0;
    for (int i = 0; i < 10000; i++) {
        both = access(ready[0], F_OK) == 0 && access(ready[1], F_OK) == 0;
        if (both) break;
        struct timespec pause = {0, 1000000}; nanosleep(&pause, NULL);
    }
    REQUIRE(both);
    snprintf(go, sizeof go, "%s/go", parent); fd = open(go, O_CREAT | O_WRONLY, 0600); REQUIRE(fd >= 0); close(fd);
    int success = 0, rejected = 0;
    for (int i = 0; i < 2; i++) {
        int status; REQUIRE(waitpid(children[i], &status, 0) == children[i] && WIFEXITED(status));
        success += WEXITSTATUS(status) == 0; rejected += WEXITSTATUS(status) == 10;
    }
    REQUIRE(success == 1 && rejected == 1);
}

static void test_execution_receipts(void)
{
    char dir[8192]; snprintf(dir, sizeof dir, "%s/receipts", root);
    sope_agent_t *a = open_agent(dir);
    send_text(a, "!check {\"argv\":[\"false\"]}");
    int seen = 0;
    for (;;) {
        sope_event_t ev = poll_event(a);
        if (ev.type == SOPE_EVENT_TOOL_END) { REQUIRE(ev.code && strstr(ev.data, "process_failed")); seen++; }
        if (ev.type == SOPE_EVENT_TURN_END) break;
    }
    REQUIRE(seen == 1);
    REQUIRE(sope_compact(a, NULL, 0, NULL) == SOPE_OK);
    finish(a, 1);
    sope_agent_free(a);
    a = open_agent(dir);
    send_text(a, "!evidence {}");
    seen = 0;
    for (;;) {
        sope_event_t ev = poll_event(a);
        if (ev.type == SOPE_EVENT_TOOL_END) {
            REQUIRE(!ev.code && strstr(ev.data, "process_failed") && strstr(ev.data, "\"exit_code\":1") && strstr(ev.data, "unverified")); seen++;
        }
        if (ev.type == SOPE_EVENT_TURN_END) break;
    }
    REQUIRE(seen == 1);
    REQUIRE(sope_agent_reset(a) == SOPE_OK);
    sope_agent_free(a);
    a = open_agent(dir);
    send_text(a, "!evidence {}");
    for (;;) {
        sope_event_t ev = poll_event(a);
        if (ev.type == SOPE_EVENT_TOOL_END) REQUIRE(strstr(ev.data, "\"receipts\":[]") && !strstr(ev.data, "process_failed"));
        if (ev.type == SOPE_EVENT_TURN_END) break;
    }
    sope_agent_free(a);
}

int main(int argc, char **argv)
{
    if (argc == 3) { crash_child(argv[1], argv[2]); return 2; }
    REQUIRE(realpath(argv[0], executable) != NULL);
    snprintf(root, sizeof root, "/tmp/sope-durable-XXXXXX");
    REQUIRE(mkdtemp(root) != NULL);
    test_crash_recovery();
    test_admission();
    test_compaction_commit();
    test_execution_receipts();
    test_failed_intent_commit();
    test_failed_start_commit();
    test_failed_result_commit();
    test_atomic_kill();
    test_process_isolation();
    test_partial_shell_archive();
    REQUIRE(sope_shutdown() == SOPE_OK);
    printf("durable tests passed (%s)\n", root);
    return 0;
}
