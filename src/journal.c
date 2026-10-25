/* SPDX-License-Identifier: MIT */
#if defined(__APPLE__)
#  define _DARWIN_C_SOURCE
#else
#  define _GNU_SOURCE
#endif
#include "agent.h"

#include <errno.h>
#include <fcntl.h>
#include <inttypes.h>
#include "sope_sqlite.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/file.h>
#include <sys/stat.h>
#include <unistd.h>

/* The database owns execution facts; model history is a replaceable projection.
 * All access is serialized by root->mu. The lifetime flock also excludes a
 * second process/agent: SQLite transaction locks alone do not establish an owner.
 * Audit payloads contain new facts, not a copy of the growing history per step. */
struct sope_journal { sqlite3 *db; int lock; };

int sope__storage_fail_locked(sope_agent_t *a, const char *msg)
{
    sope_agent_t *root = a->root;
    if (!root->journal_failed) {
        root->journal_failed = 1;
        root->cancel_requested = 1;
        sope__push_event_locked(root, SOPE_EVENT_ERROR, root->active_turn, 0, SOPE_ERROR,
                               NULL, 0, msg, strlen(msg));
        pthread_cond_broadcast(&root->poll_cv);
        sope__task_wake(&root->task);
    }
    return 0;
}

static int fail(sope_agent_t *a)
{
    return sope__storage_fail_locked(a, "Execution journal commit failed; execution stopped. Reopen the session to recover.");
}

static int sql(sqlite3 *db, const char *fmt, ...)
{
    va_list args;
    va_start(args, fmt);
    char *query = sqlite3_vmprintf(fmt, args);
    va_end(args);
    int ok = query && sqlite3_exec(db, query, NULL, NULL, NULL) == SQLITE_OK;
    sqlite3_free(query);
    return ok;
}

static int audit(sope_agent_t *a, const char *kind, uint64_t turn, uint64_t call, const char *body)
{
    return sql(a->root->journal->db,
        "INSERT INTO events(kind,agent,turn,call,payload) VALUES(%Q,%lld,%lld,%lld,%Q)",
        kind, (long long)a->agent_id, (long long)turn, (long long)call, body ? body : "");
}

static char *one_message(const sope_message *m)
{
    if (!m) return sope__strdup("[]");
    sope_message copy = *m;
    copy.next = NULL;
    sope_history h = { .head = &copy, .tail = &copy, .count = 1 };
    size_t len;
    return sope__history_json(&h, &len);
}

int sope__journal_input(sope_agent_t *a, const msg_node *m)
{
    if (!a->root->journal) return 1;
    if (a->root->journal_failed) return 0;
    sope_message user = { .role = SOPE__MSG_USER, .content = m->text, .content_len = m->len,
                          .images = m->images, .n_images = m->n_images };
    char *body = one_message(&user);
    sqlite3 *db = a->root->journal->db;
    int ok = body && sql(db, "BEGIN IMMEDIATE") && audit(a, "input", m->turn_id, 0, body);
    if (ok && !a->parent) ok = sql(db, "INSERT INTO inbox(id,compact,payload,status,request_key) VALUES(%lld,%d,%Q,0,%Q)",
                                  (long long)m->turn_id, m->compact, body, m->request_key);
    if (ok) ok = sql(db, "COMMIT");
    if (!ok) sql(db, "ROLLBACK");
    free(body);
    return ok || fail(a);
}

/* Part of the same transaction as results/checkpoints. Never a second ledger. */
static int save_harness(sope_agent_t *a)
{
    char *body = sope__harness_json(a);
    int ok = body && sql(a->root->journal->db,
        "INSERT OR REPLACE INTO harness(agent,payload) VALUES(%lld,%Q)", (long long)a->agent_id, body);
    free(body); return ok;
}

int sope__journal_harness(sope_agent_t *a)
{
    if (a->root->journal_failed) return 0;
    return !a->root->journal || save_harness(a) || fail(a);
}

static int stream_event(sope_agent_t *a, const ev_node *e);

int sope__journal_checkpoint(sope_agent_t *a, const char *kind, int terminal)
{
    if (!a->root->journal) return 1;
    if (a->root->journal_failed) return 0;
    sqlite3 *db = a->root->journal->db;
    size_t len;
    char *history = sope__history_json(&a->history, &len);
    char *fact = !strcmp(kind, "model") || !strcmp(kind, "end") ? one_message(a->history.tail) : NULL;
    const char *body = !strcmp(kind, "compact") || !strcmp(kind, "import") ? history : fact;
    uint64_t id = a->turn.active ? sope__turn_id(a) : 0;
    uint64_t sequence = a->root->event_sequence;
    int ok = history && (strcmp(kind, "model") || fact) && sql(db, "BEGIN IMMEDIATE") &&
             audit(a, kind, id, 0, body);
    if (ok && !strcmp(kind, "model")) {
        const sope_message *m = a->history.tail;
        if (m) for (size_t i = 0; ok && i < m->n_tool_uses; i++)
            ok = audit(a, "intent", id, m->tool_uses[i].call_id, m->tool_uses[i].input);
    }
    if (ok && !strcmp(kind, "compact")) {
        const sope_call *c = a->turn.call;
        int manual = a->turn.msg && a->turn.msg->compact;
        ev_node compact = { .type = SOPE_EVENT_COMPACT, .turn_id = id, .agent_id = a->agent_id,
            .name = manual ? "manual" : "auto", .name_len = manual ? 6 : 4,
            .data = c ? c->text.ptr : NULL, .data_len = c ? c->text.len : 0 };
        ok = c && stream_event(a, &compact);
    }
    /* Cancellation completions precede TURN_END in both replay and live order. */
    if (ok && terminal) for (pending_call *p = a->root->pending; ok && p; p = p->next) {
        if (p->owner != a || p->done || p->reported || p->kind == PENDING_SUBAGENT) continue;
        ev_node end = { .type = SOPE_EVENT_TOOL_END, .agent_id = a->agent_id,
            .turn_id = p->turn_id, .call_id = p->call_id, .code = 1,
            .name = p->name, .name_len = strlen(p->name), .data = "Cancelled.", .data_len = 10 };
        ok = stream_event(a, &end);
    }
    if (ok && !a->parent) {
        ok = sql(db, "UPDATE state SET history=%Q,active=%lld,round=%lld,next_call=%lld,tokens=%lld,estimate=%lld WHERE id=1",
                 history, (long long)(terminal ? 0 : id), (long long)a->turn.round,
                 (long long)a->next_call_id, (long long)a->context_tokens, (long long)a->context_estimate);
        if (ok && id) ok = sql(db, "UPDATE inbox SET status=%d WHERE id=%lld", terminal ? 2 : 1, (long long)id);
        if (ok && terminal && id) ok = sope__journal_terminal(a, a->last_stop);
    }
    if (ok && terminal && a->parent) {
        ev_node end = { .type = SOPE_EVENT_TURN_END, .agent_id = a->agent_id,
            .turn_id = id, .code = a->last_stop };
        ok = stream_event(a, &end);
    }
    if (ok) ok = save_harness(a);
    if (ok) ok = sql(db, "COMMIT");
    if (!ok) { sql(db, "ROLLBACK"); a->root->event_sequence = sequence; }
    free(fact);
    free(history);
    return ok || fail(a);
}

static const sope_tool_use *find_use(sope_agent_t *a, uint64_t id)
{
    const sope_message *m = sope__history_last(&a->history, SOPE__MSG_ASSISTANT);
    if (m) for (size_t i = 0; i < m->n_tool_uses; i++)
        if (m->tool_uses[i].call_id == id) return &m->tool_uses[i];
    return NULL;
}

/* A receipt and its public completion are one durable fact. Publish while the
 * root lock is still held so live sequence order matches the committed stream. */
static int commit_result(sope_agent_t *a, pending_call *p, uint32_t type, int32_t code)
{
    if (a->root->journal_failed) return 0;
    if (!p->is_error && p->kind == PENDING_BUILTIN && !strcmp(p->name, "report") &&
        !sope__report_current(a, p->content, p->len)) {
        char *error = sope__strdup("Evidence changed during report submission. Resubmit report against current observations.");
        if (!error) return fail(a);
        free(p->content); p->content = error; p->len = strlen(error); p->is_error = 1;
    }
    sope__harness_observe(a, p);
    if (type == SOPE_EVENT_TOOL_END) code = p->is_error;
    if (a->root->journal_failed) return 0;
    ev_node event = { .type = type, .agent_id = a->agent_id, .turn_id = p->turn_id,
        .call_id = p->call_id, .code = code, .data = p->content, .data_len = p->len,
        .name = type == SOPE_EVENT_TOOL_END ? p->name : NULL,
        .name_len = type == SOPE_EVENT_TOOL_END ? strlen(p->name) : 0 };
    if (a->root->journal) {
        if (a->root->journal_failed) return 0;
        const sope_tool_use *u = find_use(a, p->call_id);
        if (!u) return fail(a);
        sope_message msg = { .role = SOPE__MSG_TOOL, .content = p->content, .content_len = p->len,
            .tool_use_id = u->id, .tool_name = p->name, .is_error = p->is_error,
            .images = p->images, .n_images = p->n_images };
        char *body = one_message(&msg);
        sqlite3 *db = a->root->journal->db;
        uint64_t sequence = a->root->event_sequence;
        int ok = body && sql(db, "BEGIN IMMEDIATE");
        if(ok && p->recovery_terminal){
            ev_node ended={.type=SOPE_EVENT_TURN_END,.agent_id=p->call_id,.turn_id=1,.code=code};
            ok=audit(a,"child_interrupted",p->turn_id,p->call_id,code==SOPE_STOP_CANCELLED?"cancelled":"interrupted") && stream_event(a,&ended);
        }
        if(ok)ok=audit(a, "result", p->turn_id, p->call_id, body) &&
            sql(db, "INSERT INTO results(call,payload) VALUES(%lld,%Q)", (long long)p->call_id, body) &&
            stream_event(a, &event);
        if (ok && p->observation) ok = sql(db, "INSERT INTO observations VALUES(%lld,%lld,%lld,%Q)", (long long)p->call_id, (long long)a->agent_id, (long long)p->turn_id, p->observation);
        if (ok) ok = save_harness(a);
        if (ok) ok = sql(db, "COMMIT");
        if (!ok) { sql(db, "ROLLBACK"); a->root->event_sequence = sequence; }
        free(body);
        if (!ok) return fail(a);
    }
    if(p->recovery_terminal){
        sope_agent_t actor={.root=a->root,.agent_id=p->call_id};
        sope__push_event_locked(&actor,SOPE_EVENT_TURN_END,1,0,code,NULL,0,NULL,0);
    }
    sope__push_event_locked(a, event.type, event.turn_id, event.call_id, event.code,
                           event.name, event.name_len, event.data, event.data_len);
    p->reported = 1;
    return 1;
}

int sope__journal_result(sope_agent_t *a, pending_call *p)
{
    return commit_result(a, p, SOPE_EVENT_TOOL_END, p->is_error);
}

int sope__journal_subagent_result(sope_agent_t *a, pending_call *p, int32_t stop)
{
    return commit_result(a, p, SOPE_EVENT_SUBAGENT_END, stop);
}

int sope__journal_artifact(sope_agent_t *a, uint64_t call, const char *path)
{
    if (!a->root->journal) return 1;
    if (a->root->journal_failed) return 0;
    return audit(a, "artifact", a->active_turn, call, path) || fail(a);
}

void sope__journal_close(sope_agent_t *a)
{
    if (!a->journal) return;
    sqlite3_close(a->journal->db);
    close(a->journal->lock);
    free(a->journal);
    a->journal = NULL;
}

static int parse_history(sope_history *h, sqlite3_stmt *s, int column)
{
    char err[160];
    const char *text = (const char *)sqlite3_column_text(s, column);
    return text && sope__history_parse_raw(h, text, (size_t)sqlite3_column_bytes(s, column), err, sizeof err) == SOPE_OK;
}

static int answered(const sope_message *asst, const sope_tool_use *u)
{
    for (const sope_message *m = asst->next; m; m = m->next)
        if (m->role == SOPE__MSG_TOOL && !strcmp(m->tool_use_id, u->id)) return 1;
    return 0;
}

static int restore_child_calls(sope_agent_t *a, pending_call *parent);
static int finish_recovered_child(sope_agent_t *a, pending_call *parent);
static int reconcile_child_call(sope_agent_t *a, pending_call *p);

int sope__journal_restore(sope_agent_t *a)
{
    sqlite3 *db = a->journal->db;
    sqlite3_stmt *s = NULL;
    uint64_t active = 0, round = 0;
    int rc, ok = 0;
    if (sqlite3_prepare_v2(db, "SELECT history,active,round,next_call,tokens,estimate FROM state WHERE id=1", -1, &s, NULL) != SQLITE_OK) goto out;
    if (sqlite3_step(s) != SQLITE_ROW || !parse_history(&a->history, s, 0)) goto out;
    active = (uint64_t)sqlite3_column_int64(s, 1);
    round = (uint64_t)sqlite3_column_int64(s, 2);
    a->next_call_id = (uint64_t)sqlite3_column_int64(s, 3);
    a->context_tokens = (uint64_t)sqlite3_column_int64(s, 4);
    a->context_estimate = (uint64_t)sqlite3_column_int64(s, 5);
    sqlite3_finalize(s); s = NULL;
    /* Child calls also consume the root's ID space. Never reuse an exposed ID. */
    if (sqlite3_prepare_v2(db, "SELECT COALESCE(MAX(call),0) FROM events", -1, &s, NULL) != SQLITE_OK) goto out;
    if (sqlite3_step(s) != SQLITE_ROW) goto out;
    uint64_t last = (uint64_t)sqlite3_column_int64(s, 0);
    if (last > a->next_call_id) a->next_call_id = last;
    sqlite3_finalize(s); s = NULL;
    if (sqlite3_prepare_v2(db, "SELECT id,compact,payload,status FROM inbox ORDER BY id", -1, &s, NULL) != SQLITE_OK) goto out;
    while ((rc = sqlite3_step(s)) == SQLITE_ROW) {
        uint64_t id = (uint64_t)sqlite3_column_int64(s, 0);
        a->next_turn_id = id;
        if (sqlite3_column_int(s, 3) == 2) continue;
        sope_history input = {0};
        if (!parse_history(&input, s, 2) || input.count != 1) { sope__history_clear(&input); goto out; }
        msg_node *m = calloc(1, sizeof *m);
        if (!m) { sope__history_clear(&input); goto out; }
        m->turn_id = id;
        m->compact = sqlite3_column_int(s, 1);
        m->text = input.head->content; input.head->content = NULL;
        m->len = input.head->content_len;
        m->images = input.head->images; input.head->images = NULL;
        m->n_images = input.head->n_images; input.head->n_images = 0;
        m->resume = id == active;
        m->resume_round = m->resume ? round : 0;
        sope__history_clear(&input);
        if (a->in_tail) a->in_tail->next = m; else a->in_head = m;
        a->in_tail = m;
    }
    if (rc != SQLITE_DONE) goto out;
    sqlite3_finalize(s); s = NULL;
    const sope_message *asst = sope__history_last(&a->history, SOPE__MSG_ASSISTANT);
    if (active && asst) for (size_t i = 0; i < asst->n_tool_uses; i++) {
        const sope_tool_use *u = &asst->tool_uses[i];
        if (answered(asst, u)) continue;
        pending_call *p = calloc(1, sizeof *p);
        if (!p || !(p->name = sope__strdup(u->name))) { free(p); goto out; }
        p->harness_key = sope__harness_identity(u);
        p->owner = a; p->kind = !strcmp(u->name,SOPE__AGENT_TOOL)?PENDING_SUBAGENT:PENDING_TOOL; p->call_id = u->call_id; p->turn_id = active;
        p->next = a->pending; a->pending = p;
        if (sqlite3_prepare_v2(db, "SELECT payload FROM results WHERE call=?", -1, &s, NULL) != SQLITE_OK) goto out;
        sqlite3_bind_int64(s, 1, (sqlite3_int64)u->call_id);
        rc = sqlite3_step(s);
        if (rc == SQLITE_ROW) {
            sope_history result = {0};
            if (!parse_history(&result, s, 0) || result.count != 1) { sope__history_clear(&result); goto out; }
            p->content = result.head->content; result.head->content = NULL;
            p->len = result.head->content_len; p->is_error = result.head->is_error;
            p->images = result.head->images; result.head->images = NULL;
            p->n_images = result.head->n_images; result.head->n_images = 0;
            p->done = 1;
            sope__history_clear(&result);
        } else if (rc != SQLITE_DONE) goto out;
        sqlite3_finalize(s); s = NULL;
    }
    for (pending_call *p=a->pending; p; p=p->next)
        if (p->kind==PENDING_SUBAGENT && !p->done && !restore_child_calls(a,p)) goto out;
    if (sqlite3_prepare_v2(db, "SELECT payload FROM harness WHERE agent=0", -1, &s, NULL) != SQLITE_OK) goto out;
    rc = sqlite3_step(s);
    if (rc == SQLITE_ROW && !sope__harness_load(a, (const char *)sqlite3_column_text(s, 0))) goto out;
    if (rc != SQLITE_ROW && rc != SQLITE_DONE) goto out;
    a->recovering = a->in_head != NULL;
    ok = 1;
out:
    sqlite3_finalize(s);
    return ok;
}

int sope_agent_open(sope_agent_t **out, const char *directory)
{
    if (!out || !directory || !*directory) return sope__set_error(SOPE_EINVAL, "session directory is required");
    *out = NULL;
    if (mkdir(directory, 0700) != 0 && errno != EEXIST) return sope__set_error(SOPE_ERROR, "cannot create session directory: %s", strerror(errno));
    char *dir = realpath(directory, NULL);
    if (!dir) return sope__set_error(SOPE_ERROR, "cannot resolve session directory");
    sope_agent_t *a = NULL;
    int rc = sope_agent_new(&a);
    if (rc != SOPE_OK) { free(dir); return rc; }
    struct sope_journal *j = calloc(1, sizeof *j);
    sope_buf path = {0};
    if (!j) { free(dir); sope_agent_free(a); return SOPE_ENOMEM; }
    j->lock = -1; a->journal = j;
    sope__buf_appendf(&path, "%s/owner.lock", dir);
    j->lock = path.oom ? -1 : open(path.ptr, O_CREAT | O_RDWR | O_CLOEXEC, 0600);
    if (j->lock < 0 || flock(j->lock, LOCK_EX | LOCK_NB) != 0) { rc = SOPE_EBUSY; goto bad; }
    sope__buf_free(&path);
    sope__buf_appendf(&path, "%s/artifacts", dir);
    if (path.oom || (mkdir(path.ptr, 0700) != 0 && errno != EEXIST)) goto bad;
    a->artifact_dir = sope__strdup(path.ptr);
    if (!a->artifact_dir) goto bad;
    sope__buf_free(&path);
    sope__buf_appendf(&path, "%s/execution.sqlite", dir);
    if (path.oom || sqlite3_open_v2(path.ptr, &j->db, SQLITE_OPEN_READWRITE | SQLITE_OPEN_CREATE, NULL) != SQLITE_OK) goto bad;
    chmod(path.ptr, 0600);
    sqlite3_stmt *version = NULL;
    if (sqlite3_prepare_v2(j->db, "PRAGMA user_version", -1, &version, NULL) != SQLITE_OK) goto bad;
    int schema = sqlite3_step(version) == SQLITE_ROW ? sqlite3_column_int(version, 0) : -1;
    sqlite3_finalize(version);
    if (schema != 0 && schema != 2) goto bad;
    if (!sql(j->db, "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;"
        "CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1),history TEXT NOT NULL,active INTEGER NOT NULL,round INTEGER NOT NULL,next_call INTEGER NOT NULL,tokens INTEGER NOT NULL,estimate INTEGER NOT NULL);"
        "INSERT OR IGNORE INTO state VALUES(1,'[]',0,0,0,0,0);"
        "CREATE TABLE IF NOT EXISTS inbox(id INTEGER PRIMARY KEY,compact INTEGER NOT NULL,payload TEXT NOT NULL,status INTEGER NOT NULL,request_key TEXT UNIQUE);"
        "CREATE TABLE IF NOT EXISTS results(call INTEGER PRIMARY KEY,payload TEXT NOT NULL);"
        "CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY,kind TEXT NOT NULL,agent INTEGER NOT NULL,turn INTEGER NOT NULL,call INTEGER NOT NULL,payload TEXT NOT NULL);"
        "CREATE TABLE IF NOT EXISTS runtime(id INTEGER PRIMARY KEY CHECK(id=1),session_id TEXT NOT NULL,manifest TEXT);"
        "CREATE TABLE IF NOT EXISTS stream(seq INTEGER PRIMARY KEY AUTOINCREMENT,type INTEGER NOT NULL,agent INTEGER NOT NULL,turn INTEGER NOT NULL,call INTEGER NOT NULL,code INTEGER NOT NULL,name TEXT NOT NULL,data TEXT NOT NULL);"
        "CREATE TABLE IF NOT EXISTS outcomes(turn INTEGER PRIMARY KEY,payload TEXT NOT NULL);"
        "CREATE TABLE IF NOT EXISTS harness(agent INTEGER PRIMARY KEY,payload TEXT NOT NULL);"
        "CREATE TABLE IF NOT EXISTS observations(call INTEGER PRIMARY KEY,agent INTEGER NOT NULL,turn INTEGER NOT NULL,payload TEXT NOT NULL);"
        "CREATE INDEX IF NOT EXISTS stream_origin ON stream(agent,turn,type,seq);"
        "CREATE INDEX IF NOT EXISTS stream_call ON stream(call,type);"
        "CREATE INDEX IF NOT EXISTS child_lifecycle ON events(call,kind) WHERE kind='child_cancel' OR kind='child_interrupted';"
        "CREATE INDEX IF NOT EXISTS result_origin ON events(agent,call) WHERE kind='result';"
        "CREATE INDEX IF NOT EXISTS reconciliation_origin ON events(agent,call) WHERE kind='reconcile';"
        "PRAGMA user_version=2;")) goto bad;
    if (!sql(j->db, "INSERT OR IGNORE INTO runtime VALUES(1,%Q,NULL)", a->session_id)) goto bad;
    sqlite3_stmt *identity = NULL;
    if (sqlite3_prepare_v2(j->db, "SELECT session_id,manifest IS NOT NULL,(SELECT COALESCE(MAX(seq),0) FROM stream) FROM runtime WHERE id=1", -1, &identity, NULL) != SQLITE_OK) goto bad;
    if (sqlite3_step(identity) != SQLITE_ROW) { sqlite3_finalize(identity); goto bad; }
    free(a->session_id);
    a->session_id = sope__strdup((const char *)sqlite3_column_text(identity, 0));
    a->contract_required = sqlite3_column_int(identity, 1);
    a->event_sequence = (uint64_t)sqlite3_column_int64(identity, 2);
    sqlite3_finalize(identity);
    if (!a->session_id || !sope__journal_restore(a)) goto bad;
    sope__buf_free(&path); free(dir); *out = a;
    return SOPE_OK;
bad:
    /* Never run/terminate recovered work while unwinding a failed open. */
    a->recovering = 1;
    sope__journal_close(a);
    sope_agent_free(a);
    sope__buf_free(&path); free(dir);
    return sope__set_error(rc == SOPE_EBUSY ? rc : SOPE_ERROR, "cannot open durable session (locked, invalid, or storage failure)");
}

int sope_agent_recovery(sope_agent_t *a, const char **json, size_t *len)
{
    if (!a || !json) return sope__set_error(SOPE_EINVAL, "agent and JSON output are required");
    sope_buf b = {0};
    pthread_mutex_lock(a->mu);
    sope__buf_appendf(&b, "{\"pending\":%s,\"calls\":[", a->recovering ? "true" : "false");
    int count = 0;
    if (a->recovering) for (pending_call *p = a->pending; p; p = p->next) {
        if (p->done || p->kind==PENDING_SUBAGENT) continue;
        const sope_tool_use *u = find_use(a, p->call_id);
        sope__buf_appendf(&b, "%s{\"call_id\":\"%" PRIu64 "\",\"name\":", count++ ? "," : "", p->call_id);
        sope__buf_append_json_string(&b, p->name, strlen(p->name));
        sope__buf_appendf(&b, ",\"agent_id\":\"%" PRIu64 "\",\"input\":",p->recovery_agent);
        const char *input=p->recovery_input?p->recovery_input:u?u->input:"{}";
        size_t input_len=p->recovery_input?p->recovery_input_len:u?u->input_len:2;
        sope__buf_append_json_string(&b,input,input_len);
        sope__buf_appends(&b, ",\"artifacts\":[");
        sqlite3_stmt *artifacts = NULL;
        int prepared = sqlite3_prepare_v2(a->journal->db,
            "SELECT payload FROM events WHERE kind='artifact' AND (call=? OR agent=?) ORDER BY seq",
            -1, &artifacts, NULL);
        int entries = 0, rc = SQLITE_ERROR;
        if (prepared == SQLITE_OK) {
            sqlite3_bind_int64(artifacts, 1, (sqlite3_int64)p->call_id);
            sqlite3_bind_int64(artifacts, 2, (sqlite3_int64)p->call_id);
            while ((rc = sqlite3_step(artifacts)) == SQLITE_ROW) {
                if (entries++) sope__buf_appends(&b, ",");
                sope__buf_append_json_string(&b, (const char *)sqlite3_column_text(artifacts, 0),
                                             (size_t)sqlite3_column_bytes(artifacts, 0));
            }
        }
        sqlite3_finalize(artifacts);
        if (rc != SQLITE_DONE) {
            pthread_mutex_unlock(a->mu);
            sope__buf_free(&b);
            return sope__set_error(SOPE_ERROR, "cannot read recovery artifact references");
        }
        sope__buf_appends(&b, "]}");
    }
    sope__buf_appends(&b, "],\"delegations\":[");
    count=0;
    if(a->recovering)for(pending_call *p=a->pending;p;p=p->next)if(p->kind==PENDING_SUBAGENT&&!p->done){
        unsigned unknown=0;for(pending_call *q=a->pending;q;q=q->next)if(q->recovery_agent==p->call_id&&!q->done)unknown++;
        sope__buf_appendf(&b,"%s{\"agent_id\":\"%" PRIu64 "\",\"unknown_calls\":%u,\"action\":\"reconstruct_from_journal\"}",count++?",":"",p->call_id,unknown);
    }
    sope__buf_appends(&b, "]}");
    if (!b.oom) { free(a->history_json); a->history_json = b.ptr; *json = b.ptr; if (len) *len = b.len; }
    pthread_mutex_unlock(a->mu);
    if (b.oom) { sope__buf_free(&b); return SOPE_ENOMEM; }
    return SOPE_OK;
}

int sope_agent_resolve(sope_agent_t *a, uint64_t call, int error, const char *content, size_t len)
{
    if (!a || (!content && len)) return sope__set_error(SOPE_EINVAL, "invalid reconciliation arguments");
    pthread_mutex_lock(a->mu);
    if (a->closing || a->journal_failed || !sope__contract_ready_locked(a)) {
        pthread_mutex_unlock(a->mu); return sope__set_error(SOPE_EBUSY, "cannot reconcile closed, failed or unsealed session");
    }
    pending_call *p = sope__pending_find_locked(a, call, PENDING_TOOL);
    if (!a->recovering || !p || p->done) { pthread_mutex_unlock(a->mu); return sope__set_error(SOPE_ENOTFOUND, "no unresolved interrupted call with this ID"); }
    pthread_mutex_unlock(a->mu);
    sope_buf output = {0}; sope__buf_append(&output, content ? content : "", len);
    if (!sope__artifact_preview(a, call, &output, 512 * 1024)) {
        sope__buf_free(&output); return sope__set_error(SOPE_ERROR, "cannot archive reconciled tool output");
    }
    pthread_mutex_lock(a->mu);
    p = sope__pending_find_locked(a, call, PENDING_TOOL);
    if (!a->recovering || !p || p->done || a->closing || a->journal_failed) {
        pthread_mutex_unlock(a->mu); sope__buf_free(&output);
        return sope__set_error(SOPE_ENOTFOUND, "interrupted call was already reconciled");
    }
    p->content = output.ptr; p->len = output.len; p->is_error = error != 0;
    int ok = p->content && (p->recovery_agent ? reconcile_child_call(a,p) : sope__journal_result(a,p));
    if (ok) p->done = 1;
    else { free(p->content); p->content = NULL; p->len = 0; }
    pthread_mutex_unlock(a->mu);
    return ok ? SOPE_OK : sope__set_error(SOPE_ERROR, "reconciled outcome was not committed");
}

int sope_agent_resume(sope_agent_t *a)
{
    if (!a) return sope__set_error(SOPE_EINVAL, "agent is required");
    pthread_mutex_lock(a->mu);
    if ((!a->recovering && !a->suspended) || a->closing || a->journal_failed || !sope__contract_ready_locked(a)) { pthread_mutex_unlock(a->mu); return sope__set_error(SOPE_EBUSY, "session is not awaiting resume, is closed, or has a storage failure"); }
    for (pending_call *p = a->pending; p; p = p->next) if (!p->done && p->kind!=PENDING_SUBAGENT) {
        pthread_mutex_unlock(a->mu);
        return sope__set_error(SOPE_EBUSY, "interrupted tools have unknown outcomes; reconcile each call before resuming");
    }
    for(pending_call *p=a->pending;p;p=p->next)if(p->kind==PENDING_SUBAGENT&&!p->done){
        if(!finish_recovered_child(a,p)){pthread_mutex_unlock(a->mu);return sope__set_error(SOPE_ERROR,"Cannot reconstruct delegated outcome");}
    }
    const sope_message *asst = sope__history_last(&a->history, SOPE__MSG_ASSISTANT);
    if (asst) for (size_t i = 0; i < asst->n_tool_uses; i++) {
        const sope_tool_use *u = &asst->tool_uses[i];
        pending_call *p = sope__pending_find_locked(a, u->call_id, PENDING_TOOL);
        if (!p) p=sope__pending_find_locked(a,u->call_id,PENDING_SUBAGENT);
        if (!p || answered(asst, u)) continue;
        sope_message *m = sope__tool_message(u, p->content, p->len, p->is_error);
        if (!m) { pthread_mutex_unlock(a->mu); return SOPE_ENOMEM; }
        m->images = p->images; m->n_images = p->n_images; p->images = NULL; p->n_images = 0;
        sope__history_append(&a->history, m);
    }
    while (a->pending) { pending_call *p = a->pending; a->pending = p->next; sope__pending_free(p); }
    a->recovering = a->suspended = 0;
    sope__task_wake(&a->task);
    pthread_mutex_unlock(a->mu);
    return SOPE_OK;
}

/* The host consumes a separate public stream; internal audit facts remain an
 * implementation detail. A terminal stream event and outcome share the same
 * transaction as the final checkpoint. */
static int stream_event(sope_agent_t *a, const ev_node *e)
{
    if (!a->root->journal) return 1;
    sqlite3 *db = a->root->journal->db;
    sqlite3_stmt *stmt = NULL;
    int ok = sqlite3_prepare_v2(db, "INSERT INTO stream(type,agent,turn,call,code,name,data) VALUES(?,?,?,?,?,?,?)", -1, &stmt, NULL) == SQLITE_OK;
    if (ok) {
        sqlite3_bind_int(stmt, 1, (int)e->type);
        sqlite3_bind_int64(stmt, 2, (sqlite3_int64)e->agent_id);
        sqlite3_bind_int64(stmt, 3, (sqlite3_int64)e->turn_id);
        sqlite3_bind_int64(stmt, 4, (sqlite3_int64)e->call_id);
        sqlite3_bind_int(stmt, 5, e->code);
        ok = sqlite3_bind_text64(stmt, 6, e->name ? e->name : "", e->name_len, SQLITE_STATIC, SQLITE_UTF8) == SQLITE_OK &&
             sqlite3_bind_text64(stmt, 7, e->data ? e->data : "", e->data_len, SQLITE_STATIC, SQLITE_UTF8) == SQLITE_OK &&
             sqlite3_step(stmt) == SQLITE_DONE;
    }
    if (ok) a->root->event_sequence = (uint64_t)sqlite3_last_insert_rowid(db);
    sqlite3_finalize(stmt);
    return ok;
}
int sope__journal_event(sope_agent_t *a, ev_node *e)
{
    if (!a->root->journal || a->root->journal_failed) return 1;
    int completion = e->type == SOPE_EVENT_TOOL_END || e->type == SOPE_EVENT_SUBAGENT_END;
    if (e->type == SOPE_EVENT_TURN_END || e->type == SOPE_EVENT_COMPACT || completion) {
        sqlite3_stmt *s = NULL;
        if (sqlite3_prepare_v2(a->root->journal->db, "SELECT seq FROM stream WHERE type=? AND turn=? AND agent=? AND call=? ORDER BY seq DESC LIMIT 1", -1, &s, NULL) != SQLITE_OK) return fail(a);
        sqlite3_bind_int(s, 1, (int)e->type); sqlite3_bind_int64(s, 2, (sqlite3_int64)e->turn_id);
        sqlite3_bind_int64(s, 3, (sqlite3_int64)e->agent_id);
        sqlite3_bind_int64(s, 4, (sqlite3_int64)e->call_id);
        int step = sqlite3_step(s);
        if (step == SQLITE_ROW) e->sequence = (uint64_t)sqlite3_column_int64(s, 0);
        sqlite3_finalize(s);
        if (step == SQLITE_ROW) return 1;
        if (step != SQLITE_DONE || !completion) return fail(a);
    }
    return stream_event(a, e) || fail(a);
}
int sope__journal_terminal(sope_agent_t *a, int stop)
{
    const sope_message *last = stop == SOPE_STOP_END_TURN && !a->turn.msg->compact ? a->history.tail : NULL;
    if (last && (last->role != SOPE__MSG_ASSISTANT || last->n_tool_uses)) last = NULL;
    sope_buf b = {0};
    uint64_t id = sope__turn_id(a);
    sope__buf_appendf(&b, "{\"turn_id\":\"%" PRIu64 "\",\"stop\":%d,\"final\":", id, stop);
    sope__buf_append_json_string(&b, last && last->content ? last->content : "", last ? last->content_len : 0);
    sope__buf_appends(&b, ",\"acceptance\":");
    const char *report=sope__harness_report(a);
    sope__buf_appends(&b, stop==SOPE_STOP_END_TURN && !a->turn.msg->compact && report ? report : "null");
    sope__buf_appends(&b, "}");
    ev_node event = { .type = SOPE_EVENT_TURN_END, .turn_id = id, .code = stop };
    int ok = !b.oom && sql(a->journal->db, "INSERT INTO outcomes VALUES(%lld,%Q)", (long long)id, b.ptr) && stream_event(a, &event);
    sope__buf_free(&b);
    return ok;
}
int sope__journal_duplicate(sope_agent_t *a, const msg_node *m, uint64_t *id)
{
    if (!m->request_key) return 0;
    if (!a->journal) return sope__set_error(SOPE_EINVAL, "idempotent submit requires a durable session");
    sope_message user = { .role = SOPE__MSG_USER, .content = m->text, .content_len = m->len,
                          .images = a->attached, .n_images = a->n_attached };
    char *body = one_message(&user);
    sqlite3_stmt *s = NULL;
    int rc = SOPE_ERROR;
    if (!body || sqlite3_prepare_v2(a->journal->db, "SELECT id,payload FROM inbox WHERE request_key=?", -1, &s, NULL) != SQLITE_OK) goto out;
    sqlite3_bind_text(s, 1, m->request_key, -1, SQLITE_STATIC);
    int step = sqlite3_step(s);
    if (step == SQLITE_DONE) rc = 0;
    else if (step == SQLITE_ROW) {
        rc = strcmp(body, (const char *)sqlite3_column_text(s, 1)) ? SOPE_ECONFLICT : 1;
        if (rc == 1 && id) *id = (uint64_t)sqlite3_column_int64(s, 0);
    }
out:
    sqlite3_finalize(s); free(body);
    if (rc < 0) sope__set_error(rc, "request key conflicts or journal lookup failed");
    return rc;
}
int sope__journal_seal(sope_agent_t *a, const char *manifest)
{
    if (!a->journal) return SOPE_OK;
    sqlite3_stmt *s = NULL;
    int rc = SOPE_ERROR;
    if (sqlite3_prepare_v2(a->journal->db, "SELECT manifest FROM runtime WHERE id=1", -1, &s, NULL) != SQLITE_OK) goto out;
    if (sqlite3_step(s) != SQLITE_ROW) goto out;
    const char *old = (const char *)sqlite3_column_text(s, 0);
    if (old && strcmp(old, manifest)) { rc = SOPE_ECONFLICT; goto out; }
    sqlite3_finalize(s); s = NULL;
    if (!sql(a->journal->db, "UPDATE runtime SET manifest=%Q WHERE id=1", manifest)) goto out;
    a->contract_required = 1;
    rc = SOPE_OK;
out:
    sqlite3_finalize(s);
    if (rc) sope__set_error(rc, "execution configuration differs from the session contract, or storage failed");
    return rc;
}
static int return_json(sope_agent_t *a, sope_buf *b, const char **json, size_t *len)
{
    if (b->oom || !b->ptr) { sope__buf_free(b); return SOPE_ENOMEM; }
    free(a->history_json); a->history_json = b->ptr; *json = b->ptr;
    if (len) *len = b->len;
    return SOPE_OK;
}
int sope_agent_status(sope_agent_t *a, const char **json, size_t *len)
{
    if (!a || !json) return SOPE_EINVAL;
    pthread_mutex_lock(a->mu);
    const char *state = a->closed ? "closed" : a->journal_failed ? "storage_failed" : a->closing ? "closing" :
        a->suspending ? "suspending" : a->recovering ? "recovering" : a->suspended ? "suspended" :
        a->active_turn ? "running" : a->in_head ? "queued" : "idle";
    sope_buf b = {0};
    sope__buf_appendf(&b, "{\"session_id\":\"%s\",\"instance_id\":\"%s\",\"state\":\"%s\",\"active_turn\":\"%" PRIu64 "\",\"last_sequence\":\"%" PRIu64 "\",\"sealed\":%s}",
        a->session_id, a->instance_id, state, a->active_turn, a->event_sequence, a->sealed ? "true" : "false");
    int rc = return_json(a, &b, json, len);
    pthread_mutex_unlock(a->mu);
    return rc;
}
int sope_agent_events(sope_agent_t *a, uint64_t after, uint32_t limit, const char **json, size_t *len)
{
    if (!a || !a->journal || !json || !limit || limit > 256 || after > INT64_MAX) return SOPE_EINVAL;
    pthread_mutex_lock(a->mu);
    sope_buf b = {0}; sqlite3_stmt *s = NULL; int rc = SOPE_ERROR;
    if (sqlite3_prepare_v2(a->journal->db, "SELECT seq,type,agent,turn,call,code,name,data FROM stream WHERE seq>? ORDER BY seq LIMIT ?", -1, &s, NULL) != SQLITE_OK) goto out;
    sqlite3_bind_int64(s, 1, (sqlite3_int64)after); sqlite3_bind_int(s, 2, (int)limit);
    sope__buf_appends(&b, "["); int step, n = 0;
    while ((step = sqlite3_step(s)) == SQLITE_ROW) {
        sope__buf_appendf(&b, "%s{\"sequence\":\"%lld\",\"type\":%d,\"agent_id\":\"%lld\",\"turn_id\":\"%lld\",\"call_id\":\"%lld\",\"code\":%d,\"name\":", n++ ? "," : "", sqlite3_column_int64(s,0), sqlite3_column_int(s,1), sqlite3_column_int64(s,2), sqlite3_column_int64(s,3), sqlite3_column_int64(s,4), sqlite3_column_int(s,5));
        sope__buf_append_json_string(&b, (const char *)sqlite3_column_text(s,6), (size_t)sqlite3_column_bytes(s,6));
        sope__buf_appends(&b, ",\"data\":");
        sope__buf_append_json_string(&b, (const char *)sqlite3_column_text(s,7), (size_t)sqlite3_column_bytes(s,7));
        sope__buf_appends(&b, "}");
    }
    sope__buf_appends(&b, "]");
    if (step == SQLITE_DONE) { rc = return_json(a, &b, json, len); b.ptr = NULL; }
out:
    sqlite3_finalize(s); sope__buf_free(&b); pthread_mutex_unlock(a->mu);
    return rc;
}
int sope_agent_outcome(sope_agent_t *a, uint64_t id, const char **json, size_t *len)
{
    if (!a || !a->journal || !json || id > INT64_MAX) return SOPE_EINVAL;
    pthread_mutex_lock(a->mu);
    sqlite3_stmt *s = NULL; int rc = SOPE_ERROR;
    if (sqlite3_prepare_v2(a->journal->db, "SELECT payload FROM outcomes WHERE turn=?", -1, &s, NULL) == SQLITE_OK) {
        sqlite3_bind_int64(s, 1, (sqlite3_int64)id);
        int step = sqlite3_step(s);
        if (step == SQLITE_DONE) rc = SOPE_ENOTFOUND;
        else if (step == SQLITE_ROW) {
            sope_buf b = {0}; sope__buf_appends(&b, (const char *)sqlite3_column_text(s,0));
            rc = return_json(a, &b, json, len);
        }
    }
    sqlite3_finalize(s); pthread_mutex_unlock(a->mu);
    return rc;
}

/* Read a committed result belonging to this agent. This is historical evidence,
 * never a rerun or a claim that the current file contents are unchanged. *mu held. */
int sope__journal_recall(sope_agent_t *a, uint64_t call, size_t offset, size_t limit, sope_buf *out)
{ return sope__journal_recall_agent(a, a->agent_id, call, offset, limit, out); }

int sope__journal_recall_agent(sope_agent_t *a, uint64_t agent, uint64_t call, size_t offset, size_t limit, sope_buf *out)
{
    if (!sope__journal_access(a,agent,0)) return SOPE_ENOTFOUND;
    sqlite3_stmt *s = NULL;
    const char *query = "SELECT r.payload FROM results r WHERE r.call=? AND EXISTS "
        "(SELECT 1 FROM events e WHERE e.kind='result' AND e.call=r.call AND e.agent=?)";
    if (sqlite3_prepare_v2(a->root->journal->db, query, -1, &s, NULL) != SQLITE_OK) return SOPE_ERROR;
    sqlite3_bind_int64(s, 1, (sqlite3_int64)call);
    sqlite3_bind_int64(s, 2, (sqlite3_int64)agent);
    int step = sqlite3_step(s), rc = SOPE_ENOTFOUND;
    if (step == SQLITE_ROW) {
        sope_history h = {0};
        if (!parse_history(&h, s, 0) || h.count != 1) rc = SOPE_ERROR;
        else {
            const sope_message *m = h.head;
            size_t start = offset < m->content_len ? offset : m->content_len;
            while (start < m->content_len && ((unsigned char)m->content[start] & 0xc0) == 0x80) start++;
            size_t end = m->content_len-start > limit ? start+limit : m->content_len;
            while (end > start && end < m->content_len && ((unsigned char)m->content[end] & 0xc0) == 0x80) end--;
            sope__buf_appendf(out,"{\"session_id\":\"%s\",\"agent_id\":%" PRIu64 ",\"call_id\":%" PRIu64 ",\"is_error\":%s,\"offset\":%zu,\"next_offset\":%zu,\"total_bytes\":%zu,\"historical\":true,\"content\":",
                a->root->session_id,agent,call,m->is_error?"true":"false",start,end,m->content_len);
            sope__buf_append_json_string(out,m->content+start,end-start);
            sope__buf_appends(out,"}");rc=out->oom?SOPE_ENOMEM:SOPE_OK;
        }
        sope__history_clear(&h);
    } else if (step != SQLITE_DONE) rc = SOPE_ERROR;
    sqlite3_finalize(s);return rc;
}

/* A parent can inspect its direct delegated work after the child is freed.
 * Native start events establish lineage; model-supplied IDs cannot grant it. */
int sope__journal_access(sope_agent_t *a, uint64_t agent, int current)
{
    if (!a->root->journal) return 0;
    if (agent == a->agent_id) return 1;
    sqlite3_stmt *s=NULL;
    const char *q="SELECT 1 FROM stream WHERE type=? AND agent=? AND call=? AND (?=0 OR turn=?) LIMIT 1";
    if(sqlite3_prepare_v2(a->root->journal->db,q,-1,&s,NULL)!=SQLITE_OK)return 0;
    sqlite3_bind_int(s,1,SOPE_EVENT_SUBAGENT_START);sqlite3_bind_int64(s,2,(sqlite3_int64)a->agent_id);
    sqlite3_bind_int64(s,3,(sqlite3_int64)agent);sqlite3_bind_int(s,4,current);
    sqlite3_bind_int64(s,5,(sqlite3_int64)(current && a->turn.msg ? sope__turn_id(a) : 0));
    int ok=sqlite3_step(s)==SQLITE_ROW;sqlite3_finalize(s);return ok;
}

char *sope__journal_observation(sope_agent_t *a, uint64_t agent, uint64_t call)
{
    if(!sope__journal_access(a,agent,0))return NULL;
    sqlite3_stmt *s=NULL;char *result=NULL;
    if(sqlite3_prepare_v2(a->root->journal->db,"SELECT payload FROM observations WHERE agent=? AND call=? AND (?<>? OR turn=?)",-1,&s,NULL)!=SQLITE_OK)return NULL;
    sqlite3_bind_int64(s,1,(sqlite3_int64)agent);sqlite3_bind_int64(s,2,(sqlite3_int64)call);
    sqlite3_bind_int64(s,3,(sqlite3_int64)agent);sqlite3_bind_int64(s,4,(sqlite3_int64)a->agent_id);
    sqlite3_bind_int64(s,5,(sqlite3_int64)sope__turn_id(a));
    if(sqlite3_step(s)==SQLITE_ROW)result=sope__strdup((const char *)sqlite3_column_text(s,0));
    sqlite3_finalize(s);return result;
}

int sope__journal_observations(sope_agent_t *a, uint64_t agent, sope_buf *out)
{
    if(!sope__journal_access(a,agent,0))return 0;
    sqlite3_stmt *s=NULL;
    if(sqlite3_prepare_v2(a->root->journal->db,"SELECT payload FROM observations WHERE agent=? ORDER BY call DESC LIMIT 32",-1,&s,NULL)!=SQLITE_OK)return 0;
    sqlite3_bind_int64(s,1,(sqlite3_int64)agent);int step,comma=0;
    sope__buf_appendf(out,"{\"session_id\":\"%s\",\"agent_id\":%llu,\"scope\":\"historical native observations\",\"receipts\":[",a->root->session_id,(unsigned long long)agent);
    while((step=sqlite3_step(s))==SQLITE_ROW){
        const char *raw=(const char *)sqlite3_column_text(s,0);sope_json *v=sope__json_parse(raw,strlen(raw));
        if(comma++)sope__buf_appends(out,",");
        sope__json_canonical(out,sope__json_get(v,"receipt"),0);sope__json_free(v);
    }
    sope__buf_appends(out,"]}");sqlite3_finalize(s);return step==SQLITE_DONE&&!out->oom;
}

/* Conservative invalidation for known workspace-mutating tools, including
 * overlapping attempts. Contract check programs are trusted verifier inputs;
 * arbitrary side effects within them are outside this freshness test. */
int sope__journal_stale(sope_agent_t *a, uint64_t call)
{
    if(!a->root->journal)return 1;
    sqlite3_stmt *s=NULL;
    const char *q="SELECT 1 FROM stream WHERE type IN (12,13) AND name IN ('write','edit','bash') AND seq>(SELECT MIN(seq) FROM stream WHERE type=12 AND call=?) LIMIT 1";
    if(sqlite3_prepare_v2(a->root->journal->db,q,-1,&s,NULL)!=SQLITE_OK)return 1;
    sqlite3_bind_int64(s,1,(sqlite3_int64)call);int step=sqlite3_step(s);sqlite3_finalize(s);return step!=SQLITE_DONE;
}

/* Recovery never replays delegated effects. Reconcile unknown leaves, then
 * derive the delegation outcome from native lifecycle facts and receipts. */
typedef struct { int started, ended, stop, cancelled, interrupted; } child_lifecycle;

static int child_status(sope_agent_t *a, uint64_t child, child_lifecycle *state)
{
    sqlite3_stmt *s = NULL;
    const char *q = "SELECT EXISTS(SELECT 1 FROM stream WHERE type=9 AND call=?),"
        "(SELECT code FROM stream WHERE type=4 AND agent=? ORDER BY seq DESC LIMIT 1),"
        "EXISTS(SELECT 1 FROM events WHERE kind='child_cancel' AND call=?),"
        "EXISTS(SELECT 1 FROM events WHERE kind='child_interrupted' AND payload='interrupted' AND call=?)";
    if (sqlite3_prepare_v2(a->root->journal->db,q,-1,&s,NULL)!=SQLITE_OK) return 0;
    for(int i=1;i<=4;i++) sqlite3_bind_int64(s,i,(sqlite3_int64)child);
    int ok=sqlite3_step(s)==SQLITE_ROW;
    if(ok){state->started=sqlite3_column_int(s,0);state->ended=sqlite3_column_type(s,1)!=SQLITE_NULL;
        state->stop=sqlite3_column_int(s,1);state->cancelled=sqlite3_column_int(s,2);state->interrupted=sqlite3_column_int(s,3);}
    sqlite3_finalize(s);return ok;
}

static const char *child_state(const child_lifecycle *s)
{
    if(s->interrupted)return "interrupted";
    if(s->ended)return s->stop==SOPE_STOP_END_TURN?"completed":s->stop==SOPE_STOP_CANCELLED?"cancelled":"failed";
    return s->cancelled?"cancel_requested":s->started?"running":"not_started";
}

int sope__journal_child_cancel(sope_agent_t *a, uint64_t child, const char *note, size_t len)
{
    if(!a->root->journal)return 1;
    if(a->root->journal_failed)return 0;
    sope_buf b={0};sope__buf_appends(&b,"{\"note\":");
    sope__buf_append_json_string(&b,note?note:"",len);sope__buf_appends(&b,"}");
    int ok=!b.oom && audit(a,"child_cancel",a->active_turn,child,b.ptr);
    sope__buf_free(&b);return ok||fail(a);
}

static int restore_child_calls(sope_agent_t *a, pending_call *parent)
{
    child_lifecycle state;
    if(!child_status(a,parent->call_id,&state))return 0;
    if(!state.started)return 1;
    sqlite3_stmt *s=NULL;
    const char *q="SELECT payload,turn FROM events WHERE kind='model' AND agent=? ORDER BY seq DESC LIMIT 1";
    if(sqlite3_prepare_v2(a->journal->db,q,-1,&s,NULL)!=SQLITE_OK)return 0;
    sqlite3_bind_int64(s,1,(sqlite3_int64)parent->call_id);
    int step=sqlite3_step(s),ok=step==SQLITE_DONE;
    sope_history h={0};uint64_t turn=0;
    if(step==SQLITE_ROW){ok=parse_history(&h,s,0);turn=(uint64_t)sqlite3_column_int64(s,1);}
    sqlite3_finalize(s);s=NULL;
    const sope_message *m=sope__history_last(&h,SOPE__MSG_ASSISTANT);
    if(ok&&m)for(size_t i=0;ok&&i<m->n_tool_uses;i++){
        const sope_tool_use *u=&m->tool_uses[i];
        if(sqlite3_prepare_v2(a->journal->db,"SELECT 1 FROM results WHERE call=?",-1,&s,NULL)!=SQLITE_OK){ok=0;break;}
        sqlite3_bind_int64(s,1,(sqlite3_int64)u->call_id);step=sqlite3_step(s);
        sqlite3_finalize(s);s=NULL;
        if(step==SQLITE_ROW)continue;
        if(step!=SQLITE_DONE){ok=0;break;}
        pending_call *p=calloc(1,sizeof *p);
        if(!p){ok=0;break;}
        p->owner=a;p->kind=PENDING_TOOL;p->call_id=u->call_id;p->turn_id=turn;
        p->recovery_agent=parent->call_id;p->name=sope__strdup(u->name);
        p->recovery_id=sope__strdup(u->id);p->recovery_input=sope__strndup(u->input,u->input_len);p->recovery_input_len=u->input_len;
        if(!p->name||!p->recovery_id||!p->recovery_input){sope__pending_free(p);ok=0;break;}
        p->next=a->pending;a->pending=p;
    }
    sope__history_clear(&h);return ok;
}

static int reconcile_child_call(sope_agent_t *a, pending_call *p)
{
    sope_agent_t actor={.root=a->root,.agent_id=p->recovery_agent};
    sope_message m={.role=SOPE__MSG_TOOL,.tool_use_id=p->recovery_id,.tool_name=p->name,
        .content=p->content,.content_len=p->len,.is_error=p->is_error};
    char *body=one_message(&m);
    ev_node e={.type=SOPE_EVENT_TOOL_END,.agent_id=p->recovery_agent,.turn_id=p->turn_id,
        .call_id=p->call_id,.code=p->is_error,.name=p->name,.name_len=strlen(p->name),.data=p->content,.data_len=p->len};
    sqlite3 *db=a->journal->db;uint64_t sequence=a->event_sequence;
    sqlite3_stmt *existing=NULL;
    int terminal=-1;
    if(sqlite3_prepare_v2(db,"SELECT EXISTS(SELECT 1 FROM stream WHERE type=13 AND agent=? AND call=?)",-1,&existing,NULL)==SQLITE_OK){
        sqlite3_bind_int64(existing,1,(sqlite3_int64)p->recovery_agent);sqlite3_bind_int64(existing,2,(sqlite3_int64)p->call_id);
        if(sqlite3_step(existing)==SQLITE_ROW)terminal=sqlite3_column_int(existing,0);
    }
    sqlite3_finalize(existing);
    int ok=terminal>=0&&body&&sql(db,"BEGIN IMMEDIATE")&&audit(&actor,"reconcile",p->turn_id,p->call_id,"host verified unknown outcome")&&
        audit(&actor,"result",p->turn_id,p->call_id,body)&&
        sql(db,"INSERT INTO results VALUES(%lld,%Q)",(long long)p->call_id,body)&&(terminal||stream_event(a,&e))&&sql(db,"COMMIT");
    if(!ok){sql(db,"ROLLBACK");a->event_sequence=sequence;}
    free(body);if(!ok)return fail(a);
    if(!terminal)sope__push_event_locked(&actor,e.type,e.turn_id,e.call_id,e.code,e.name,e.name_len,e.data,e.data_len);
    p->reported=1;return 1;
}

static int finish_recovered_child(sope_agent_t *a, pending_call *p)
{
    child_lifecycle lifecycle;
    if(!child_status(a,p->call_id,&lifecycle))return fail(a);
    int started=lifecycle.started,ended=lifecycle.ended,cancelled=lifecycle.cancelled;
    int stop=ended?lifecycle.stop:cancelled?SOPE_STOP_CANCELLED:SOPE_STOP_ERROR;
    const char *state=ended?child_state(&lifecycle):cancelled?"cancelled":started?"interrupted":"not_started";
    sope_buf prose={0},envelope={0};sqlite3_stmt *s=NULL;
    if(!ended)sope__buf_appends(&prose,"Execution interrupted. Unknown tool outcomes were reconciled by the host; delegated reasoning did not finish.\n");
    const char *q="SELECT payload FROM events WHERE agent=? AND kind IN ('model','end') ORDER BY seq DESC LIMIT 1";
    int ok=sqlite3_prepare_v2(a->journal->db,q,-1,&s,NULL)==SQLITE_OK;
    if(ok){sqlite3_bind_int64(s,1,(sqlite3_int64)p->call_id);int step=sqlite3_step(s);
        if(step==SQLITE_ROW){sope_history h={0};ok=parse_history(&h,s,0);
            if(ok&&h.tail&&h.tail->role==SOPE__MSG_ASSISTANT)sope__buf_append(&prose,h.tail->content,h.tail->content_len);
            sope__history_clear(&h);
        }else ok=step==SQLITE_DONE;}
    sqlite3_finalize(s);s=NULL;
    if(ok&&cancelled){
        ok=sqlite3_prepare_v2(a->journal->db,"SELECT payload FROM events WHERE kind='child_cancel' AND call=? ORDER BY seq LIMIT 1",-1,&s,NULL)==SQLITE_OK;
        if(ok){sqlite3_bind_int64(s,1,(sqlite3_int64)p->call_id);int step=sqlite3_step(s);
            if(step==SQLITE_ROW){const char *raw=(const char *)sqlite3_column_text(s,0);sope_json *v=sope__json_parse(raw,strlen(raw));
                const char *note=sope__json_string(sope__json_get(v,"note"),NULL);
                if(note)sope__buf_appendf(&prose,"\nCancellation note: %s",note);
                sope__json_free(v);
            }else ok=step==SQLITE_DONE;
        }
        sqlite3_finalize(s);
    }
    if(ok&&!prose.oom)ok=sope__subagent_envelope(a,p->call_id,stop,state,prose.ptr?prose.ptr:"",prose.len,&envelope);
    else ok=0;
    sope__buf_free(&prose);
    if(!ok){sope__buf_free(&envelope);return fail(a);}
    p->content=envelope.ptr;p->len=envelope.len;p->is_error=stop!=SOPE_STOP_END_TURN;
    p->recovery_terminal=started&&!ended;
    ok=started?sope__journal_subagent_result(a,p,stop):sope__journal_result(a,p);
    if(ok)p->done=1;
    else{free(p->content);p->content=NULL;p->len=0;}
    return ok;
}

/* Host assertions are discoverable after recovery, but remain separate from
 * native process observations. Full stored results are available via evidence. */
int sope__journal_reconciliations(sope_agent_t *a, uint64_t child, sope_buf *out)
{
    sope__buf_appends(out,"[");
    if(!a->root->journal){sope__buf_appends(out,"]");return !out->oom;}
    sqlite3_stmt *s=NULL;
    const char *q="SELECT e.call,r.payload FROM events e JOIN results r ON e.call=r.call "
        "WHERE e.kind='reconcile' AND e.agent=? ORDER BY e.seq DESC LIMIT 32";
    if(sqlite3_prepare_v2(a->root->journal->db,q,-1,&s,NULL)!=SQLITE_OK)return 0;
    sqlite3_bind_int64(s,1,(sqlite3_int64)child);int step,comma=0,ok=1;
    while((step=sqlite3_step(s))==SQLITE_ROW){
        sope_history h={0};
        if(!parse_history(&h,s,1)||!h.head){sope__history_clear(&h);ok=0;break;}
        const sope_message *m=h.head;size_t n=m->content_len<512?m->content_len:512;
        while(n<m->content_len&&n&&((unsigned char)m->content[n]&0xc0)==0x80)n--;
        sope__buf_appendf(out,"%s{\"call_id\":%lld,\"tool\":",comma++?",":"",sqlite3_column_int64(s,0));
        sope__buf_append_json_string(out,m->tool_name,strlen(m->tool_name));
        sope__buf_appendf(out,",\"source\":\"host assertion; not a native check\",\"is_error\":%s,\"result_bytes\":%zu,\"excerpt\":",m->is_error?"true":"false",m->content_len);
        sope__buf_append_json_string(out,m->content,n);sope__buf_appends(out,"}");sope__history_clear(&h);
    }
    sqlite3_finalize(s);sope__buf_appends(out,"]");return ok&&step==SQLITE_DONE&&!out->oom;
}

/* Re-render native delegation state after every summary. Model prose cannot
 * promote failed/cancelled/interrupted work to completed. Bounded by task. */
int sope__journal_delegations(sope_agent_t *a, sope_buf *out)
{
    static const char *states[]={"running","cancel_requested","completed","failed","cancelled","interrupted","not_started"};
    uint64_t counts[7]={0},total=0;
    sope_buf recent={0};sqlite3_stmt *s=NULL;
    int step=SQLITE_DONE,ok=1;
    if(a->root->journal){
        const char *q="SELECT call FROM stream WHERE type=9 AND agent=? AND turn=? ORDER BY seq DESC";
        if(sqlite3_prepare_v2(a->root->journal->db,q,-1,&s,NULL)!=SQLITE_OK)return 0;
        sqlite3_bind_int64(s,1,(sqlite3_int64)a->agent_id);sqlite3_bind_int64(s,2,(sqlite3_int64)sope__turn_id(a));
        while((step=sqlite3_step(s))==SQLITE_ROW){
            uint64_t child=(uint64_t)sqlite3_column_int64(s,0);child_lifecycle lifecycle;
            if(!child_status(a,child,&lifecycle)){ok=0;break;}
            const char *state=child_state(&lifecycle);
            for(unsigned i=0;i<7;i++)if(!strcmp(state,states[i]))counts[i]++;
            if(total++>=32)continue;
            sope__buf_appendf(&recent,"%s{\"agent_id\":%" PRIu64 ",\"state\":",total>1?",":"",child);
            sope__buf_append_json_string(&recent,state,strlen(state));
            sope__buf_appends(&recent,",\"recent_evidence_call_ids\":[");
            sqlite3_stmt *receipts=NULL;int rstep=SQLITE_ERROR,n=0;
            if(sqlite3_prepare_v2(a->root->journal->db,"SELECT call FROM observations WHERE agent=? ORDER BY call DESC LIMIT 8",-1,&receipts,NULL)==SQLITE_OK){
                sqlite3_bind_int64(receipts,1,(sqlite3_int64)child);
                while((rstep=sqlite3_step(receipts))==SQLITE_ROW)
                    sope__buf_appendf(&recent,"%s%lld",n++?",":"",sqlite3_column_int64(receipts,0));
            }
            sqlite3_finalize(receipts);if(rstep!=SQLITE_DONE)ok=0;
            sope__buf_appends(&recent,"],\"host_reconciled_call_ids\":[");
            receipts=NULL;rstep=SQLITE_ERROR;n=0;
            if(sqlite3_prepare_v2(a->root->journal->db,"SELECT call FROM events WHERE kind='reconcile' AND agent=? ORDER BY call DESC LIMIT 8",-1,&receipts,NULL)==SQLITE_OK){
                sqlite3_bind_int64(receipts,1,(sqlite3_int64)child);
                while((rstep=sqlite3_step(receipts))==SQLITE_ROW)
                    sope__buf_appendf(&recent,"%s%lld",n++?",":"",sqlite3_column_int64(receipts,0));
            }
            sqlite3_finalize(receipts);if(rstep!=SQLITE_DONE)ok=0;
            sope__buf_appends(&recent,"]}");
            if(!ok)break;
        }
        sqlite3_finalize(s);
    }
    sope__buf_appendf(out,"{\"total\":%" PRIu64 ",\"states\":{",total);
    for(unsigned i=0;i<7;i++)sope__buf_appendf(out,"%s\"%s\":%" PRIu64,i?",":"",states[i],counts[i]);
    sope__buf_appends(out,"},\"recent\":[");
    sope__buf_append(out,recent.ptr,recent.len);sope__buf_appends(out,"]}");
    ok=ok&&step==SQLITE_DONE&&!recent.oom&&!out->oom;sope__buf_free(&recent);return ok;
}
