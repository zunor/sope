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
struct operation { char *key; unsigned reads, failures; uint64_t last; };
struct sope_harness {
    uint64_t turn;
    unsigned calls, searches, blocked, shells;
    struct operation ops[KEYS];
    unsigned next;
    char *receipts[RECEIPTS];
    unsigned count;
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
    free(a->harness); a->harness = NULL;
}

static void begin(struct sope_harness *h, uint64_t turn)
{
    if (h->turn == turn) return;
    for (size_t i = 0; i < KEYS; i++) { free(h->ops[i].key); memset(&h->ops[i], 0, sizeof h->ops[i]); }
    h->turn = turn; h->calls = h->searches = h->blocked = h->shells = h->next = 0;
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

static char *identity(const sope_tool_use *u)
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
    int search = !strcmp(u->name, "grep") || !strcmp(u->name, "glob");
    p->harness_key = identity(u);
    struct operation *op = find(h, p->harness_key, 1);
    unsigned repeats = limit(a, "harness.max_repeats", 2);
    const char *why = NULL;
    if (h->blocked >= 3) why = "turn execution circuit is open";
    else if (++h->calls > limit(a, "harness.max_calls", 128)) why = "tool-call budget exhausted";
    else if (search && ++h->searches > limit(a, "harness.max_searches", 16)) why = "search budget exhausted";
    else if (!exempt && op && (op->failures >= repeats || (readonly(u->name) && op->reads >= repeats)))
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
    /* Native file mutations establish a reason to retry a failed check.
     * A successful shell/check alone is not evidence that the cause changed. */
    if (!p->is_error && (!strcmp(p->name,"write") || !strcmp(p->name,"edit")))
        for (size_t i = 0; i < KEYS; i++) h->ops[i].failures = 0;
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
        sope__buf_appendf(&b,",\"reads\":%u,\"failures\":%u,\"last\":%" PRIu64 "}",op->reads,op->failures,op->last);
    }
    sope__buf_appends(&b,"],\"receipts\":[");
    for (unsigned i=0;i<h->count;i++) { if(i)sope__buf_appends(&b,",");sope__buf_appends(&b,h->receipts[i]); }
    sope__buf_appends(&b,"]}");
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
        !unsigned_field(v, "blocked", UINT32_MAX) || !unsigned_field(v, "shells", UINT32_MAX)) {
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
            !unsigned_field(p, "failures", UINT32_MAX) || !unsigned_field(p, "last", 9007199254740991ULL)) { ok=0; break; }
        const char *key=sope__json_string(sope__json_get(p,"key"),NULL);
        struct operation *op=key&&strlen(key)<=KEY_BYTES?find(h,key,1):NULL;
        if(!op){ok=0;break;}
        op->reads=(unsigned)sope__json_number(sope__json_get(p,"reads"),0);
        op->failures=(unsigned)sope__json_number(sope__json_get(p,"failures"),0);
        op->last=(uint64_t)sope__json_number(sope__json_get(p,"last"),0);
    }
    for(const sope_json *p=receipts?receipts->child:NULL;ok&&p;p=p->next){
        if (p->type != SOPE_JSON_OBJECT) { ok=0; break; }
        sope_buf b={0};ok=sope__json_canonical(&b,p,0)&&!b.oom&&b.len<=70000;
        if(ok)h->receipts[h->count++]=b.ptr;else sope__buf_free(&b);
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
    } else sope__buf_appends(out,"{\"retention\":32,\"scope\":\"historical execution facts; no claim of current source validity\",\"receipts\":[");
    unsigned count=h?h->count:0;
    unsigned start=summary && count>8 ? count-8:0;
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
    pthread_mutex_lock(r->agent->mu);sope__harness_evidence(r->agent,&r->out,0);pthread_mutex_unlock(r->agent->mu);
    return sope__run_done(r);
}
const sope_builtin sope__builtin_evidence={"evidence","Returns the last 32 native execution receipts, preserved across compaction and durable reopen. These are historical execution facts, not model assertions or proof of coverage/current source correctness.","{\"type\":\"object\",\"properties\":{}}",0,evidence,NULL};
