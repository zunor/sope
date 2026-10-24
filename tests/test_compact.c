/* SPDX-License-Identifier: MIT */
#include "../src/agent.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static int failures;
#define CHECK(x) do { if (!(x)) { fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #x); failures++; } } while (0)

static void test_transcript_budget_and_utf8(void)
{
    sope_history h = { 0 };
    sope_tool_use use = { .id = "call", .name = "bash" };
    sope_buf body = { 0 };
    char *text;
    size_t len, i;
    sope__buf_appends(&body, "HEAD: compile started\n");
    for (i = 0; i < 20000; i++) sope__buf_appends(&body, "中文🙂");
    sope__buf_appends(&body, "\nTAIL: tests failed, exit 1");
    use.input = body.ptr;
    use.input_len = body.len;
    sope_message *call = sope__message_new(SOPE__MSG_ASSISTANT, "", 0);
    call->tool_uses = calloc(1, sizeof *call->tool_uses);
    call->tool_uses[0] = (sope_tool_use){ .id = sope__strdup("call"), .name = sope__strdup("bash"),
                                        .input = sope__strdup(body.ptr), .input_len = body.len };
    call->n_tool_uses = 1;
    sope__history_append(&h, call);
    sope__history_append(&h, sope__tool_message(&use, body.ptr, body.len, 1));
    CHECK(sope__compact_request(&h, NULL, NULL, 0, 2200, &text, &len) == SOPE_OK);
    if (text) {
        CHECK(strstr(text, "HEAD: compile started") != NULL);
        CHECK(strstr(text, "TAIL: tests failed, exit 1") != NULL);
        CHECK(strstr(text, "bytes omitted") != NULL);
        CHECK(sope__text_tokens(text, len) + sope__text_tokens(sope__compact_system, strlen(sope__compact_system)) + 24 <= 2200);
        /* Every non-ASCII sequence must remain a complete original character. */
        for (i = 0; i < len; i++) {
            unsigned char ch = (unsigned char)text[i];
            if (ch < 128) continue;
            size_t bytes = ch >= 0xf0 ? 4 : ch >= 0xe0 ? 3 : ch >= 0xc0 ? 2 : 0;
            CHECK(bytes > 0 && i + bytes <= len);
            if (!bytes || i + bytes > len) break;
            for (size_t j = 1; j < bytes; j++) CHECK(((unsigned char)text[i + j] & 0xc0) == 0x80);
            i += bytes - 1;
        }
        free(text);
    }
    CHECK(sope__compact_request(&h, NULL, NULL, 0, 1, &text, &len) == SOPE_ERROR);
    CHECK(text == NULL && len == 0 && h.count == 2);
    sope__history_clear(&h);
    sope__buf_free(&body);
}

static void test_suffix_groups(void)
{
    const char *json = "[{\"role\":\"user\",\"content\":\"checkpoint\",\"summary\":true},"
        "{\"role\":\"assistant\",\"content\":\"\",\"tool_uses\":["
        "{\"id\":\"a\",\"name\":\"read\",\"input\":\"{}\"},{\"id\":\"b\",\"name\":\"read\",\"input\":\"{}\"}]},"
        "{\"role\":\"tool\",\"tool_use_id\":\"a\",\"name\":\"read\",\"content\":\"first\"},"
        "{\"role\":\"tool\",\"tool_use_id\":\"b\",\"name\":\"read\",\"content\":\"second\"}]";
    sope_history h;
    char err[160];
    CHECK(sope__history_parse(&h, json, strlen(json), err, sizeof err) == SOPE_OK);
    uint64_t group = sope__history_tokens(&h) - sope__message_tokens(h.head);
    CHECK(sope__compact_suffix(&h, group) == h.head->next);
    CHECK(sope__compact_suffix(&h, group - 1) == NULL); /* never orphan either result */
    CHECK(sope__compact_suffix(&h, UINT64_MAX) == h.head->next); /* no old summary */
    size_t len;
    char *saved = sope__history_json(&h, &len);
    CHECK(strstr(saved, "\"summary\":true") != NULL);
    free(saved);
    sope__history_clear(&h);
}

static void test_request_accounting(void)
{
    sope_agent_t a = { 0 };
    sope_tool_spec schema = { "tool", "description", "{\"type\":\"object\"}" };
    sope_message *m = sope__message_new(SOPE__MSG_USER, "hello", 5);
    a.turn.system = "system instructions";
    a.turn.specs = &schema;
    a.turn.n_specs = 1;
    sope__history_append(&a.history, m);
    CHECK(sope__context_tokens(&a) > sope__history_tokens(&a.history)); /* restore, no usage */
    a.context_estimate = sope__request_tokens(&a);
    a.context_tokens = 10000;
    sope__history_append(&a.history, sope__message_new(SOPE__MSG_USER, "new input", 9));
    CHECK(sope__context_tokens(&a) == 10000 + sope__message_tokens(a.history.tail));
    a.context_tokens = UINT64_MAX;
    CHECK(sope__context_tokens(&a) == UINT64_MAX);
    CHECK(sope__text_tokens("中文", strlen("中文")) > sope__text_tokens("abcdef", 6));
    sope__history_clear(&a.history);
}

/* The guard and evidence ledger must outlive replacement of model history. */
static void test_harness_checkpoint(void)
{
    sope_agent_t *a = NULL, *b = NULL;
    CHECK(sope_agent_new(&a) == SOPE_OK && sope_agent_new(&b) == SOPE_OK);
    const char *inputs[] = { "{\"command\":\"false\",\"description\":\"first\"}", "{\"description\":\"renamed\",\"command\":\"false\"}" };
    for (int i = 0; i < 2; i++) {
        pending_call *p = calloc(1, sizeof *p);
        p->name = sope__strdup("bash"); p->call_id = (uint64_t)i + 1; p->turn_id = 7;
        sope_tool_use u = { .name = "bash", .input = (char *)inputs[i], .input_len = strlen(inputs[i]) };
        CHECK(sope__harness_admit(a, p, &u) && !p->harness_blocked);
        p->is_error = 1;
        sope__harness_observe(a, p); sope__pending_free(p);
    }
    sope__history_append(&a->history, sope__message_new(SOPE__MSG_USER, "summary", 7));
    sope__history_clear(&a->history); /* what compaction can replace */
    char *state = sope__harness_json(a);
    CHECK(state && sope__harness_load(b, state));
    free(state);
    for (int i = 0; i < 3; i++) {
        pending_call *p = calloc(1, sizeof *p);
        p->name = sope__strdup("bash"); p->call_id = 10 + (uint64_t)i; p->turn_id = 7;
        sope_tool_use u = { .name = "bash", .input = (char *)inputs[0], .input_len = strlen(inputs[0]) };
        CHECK(sope__harness_admit(b, p, &u) && p->harness_blocked);
        CHECK(strstr(p->content, "#2"));
        sope__harness_observe(b, p); sope__pending_free(p);
    }
    CHECK(sope__harness_exhausted(b));
    pending_call *p = calloc(1, sizeof *p);
    p->name = sope__strdup("bash"); p->call_id = 20; p->turn_id = 8;
    sope_tool_use u = { .name = "bash", .input = (char *)inputs[0], .input_len = strlen(inputs[0]) };
    CHECK(sope__harness_admit(b, p, &u) && !p->harness_blocked && !sope__harness_exhausted(b));
    sope__pending_free(p);
    CHECK(!sope__harness_load(b, "{\"calls\":-1}"));
    CHECK(!sope__harness_load(b, "{\"turn\":1e100}"));
    sope_agent_free(a); sope_agent_free(b);
}

static void test_failed_operation_retry_after_edit(void)
{
    sope_agent_t *a = NULL;
    CHECK(sope_agent_new(&a) == SOPE_OK);
    sope_tool_use u = { .name = "host_operation", .input = "{}", .input_len = 2 };
    for (int i = 0; i < 3; i++) {
        pending_call *p = calloc(1, sizeof *p);
        p->name = sope__strdup(u.name); p->call_id = (uint64_t)i + 1; p->turn_id = 1;
        CHECK(sope__harness_admit(a, p, &u));
        CHECK(p->harness_blocked == (i == 2));
        p->is_error = 1; sope__harness_observe(a, p); sope__pending_free(p);
    }
    /* A known file mutation creates a reason to retry, without opening a new
     * user turn or resetting the aggregate and blocked-call budgets. */
    pending_call mutation = { .name = "edit" };
    sope__harness_observe(a, &mutation);
    pending_call *p = calloc(1, sizeof *p);
    p->name = sope__strdup(u.name); p->call_id = 5; p->turn_id = 1;
    CHECK(sope__harness_admit(a, p, &u) && !p->harness_blocked);
    sope__pending_free(p); sope_agent_free(a);
}

static void test_work_state_survives_history_replacement(void)
{
    sope_agent_t *a=NULL,*b=NULL;
    CHECK(sope_agent_new(&a)==SOPE_OK && sope_agent_new(&b)==SOPE_OK);
    msg_node request={.turn_id=7,.text="Exact task: preserve source",.len=27};
    request.len=strlen(request.text);
    a->turn.msg=b->turn.msg=&request;
    a->turn.max_rounds=b->turn.max_rounds=20;
    const char *input="{\"todos\":[{\"content\":\"Verify\",\"status\":\"pending\"}]}";
    sope_tool_use u={.name="todo_write",.input=(char *)input,.input_len=strlen(input)};
    pending_call *p=calloc(1,sizeof *p);
    p->kind=PENDING_BUILTIN;p->name=sope__strdup(u.name);p->call_id=1;p->turn_id=7;
    CHECK(sope__harness_admit(a,p,&u));sope__harness_observe(a,p);sope__pending_free(p);
    sope_message *summary=sope__message_new(SOPE__MSG_USER,"Everything is done",18);
    summary->is_summary=1;sope__history_append(&a->history,summary);
    CHECK(sope__harness_context(a));
    CHECK(strstr(a->turn.work_context,request.text) && strstr(a->turn.work_context,"pending"));
    CHECK(sope__harness_finish(a)==1);
    char *saved=sope__harness_json(a);CHECK(saved && sope__harness_load(b,saved));free(saved);
    CHECK(sope__harness_finish(b)==1 && sope__harness_finish(b)==-1);
    CHECK(sope__harness_context(b));CHECK(strstr(b->turn.work_context,"pending"));
    CHECK(!sope__harness_load(b,"{\"todo_call\":1,\"todo_turn\":7,\"todos\":{\"todos\":[{\"content\":\"x\",\"status\":\"blocked\"}]}}"));
    free(a->turn.work_context);a->turn.work_context=NULL;
    free(b->turn.work_context);b->turn.work_context=NULL;
    a->turn.msg=b->turn.msg=NULL;sope_agent_free(a);sope_agent_free(b);
}

int main(void)
{
    test_transcript_budget_and_utf8();
    test_suffix_groups();
    test_request_accounting();
    test_harness_checkpoint();
    test_failed_operation_retry_after_edit();
    test_work_state_survives_history_replacement();
    return failures ? 1 : 0;
}
