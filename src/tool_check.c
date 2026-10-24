/* SPDX-License-Identifier: MIT */
#define _POSIX_C_SOURCE 200809L
#include "tools.h"
#include <inttypes.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>
#include <unistd.h>

static int64_t now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (int64_t)ts.tv_sec * 1000 + ts.tv_nsec / 1000000;
}

/* proc's shell only performs exec: every argv element is a single literal
 * word. Invoking an interpreter explicitly still has that interpreter's
 * semantics, so a receipt describes process completion, never test success. */
static int command(tool_run *r, sope_buf *cmd)
{
    const sope_json *argv = sope__json_get(r->input, "argv");
    if (!argv || argv->type != SOPE_JSON_ARRAY || !argv->count || argv->count > 256) return 0;
    sope__buf_appends(cmd, "exec --");
    for (const sope_json *v = argv->child; v; v = v->next) {
        if (v->type != SOPE_JSON_STRING || strlen(v->str) != v->len ||
            (v == argv->child && !v->len)) return 0;
        sope__buf_appends(cmd, " '");
        for (size_t i = 0; i < v->len; i++) {
            if (v->str[i] == '\'') sope__buf_appends(cmd, "'\\''");
            else sope__buf_append(cmd, v->str + i, 1);
        }
        sope__buf_appends(cmd, "'");
        if (cmd->oom || cmd->len > 65536) return 0;
    }
    return 1;
}

void sope__execution_receipt(tool_run *r, int status)
{
    sope_buf b = {0};
    sope__buf_appendf(&b, "{\"version\":1,\"call_id\":%" PRIu64 ",\"turn_id\":%" PRIu64 ",\"tool\":\"%s\",\"input\":", r->call_id, r->turn_id, r->tool->name);
    sope_buf input = {0};
    int valid = sope__json_canonical(&input, r->input, 0) && !input.oom;
    /* Large shell scripts already live in their tool intent; don't duplicate
     * them in every bounded ledger checkpoint. Call ID is the join key. */
    if (valid && input.len <= 16384) sope__buf_append(&b, input.ptr, input.len);
    else sope__buf_appends(&b, "null,\"input_omitted\":true");
    sope__buf_free(&input);
    if (!valid) b.oom = 1;
    sope__buf_appends(&b, ",\"cwd\":");
    sope__buf_append_json_string(&b, r->cwd, strlen(r->cwd));
    sope__buf_appendf(&b, ",\"exit_code\":%d,\"outcome\":\"%s\",\"test_verdict\":\"unverified\",\"output_path\":",
        status, r->timed_out ? "timed_out" : status ? "process_failed" : "process_exited_zero");
    sope__buf_append_json_string(&b, r->check_archive, strlen(r->check_archive));
    sope__buf_appends(&b, "}");
    if (b.oom) {
        sope__buf_free(&b);
        pthread_mutex_lock(r->agent->mu);
        sope__storage_fail_locked(r->agent, "Cannot retain check receipt; verify execution before recovery.");
        pthread_mutex_unlock(r->agent->mu);
        return;
    }
    r->receipt = b.ptr;
    sope__buf_appends(&r->out, "\n[sope execution receipt; test assertions and coverage unverified]\n");
    sope__buf_appends(&r->out, r->receipt);
}

static sope_next check(tool_run *r)
{
    if (!r->proc) {
        sope_buf cmd = {0};
        if (!command(r, &cmd)) {
            sope__buf_free(&cmd);
            return sope__run_fail(r, "argv must contain 1–256 strings, a nonempty program, no NUL bytes, and at most 64 KiB of quoted arguments.");
        }
        r->timeout_ms = sope__arg_int(r, "timeout", 120000);
        if (r->timeout_ms <= 0) r->timeout_ms = 120000;
        if (r->timeout_ms > 600000) r->timeout_ms = 600000;
        int fd = sope__artifact_create(r->agent, "check", &r->check_archive);
        if (fd < 0) { sope__buf_free(&cmd); return sope__run_fail(r, "Cannot create check archive; program did not run."); }
        pthread_mutex_lock(r->agent->mu);
        int committed = sope__journal_artifact(r->agent, r->call_id, r->check_archive);
        pthread_mutex_unlock(r->agent->mu);
        if (!committed) {
            close(fd); sope__buf_free(&cmd);
            return sope__run_fail(r, "Cannot commit check archive; program did not run.");
        }
        char err[256];
        r->proc = sope__proc_start(cmd.ptr, r->cwd, r->agent->root->environment, &r->task, fd, r->check_archive, err, sizeof err);
        sope__buf_free(&cmd);
        if (!r->proc) return sope__run_fail(r, "%s", err);
        r->deadline_ms = now_ms() + r->timeout_ms;
    }
    int status;
    if (sope__proc_done(r->proc, &status)) {
        sope__proc_output(r->proc, 0, &r->out);
        sope__buf_sanitize(&r->out, 0);
        sope__buf_clip_middle(&r->out, 30000);
        int archived = sope__proc_archive(r->proc, &r->out);
        r->is_error = status != 0 || r->timed_out || !archived;
        if (archived) sope__execution_receipt(r, status);
        else {
            pthread_mutex_lock(r->agent->mu);
            sope__storage_fail_locked(r->agent, "Check output archive failed; verify execution before recovery.");
            pthread_mutex_unlock(r->agent->mu);
        }
        return sope__run_done(r);
    }
    if (r->timed_out) return (sope_next){ SOPE__NEXT_WAIT, 0 };
    int64_t left = r->deadline_ms - now_ms();
    if (left <= 0) {
        r->timed_out = 1; sope__proc_kill(r->proc);
        return (sope_next){ SOPE__NEXT_WAIT, 0 };
    }
    return (sope_next){ SOPE__NEXT_SLEEP, (int32_t)left };
}

static void cancel(tool_run *r) { sope__proc_release(r->proc); r->proc = NULL; }

const sope_builtin sope__builtin_check = {
    "check", "Runs a test/build program as literal argv in the working directory, without shell chaining or expansion. Output is bounded and archived. Returns a native execution receipt retained by evidence across compaction. Exit zero records process completion only: test assertions, coverage and current-source validity remain unverified. Timeout defaults to 120000 ms, maximum 600000 ms.",
    "{\"type\":\"object\",\"properties\":{\"argv\":{\"type\":\"array\",\"items\":{\"type\":\"string\"},\"minItems\":1},\"timeout\":{\"type\":\"integer\"},\"description\":{\"type\":\"string\"}},\"required\":[\"argv\"]}",
    1, check, cancel
};
