/* SPDX-License-Identifier: MIT */
#if defined(__APPLE__)
#  define _DARWIN_C_SOURCE
#else
#  define _GNU_SOURCE
#endif
#include "tools.h"
#include <errno.h>
#include <fcntl.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/stat.h>
#include <unistd.h>

int sope__write_fd(int fd, const void *data, size_t n)
{
    const char *p = data;
    while (n) {
        ssize_t count = write(fd, p, n);
        if (count < 0 && errno == EINTR) continue;
        if (count <= 0) return 0;
        p += count; n -= (size_t)count;
    }
    return 1;
}

int sope__artifact_create(sope_agent_t *a, const char *kind, char **path)
{
    sope_buf b = {0};
    sope_agent_t *root = a->root;
    *path = NULL;
    pthread_mutex_lock(root->mu);
    if (!root->artifact_dir) {
        char temp[] = "/tmp/sope-artifacts-XXXXXX";
        if (mkdtemp(temp)) root->artifact_dir = sope__strdup(temp);
    }
    if (root->artifact_dir) sope__buf_appendf(&b, "%s/%s-XXXXXX", root->artifact_dir, kind);
    pthread_mutex_unlock(root->mu);
    int fd = b.ptr && !b.oom ? mkstemp(b.ptr) : -1;
    if (fd >= 0) {
        fcntl(fd, F_SETFD, FD_CLOEXEC);
        char *slash = strrchr(b.ptr, '/');
        *slash = '\0';
        int dir = open(b.ptr, O_RDONLY | O_CLOEXEC);
        int synced = dir >= 0 && fsync(dir) == 0;
        if (dir >= 0) close(dir);
        *slash = '/';
        if (!synced) { close(fd); unlink(b.ptr); sope__buf_free(&b); return -1; }
        *path = b.ptr;
    }
    else sope__buf_free(&b);
    return fd;
}

/* Never silently discard a result when archiving fails. The caller must report
 * failure and stop execution. Paths are immutable evidence owned by the host. */
int sope__artifact_save(sope_agent_t *a, uint64_t call, const void *data, size_t n, char **path)
{
    int fd = sope__artifact_create(a, "result", path);
    int ok = fd >= 0 && sope__write_fd(fd, data, n) && fsync(fd) == 0;
    if (fd >= 0 && close(fd) != 0) ok = 0;
    pthread_mutex_lock(a->mu);
    if (ok) ok = sope__journal_artifact(a, call, *path);
    if (!ok) sope__storage_fail_locked(a, "Tool output archive failed; execution stopped. Reopen the session and verify the interrupted operation.");
    pthread_mutex_unlock(a->mu);
    return ok;
}

int sope__artifact_preview(sope_agent_t *a, uint64_t call, sope_buf *out, size_t limit)
{
    if (out->oom) return 0;
    if (out->len <= limit) return 1;
    char *path = NULL;
    size_t bytes = out->len;
    int ok = sope__artifact_save(a, call, out->ptr, out->len, &path);
    if (ok) {
        sope__buf_clip_middle(out, limit);
        sope__buf_appendf(out, "\n[Full output: %s (%zu bytes). Use artifact_read with byte offset/limit, or search the file with bash.]", path, bytes);
        ok = !out->oom;
    }
    free(path);
    return ok;
}

static sope_next artifact_read(tool_run *r)
{
    const char *path = sope__arg_string(r, "path");
    int64_t offset = sope__arg_int(r, "offset", 0), limit = sope__arg_int(r, "limit", 16384);
    if (!path || offset < 0 || limit <= 0 || limit > 32768) return sope__run_fail(r, "path, offset >= 0, and limit 1..32768 are required");
    /* Artifacts can also be read with ordinary file tools; this endpoint gives
     * byte pagination without the read tool's per-line truncation. */
    int fd = open(path, O_RDONLY | O_CLOEXEC);
    if (fd < 0) return sope__run_fail(r, "Cannot open artifact: %s", strerror(errno));
    char buf[32768];
    ssize_t n;
    do n = pread(fd, buf, (size_t)limit, (off_t)offset); while (n < 0 && errno == EINTR);
    close(fd);
    if (n < 0) return sope__run_fail(r, "Cannot read artifact: %s", strerror(errno));
    sope__buf_append(&r->out, buf, (size_t)n);
    sope__buf_appendf(&r->out, "\n[next byte offset: %lld; bytes read: %lld]", (long long)(offset + n), (long long)n);
    return sope__run_done(r);
}

const sope_builtin sope__builtin_artifact_read = {
    "artifact_read", "Read an archived tool output by byte offset. Use this to retrieve evidence omitted from a preview. Offsets are zero-based; limit is at most 32768 bytes.",
    "{\"type\":\"object\",\"properties\":{\"path\":{\"type\":\"string\"},\"offset\":{\"type\":\"integer\"},\"limit\":{\"type\":\"integer\"}},\"required\":[\"path\"]}",
    0, artifact_read, NULL
};
