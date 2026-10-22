/* SPDX-License-Identifier: MIT */
/*
 * compact.c - prompts for history compaction.
 *
 * When a conversation grows past option compact.threshold tokens (or the
 * host calls sope_compact), the loop asks the model to summarize it and
 * replaces the whole history with that summary as a single user message.
 * The model sees the history as a plain transcript rather than as chat
 * messages, which keeps the request independent of tool-call formats.
 */
#include "sope_internal.h"

#include <string.h>

/* Tool results dominate long histories and rarely matter verbatim. */
#define MAX_TOOL_RESULT 2000
#define MAX_TOOL_INPUT 1000

const char sope__compact_system[] =
    "You summarize conversations between a user and an AI assistant so that the assistant can continue the work "
    "with the summary as its only context. Be faithful and specific; never invent details.";

static const char INSTRUCTIONS[] =
    "Write a detailed summary of the conversation transcript below. The summary will replace the conversation, "
    "so include everything needed to continue seamlessly:\n"
    "1. The user's requests and intent, in order, quoting key wording.\n"
    "2. Key facts, decisions and constraints established so far.\n"
    "3. Files, commands, code and tool results that still matter, with exact names, paths and values.\n"
    "4. Errors encountered and how they were resolved.\n"
    "5. Work completed, work in progress, and the next step (if the latest request is unfinished).\n"
    "Scale the summary to the conversation: a short exchange needs only a few lines. Reply with the summary only.\n";

static void append_clipped(sope_buf *b, const char *s, size_t n, size_t max)
{
    if (n <= max) {
        sope__buf_append(b, s, n);
        return;
    }
    while (max > 0 && ((unsigned char)s[max] & 0xc0) == 0x80) max--; /* keep UTF-8 whole */
    sope__buf_append(b, s, max);
    sope__buf_appendf(b, " … [%zu more bytes]", n - max);
}

char *sope__compact_request(const sope_history *h, const char *extra, size_t extra_len, size_t *len)
{
    sope_buf b = { 0 };
    const sope_message *m;
    size_t i;

    sope__buf_appends(&b, INSTRUCTIONS);
    if (extra_len) {
        sope__buf_appends(&b, "\nAdditional instructions from the user:\n");
        sope__buf_append(&b, extra, extra_len);
        sope__buf_appends(&b, "\n");
    }
    sope__buf_appends(&b, "\n<transcript>\n");
    for (m = h->head; m; m = m->next) {
        switch (m->role) {
        case SOPE__MSG_USER:
            sope__buf_appends(&b, "\n[user]\n");
            sope__buf_append(&b, m->content, m->content_len);
            sope__buf_appends(&b, "\n");
            break;
        case SOPE__MSG_ASSISTANT:
            if (m->content_len) {
                sope__buf_appends(&b, "\n[assistant]\n");
                sope__buf_append(&b, m->content, m->content_len);
                sope__buf_appends(&b, "\n");
            }
            for (i = 0; i < m->n_tool_uses; i++) {
                sope__buf_appendf(&b, "\n[assistant called tool %s]\n", m->tool_uses[i].name);
                append_clipped(&b, m->tool_uses[i].input, m->tool_uses[i].input_len, MAX_TOOL_INPUT);
                sope__buf_appends(&b, "\n");
            }
            break;
        case SOPE__MSG_TOOL:
            sope__buf_appendf(&b, "\n[%s %s]\n", m->tool_name, m->is_error ? "failed" : "returned");
            append_clipped(&b, m->content, m->content_len, MAX_TOOL_RESULT);
            sope__buf_appends(&b, "\n");
            break;
        }
    }
    sope__buf_appends(&b, "</transcript>\n");
    if (b.oom) {
        sope__buf_free(&b);
        return NULL;
    }
    *len = b.len;
    return b.ptr;
}

char *sope__compact_summary(const char *summary, size_t n, int mid_turn, size_t *len)
{
    sope_buf b = { 0 };
    sope__buf_appends(&b,
                      "This conversation was compacted to save context. Summary of everything before this point:\n\n");
    sope__buf_append(&b, summary, n);
    if (mid_turn) sope__buf_appends(&b, "\n\nContinue with the current task from where it left off.");
    if (b.oom) {
        sope__buf_free(&b);
        return NULL;
    }
    *len = b.len;
    return b.ptr;
}
