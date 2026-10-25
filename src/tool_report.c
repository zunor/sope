/* SPDX-License-Identifier: MIT */
#include "tools.h"
#include <math.h>
#include <stdlib.h>
#include <string.h>

static int text(const sope_json* v) { return v && v->type == SOPE_JSON_STRING && v->len && strlen(v->str) == v->len; }
static int integer(const sope_json* v)
{
    return v && v->type == SOPE_JSON_NUMBER && isfinite(v->num) && v->num >= 0 && v->num <= 9007199254740991.0
        && floor(v->num) == v->num;
}
static int equal(const sope_json* a, const sope_json* b)
{
    sope_buf x = { 0 }, y = { 0 };
    int ok = a && b && sope__json_canonical(&x, a, 0) && sope__json_canonical(&y, b, 0) && !x.oom && !y.oom
        && x.len == y.len && !memcmp(x.ptr, y.ptr, x.len);
    sope__buf_free(&x);
    sope__buf_free(&y);
    return ok;
}
int sope__report_contract_valid(const sope_json* contract)
{
    const sope_json* cs = sope__json_get(contract, "criteria");
    if (!contract || contract->type != SOPE_JSON_OBJECT || !cs || cs->type != SOPE_JSON_ARRAY || !cs->count
        || cs->count > 32)
        return 0;
    sope_buf b = { 0 };
    int ok = sope__json_canonical(&b, contract, 0) && !b.oom && b.len <= 16000;
    sope__buf_free(&b);
    if (!ok)
        return 0;
    for (const sope_json* c = cs->child; c; c = c->next) {
        const sope_json *id = sope__json_get(c, "id"), *argv = sope__json_get(c, "argv"),
                        *exit = sope__json_get(c, "exit_code"), *out = sope__json_get(c, "output");
        if (!text(id) || id->len > 64 || !text(sope__json_get(c, "cwd")) || sope__json_get(c, "cwd")->str[0] != '/'
            || !text(sope__json_get(c, "description")) || !argv || argv->type != SOPE_JSON_ARRAY || !argv->count
            || argv->count > 256 || !integer(exit) || exit->num > 255)
            return 0;
        for (const sope_json* p = cs->child; p != c; p = p->next)
            if (!strcmp(sope__json_get(p, "id")->str, id->str))
                return 0;
        for (const sope_json* v = argv->child; v; v = v->next)
            if (v->type != SOPE_JSON_STRING || strlen(v->str) != v->len)
                return 0;
        if (!argv->child->len)
            return 0;
        if (out) {
            const sope_json *empty = sope__json_get(out, "empty"), *contains = sope__json_get(out, "contains");
            if (out->type != SOPE_JSON_OBJECT || out->count != 1
                || !((empty && empty->type == SOPE_JSON_BOOL && empty->boolean) || text(contains)))
                return 0;
        }
    }
    return 1;
}
static int contains(const sope_json* hay, const sope_json* needle)
{
    if (!hay || hay->type != SOPE_JSON_STRING || !text(needle) || hay->len < needle->len)
        return 0;
    for (size_t i = 0; i <= hay->len - needle->len; i++)
        if (!memcmp(hay->str + i, needle->str, needle->len))
            return 1;
    return 0;
}
static sope_next report(tool_run* r)
{
    sope_agent_t* a = r->agent;
    sope_buf result = { 0 };
    sope_json* contract = NULL;
    pthread_mutex_lock(a->mu);
    const char* raw = sope__harness_contract(a);
    if (raw)
        contract = sope__json_parse(raw, strlen(raw));
    const sope_json *cs = sope__json_get(contract, "criteria"), *entries = sope__json_get(r->input, "entries");
    const char* error = NULL;
    unsigned failed = 0, unknown = 0;
    if (!a->root->journal || !sope__report_contract_valid(contract))
        error = "report requires durable execution and a valid host acceptance.contract";
    else if (!entries || entries->type != SOPE_JSON_ARRAY || entries->count != cs->count)
        error = "Provide exactly one entry for every immutable acceptance criterion";
    sope__buf_appendf(&result,
        "{\"session_id\":\"%s\",\"agent_id\":%llu,\"turn_id\":%llu,\"scope\":\"host-defined checks; not a proof of "
        "general correctness\",\"criteria\":[",
        a->root->session_id, (unsigned long long)a->agent_id, (unsigned long long)r->turn_id);
    int comma = 0;
    for (const sope_json* c = cs ? cs->child : NULL; !error && c; c = c->next) {
        const sope_json *entry = NULL, *id = sope__json_get(c, "id");
        for (const sope_json* e = entries->child; e; e = e->next) {
            const sope_json* eid = sope__json_get(e, "id");
            if (text(eid) && !strcmp(eid->str, id->str)) {
                if (entry) {
                    error = "Duplicate criterion entry";
                    break;
                }
                entry = e;
            }
        }
        if (error)
            break;
        if (!entry) {
            error = "Missing required criterion";
            break;
        }
        const sope_json *ref = sope__json_get(entry, "evidence"), *reason = sope__json_get(entry, "unverified"),
                        *note = sope__json_get(entry, "interpretation");
        if ((reason && (!text(reason) || reason->len > 2048)) || (note && (!text(note) || note->len > 2048))
            || (!ref && !reason) || (ref && reason)) {
            error = "Each entry needs evidence OR a bounded unverified reason; interpretation is optional unverified "
                    "prose";
            break;
        }
        if (comma++)
            sope__buf_appends(&result, ",");
        sope__buf_appends(&result, "{\"expected\":");
        sope__json_canonical(&result, c, 0);
        if (reason) {
            unknown++;
            sope__buf_appends(&result, ",\"verdict\":\"unverified\",\"reason\":");
            sope__json_canonical(&result, reason, 0);
        } else {
            const sope_json *sid = sope__json_get(ref, "session_id"), *aid = sope__json_get(ref, "agent_id"),
                            *cid = sope__json_get(ref, "call_id");
            if (!text(sid) || strcmp(sid->str, a->root->session_id) || !integer(aid) || !integer(cid) || cid->num < 1
                || !sope__journal_access(a, (uint64_t)aid->num, 1)) {
                error = "Evidence must identify this session and this turn's own or delegated work";
                break;
            }
            char* obs = sope__journal_observation(a, (uint64_t)aid->num, (uint64_t)cid->num);
            sope_json* v = obs ? sope__json_parse(obs, strlen(obs)) : NULL;
            free(obs);
            const sope_json *receipt = sope__json_get(v, "receipt"), *input = sope__json_get(receipt, "input"),
                            *output = sope__json_get(v, "output"), *tool = sope__json_get(receipt, "tool");
            if (!v || !text(tool) || strcmp(tool->str, "check")
                || !equal(sope__json_get(input, "argv"), sope__json_get(c, "argv"))
                || !equal(sope__json_get(receipt, "cwd"), sope__json_get(c, "cwd"))
                || ((uint64_t)aid->num == a->agent_id
                    && sope__json_number(sope__json_get(receipt, "turn_id"), 0) != (double)r->turn_id)) {
                sope__json_free(v);
                error = "Reference is not a native check of the exact required argv and cwd in this task";
                break;
            }
            int stale = sope__journal_stale(a, (uint64_t)cid->num);
            const sope_json* rule = sope__json_get(c, "output");
            const sope_json* flag = sope__json_get(v, "output_complete");
            int complete = flag && flag->type == SOPE_JSON_BOOL && flag->boolean;
            int known = !stale && (!rule || complete);
            const char* outcome = sope__json_string(sope__json_get(receipt, "outcome"), NULL);
            int pass = known && outcome && strcmp(outcome, "timed_out")
                && equal(sope__json_get(receipt, "exit_code"), sope__json_get(c, "exit_code"));
            if (pass && rule) {
                const sope_json* needle = sope__json_get(rule, "contains");
                pass = needle ? contains(output, needle)
                              : (output && output->type == SOPE_JSON_STRING && output->len == 0);
            }
            if (!known)
                unknown++;
            else if (!pass)
                failed++;
            sope__buf_appendf(&result, ",\"verdict\":\"%s\",\"stale\":%s,\"observation\":",
                !known     ? "unverified"
                    : pass ? "satisfied"
                           : "failed",
                stale ? "true" : "false");
            sope__json_canonical(&result, receipt, 0);
            sope__buf_appendf(&result, ",\"output_complete\":%s,\"output_bytes\":%zu", complete ? "true" : "false",
                complete && output ? output->len : 0);
            if (complete && output) {
                sope__buf_appends(&result, ",\"output_excerpt\":");
                size_t n = output->len < 512 ? output->len : 512;
                while (n < output->len && n && ((unsigned char)output->str[n] & 0xc0) == 0x80)
                    n--;
                sope__buf_append_json_string(&result, output->str, n);
            }
            sope__json_free(v);
        }
        if (note) {
            sope__buf_appends(&result, ",\"unverified_interpretation\":");
            sope__json_canonical(&result, note, 0);
        }
        sope__buf_appends(&result, "}");
    }
    sope__buf_appends(&result, "],\"delegations\":");
    if (!sope__journal_delegations(a, &result))
        error = "Cannot read native delegation states";
    sope__buf_appendf(&result, ",\"status\":\"%s\"}", failed ? "rejected" : unknown ? "incomplete" : "accepted");
    pthread_mutex_unlock(a->mu);
    sope__json_free(contract);
    if (error || result.oom || result.len > 65536) {
        sope__buf_free(&result);
        return sope__run_fail(r, "%s", error ? error : "Report exceeds its bounded result size");
    }
    r->out = result;
    return sope__run_done(r);
}
/* Recheck under the commit/closure lock: a tool may have mutated the workspace
 * between report evaluation and its completion callback. Already unverified
 * entries remain honest; only newly stale observations invalidate a report. */
int sope__report_current(sope_agent_t* a, const char* raw, size_t len)
{
    sope_json* v = sope__json_parse(raw, len);
    const sope_json* cs = sope__json_get(v, "criteria");
    sope_buf delegations = {0};
    int loaded = sope__journal_delegations(a, &delegations);
    sope_json *current = loaded ? sope__json_parse(delegations.ptr, delegations.len) : NULL;
    int ok = cs && cs->type == SOPE_JSON_ARRAY && equal(sope__json_get(v, "delegations"), current);
    sope__json_free(current);
    sope__buf_free(&delegations);
    for (const sope_json* c = cs ? cs->child : NULL; ok && c; c = c->next) {
        const sope_json *verdict = sope__json_get(c, "verdict"), *obs = sope__json_get(c, "observation");
        if (text(verdict) && strcmp(verdict->str, "unverified") && obs)
            ok = !sope__journal_stale(a, (uint64_t)sope__json_number(sope__json_get(obs, "call_id"), 0));
    }
    sope__json_free(v);
    return ok;
}
const sope_builtin sope__builtin_report = { "report",
    "Submit evidence for the immutable host acceptance contract in runtime working state. The runtime computes each "
    "verdict from a committed native check's exact argv, exit status and full output snapshot. Provide exactly one "
    "entry per criterion, using evidence or an unverified reason. Model interpretations remain unverified. Submit "
    "after all mutations/checks; later executions invalidate the report. A rejected report honestly closes a task that "
    "found failures; it is not acceptance success.",
    "{\"type\":\"object\",\"properties\":{\"entries\":{\"type\":\"array\",\"items\":{\"type\":\"object\","
    "\"properties\":{\"id\":{\"type\":\"string\"},\"evidence\":{\"type\":\"object\",\"properties\":{\"session_id\":{"
    "\"type\":\"string\"},\"agent_id\":{\"type\":\"integer\"},\"call_id\":{\"type\":\"integer\"}},\"required\":["
    "\"session_id\",\"agent_id\",\"call_id\"]},\"unverified\":{\"type\":\"string\"},\"interpretation\":{\"type\":"
    "\"string\"}},\"required\":[\"id\"]}}},\"required\":[\"entries\"]}",
    0, report, NULL };
