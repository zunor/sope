/* SPDX-License-Identifier: MIT */
/*
 * tool_bash.c - bash, and the background shells of bash_output and
 * bash_kill.
 *
 * A command runs through proc.c, which wakes the run's task on output and
 * exit, so a long command holds no thread. A background shell outlives the
 * call: it belongs to the root agent until bash_kill or teardown.
 */
#define _POSIX_C_SOURCE 200809L

#include "tools.h"

#include <stdio.h>
#include <stdlib.h>
#include <unistd.h>
#include <string.h>
#include <time.h>

#define BASH_DEFAULT_MS 120000
#define BASH_MAX_MS 600000
#define BASH_MAX_OUTPUT 30000

static const char BASH_DESC[] =
    "Runs a shell command with /bin/bash -o pipefail -c in the working directory and returns its combined stdout and stderr "
    "and its exit code.\n\n"
    "Usage:\n"
    "- Commands run without a terminal and with stdin closed. Avoid interactive programs (editors, pagers, "
    "git rebase -i) and pass flags such as -y where a command would prompt.\n"
    "- Every call starts a fresh shell in the working directory, so cd does not carry over: use `cd dir && "
    "cmd` or absolute paths.\n"
    "- Prefer the dedicated tools: read instead of cat, head or tail; edit or write instead of sed or echo "
    "redirection; glob instead of find; grep instead of grep or rg.\n"
    "- timeout is in milliseconds (default 120000, at most 600000). When the output is long, its beginning "
    "and end are shown, with complete output archived to a file.\n"
    "- Use run_in_background for long-running processes such as dev servers and watchers: you get a shell id "
    "right away, read its output with bash_output and stop it with bash_kill. Do not append & yourself.\n"
    "- Run independent commands as parallel tool calls; chain dependent ones with &&.\n"
    "- Run tests/builds directly: output is already bounded and archived, so do not pipe checks to head/tail. "
    "pipefail preserves failures inside pipelines; a later echo or other command can still replace the exit status. "
    "To inspect a failure, capture status=$? immediately and finish with exit $status. Never report a check as "
    "passed merely because a wrapper command returned zero.\n"
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

static int64_t now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* ------------------------------------------------------------------------ */
/* bash                                                                     */
/* ------------------------------------------------------------------------ */

static void bash_result(tool_run *r, int status)
{
    size_t start = r->out.len;
    sope__proc_output(r->proc, 0, &r->out);
    sope__buf_sanitize(&r->out, start);
    while (r->out.len > start && r->out.ptr[r->out.len - 1] == '\n') r->out.ptr[--r->out.len] = '\0';
    sope__buf_clip_middle(&r->out, BASH_MAX_OUTPUT);
    int archived = sope__proc_archive(r->proc, &r->out);
    if (!archived) {
        pthread_mutex_lock(r->agent->mu);
        sope__storage_fail_locked(r->agent, "Shell output archive failed; verify the command outcome before recovery.");
        pthread_mutex_unlock(r->agent->mu);
    }
    if (r->out.len) sope__buf_appends(&r->out, "\n");
    if (r->timed_out) {
        sope__buf_appendf(&r->out, "[timed out after %lld ms; the command was killed]", (long long)r->timeout_ms);
        r->is_error = 1;
    } else {
        sope__buf_appendf(&r->out, "[exit code %d]", status);
        r->is_error = status != 0 || !archived;
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
        char *archive_path;
        int archive_fd = sope__artifact_create(r->agent, "shell", &archive_path);
        if (archive_fd < 0) return sope__run_fail(r, "Cannot create shell output archive; command did not run.");
        pthread_mutex_lock(r->agent->mu);
        int committed = sope__journal_artifact(r->agent, r->call_id, archive_path);
        pthread_mutex_unlock(r->agent->mu);
        if (!committed) { close(archive_fd); free(archive_path); return sope__run_fail(r, "Cannot commit shell archive; command did not run."); }
        r->proc = sope__proc_start(cmd, r->cwd, r->agent->root->environment, background ? NULL : &r->task, archive_fd, archive_path, err, sizeof err);
        free(archive_path);
        if (!r->proc) return sope__run_fail(r, "%s", err);
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
            sope__proc_archive(sh->proc, &r->out);
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

/* ------------------------------------------------------------------------ */
/* background shells                                                        */
/* ------------------------------------------------------------------------ */

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
    sh->read_pos = sope__proc_read(sh->proc, sh->read_pos, BASH_MAX_OUTPUT, &fresh);
    int archived = sope__proc_archive(sh->proc, &r->out);
    if (!archived) sope__storage_fail_locked(r->agent, "Background output archive failed; verify the command outcome before recovery.");
    r->is_error = !archived;
    pthread_mutex_unlock(r->agent->mu);

    sope__buf_sanitize(&fresh, 0);

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

const sope_builtin sope__builtin_bash = { "bash", BASH_DESC, BASH_SCHEMA, 1, tool_bash, bash_cancel };
const sope_builtin sope__builtin_bash_output = { "bash_output", BASH_OUTPUT_DESC, SHELL_ID_SCHEMA, 0, tool_bash_output, NULL };
const sope_builtin sope__builtin_bash_kill = { "bash_kill", BASH_KILL_DESC, SHELL_ID_SCHEMA, 0, tool_bash_kill, NULL };
