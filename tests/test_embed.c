/* SPDX-License-Identifier: MIT */
#define _POSIX_C_SOURCE 200809L
#if defined(__APPLE__)
#define _DARWIN_C_SOURCE
#endif
#include "sope.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>

/* Simulate a host's unrelated SQLite implementation. Neither the shared nor
 * static libsope may bind to these public names or collide with them. */
typedef struct sqlite3 sqlite3;
int sqlite3_open_v2(const char *, sqlite3 **, int, const char *);
const char *sqlite3_libversion(void);
static int host_sqlite_calls;
int sqlite3_open_v2(const char *path, sqlite3 **db, int flags, const char *vfs)
{
    (void)path; (void)db; (void)flags; (void)vfs;
    host_sqlite_calls++;
    return 21;
}
const char *sqlite3_libversion(void) { return "host-owned-sqlite"; }

#define REQUIRE(x) do { if (!(x)) { fprintf(stderr, "%s:%d: %s: %s\n", __FILE__, __LINE__, #x, sope_last_error()); exit(1); } } while (0)
int main(void)
{
    char dir[] = "/tmp/sope-embed-XXXXXX", path[512];
    sope_agent_t *a = NULL;
    const char *json;
    size_t len;
    REQUIRE(mkdtemp(dir) != NULL);
    REQUIRE(sope_agent_open(&a, dir) == SOPE_OK);
    REQUIRE(sope_agent_set_option(a, "provider", "mock") == SOPE_OK);
    REQUIRE(sope_agent_set_option(a, "mock.delay_ms", "0") == SOPE_OK);
    REQUIRE(sope_send(a, "embedded storage", 16, NULL) == SOPE_OK);
    for (;;) {
        sope_event_t ev = { .size = sizeof ev };
        REQUIRE(sope_poll(a, &ev, 10000) == 1);
        REQUIRE(ev.type != SOPE_EVENT_ERROR);
        if (ev.type == SOPE_EVENT_TURN_END) break;
    }
    sope_agent_free(a);
    REQUIRE(sope_agent_open(&a, dir) == SOPE_OK);
    REQUIRE(sope_agent_history(a, &json, &len) == SOPE_OK);
    REQUIRE(len && strstr(json, "embedded storage"));
    sope_agent_free(a);
    REQUIRE(host_sqlite_calls == 0);
    REQUIRE(strcmp(sqlite3_libversion(), "host-owned-sqlite") == 0);
    const char *files[] = { "execution.sqlite", "execution.sqlite-wal", "execution.sqlite-shm", "owner.lock" };
    for (size_t i = 0; i < sizeof files / sizeof files[0]; i++) {
        snprintf(path, sizeof path, "%s/%s", dir, files[i]);
        unlink(path);
    }
    snprintf(path, sizeof path, "%s/artifacts", dir);
    rmdir(path);
    REQUIRE(rmdir(dir) == 0);
    return 0;
}
