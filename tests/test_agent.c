/* SPDX-License-Identifier: MIT */
/* test_agent.c - behavioural tests for the public ABI, driven by the mock provider. */
#define _POSIX_C_SOURCE 200809L

#include "sope.h"

#include <poll.h>
#include <pthread.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <time.h>

static int failures;

#define CHECK(cond)                                                                \
    do {                                                                           \
        if (!(cond)) {                                                             \
            fprintf(stderr, "%s:%d: check failed: %s\n", __FILE__, __LINE__, #cond); \
            failures++;                                                            \
        }                                                                          \
    } while (0)

typedef struct {
    char text[8192];       /* root agent text */
    size_t len;
    char sub_text[8192];   /* text of all subagents */
    size_t sub_len;
    int starts, ends, tool_calls, sub_tool_calls, errors, usage;
    int sub_starts, sub_ends, sub_cancelled;
    int sub_end_before_turn_end;
    double subs_done_at; /* when the last subagent ended */
    int32_t stop;
    uint64_t last_call_id;
    int compacts;
    char compact_kind[16];
    char summary[2048];
} turn_log;

static void append(char *buf, size_t *len, size_t cap, const char *s, size_t n)
{
    if (*len + n < cap) {
        memcpy(buf + *len, s, n);
        *len += n;
        buf[*len] = '\0';
    }
}

static double now_seconds(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return (double)ts.tv_sec + (double)ts.tv_nsec / 1e9;
}

static sope_agent_t *new_agent(const char *delay_ms)
{
    sope_agent_t *a = NULL;
    CHECK(sope_agent_new(&a) == SOPE_OK);
    CHECK(sope_agent_set_option(a, "mock.delay_ms", delay_ms) == SOPE_OK);
    CHECK(sope_tool_register(a, "echo", "Echo the input.", NULL) == SOPE_OK);
    return a;
}

static int next_event(sope_agent_t *a, sope_event_t *ev)
{
    memset(ev, 0, sizeof *ev);
    ev->size = sizeof *ev;
    return sope_poll(a, ev, 3000);
}

/* Polls until the root's TURN_END. Tool calls (from the root or any
 * subagent) are answered with "got <input>" when answer_tools is set.
 * Returns 0, or the failing sope_poll result. */
static int drain_turn(sope_agent_t *a, turn_log *log, int answer_tools)
{
    sope_event_t ev;
    for (;;) {
        int rc = next_event(a, &ev);
        if (rc != 1) return rc == 0 ? -100 : rc;
        switch (ev.type) {
        case SOPE_EVENT_TURN_START:
            if (!ev.agent_id) log->starts++;
            break;
        case SOPE_EVENT_TEXT_DELTA:
            if (ev.agent_id)
                append(log->sub_text, &log->sub_len, sizeof log->sub_text, ev.data, ev.data_len);
            else
                append(log->text, &log->len, sizeof log->text, ev.data, ev.data_len);
            break;
        case SOPE_EVENT_TOOL_CALL:
            if (ev.agent_id) log->sub_tool_calls++;
            else log->tool_calls++;
            log->last_call_id = ev.call_id;
            if (answer_tools) {
                char out[512];
                snprintf(out, sizeof out, "got %.*s", (int)ev.data_len, ev.data);
                CHECK(sope_tool_result(a, ev.call_id, 0, out, strlen(out)) == SOPE_OK);
            }
            break;
        case SOPE_EVENT_SUBAGENT_START:
            log->sub_starts++;
            CHECK(ev.agent_id == 0 && ev.call_id != 0);
            break;
        case SOPE_EVENT_SUBAGENT_END:
            log->sub_ends++;
            if (ev.code == SOPE_STOP_CANCELLED) log->sub_cancelled++;
            log->subs_done_at = now_seconds();
            break;
        case SOPE_EVENT_USAGE:
            log->usage++;
            break;
        case SOPE_EVENT_COMPACT:
            log->compacts++;
            snprintf(log->compact_kind, sizeof log->compact_kind, "%.*s", (int)ev.name_len, ev.name);
            snprintf(log->summary, sizeof log->summary, "%.*s", (int)ev.data_len, ev.data);
            break;
        case SOPE_EVENT_ERROR:
            if (!ev.agent_id) log->errors++;
            break;
        case SOPE_EVENT_TURN_END:
            if (ev.agent_id) break;
            log->ends++;
            log->stop = ev.code;
            log->sub_end_before_turn_end = log->sub_ends == log->sub_starts;
            return 0;
        default: break;
        }
    }
}

/* ---- basics ------------------------------------------------------------ */

static void test_version(void)
{
    CHECK(sope_version_number() == SOPE_VERSION_NUMBER);
    CHECK(strcmp(sope_version(), SOPE_VERSION_STRING) == 0);
}

static void test_basic_turn(void)
{
    sope_agent_t *a = new_agent("0");
    turn_log log = { 0 };
    uint64_t id = 0;
    CHECK(sope_send(a, "hello", 5, &id) == SOPE_OK);
    CHECK(id == 1);
    CHECK(drain_turn(a, &log, 0) == 0);
    CHECK(log.starts == 1 && log.ends == 1);
    CHECK(log.stop == SOPE_STOP_END_TURN);
    CHECK(log.usage == 1);
    CHECK(strstr(log.text, "You said: hello") != NULL);
    sope_agent_free(a);
}

static void test_tool_roundtrip(void)
{
    sope_agent_t *a = new_agent("0");
    turn_log log = { 0 };
    CHECK(sope_send(a, "!echo hi \"there\"", 16, NULL) == SOPE_OK);
    CHECK(drain_turn(a, &log, 1) == 0);
    CHECK(log.tool_calls == 1);
    CHECK(log.usage == 2); /* two model rounds */
    CHECK(log.stop == SOPE_STOP_END_TURN);
    CHECK(strstr(log.text, "`echo` returned: got {\"input\":\"hi \\\"there\\\"\"}") != NULL);
    sope_agent_free(a);
}

static void test_history_and_reset(void)
{
    sope_agent_t *a = new_agent("0");
    turn_log log = { 0 };

    CHECK(sope_send(a, "one", 3, NULL) == SOPE_OK);
    CHECK(drain_turn(a, &log, 0) == 0);
    memset(&log, 0, sizeof log);
    CHECK(sope_send(a, "!history", 8, NULL) == SOPE_OK);
    CHECK(drain_turn(a, &log, 0) == 0);
    CHECK(strstr(log.text, "history: 3 messages") != NULL); /* user, assistant, user */

    CHECK(sope_agent_reset(a) == SOPE_OK);
    memset(&log, 0, sizeof log);
    CHECK(sope_send(a, "!history", 8, NULL) == SOPE_OK);
    CHECK(drain_turn(a, &log, 0) == 0);
    CHECK(strstr(log.text, "history: 1 messages") != NULL);
    sope_agent_free(a);
}

static void send_and_drain(sope_agent_t *a, const char *text, turn_log *log);

static void test_save_and_resume(void)
{
    sope_agent_t *a = new_agent("0"), *b = new_agent("0");
    turn_log log = { 0 };
    const char *json = NULL, *again = NULL;
    char saved[4096];
    size_t len = 0, len2 = 0;

    CHECK(sope_agent_history(a, &json, &len) == SOPE_OK);
    CHECK(len == 2 && !memcmp(json, "[]", 2));

    CHECK(sope_send(a, "!echo hi", 8, NULL) == SOPE_OK);
    CHECK(drain_turn(a, &log, 1) == 0);
    CHECK(sope_agent_history(a, &json, &len) == SOPE_OK);
    CHECK(len < sizeof saved);
    memcpy(saved, json, len);
    saved[len] = '\0';
    CHECK(strstr(saved, "{\"role\":\"user\",\"content\":\"!echo hi\"}") != NULL);
    CHECK(strstr(saved, "\"tool_uses\":[{\"id\":") != NULL);
    CHECK(strstr(saved, "\"role\":\"tool\"") != NULL && strstr(saved, "\"is_error\":false") != NULL);

    /* Another agent picks the conversation up where it was. */
    CHECK(sope_agent_load_history(b, saved, len) == SOPE_OK);
    CHECK(sope_agent_history(b, &again, &len2) == SOPE_OK);
    CHECK(len2 == len && !memcmp(again, saved, len));
    send_and_drain(b, "!history", &log);
    CHECK(strstr(log.text, "history: 5 messages") != NULL); /* user, assistant+tool use, tool, assistant, user */

    /* Not while a turn runs or waits. */
    CHECK(sope_agent_set_option(b, "mock.delay_ms", "20") == SOPE_OK);
    CHECK(sope_send(b, "slow", 4, NULL) == SOPE_OK);
    CHECK(sope_agent_history(b, &json, &len) == SOPE_EBUSY);
    CHECK(sope_agent_load_history(b, "[]", 2) == SOPE_EBUSY);
    CHECK(drain_turn(b, &log, 0) == 0);

    /* A pending reset counts; a load supersedes it. */
    CHECK(sope_agent_reset(b) == SOPE_OK);
    CHECK(sope_agent_history(b, &json, &len) == SOPE_OK && len == 2);
    CHECK(sope_agent_load_history(b, saved, strlen(saved)) == SOPE_OK);
    send_and_drain(b, "!history", &log);
    CHECK(strstr(log.text, "history: 5 messages") != NULL);

    /* Malformed input is rejected and leaves the history alone. */
    CHECK(sope_agent_load_history(b, "{}", 2) == SOPE_EINVAL);
    CHECK(strstr(sope_last_error(), "array") != NULL);
    CHECK(sope_agent_load_history(b, "[{\"role\":\"robot\"}]", 18) == SOPE_EINVAL);
    CHECK(strstr(sope_last_error(), "robot") != NULL);
    CHECK(sope_agent_load_history(b, "[{\"role\":\"tool\",\"content\":\"x\"}]", 31) == SOPE_EINVAL);
    CHECK(sope_agent_load_history(b, NULL, 1) == SOPE_EINVAL);
    send_and_drain(b, "!history", &log);
    CHECK(strstr(log.text, "history: 7 messages") != NULL);

    /* A history saved with tool uses still open gets them answered. */
    {
        static const char open[] = "[{\"role\":\"user\",\"content\":\"go\"},"
                                   "{\"role\":\"assistant\",\"content\":\"\",\"tool_uses\":"
                                   "[{\"id\":\"t1\",\"name\":\"bash\",\"input\":\"{}\"}]}]";
        CHECK(sope_agent_load_history(b, open, sizeof open - 1) == SOPE_OK);
        CHECK(sope_agent_history(b, &json, &len) == SOPE_OK);
        CHECK(strstr(json, "{\"role\":\"tool\",\"content\":\"cancelled\",\"tool_use_id\":\"t1\",\"name\":\"bash\",\"is_error\":true}") != NULL);
    }
    sope_agent_free(a);
    sope_agent_free(b);
}

static const unsigned char PNG[] = { 0x89, 'P', 'N', 'G', '\r', '\n', 0x1a, '\n', 0, 0, 0, 13, 'I', 'H', 'D', 'R' };

static void test_images(void)
{
    sope_agent_t *a = new_agent("0"), *b = new_agent("0");
    turn_log log = { 0 };
    const char *json = NULL, *again = NULL;
    char saved[4096];
    size_t len = 0;
    unsigned char *big;

    CHECK(sope_attach_image(a, NULL, "hello", 5) == SOPE_EINVAL);
    CHECK(strstr(sope_last_error(), "unsupported") != NULL);
    CHECK(sope_attach_image(a, "image/bmp", PNG, sizeof PNG) == SOPE_EINVAL);
    CHECK(sope_attach_image(a, NULL, NULL, 0) == SOPE_EINVAL);
    big = calloc(1, (10u << 20) + 1);
    CHECK(big && sope_attach_image(a, "image/png", big, (10u << 20) + 1) == SOPE_EINVAL);
    free(big);

    /* Every image attached before a send goes with it; compaction leaves them waiting. */
    send_and_drain(a, "hi", &log);
    CHECK(sope_attach_image(a, NULL, PNG, sizeof PNG) == SOPE_OK);
    CHECK(sope_compact(a, NULL, 0, NULL) == SOPE_OK);
    CHECK(drain_turn(a, &log, 0) == 0);
    CHECK(sope_attach_image(a, "image/jpeg", PNG, sizeof PNG) == SOPE_OK); /* the host's type wins */
    send_and_drain(a, "look", &log);
    CHECK(strstr(log.text, "You said: look (with 2 images)") != NULL);
    CHECK(sope_attach_image(a, NULL, PNG, sizeof PNG) == SOPE_OK);
    send_and_drain(a, "and this", &log);
    CHECK(strstr(log.text, "You said: and this (with 1 image)") != NULL); /* the earlier ones went with "look" */

    CHECK(sope_agent_history(a, &json, &len) == SOPE_OK && len < sizeof saved);
    memcpy(saved, json, len);
    saved[len] = '\0';
    CHECK(strstr(saved, "\"content\":\"look\",\"images\":[{\"media_type\":\"image/png\",\"data\":\"iVBORw0KGgoAAAANSUhEUg==\"},"
                        "{\"media_type\":\"image/jpeg\"") != NULL);
    CHECK(sope_agent_load_history(b, saved, len) == SOPE_OK);
    CHECK(sope_agent_history(b, &again, NULL) == SOPE_OK && !strcmp(again, saved));
    CHECK(sope_agent_load_history(b, "[{\"role\":\"user\",\"content\":\"x\",\"images\":[{\"data\":\"AA==\"}]}]", 63) ==
          SOPE_EINVAL);

    sope_agent_close(a);
    CHECK(sope_attach_image(a, NULL, PNG, sizeof PNG) == SOPE_ECLOSED);
    sope_agent_free(a);
    sope_agent_free(b);
}

static void test_unknown_call_id(void)
{
    sope_agent_t *a = new_agent("0");
    CHECK(sope_tool_result(a, 999, 0, "x", 1) == SOPE_ENOTFOUND);
    CHECK(strstr(sope_last_error(), "999") != NULL);
    sope_agent_free(a);
}

static void test_cancel_while_streaming(void)
{
    sope_agent_t *a = new_agent("50");
    turn_log log = { 0 };
    sope_event_t ev;
    CHECK(sope_send(a, "a long message to stream slowly", 31, NULL) == SOPE_OK);
    do CHECK(next_event(a, &ev) == 1);
    while (ev.type != SOPE_EVENT_TEXT_DELTA);
    CHECK(sope_cancel(a) == SOPE_OK);
    CHECK(drain_turn(a, &log, 0) == 0);
    CHECK(log.stop == SOPE_STOP_CANCELLED);
    sope_agent_free(a);
}

static void test_cancel_while_waiting_for_tool(void)
{
    sope_agent_t *a = new_agent("0");
    turn_log log = { 0 };
    sope_event_t ev;
    uint64_t call_id;
    CHECK(sope_send(a, "!echo x", 7, NULL) == SOPE_OK);
    do CHECK(next_event(a, &ev) == 1);
    while (ev.type != SOPE_EVENT_TOOL_CALL);
    call_id = ev.call_id;
    CHECK(sope_cancel(a) == SOPE_OK);
    CHECK(drain_turn(a, &log, 0) == 0);
    CHECK(log.stop == SOPE_STOP_CANCELLED);
    CHECK(sope_tool_result(a, call_id, 0, "late", 4) == SOPE_ENOTFOUND);

    /* The unanswered tool use was repaired, so the conversation goes on. */
    memset(&log, 0, sizeof log);
    CHECK(sope_send(a, "!history", 8, NULL) == SOPE_OK);
    CHECK(drain_turn(a, &log, 0) == 0);
    CHECK(strstr(log.text, "history: 4 messages") != NULL); /* user, assistant, tool, user */
    sope_agent_free(a);
}

static void test_close_ends_queued_turns(void)
{
    sope_agent_t *a = new_agent("20");
    sope_event_t ev;
    int ends = 0, rc;
    CHECK(sope_send(a, "one", 3, NULL) == SOPE_OK);
    CHECK(sope_send(a, "two", 3, NULL) == SOPE_OK);
    CHECK(sope_send(a, "three", 5, NULL) == SOPE_OK);
    CHECK(sope_agent_close(a) == SOPE_OK);
    CHECK(sope_send(a, "four", 4, NULL) == SOPE_ECLOSED);
    while ((rc = next_event(a, &ev)) == 1)
        if (ev.type == SOPE_EVENT_TURN_END) ends++;
    CHECK(rc == SOPE_ECLOSED);
    CHECK(ends == 3);
    sope_agent_free(a);
}

static void test_errors(void)
{
    sope_agent_t *a = new_agent("0");
    sope_event_t ev = { 0 };
    turn_log log = { 0 };
    static const char bad_def[] = "{\"name\":\"x\"}";

    ev.size = sizeof ev;
    CHECK(sope_poll(a, &ev, 0) == 0);
    CHECK(sope_poll(a, &ev, 10) == 0);
    ev.size = 8;
    CHECK(sope_poll(a, &ev, 0) == SOPE_EINVAL);
    CHECK(sope_send(NULL, "x", 1, NULL) == SOPE_EINVAL);
    CHECK(sope_tool_register(a, "bad name", NULL, NULL) == SOPE_EINVAL);
    CHECK(sope_tool_register(a, "agent", NULL, NULL) == SOPE_EINVAL);
    CHECK(sope_tool_register(a, "schema", NULL, "[1,2]") == SOPE_EINVAL);
    CHECK(sope_subagent_register(a, bad_def, sizeof bad_def - 1) == SOPE_EINVAL);
    CHECK(sope_subagent_register(a, "nope", 4) == SOPE_EINVAL);

    CHECK(sope_send(a, "!panic", 6, NULL) == SOPE_OK);
    CHECK(drain_turn(a, &log, 0) == 0);
    CHECK(log.errors == 1 && log.stop == SOPE_STOP_ERROR);

    memset(&log, 0, sizeof log);
    CHECK(sope_agent_set_option(a, "provider", "nope") == SOPE_OK);
    CHECK(sope_send(a, "hi", 2, NULL) == SOPE_OK);
    CHECK(drain_turn(a, &log, 0) == 0);
    CHECK(log.errors == 1 && log.stop == SOPE_STOP_ERROR);
    sope_agent_free(a);
}

/* An unreachable OpenAI-compatible server exercises the HTTP path offline. */
static void test_openai_unreachable(void)
{
    sope_agent_t *a = new_agent("0");
    turn_log log = { 0 };
    CHECK(sope_agent_set_option(a, "provider", "openai") == SOPE_OK);
    CHECK(sope_send(a, "hi", 2, NULL) == SOPE_OK);
    CHECK(drain_turn(a, &log, 0) == 0); /* no model set */
    CHECK(log.errors == 1 && log.stop == SOPE_STOP_ERROR);

    memset(&log, 0, sizeof log);
    CHECK(sope_agent_set_option(a, "model", "test") == SOPE_OK);
    CHECK(sope_agent_set_option(a, "openai.base_url", "http://127.0.0.1:9/v1") == SOPE_OK);
    CHECK(sope_send(a, "hi", 2, NULL) == SOPE_OK);
    CHECK(drain_turn(a, &log, 0) == 0);
    CHECK(log.errors == 1 && log.stop == SOPE_STOP_ERROR);
    sope_agent_free(a);
}

/* ---- readable fd ------------------------------------------------------- */

static int fd_readable(int fd, int timeout_ms)
{
    struct pollfd p = { fd, POLLIN, 0 };
    return poll(&p, 1, timeout_ms) == 1 && (p.revents & POLLIN);
}

static void test_fd(void)
{
    sope_agent_t *a = new_agent("0");
    sope_event_t ev;
    int fd = sope_agent_fd(a), done = 0;

    CHECK(fd >= 0);
    CHECK(sope_agent_fd(a) == fd);
    CHECK(!fd_readable(fd, 0));
    CHECK(sope_send(a, "hello", 5, NULL) == SOPE_OK);
    while (!done) {
        CHECK(fd_readable(fd, 3000));
        ev.size = sizeof ev;
        while (sope_poll(a, &ev, 0) == 1)
            if (ev.type == SOPE_EVENT_TURN_END) done = 1;
    }
    CHECK(!fd_readable(fd, 50)); /* drained: no longer readable */

    CHECK(sope_agent_close(a) == SOPE_OK);
    CHECK(fd_readable(fd, 3000)); /* closed: stays readable */
    ev.size = sizeof ev;
    CHECK(sope_poll(a, &ev, 0) == SOPE_ECLOSED);
    CHECK(fd_readable(fd, 0));
    sope_agent_free(a);
}

/* One thread waits on many agents through their fds. */
#define FD_AGENTS 50

static void test_fd_multiplexing(void)
{
    sope_agent_t *agents[FD_AGENTS];
    struct pollfd fds[FD_AGENTS];
    int i, remaining = FD_AGENTS;
    double start = now_seconds();

    for (i = 0; i < FD_AGENTS; i++) {
        agents[i] = new_agent("5");
        fds[i].fd = sope_agent_fd(agents[i]);
        fds[i].events = POLLIN;
        CHECK(sope_send(agents[i], "!echo multiplexed", 17, NULL) == SOPE_OK);
    }
    while (remaining > 0 && now_seconds() - start < 10) {
        if (poll(fds, FD_AGENTS, 1000) <= 0) continue;
        for (i = 0; i < FD_AGENTS; i++) {
            sope_event_t ev;
            if (!(fds[i].revents & POLLIN)) continue;
            ev.size = sizeof ev;
            while (fds[i].fd >= 0 && sope_poll(agents[i], &ev, 0) == 1) {
                if (ev.type == SOPE_EVENT_TOOL_CALL) CHECK(sope_tool_result(agents[i], ev.call_id, 0, "ok", 2) == SOPE_OK);
                if (ev.type == SOPE_EVENT_TURN_END) {
                    CHECK(ev.code == SOPE_STOP_END_TURN);
                    fds[i].fd = -1; /* poll ignores negative fds */
                    remaining--;
                }
            }
        }
    }
    CHECK(remaining == 0);
    for (i = 0; i < FD_AGENTS; i++) sope_agent_free(agents[i]);
}

/* ---- subagents --------------------------------------------------------- */

static void test_subagent_basic(void)
{
    sope_agent_t *a = new_agent("0");
    turn_log log = { 0 };
    CHECK(sope_send(a, "!agent summarize the repo", 25, NULL) == SOPE_OK);
    CHECK(drain_turn(a, &log, 0) == 0);
    CHECK(log.sub_starts == 1 && log.sub_ends == 1);
    CHECK(log.sub_end_before_turn_end);
    CHECK(strstr(log.sub_text, "You said: summarize the repo") != NULL);
    CHECK(strstr(log.text, "`agent` returned: You said: summarize the repo") != NULL);
    CHECK(log.stop == SOPE_STOP_END_TURN);
    sope_agent_free(a);
}

static void test_parallel_subagents(void)
{
    sope_agent_t *a = new_agent("20");
    turn_log log = { 0 };
    static const char msg[] = "!agent task one | task two | task three | task four";
    double start = now_seconds(), elapsed;

    CHECK(sope_send(a, msg, sizeof msg - 1, NULL) == SOPE_OK);
    CHECK(drain_turn(a, &log, 0) == 0);
    elapsed = log.subs_done_at - start;
    CHECK(log.sub_starts == 4 && log.sub_ends == 4);
    CHECK(strstr(log.text, "You said: task one") && strstr(log.text, "You said: task four"));
    /* Each subagent streams ~35 chunks x 20 ms; in sequence that is ~3 s. */
    CHECK(elapsed < 1.5);
    sope_agent_free(a);
}

static void test_subagent_calls_host_tool(void)
{
    sope_agent_t *a = new_agent("0");
    turn_log log = { 0 };
    CHECK(sope_send(a, "!agent !echo from child", 23, NULL) == SOPE_OK);
    CHECK(drain_turn(a, &log, 1) == 0);
    CHECK(log.sub_tool_calls == 1 && log.tool_calls == 0);
    CHECK(strstr(log.text, "got {\"input\":\"from child\"}") != NULL);
    sope_agent_free(a);
}

static void test_cancel_reaches_subagents(void)
{
    sope_agent_t *a = new_agent("0");
    turn_log log = { 0 };
    sope_event_t ev;
    CHECK(sope_send(a, "!agent !echo never answered", 27, NULL) == SOPE_OK);
    do CHECK(next_event(a, &ev) == 1);
    while (ev.type != SOPE_EVENT_TOOL_CALL);
    CHECK(ev.agent_id != 0);
    log.sub_starts = 1;
    CHECK(sope_cancel(a) == SOPE_OK);
    CHECK(drain_turn(a, &log, 0) == 0);
    CHECK(log.stop == SOPE_STOP_CANCELLED);
    CHECK(log.sub_cancelled == 1);
    CHECK(log.sub_end_before_turn_end);
    sope_agent_free(a);
}

static void test_custom_subagent(void)
{
    sope_agent_t *a = new_agent("0");
    turn_log log = { 0 };
    static const char def[] = "{\"name\":\"limited\",\"description\":\"Only echoes.\",\"system_prompt\":\"Echo.\","
                              "\"tools\":[\"echo\"]}";
    CHECK(sope_tool_register(a, "clock", "Current time.", NULL) == SOPE_OK);
    CHECK(sope_subagent_register(a, def, sizeof def - 1) == SOPE_OK);

    CHECK(sope_send(a, "!agent:limited !clock", 21, NULL) == SOPE_OK);
    CHECK(drain_turn(a, &log, 1) == 0);
    CHECK(strstr(log.sub_text, "no tool named `clock` is available") != NULL);

    memset(&log, 0, sizeof log);
    CHECK(sope_send(a, "!agent:missing x", 16, NULL) == SOPE_OK);
    CHECK(drain_turn(a, &log, 1) == 0);
    CHECK(log.sub_starts == 0);
    CHECK(strstr(log.text, "`agent` failed: unknown subagent_type") != NULL);

    memset(&log, 0, sizeof log);
    CHECK(sope_agent_set_option(a, "subagents", "off") == SOPE_OK);
    CHECK(sope_send(a, "!agent x", 8, NULL) == SOPE_OK);
    CHECK(drain_turn(a, &log, 1) == 0);
    CHECK(strstr(log.text, "no tool named `agent` is available") != NULL);
    sope_agent_free(a);
}

static void test_free_with_running_subagents(void)
{
    sope_agent_t *a = new_agent("30");
    sope_event_t ev;
    CHECK(sope_send(a, "!agent slow one | slow two", 26, NULL) == SOPE_OK);
    do CHECK(next_event(a, &ev) == 1);
    while (ev.type != SOPE_EVENT_SUBAGENT_START);
    sope_agent_free(a); /* must wait for both children, without leaks or races */
}

/* ---- pool -------------------------------------------------------------- */

#define THREADS 8
#define TURNS 5

static void *concurrent_worker(void *arg)
{
    int *ok = arg;
    sope_agent_t *a = new_agent("1");
    int i;
    *ok = 1;
    for (i = 0; i < TURNS; i++) {
        turn_log log = { 0 };
        const char *msg = (i % 2) ? "!echo ping" : "hello";
        if (sope_send(a, msg, strlen(msg), NULL) != SOPE_OK || drain_turn(a, &log, 1) != 0 ||
            log.stop != SOPE_STOP_END_TURN)
            *ok = 0;
    }
    sope_agent_free(a);
    return NULL;
}

/* ---- compaction -------------------------------------------------------- */

static void send_and_drain(sope_agent_t *a, const char *text, turn_log *log)
{
    memset(log, 0, sizeof *log);
    CHECK(sope_send(a, text, strlen(text), NULL) == SOPE_OK);
    CHECK(drain_turn(a, log, 1) == 0);
}

static void test_manual_compact(void)
{
    sope_agent_t *a = new_agent("0");
    turn_log log;

    send_and_drain(a, "first", &log);
    send_and_drain(a, "second", &log);
    memset(&log, 0, sizeof log);
    CHECK(sope_compact(a, "keep it short", 13, NULL) == SOPE_OK);
    CHECK(drain_turn(a, &log, 0) == 0);
    CHECK(log.stop == SOPE_STOP_END_TURN);
    CHECK(log.compacts == 1 && strcmp(log.compact_kind, "manual") == 0);
    CHECK(strstr(log.summary, "- first") && strstr(log.summary, "- second"));
    CHECK(log.len == 0);   /* the summary never streams as assistant text */
    CHECK(log.usage == 1); /* but its tokens are reported */

    send_and_drain(a, "!history", &log);
    CHECK(strstr(log.text, "history: 2 messages") != NULL); /* summary, !history */

    /* Nothing to compact: the turn just ends. */
    CHECK(sope_agent_reset(a) == SOPE_OK);
    memset(&log, 0, sizeof log);
    CHECK(sope_compact(a, NULL, 0, NULL) == SOPE_OK);
    CHECK(drain_turn(a, &log, 0) == 0);
    CHECK(log.stop == SOPE_STOP_END_TURN && log.compacts == 0);
    sope_agent_free(a);
}

/* The number after "key": in a sope_agent_context report (the first match). */
static unsigned long long context_field(const char *json, const char *key)
{
    char pattern[64];
    const char *p;
    snprintf(pattern, sizeof pattern, "\"%s\":", key);
    p = strstr(json, pattern);
    return p ? strtoull(p + strlen(pattern), NULL, 10) : ~0ULL;
}

static unsigned long long context_parts_sum(const char *json)
{
    static const char *parts[] = { "system", "tools", "summary", "messages", "tool_results", "images" };
    const char *p = strstr(json, "\"parts\":");
    unsigned long long sum = 0;
    size_t i;
    for (i = 0; p && i < sizeof parts / sizeof parts[0]; i++) sum += context_field(p, parts[i]);
    return sum;
}

static void test_context(void)
{
    sope_agent_t *a = new_agent("0");
    turn_log log;
    sope_event_t ev;
    const char *json = NULL;
    size_t len = 0;
    unsigned long long before;
    int rc;

    CHECK(sope_agent_context(NULL, &json, &len) == SOPE_EINVAL);
    CHECK(sope_agent_context(a, NULL, &len) == SOPE_EINVAL);

    /* Before any turn: the system prompt and the tools the first turn offers. */
    CHECK(sope_agent_context(a, &json, &len) == SOPE_OK && len == strlen(json));
    CHECK(strstr(json, "\"state\":\"idle\"") != NULL);
    CHECK(context_field(json, "messages") == 0 && context_field(json, "system") > 12);
    CHECK(context_field(json, "tools") > 0 && strstr(json, "\"counts\":{\"tools\":") != NULL);
    CHECK(context_field(json, "window") == 0 && context_field(json, "reserve") == 0);
    CHECK(context_field(json, "used") == context_field(json, "estimate"));
    CHECK(context_parts_sum(json) == context_field(json, "estimate"));
    CHECK(strstr(json, "\"largest\":[]") != NULL);
    before = context_field(json, "estimate");

    CHECK(sope_agent_set_option(a, "context.window", "200000") == SOPE_OK);
    CHECK(sope_agent_set_option(a, "compact.threshold", "160000") == SOPE_OK);
    CHECK(sope_agent_set_option(a, "openai.max_tokens", "8192") == SOPE_OK);
    CHECK(sope_agent_context(a, &json, &len) == SOPE_OK);
    CHECK(context_field(json, "window") == 200000 && context_field(json, "threshold") == 160000);
    CHECK(context_field(json, "reserve") == 8192);

    /* A host tool result is listed with the call that produced it. */
    send_and_drain(a, "!echo a fairly long tool input", &log);
    CHECK(sope_agent_context(a, &json, &len) == SOPE_OK);
    CHECK(context_field(json, "estimate") > before && context_parts_sum(json) == context_field(json, "estimate"));
    CHECK(context_field(json, "used") >= context_field(json, "estimate"));
    CHECK(strstr(json, "\"tool_results\":1") != NULL); /* the count */
    CHECK(strstr(json, "\"largest\":[{\"name\":\"echo\",\"input\":\"{\\\"input\\\":\\\"a fairly long tool input\\\"}\"") != NULL);

    /* While a turn runs: its last request. */
    CHECK(sope_send(a, "!echo again", 11, NULL) == SOPE_OK);
    while ((rc = next_event(a, &ev)) == 1 && ev.type != SOPE_EVENT_TOOL_CALL) {}
    CHECK(rc == 1);
    CHECK(sope_agent_context(a, &json, &len) == SOPE_OK);
    CHECK(strstr(json, "\"state\":\"running\"") != NULL && context_field(json, "window") == 200000);
    CHECK(strstr(json, "\"tool_results\":1") != NULL); /* this call is not answered yet */
    CHECK(sope_tool_result(a, ev.call_id, 0, "done", 4) == SOPE_OK);
    memset(&log, 0, sizeof log);
    CHECK(drain_turn(a, &log, 1) == 0);
    CHECK(sope_agent_context(a, &json, &len) == SOPE_OK && strstr(json, "\"tool_results\":2") != NULL);

    /* After compaction the older history is a summary. */
    memset(&log, 0, sizeof log);
    CHECK(sope_compact(a, NULL, 0, NULL) == SOPE_OK);
    CHECK(drain_turn(a, &log, 0) == 0 && log.compacts == 1);
    CHECK(sope_agent_context(a, &json, &len) == SOPE_OK);
    CHECK(context_field(json, "summary") > 0 && context_parts_sum(json) == context_field(json, "estimate"));

    /* A reset counts from the next turn on, and so does the report. */
    CHECK(sope_agent_reset(a) == SOPE_OK);
    CHECK(sope_agent_context(a, &json, &len) == SOPE_OK);
    CHECK(context_field(json, "summary") == 0 && context_field(json, "messages") == 0);
    CHECK(context_field(json, "used") == context_field(json, "estimate"));
    sope_agent_free(a);
}

static void test_auto_compact_at_turn_start(void)
{
    sope_agent_t *a = new_agent("0");
    turn_log log;

    /* The mock reports 10 input tokens per history message plus output/4. */
    CHECK(sope_agent_set_option(a, "compact.threshold", "25") == SOPE_OK);
    send_and_drain(a, "one", &log);
    CHECK(log.compacts == 0);
    send_and_drain(a, "!history", &log);
    CHECK(log.compacts == 1 && strcmp(log.compact_kind, "auto") == 0);
    CHECK(strstr(log.summary, "- one") != NULL);
    CHECK(strstr(log.summary, "!history") == NULL); /* the new request is kept verbatim */
    CHECK(strstr(log.text, "history: 2 messages") != NULL);
    CHECK(log.stop == SOPE_STOP_END_TURN);
    sope_agent_free(a);
}

static void test_auto_compact_mid_turn(void)
{
    sope_agent_t *a = new_agent("0");
    turn_log log;

    /* Round 1 reports 10 + 4 tokens, so the history is compacted before round 2. */
    CHECK(sope_agent_set_option(a, "compact.threshold", "12") == SOPE_OK);
    send_and_drain(a, "!echo x", &log);
    CHECK(log.tool_calls == 1);
    CHECK(log.compacts == 1);
    CHECK(strstr(log.summary, "- !echo x") != NULL);
    CHECK(strstr(log.text, "You said: This conversation was compacted") != NULL);
    CHECK(strstr(log.text, "Continue with the current task") != NULL);
    CHECK(log.stop == SOPE_STOP_END_TURN);
    sope_agent_free(a);
}

static void test_cancel_compaction(void)
{
    sope_agent_t *a = new_agent("0");
    turn_log log;

    send_and_drain(a, "one", &log);
    CHECK(sope_agent_set_option(a, "mock.delay_ms", "50") == SOPE_OK);
    memset(&log, 0, sizeof log);
    CHECK(sope_compact(a, NULL, 0, NULL) == SOPE_OK);
    {
        sope_event_t ev;
        do CHECK(next_event(a, &ev) == 1);
        while (ev.type != SOPE_EVENT_TURN_START);
        CHECK(sope_cancel(a) == SOPE_OK);
    }
    CHECK(drain_turn(a, &log, 0) == 0);
    CHECK(log.stop == SOPE_STOP_CANCELLED && log.compacts == 0);

    CHECK(sope_agent_set_option(a, "mock.delay_ms", "0") == SOPE_OK);
    send_and_drain(a, "!history", &log);
    CHECK(strstr(log.text, "history: 3 messages") != NULL); /* untouched */
    sope_agent_free(a);
}

static void test_concurrent_agents(void)
{
    pthread_t threads[THREADS];
    int ok[THREADS];
    int i;
    for (i = 0; i < THREADS; i++) CHECK(pthread_create(&threads[i], NULL, concurrent_worker, &ok[i]) == 0);
    for (i = 0; i < THREADS; i++) {
        pthread_join(threads[i], NULL);
        CHECK(ok[i]);
    }
}

static void test_pool_config(void)
{
    sope_agent_t *a = new_agent("0");
    CHECK(sope_set_threads(4) == SOPE_EBUSY);
    CHECK(sope_shutdown() == SOPE_EBUSY);
    sope_agent_free(a);
}

/* 200 agents streaming at once on a 2-thread pool: waiting for the next
 * chunk must not hold a thread, so this takes about as long as one turn. */
#define MANY 200

static void test_many_agents_few_threads(void)
{
    static sope_agent_t *agents[MANY];
    static int done[MANY];
    int i, remaining = MANY;
    double start = now_seconds();

    for (i = 0; i < MANY; i++) {
        agents[i] = new_agent("5");
        done[i] = 0;
        CHECK(sope_send(agents[i], "hello", 5, NULL) == SOPE_OK);
    }
    while (remaining > 0 && now_seconds() - start < 10) {
        for (i = 0; i < MANY; i++) {
            sope_event_t ev;
            ev.size = sizeof ev;
            while (!done[i] && sope_poll(agents[i], &ev, 0) == 1) {
                if (ev.type == SOPE_EVENT_TURN_END) {
                    CHECK(ev.code == SOPE_STOP_END_TURN);
                    done[i] = 1;
                    remaining--;
                }
            }
        }
    }
    CHECK(remaining == 0);
    /* ~35 chunks x 5 ms per turn; a thread-per-turn pool of 2 would need ~18 s. */
    CHECK(now_seconds() - start < 3.0);
    for (i = 0; i < MANY; i++) sope_agent_free(agents[i]);
}

int main(void)
{
    /* Deliberately tiny so the tests prove that turns never pin a thread. */
    CHECK(sope_set_threads(2) == SOPE_OK);

    test_version();
    test_basic_turn();
    test_tool_roundtrip();
    test_history_and_reset();
    test_save_and_resume();
    test_images();
    test_unknown_call_id();
    test_cancel_while_streaming();
    test_cancel_while_waiting_for_tool();
    test_close_ends_queued_turns();
    test_errors();
    test_openai_unreachable();
    test_fd();
    test_fd_multiplexing();
    test_subagent_basic();
    test_parallel_subagents();
    test_subagent_calls_host_tool();
    test_cancel_reaches_subagents();
    test_custom_subagent();
    test_free_with_running_subagents();
    test_manual_compact();
    test_context();
    test_auto_compact_at_turn_start();
    test_auto_compact_mid_turn();
    test_cancel_compaction();
    test_concurrent_agents();
    test_pool_config();
    test_many_agents_few_threads();

    CHECK(sope_shutdown() == SOPE_OK);
    CHECK(sope_shutdown() == SOPE_OK); /* idempotent */

    if (failures) {
        fprintf(stderr, "%d check(s) failed\n", failures);
        return 1;
    }
    printf("all tests passed\n");
    return 0;
}
