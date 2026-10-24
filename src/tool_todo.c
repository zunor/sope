/* SPDX-License-Identifier: MIT */
/*
 * tool_todo.c - validates model-authored task lists. The harness commits the
 * latest successful list atomically with this tool result, outside summaries.
 */
#include "tools.h"

#include <string.h>
#include <stdlib.h>

static const char TODO_DESC[] =
    "Creates and updates a task list for the current work. It keeps you on track through multi-step tasks "
    "and shows the user your progress.\n\n"
    "When to use it:\n"
    "- Work with 3 or more distinct steps, or when the user gives you several tasks at once.\n"
    "- Right after receiving new instructions: capture the requirements as todos.\n"
    "Skip it for a single trivial task or a purely conversational request.\n\n"
    "How to use it:\n"
    "- Send the whole list every time; it replaces the previous one.\n"
    "- The latest successful list is retained outside summary history and restored with the execution. "
    "Use blocked with a concrete reason for work that cannot proceed; it is not completed.\n"
    "- Each todo has content (imperative, e.g. \"Run the tests\"), activeForm (present continuous, e.g. "
    "\"Running the tests\") and a status: pending, in_progress, completed or blocked.\n"
    "- Keep exactly one todo in_progress while you work. Mark it completed as soon as it is done, not in "
    "batches, and only when it is really done (tests pass, nothing left half-finished).\n"
    "- Add follow-up tasks you discover and remove ones that no longer apply.";
static const char TODO_SCHEMA[] =
    "{\"type\":\"object\",\"properties\":{\"todos\":{\"type\":\"array\",\"description\":\"The updated todo "
    "list\",\"items\":{\"type\":\"object\",\"properties\":{"
    "\"content\":{\"type\":\"string\"},"
    "\"activeForm\":{\"type\":\"string\"},"
    "\"status\":{\"type\":\"string\",\"enum\":[\"pending\",\"in_progress\",\"completed\",\"blocked\"]},\"reason\":{\"type\":\"string\"}},"
    "\"required\":[\"content\",\"status\",\"activeForm\"]}}},"
    "\"required\":[\"todos\"]}";

static sope_next tool_todo_write(tool_run *r)
{
    const sope_json *todos = sope__json_get(r->input, "todos"), *t;
    size_t pending = 0, active = 0, completed = 0, blocked = 0, i = 0;

    if (!todos || todos->type != SOPE_JSON_ARRAY) return sope__run_fail(r, "todos (an array) is required");
    sope_buf canonical = {0};
    int bounded = todos->count <= 64 && sope__json_canonical(&canonical, r->input, 0) &&
        !canonical.oom && canonical.len <= 16000;
    sope__buf_free(&canonical);
    if (!bounded) return sope__run_fail(r, "todo list must contain at most 64 items and 16000 bytes of JSON");
    for (t = todos->child; t; t = t->next, i++) {
        const char *content = sope__json_string(sope__json_get(t, "content"), NULL);
        const char *status = sope__json_string(sope__json_get(t, "status"), NULL);
        if (!content || !*content) return sope__run_fail(r, "todo %zu has no content", i + 1);
        if (!status) status = "pending";
        if (!strcmp(status, "pending")) pending++;
        else if (!strcmp(status, "in_progress")) active++;
        else if (!strcmp(status, "completed")) completed++;
        else if (!strcmp(status, "blocked")) {
            const char *reason = sope__json_string(sope__json_get(t, "reason"), NULL);
            if (!reason || !*reason) return sope__run_fail(r, "blocked todo %zu requires a reason", i + 1);
            blocked++;
        }
        else
            return sope__run_fail(r, "todo %zu has status \"%s\"; use pending, in_progress, completed or blocked", i + 1,
                                  status);
    }
    sope__buf_appendf(&r->out,
                      "Todo list updated: %zu pending, %zu in progress, %zu completed, %zu blocked. Keep it current as you "
                      "work, and mark each task completed as soon as it is done.",
                      pending, active, completed, blocked);
    if (active > 1) sope__buf_appends(&r->out, " Keep only one task in progress at a time.");
    return sope__run_done(r);
}

const sope_builtin sope__builtin_todo_write = { "todo_write", TODO_DESC, TODO_SCHEMA, 0, tool_todo_write, NULL };
