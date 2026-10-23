/* SPDX-License-Identifier: MIT */
/* Isolate the real pool with a controlled I/O shutdown boundary. */
#include "../src/sope_internal.h"
#include <stdio.h>
#include <stdlib.h>

#define CHECK(x) do { if (!(x)) { fprintf(stderr, "%d: %s\n", __LINE__, #x); exit(1); } } while (0)
static pthread_mutex_t mu = PTHREAD_MUTEX_INITIALIZER;
static pthread_cond_t cv = PTHREAD_COND_INITIALIZER;
static int entered, release_io;

void sope__http_shutdown(void)
{
    pthread_mutex_lock(&mu);
    entered = 1;
    pthread_cond_broadcast(&cv);
    while (!release_io) pthread_cond_wait(&cv, &mu);
    pthread_mutex_unlock(&mu);
}

void sope__proc_shutdown(void) {}

static void *shutdown_pool(void *unused)
{
    (void)unused;
    CHECK(sope_shutdown() == SOPE_OK);
    return NULL;
}

static sope_next close_task(sope_task *task)
{
    (void)task;
    return (sope_next){ SOPE__NEXT_CLOSED, 0 };
}

int main(void)
{
    CHECK(sope_set_threads(2) == SOPE_OK);
    CHECK(sope__pool_acquire() == SOPE_OK);
    sope__pool_release();
    pthread_t thread;
    CHECK(pthread_create(&thread, NULL, shutdown_pool, NULL) == 0);
    pthread_mutex_lock(&mu);
    while (!entered) pthread_cond_wait(&cv, &mu);
    pthread_mutex_unlock(&mu);

    CHECK(sope__pool_acquire() == SOPE_EBUSY);
    CHECK(sope_shutdown() == SOPE_EBUSY);
    CHECK(sope_set_threads(4) == SOPE_EBUSY);

    pthread_mutex_lock(&mu);
    release_io = 1;
    pthread_cond_broadcast(&cv);
    pthread_mutex_unlock(&mu);
    CHECK(pthread_join(thread, NULL) == 0);

    /* A later acquire must start workers that really execute tasks. */
    CHECK(sope__pool_acquire() == SOPE_OK);
    sope_task task = {0};
    sope__task_init(&task, close_task, NULL);
    sope__task_wake(&task);
    sope__task_wait_closed(&task);
    sope__pool_release();
    CHECK(sope_shutdown() == SOPE_OK);
    CHECK(sope_shutdown() == SOPE_OK);
    return 0;
}
