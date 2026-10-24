/* SPDX-License-Identifier: MIT */
#include "tools.h"
#include <inttypes.h>
#include <math.h>
#include <stdlib.h>
#include <string.h>

/* Bounded working set, not a result cache. A blocked read does not assert that
 * its old output is still current. New user turns reopen the execution budget. */
#define KEYS 64
#define RECEIPTS 32
#define KEY_BYTES 16384
struct operation { char *key; unsigned reads, runs, failures; uint64_t last; };
struct sope_harness {
    uint64_t turn;
    unsigned calls, searches, blocked, shells;
    struct operation ops[KEYS];
    unsigned next;
    char *receipts[RECEIPTS];
    unsigned count;
    char *todos; /* latest successful native todo_write input; model assertions */
    uint64_t todo_call, todo_turn;
    unsigned closure_checks;
};

static struct sope_harness *state(sope_agent_t *a)
{
    if (!a->harness) a->harness = calloc(1, sizeof *a->harness);
    return a->harness;
}

void sope__harness_clear(sope_agent_t *a)
{
    if (!a->harness) return;
    for (size_t i = 0; i < KEYS; i++) free(a->harness->ops[i].key);
    for (size_t i = 0; i < a->harness->count; i++) free(a->harness->receipts[i]);
    free(a->harness->todos);
    free(a->harness); a->harness = NULL;
}

static void begin(struct sope_harness *h, uint64_t turn)
{
    if (h->turn == turn) return;
    for (size_t i = 0; i < KEYS; i++) { free(h->ops[i].key); memset(&h->ops[i], 0, sizeof h->ops[i]); }
    h->turn = turn; h->calls = h->searches = h->blocked = h->shells = h->next = 0; h->closure_checks = 0;
}

static unsigned limit(sope_agent_t *a, const char *key, unsigned fallback)
{
    char *v = sope__option_dup_locked(a, key), *end;
    unsigned long n = v ? strtoul(v, &end, 10) : 0;
    int valid = v && *v && !*end && n > 0 && n <= 10000;
    free(v);
    return valid ? (unsigned)n : fallback;
}

static int readonly(const char *name)
{
    return !strcmp(name, "read") || !strcmp(name, "grep") || !strcmp(name, "glob") || !strcmp(name, "artifact_read");
}

char *sope__harness_identity(const sope_tool_use *u)
{
    sope_json *v = sope__json_parse(u->input, u->input_len);
    if (!v || v->type != SOPE_JSON_OBJECT) { sope__json_free(v); return NULL; }
    /* Presentation-only fields cannot be used to evade identity checks. */
    if (!strcmp(u->name, "bash") || !strcmp(u->name, "check")) {
        for (sope_json **p = &v->child; *p; p = &(*p)->next) if (!strcmp((*p)->key, "description")) {
            sope_json *d = *p; *p = d->next; d->next = NULL; sope__json_free(d); v->count--; break;
        }
    }
    sope_buf b = {0};
    sope__buf_appendf(&b, "%s:", u->name);
    int ok = sope__json_canonical(&b, v, 0);
    sope__json_free(v);
    if (!ok || b.oom || b.len > KEY_BYTES) { sope__buf_free(&b); return NULL; }
    return b.ptr;
}

static struct operation *find(struct sope_harness *h, const char *key, int create)
{
    if (!key) return NULL;
    for (size_t i = 0; i < KEYS; i++) if (h->ops[i].key && !strcmp(key, h->ops[i].key)) return &h->ops[i];
    if (!create) return NULL;
    struct operation *op = &h->ops[h->next++ % KEYS];
    free(op->key); memset(op, 0, sizeof *op);
    op->key = sope__strdup(key);
    return op->key ? op : NULL;
}

int sope__harness_admit(sope_agent_t *a, pending_call *p, const sope_tool_use *u)
{
    struct sope_harness *h = state(a);
    if (!h) return 0;
    begin(h, p->turn_id);
    /* Polling and evidence retrieval are not repeated execution. */
    int exempt = !strcmp(u->name, "bash_output") || !strcmp(u->name, "bash_kill") || !strcmp(u->name, "evidence");
    int execution = !strcmp(u->name, "bash") || !strcmp(u->name, "check");
    int search = !strcmp(u->name, "grep") || !strcmp(u->name, "glob");
    p->harness_key = sope__harness_identity(u);
    struct operation *op = find(h, p->harness_key, 1);
    unsigned repeats = limit(a, "harness.max_repeats", 2);
    const char *why = NULL;
    if (h->blocked >= 3) why = "turn execution circuit is open";
    else if (++h->calls > limit(a, "harness.max_calls", 128)) why = "tool-call budget exhausted";
    else if (search && ++h->searches > limit(a, "harness.max_searches", 16)) why = "search budget exhausted";
    else if (!exempt && op && (op->failures >= repeats || (readonly(u->name) && op->reads >= repeats) || (execution && op->runs >= repeats)))
        why = "repeated operation budget exhausted";
    if (why) {
        sope_buf b = {0};
        sope__buf_appendf(&b, "harness: %s; operation did not run. Prior admitted call: #%" PRIu64 ". "
            "Use existing evidence, change the operation, or report the limitation. Three blocked calls end this turn. "
            "A new user turn opens a new budget; old output is not asserted to be current.", why, op ? op->last : 0);
        p->content = b.ptr; p->len = b.len; p->is_error = 1; p->harness_blocked = 1;
        h->blocked++;
        return b.oom ? 0 : 1;
    }
    if (op && readonly(u->name)) op->reads++;
    if (op && execution) op->runs++;
    if (op) op->last = p->call_id;
    if (!strcmp(u->name, "bash")) h->shells++;
    return 1;
}

void sope__harness_observe(sope_agent_t *a, pending_call *p)
{
    struct sope_harness *h = state(a);
    if (!h) { sope__storage_fail_locked(a, "Cannot retain execution facts."); return; }
    struct operation *op = find(h, p->harness_key, 0);
    if (op && !p->harness_blocked) {
        if (p->is_error) op->failures++;
        else op->failures = 0;
    }
    /* Commit the plan with the successful native result, not tool admission.
     * Parallel replacements resolve by call ID, independent of completion order. */
    if (!p->is_error && !p->harness_blocked && p->kind == PENDING_BUILTIN &&
        !strcmp(p->name, "todo_write") && p->harness_key && p->call_id > h->todo_call) {
        const char *input = strchr(p->harness_key, ':');
        char *copy = input ? sope__strdup(input + 1) : NULL;
        if (!copy) { sope__storage_fail_locked(a, "Cannot retain task plan."); return; }
        free(h->todos); h->todos = copy; h->todo_call = p->call_id; h->todo_turn = p->turn_id;
    }
    /* Native file mutations establish a reason to retry a failed check.
     * A successful shell/check alone is not evidence that the cause changed. */
    if (!p->is_error && (!strcmp(p->name,"write") || !strcmp(p->name,"edit")))
        for (size_t i = 0; i < KEYS; i++) h->ops[i].failures = h->ops[i].runs = 0;
    /* Arbitrary programs may change what reads see; this is not a cache. */
    if (!p->is_error && (!strcmp(p->name,"write") || !strcmp(p->name,"edit") || !strcmp(p->name,"bash") || !strcmp(p->name,"check")))
        for (size_t i = 0; i < KEYS; i++) h->ops[i].reads = 0;
    if (p->receipt) {
        char *copy = sope__strdup(p->receipt);
        if (!copy) { sope__storage_fail_locked(a, "Cannot retain check receipt."); return; }
        if (h->count == RECEIPTS) {
            free(h->receipts[0]); memmove(h->receipts, h->receipts + 1, (RECEIPTS - 1) * sizeof(char *)); h->count--;
        }
        h->receipts[h->count++] = copy;
    }
}

int sope__harness_exhausted(sope_agent_t *a) { return a->harness && a->harness->blocked >= 3; }

char *sope__harness_json(sope_agent_t *a)
{
    struct sope_harness *h = a->harness;
    if (!h) return sope__strdup("{}");
    sope_buf b = {0};
    sope__buf_appendf(&b, "{\"turn\":%" PRIu64 ",\"calls\":%u,\"searches\":%u,\"blocked\":%u,\"shells\":%u,\"ops\":[", h->turn,h->calls,h->searches,h->blocked,h->shells);
    int comma = 0;
    for (size_t i = 0; i < KEYS; i++) if (h->ops[i].key) {
        struct operation *op = &h->ops[i];
        sope__buf_appends(&b, comma++ ? ",{" : "{");
        sope__buf_appends(&b,"\"key\":"); sope__buf_append_json_string(&b,op->key,strlen(op->key));
        sope__buf_appendf(&b,",\"reads\":%u,\"runs\":%u,\"failures\":%u,\"last\":%" PRIu64 "}",op->reads,op->runs,op->failures,op->last);
    }
    sope__buf_appends(&b,"],\"receipts\":[");
    for (unsigned i=0;i<h->count;i++) { if(i)sope__buf_appends(&b,",");sope__buf_appends(&b,h->receipts[i]); }
    sope__buf_appendf(&b, "],\"todo_call\":%" PRIu64 ",\"todo_turn\":%" PRIu64 ",\"closure_checks\":%u,\"todos\":",
        h->todo_call, h->todo_turn, h->closure_checks);
    sope__buf_appends(&b, h->todos ? h->todos : "null");
    sope__buf_appends(&b, "}");
    if(b.oom){sope__buf_free(&b);return NULL;}return b.ptr;
}

static int unsigned_field(const sope_json *v, const char *name, uint64_t max)
{
    const sope_json *f = sope__json_get(v, name);
    return !f || (f->type == SOPE_JSON_NUMBER && isfinite(f->num) &&
        f->num >= 0 && f->num <= (double)max && f->num == (double)(uint64_t)f->num);
}

int sope__harness_load(sope_agent_t *a, const char *text)
{
    sope_json *v = sope__json_parse(text,strlen(text));
    if (!v || v->type != SOPE_JSON_OBJECT) { sope__json_free(v); return 0; }
    if (!unsigned_field(v, "turn", 9007199254740991ULL) ||
        !unsigned_field(v, "calls", UINT32_MAX) || !unsigned_field(v, "searches", UINT32_MAX) ||
        !unsigned_field(v, "blocked", UINT32_MAX) || !unsigned_field(v, "shells", UINT32_MAX) ||
        !unsigned_field(v, "todo_call", 9007199254740991ULL) || !unsigned_field(v, "todo_turn", 9007199254740991ULL) ||
        !unsigned_field(v, "closure_checks", 2)) {
        sope__json_free(v); return 0;
    }
    sope__harness_clear(a);
    struct sope_harness *h=state(a);
    if(!h){sope__json_free(v);return 0;}
    h->turn=(uint64_t)sope__json_number(sope__json_get(v,"turn"),0);
    h->calls=(unsigned)sope__json_number(sope__json_get(v,"calls"),0);
    h->searches=(unsigned)sope__json_number(sope__json_get(v,"searches"),0);
    h->blocked=(unsigned)sope__json_number(sope__json_get(v,"blocked"),0);
    h->shells=(unsigned)sope__json_number(sope__json_get(v,"shells"),0);
    const sope_json *ops=sope__json_get(v,"ops"),*receipts=sope__json_get(v,"receipts");
    int ok=(!ops || (ops->type==SOPE_JSON_ARRAY && ops->count<=KEYS)) && (!receipts || (receipts->type==SOPE_JSON_ARRAY && receipts->count<=RECEIPTS));
    for(const sope_json *p=ops?ops->child:NULL;ok&&p;p=p->next){
        if (p->type != SOPE_JSON_OBJECT || !unsigned_field(p, "reads", UINT32_MAX) ||
            !unsigned_field(p, "runs", UINT32_MAX) || !unsigned_field(p, "failures", UINT32_MAX) || !unsigned_field(p, "last", 9007199254740991ULL)) { ok=0; break; }
        const char *key=sope__json_string(sope__json_get(p,"key"),NULL);
        struct operation *op=key&&strlen(key)<=KEY_BYTES?find(h,key,1):NULL;
        if(!op){ok=0;break;}
        op->reads=(unsigned)sope__json_number(sope__json_get(p,"reads"),0);
        op->runs=(unsigned)sope__json_number(sope__json_get(p,"runs"),0);
        op->failures=(unsigned)sope__json_number(sope__json_get(p,"failures"),0);
        op->last=(uint64_t)sope__json_number(sope__json_get(p,"last"),0);
    }
    for(const sope_json *p=receipts?receipts->child:NULL;ok&&p;p=p->next){
        if (p->type != SOPE_JSON_OBJECT) { ok=0; break; }
        sope_buf b={0};ok=sope__json_canonical(&b,p,0)&&!b.oom&&b.len<=70000;
        if(ok)h->receipts[h->count++]=b.ptr;else sope__buf_free(&b);
    }
    h->todo_call=(uint64_t)sope__json_number(sope__json_get(v,"todo_call"),0);
    h->todo_turn=(uint64_t)sope__json_number(sope__json_get(v,"todo_turn"),0);
    h->closure_checks=(unsigned)sope__json_number(sope__json_get(v,"closure_checks"),0);
    const sope_json *todos=sope__json_get(v,"todos");
    if (ok && todos && todos->type != SOPE_JSON_NULL) {
        sope_buf b={0};
        const sope_json *items=sope__json_get(todos,"todos");
        ok=todos->type==SOPE_JSON_OBJECT && items && items->type==SOPE_JSON_ARRAY && items->count<=64 && h->todo_call && h->todo_turn;
        for(const sope_json *p=ok?items->child:NULL;ok&&p;p=p->next) {
            const char *content=sope__json_string(sope__json_get(p,"content"),NULL);
            const char *status=sope__json_string(sope__json_get(p,"status"),NULL);
            const char *reason=sope__json_string(sope__json_get(p,"reason"),NULL);
            ok=content && *content && (!status || !strcmp(status,"pending") || !strcmp(status,"in_progress") ||
                !strcmp(status,"completed") || (!strcmp(status,"blocked") && reason && *reason));
        }
        ok=ok && sope__json_canonical(&b,todos,0) && !b.oom && b.len<=16000;
        if(ok)h->todos=b.ptr;else sope__buf_free(&b);
    }
    sope__json_free(v);return ok;
}

void sope__harness_evidence(sope_agent_t *a, sope_buf *out, int summary)
{
    struct sope_harness *h=a->harness;
    if(summary){
        if(!h || (!h->count && !h->shells))return;
        sope__buf_appends(out,"\n\nExecution evidence — recorded by sope (historical observations, not proof of correctness):\n");
        if(!h->count){sope__buf_appends(out,"No structured checks recorded. Shell completion alone does not establish test success.\n");return;}
        sope__buf_appendf(out,"Session %s; agent %" PRIu64 ". Call IDs from other runs are not these receipts.\n", a->root->session_id,a->agent_id);
    } else {
        sope__buf_appendf(out,"{\"session_id\":\"%s\",\"agent_id\":%" PRIu64 ",", a->root->session_id,a->agent_id);
        sope__buf_appends(out,"\"retention\":32,\"scope\":\"historical execution facts; no claim of current source validity\",\"receipts\":[");
    }
    unsigned count=h?h->count:0;
    unsigned start=summary && count>8 ? count-8:0;
    if (summary) sope__buf_appendf(out,"Showing latest %u of %u retained executions (retention: 32).\n",count-start,count);
    for(unsigned i=start;i<count;i++){
        if(!summary){if(i)sope__buf_appends(out,",");sope__buf_appends(out,h->receipts[i]);continue;}
        sope_json *r=sope__json_parse(h->receipts[i],strlen(h->receipts[i]));
        const char *outcome=sope__json_string(sope__json_get(r,"outcome"),NULL);
        sope__buf_appendf(out,"- execution #%" PRIu64 ": %s; process exit %.0f; test verdict unverified",(uint64_t)sope__json_number(sope__json_get(r,"call_id"),0),outcome?outcome:"unknown",sope__json_number(sope__json_get(r,"exit_code"),-1));
        sope__buf_appends(out,"\n");sope__json_free(r);
    }
    if(summary)sope__buf_appends(out,"Exact commands and output archives: evidence tool. Coverage, assertion quality and source freshness are not established by these receipts.\n");
    else sope__buf_appends(out,"]}");
}

static sope_next evidence(tool_run *r)
{
    const sope_json *id = sope__json_get(r->input, "call_id");
    if (id) {
        const char *session=sope__json_string(sope__json_get(r->input,"session_id"),NULL);
        if(!session || strcmp(session,r->agent->root->session_id))
            return sope__run_fail(r,"Historical recall requires the current session_id from runtime working state or evidence(). Bare call IDs and IDs from other sessions cannot identify this execution's evidence.");
        if (!unsigned_field(r->input,"call_id",9007199254740991ULL) || id->num < 1 ||
            !unsigned_field(r->input,"offset",UINT32_MAX) || !unsigned_field(r->input,"limit",8192))
            return sope__run_fail(r,"call_id must be a positive integer; offset >= 0; limit 4..8192 bytes");
        size_t offset=(size_t)sope__json_number(sope__json_get(r->input,"offset"),0);
        size_t max=(size_t)sope__json_number(sope__json_get(r->input,"limit"),8192);
        if(max<4)return sope__run_fail(r,"limit must be at least 4 bytes");
        pthread_mutex_lock(r->agent->mu);
        int rc=sope__journal_recall(r->agent,(uint64_t)id->num,offset,max,&r->out);
        pthread_mutex_unlock(r->agent->mu);
        if(rc!=SOPE_OK)return sope__run_fail(r,"No readable committed result for this agent/call; historical recall requires durable execution. Nothing was rerun.");
    } else {
        pthread_mutex_lock(r->agent->mu);sope__harness_evidence(r->agent,&r->out,0);pthread_mutex_unlock(r->agent->mu);
    }
    return sope__run_done(r);
}
const sope_builtin sope__builtin_evidence={"evidence",
    "With no arguments, returns the last 32 native execution receipts across compaction and reopen. "
    "With call_id and the current session_id (both required for recall), retrieves a page of that agent's original committed tool result from durable execution "
    "without rerunning it. offset and limit are UTF-8 byte offsets (default limit 8192); use next_offset to continue. "
    "Historical observations do not prove current file contents, coverage or correctness.",
    "{\"type\":\"object\",\"properties\":{\"session_id\":{\"type\":\"string\"},\"call_id\":{\"type\":\"integer\"},\"offset\":{\"type\":\"integer\"},\"limit\":{\"type\":\"integer\"}}}",0,evidence,NULL};

/* The plan is model-authored; only its persisted status is a fact. A bounded
 * reconciliation prevents silent success with outstanding items, not false
 * assertions that the work itself is correct. No synthetic user turn. */
int sope__harness_finish(sope_agent_t *a)
{
    struct sope_harness *h = a->harness;
    if (!h || !h->todos || h->todo_turn != sope__turn_id(a)) return 0;
    sope_json *v = sope__json_parse(h->todos, strlen(h->todos));
    const sope_json *todos = sope__json_get(v, "todos");
    if (!v || !todos || todos->type != SOPE_JSON_ARRAY) {
        sope__json_free(v);
        sope__storage_fail_locked(a, "Cannot read the task plan; completion not established.");
        return -1;
    }
    unsigned outstanding = 0;
    for (const sope_json *p = todos ? todos->child : NULL; p; p = p->next) {
        const char *status = sope__json_string(sope__json_get(p, "status"), NULL);
        if (!status || !strcmp(status, "pending") || !strcmp(status, "in_progress")) outstanding++;
    }
    sope__json_free(v);
    if (!outstanding) return 0;
    if (h->closure_checks >= 2) return -1;
    h->closure_checks++;
    return sope__journal_harness(a) ? 1 : -1;
}

int sope__harness_context(sope_agent_t *a)
{
    struct sope_harness *h = a->harness;
    turn_state *t = &a->turn;
    if (h && t->msg && !t->msg->compact) begin(h, t->msg->turn_id);
    sope_buf b = {0};
    const msg_node *request = t->msg;
    int summarized = 0, present = 0;
    for (const sope_message *m = a->history.head; m; m = m->next) {
        summarized |= m->is_summary;
        if (request && m->role == SOPE__MSG_USER && !m->is_summary &&
            m->content_len == request->len && !memcmp(m->content, request->text, request->len)) present = 1;
    }
    int task = summarized && request && !request->compact && !present;
    if (task || (h && (h->todos || h->count))) {
        sope__buf_appends(&b, "Runtime working state (derived data, not a new user request). "
            "Summaries may be lossy: use the original request and recorded observations below to resolve conflicts. "
            "Todos are model assertions, not verified completion. Call IDs are scoped to this session and agent; "
            "numbers cited in files from other runs are not these receipts. Never associate a test claim with an "
            "unrelated command. Receipts prove process outcomes only; "
            "source freshness, coverage and correctness require assessment. Reuse known evidence; reread only the needed "
            "range when a specific uncertainty or source change requires it. Finish the requested deliverables and "
            "reconcile the plan before answering; mark a genuinely blocked item with its reason, never as completed.\n");
        sope__buf_appendf(&b, "{\"session_id\":\"%s\",\"agent_id\":%" PRIu64 ",\"turn_id\":%" PRIu64 ",\"round\":%" PRIu64 ",\"remaining_rounds\":%" PRIu64,
            a->root->session_id,a->agent_id,request ? request->turn_id : 0,t->round, t->max_rounds > (int64_t)t->round ? (uint64_t)t->max_rounds - t->round : 0);
        if (task) {
            sope__buf_appends(&b, ",\"original_current_request\":");
            sope__buf_append_json_string(&b, request->text, request->len);
        }
        if (h) {
            unsigned calls = limit(a, "harness.max_calls", 128), searches = limit(a, "harness.max_searches", 16);
            sope__buf_appendf(&b, ",\"remaining_tool_calls\":%u,\"remaining_searches\":%u,\"closure_checks\":%u",
                calls > h->calls ? calls-h->calls : 0, searches > h->searches ? searches-h->searches : 0, h->closure_checks);
            if (h->todos) {
                sope__buf_appendf(&b, ",\"plan_call_id\":%" PRIu64 ",\"plan_turn_id\":%" PRIu64 ",\"plan\":", h->todo_call,h->todo_turn);
                sope__buf_appends(&b, h->todos);
            }
            sope__buf_appends(&b, ",\"recent_executions\":[");
            unsigned start = h->count > 8 ? h->count-8 : 0;
            for (unsigned i=start;i<h->count;i++) {
                sope_json *r=sope__json_parse(h->receipts[i],strlen(h->receipts[i]));
                if(i>start)sope__buf_appends(&b,",");
                sope__buf_appendf(&b,"{\"call_id\":%.0f,\"exit_code\":%.0f,\"outcome\":",
                    sope__json_number(sope__json_get(r,"call_id"),0),sope__json_number(sope__json_get(r,"exit_code"),-1));
                const char *outcome=sope__json_string(sope__json_get(r,"outcome"),NULL);
                sope__buf_append_json_string(&b,outcome ? outcome : "unknown",outcome ? strlen(outcome) : 7);
                const char *tool=sope__json_string(sope__json_get(r,"tool"),NULL);
                sope__buf_appends(&b,",\"tool\":");
                sope__buf_append_json_string(&b,tool?tool:"unknown",tool?strlen(tool):7);
                const sope_json *input=sope__json_get(r,"input");
                sope_buf command={0};
                int exact=input && input->type==SOPE_JSON_OBJECT && sope__json_canonical(&command,input,0) && !command.oom && command.len<=1024;
                sope__buf_appends(&b,",\"input\":");
                if(exact)sope__buf_append(&b,command.ptr,command.len);
                else sope__buf_appends(&b,"null,\"input_omitted\":true");
                sope__buf_free(&command);
                sope__buf_appends(&b,"}");sope__json_free(r);
            }
            sope__buf_appends(&b,"],\"recent_reads\":[");
            uint64_t before=UINT64_MAX;
            for(unsigned n=0;n<12;n++) {
                struct operation *best=NULL;
                for(size_t i=0;i<KEYS;i++) if(h->ops[i].key && !strncmp(h->ops[i].key,"read:",5) &&
                    h->ops[i].last < before && (!best || h->ops[i].last>best->last)) best=&h->ops[i];
                if(!best)break;
                if(n)sope__buf_appends(&b,",");
                sope__buf_appendf(&b,"{\"call_id\":%" PRIu64 ",\"input\":",best->last);
                sope__buf_appends(&b,strlen(best->key+5)<=1024?best->key+5:"null");
                sope__buf_appends(&b,"}");before=best->last;
            }
            sope__buf_appends(&b,"],\"execution_details\":\"Use evidence(session_id, call_id) for exact historical tool results; evidence() for execution receipts. A read call may have failed; inspect its result.\"}");
        } else sope__buf_appends(&b,"}");
    }
    if(b.oom){sope__buf_free(&b);return 0;}
    free(t->work_context);t->work_context=b.ptr;return 1;
}
