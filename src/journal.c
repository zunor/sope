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
    if (ok && !a->parent) ok = sql(db, "INSERT INTO inbox(id,compact,payload,status) VALUES(%lld,%d,%Q,0)",
                                  (long long)m->turn_id, m->compact, body);
    if (ok) ok = sql(db, "COMMIT");
    if (!ok) sql(db, "ROLLBACK");
    free(body);
    return ok || fail(a);
}

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
    int ok = history && (strcmp(kind, "model") || fact) && sql(db, "BEGIN IMMEDIATE") &&
             audit(a, kind, id, 0, body);
    if (ok && !strcmp(kind, "model")) {
        const sope_message *m = a->history.tail;
        if (m) for (size_t i = 0; ok && i < m->n_tool_uses; i++)
            ok = audit(a, "intent", id, m->tool_uses[i].call_id, m->tool_uses[i].input);
    }
    if (ok && !a->parent) {
        ok = sql(db, "UPDATE state SET history=%Q,active=%lld,round=%lld,next_call=%lld,tokens=%lld,estimate=%lld WHERE id=1",
                 history, (long long)(terminal ? 0 : id), (long long)a->turn.round,
                 (long long)a->next_call_id, (long long)a->context_tokens, (long long)a->context_estimate);
        if (ok && id) ok = sql(db, "UPDATE inbox SET status=%d WHERE id=%lld", terminal ? 2 : 1, (long long)id);
    }
    if (ok) ok = sql(db, "COMMIT");
    if (!ok) sql(db, "ROLLBACK");
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

int sope__journal_result(sope_agent_t *a, pending_call *p)
{
    if (!a->root->journal) return 1;
    if (a->root->journal_failed) return 0;
    const sope_tool_use *u = find_use(a, p->call_id);
    if (!u) return fail(a);
    sope_message msg = { .role = SOPE__MSG_TOOL, .content = p->content, .content_len = p->len,
                        .tool_use_id = u->id, .tool_name = p->name, .is_error = p->is_error,
                        .images = p->images, .n_images = p->n_images };
    char *body = one_message(&msg);
    sqlite3 *db = a->root->journal->db;
    int ok = body && sql(db, "BEGIN IMMEDIATE") && audit(a, "result", p->turn_id, p->call_id, body) &&
             sql(db, "INSERT INTO results(call,payload) VALUES(%lld,%Q)", (long long)p->call_id, body);
    if (ok) ok = sql(db, "COMMIT");
    if (!ok) sql(db, "ROLLBACK");
    free(body);
    return ok || fail(a);
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

static int restore(sope_agent_t *a)
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
        p->owner = a; p->kind = PENDING_TOOL; p->call_id = u->call_id; p->turn_id = active;
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
    if (schema != 0 && schema != 1) goto bad;
    if (!sql(j->db, "PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA busy_timeout=3000;"
        "CREATE TABLE IF NOT EXISTS state(id INTEGER PRIMARY KEY CHECK(id=1),history TEXT NOT NULL,active INTEGER NOT NULL,round INTEGER NOT NULL,next_call INTEGER NOT NULL,tokens INTEGER NOT NULL,estimate INTEGER NOT NULL);"
        "INSERT OR IGNORE INTO state VALUES(1,'[]',0,0,0,0,0);"
        "CREATE TABLE IF NOT EXISTS inbox(id INTEGER PRIMARY KEY,compact INTEGER NOT NULL,payload TEXT NOT NULL,status INTEGER NOT NULL);"
        "CREATE TABLE IF NOT EXISTS results(call INTEGER PRIMARY KEY,payload TEXT NOT NULL);"
        "CREATE TABLE IF NOT EXISTS events(seq INTEGER PRIMARY KEY,kind TEXT NOT NULL,agent INTEGER NOT NULL,turn INTEGER NOT NULL,call INTEGER NOT NULL,payload TEXT NOT NULL);"
        "PRAGMA user_version=1;")) goto bad;
    if (!restore(a)) goto bad;
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
        if (p->done) continue;
        const sope_tool_use *u = find_use(a, p->call_id);
        sope__buf_appendf(&b, "%s{\"call_id\":\"%" PRIu64 "\",\"name\":", count++ ? "," : "", p->call_id);
        sope__buf_append_json_string(&b, p->name, strlen(p->name));
        sope__buf_appends(&b, ",\"input\":");
        sope__buf_append_json_string(&b, u ? u->input : "{}", u ? u->input_len : 2);
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
    pending_call *p = sope__pending_find_locked(a, call, PENDING_TOOL);
    if (!a->recovering || !p || p->done) { pthread_mutex_unlock(a->mu); return sope__set_error(SOPE_ENOTFOUND, "no unresolved interrupted call with this ID"); }
    p->content = sope__strndup(content ? content : "", len); p->len = len; p->is_error = error != 0;
    int ok = p->content && sope__journal_result(a, p);
    if (ok) p->done = 1;
    else { free(p->content); p->content = NULL; p->len = 0; }
    pthread_mutex_unlock(a->mu);
    return ok ? SOPE_OK : sope__set_error(SOPE_ERROR, "reconciled outcome was not committed");
}

int sope_agent_resume(sope_agent_t *a)
{
    if (!a) return sope__set_error(SOPE_EINVAL, "agent is required");
    pthread_mutex_lock(a->mu);
    if (!a->recovering || a->closing || a->journal_failed) { pthread_mutex_unlock(a->mu); return sope__set_error(SOPE_EBUSY, "session is not awaiting resume, is closed, or has a storage failure"); }
    for (pending_call *p = a->pending; p; p = p->next) if (!p->done) {
        pthread_mutex_unlock(a->mu);
        return sope__set_error(SOPE_EBUSY, "interrupted tools have unknown outcomes; reconcile each call before resuming");
    }
    const sope_message *asst = sope__history_last(&a->history, SOPE__MSG_ASSISTANT);
    if (asst) for (size_t i = 0; i < asst->n_tool_uses; i++) {
        const sope_tool_use *u = &asst->tool_uses[i];
        pending_call *p = sope__pending_find_locked(a, u->call_id, PENDING_TOOL);
        if (!p || answered(asst, u)) continue;
        sope_message *m = sope__tool_message(u, p->content, p->len, p->is_error);
        if (!m) { pthread_mutex_unlock(a->mu); return SOPE_ENOMEM; }
        m->images = p->images; m->n_images = p->n_images; p->images = NULL; p->n_images = 0;
        sope__history_append(&a->history, m);
    }
    while (a->pending) { pending_call *p = a->pending; a->pending = p->next; sope__pending_free(p); }
    a->recovering = 0;
    sope__task_wake(&a->task);
    pthread_mutex_unlock(a->mu);
    return SOPE_OK;
}
