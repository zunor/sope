/* SPDX-License-Identifier: MIT */
/*
 * pool.c - the shared worker pool that runs every agent.
 *
 * Agents are scheduled as tasks. A task runs one short step at a time and
 * never blocks a pool thread: instead of waiting it returns SLEEP (timer) or
 * WAIT (until sope__task_wake). A task is in at most one place at a time:
 *
 *   IDLE ──wake──▶ QUEUED ──thread──▶ RUNNING ──step──▶ QUEUED | SLEEPING | IDLE | CLOSED
 *   SLEEPING ──deadline or wake──▶ QUEUED
 *
 * A wake that arrives while RUNNING sets wake_pending, so the task is
 * requeued instead of going idle and the wake is never lost. All scheduling
 * state is guarded by the single pool lock. Lock order: agent lock, then
 * pool lock; pool threads never take an agent lock while holding it.
 */
#if defined(__APPLE__)
#  define _DARWIN_C_SOURCE /* _SC_NPROCESSORS_ONLN is an extension */
#else
#  define _DEFAULT_SOURCE
#endif

#include "sope_internal.h"

#include <pthread.h>
#include <stdlib.h>
#include <time.h>
#include <unistd.h>

#define NO_HEAP_INDEX ((size_t)-1)

static struct {
    pthread_mutex_t mu;
    pthread_cond_t cv;        /* pool threads: ready tasks, earlier timers, shutdown */
    pthread_cond_t closed_cv; /* sope__task_wait_closed */

    uint32_t configured; /* 0 = default */
    pthread_t *threads;
    uint32_t nthreads;
    int started;
    int shutdown;
    size_t tasks; /* live agents */

    sope_task *ready_head, *ready_tail;
    sope_task **heap; /* min-heap of SLEEPING tasks by deadline */
    size_t heap_len, heap_cap;
} P = { PTHREAD_MUTEX_INITIALIZER, PTHREAD_COND_INITIALIZER, PTHREAD_COND_INITIALIZER, 0, NULL, 0, 0, 0, 0,
        NULL, NULL, NULL, 0, 0 };

/* ---- timer heap ---- */

static int before(const struct timespec *a, const struct timespec *b)
{
    return a->tv_sec < b->tv_sec || (a->tv_sec == b->tv_sec && a->tv_nsec < b->tv_nsec);
}

static void heap_set(size_t i, sope_task *t)
{
    P.heap[i] = t;
    t->heap_index = i;
}

static void heap_up(size_t i)
{
    sope_task *t = P.heap[i];
    while (i > 0) {
        size_t parent = (i - 1) / 2;
        if (!before(&t->deadline, &P.heap[parent]->deadline)) break;
        heap_set(i, P.heap[parent]);
        i = parent;
    }
    heap_set(i, t);
}

static void heap_down(size_t i)
{
    sope_task *t = P.heap[i];
    for (;;) {
        size_t child = 2 * i + 1;
        if (child >= P.heap_len) break;
        if (child + 1 < P.heap_len && before(&P.heap[child + 1]->deadline, &P.heap[child]->deadline)) child++;
        if (!before(&P.heap[child]->deadline, &t->deadline)) break;
        heap_set(i, P.heap[child]);
        i = child;
    }
    heap_set(i, t);
}

static int heap_push(sope_task *t)
{
    if (P.heap_len == P.heap_cap) {
        size_t cap = P.heap_cap ? P.heap_cap * 2 : 16;
        sope_task **h = realloc(P.heap, cap * sizeof *h);
        if (!h) return 0;
        P.heap = h;
        P.heap_cap = cap;
    }
    heap_set(P.heap_len++, t);
    heap_up(t->heap_index);
    return 1;
}

static void heap_remove(sope_task *t)
{
    size_t i = t->heap_index;
    sope_task *last = P.heap[--P.heap_len];
    t->heap_index = NO_HEAP_INDEX;
    if (i == P.heap_len) return;
    heap_set(i, last);
    heap_up(i);
    heap_down(last->heap_index);
}

/* ---- scheduling (pool lock held) ---- */

static void enqueue_locked(sope_task *t)
{
    t->state = SOPE__TASK_QUEUED;
    t->next_ready = NULL;
    if (P.ready_tail)
        P.ready_tail->next_ready = t;
    else
        P.ready_head = t;
    P.ready_tail = t;
    pthread_cond_signal(&P.cv);
}

static void fire_timers_locked(void)
{
    struct timespec now;
    clock_gettime(CLOCK_REALTIME, &now);
    while (P.heap_len && !before(&now, &P.heap[0]->deadline)) {
        sope_task *t = P.heap[0];
        heap_remove(t);
        enqueue_locked(t);
    }
}

static void apply_locked(sope_task *t, sope_next next)
{
    if (next.kind == SOPE__NEXT_CLOSED) {
        t->state = SOPE__TASK_CLOSED;
        pthread_cond_broadcast(&P.closed_cv);
        return;
    }
    if (next.kind == SOPE__NEXT_CONTINUE || t->wake_pending || (next.kind == SOPE__NEXT_SLEEP && next.ms <= 0)) {
        enqueue_locked(t);
        return;
    }
    if (next.kind == SOPE__NEXT_SLEEP) {
        clock_gettime(CLOCK_REALTIME, &t->deadline);
        t->deadline.tv_sec += next.ms / 1000;
        t->deadline.tv_nsec += (long)(next.ms % 1000) * 1000000L;
        if (t->deadline.tv_nsec >= 1000000000L) {
            t->deadline.tv_sec += 1;
            t->deadline.tv_nsec -= 1000000000L;
        }
        if (!heap_push(t)) {
            enqueue_locked(t); /* out of memory: degrade to a busy retry */
            return;
        }
        t->state = SOPE__TASK_SLEEPING;
        if (t->heap_index == 0) pthread_cond_signal(&P.cv); /* a waiting thread may need an earlier wakeup */
        return;
    }
    t->state = SOPE__TASK_IDLE;
}

static void *pool_main(void *arg)
{
    (void)arg;
    pthread_mutex_lock(&P.mu);
    while (!P.shutdown) {
        sope_task *t;
        sope_next next;

        fire_timers_locked();
        t = P.ready_head;
        if (!t) {
            if (P.heap_len) {
                struct timespec deadline = P.heap[0]->deadline;
                pthread_cond_timedwait(&P.cv, &P.mu, &deadline);
            } else {
                pthread_cond_wait(&P.cv, &P.mu);
            }
            continue;
        }

        P.ready_head = t->next_ready;
        if (!P.ready_head) P.ready_tail = NULL;
        t->state = SOPE__TASK_RUNNING;
        t->wake_pending = 0;
        pthread_mutex_unlock(&P.mu);

        next = t->run(t);

        pthread_mutex_lock(&P.mu);
        if (next.kind == SOPE__NEXT_CLOSED && t->on_closed) {
            /* Nobody waits on such tasks; the callback owns (and may free) t. */
            void (*on_closed)(sope_task *) = t->on_closed;
            t->state = SOPE__TASK_CLOSED;
            pthread_mutex_unlock(&P.mu);
            on_closed(t);
            pthread_mutex_lock(&P.mu);
            continue;
        }
        apply_locked(t, next);
    }
    pthread_mutex_unlock(&P.mu);
    return NULL;
}

static uint32_t default_threads(void)
{
#ifdef _SC_NPROCESSORS_ONLN
    long n = sysconf(_SC_NPROCESSORS_ONLN);
#else
    long n = 4;
#endif
    if (n < 2) return 2;
    if (n > 8) return 8;
    return (uint32_t)n;
}

/* ---- public API ---- */

int sope_set_threads(uint32_t n)
{
    int rc = SOPE_OK;
    if (n > 256) return sope__set_error(SOPE_EINVAL, "sope_set_threads: %u threads is too many", n);
    pthread_mutex_lock(&P.mu);
    if (P.started)
        rc = sope__set_error(SOPE_EBUSY, "sope_set_threads: the worker pool is already running");
    else
        P.configured = n;
    pthread_mutex_unlock(&P.mu);
    return rc;
}

int sope_shutdown(void)
{
    pthread_t *threads;
    uint32_t i, n;

    pthread_mutex_lock(&P.mu);
    if (P.tasks) {
        size_t live = P.tasks;
        pthread_mutex_unlock(&P.mu);
        return sope__set_error(SOPE_EBUSY, "sope_shutdown: %zu agent(s) still alive", live);
    }
    if (!P.started) {
        pthread_mutex_unlock(&P.mu);
        return SOPE_OK;
    }
    P.shutdown = 1;
    pthread_cond_broadcast(&P.cv);
    threads = P.threads;
    n = P.nthreads;
    pthread_mutex_unlock(&P.mu);

    for (i = 0; i < n; i++) pthread_join(threads[i], NULL);
    sope__http_shutdown(); /* no agent is alive, so no transfer is either */
    sope__proc_shutdown(); /* nor a process, once the killed ones are reaped */

    pthread_mutex_lock(&P.mu);
    free(P.threads);
    free(P.heap);
    P.threads = NULL;
    P.heap = NULL;
    P.nthreads = 0;
    P.heap_len = P.heap_cap = 0;
    P.started = 0;
    P.shutdown = 0;
    pthread_mutex_unlock(&P.mu);
    return SOPE_OK;
}

/* ---- internal API ---- */

int sope__pool_acquire(void)
{
    pthread_mutex_lock(&P.mu);
    if (!P.started) {
        uint32_t want = P.configured ? P.configured : default_threads();
        P.threads = calloc(want, sizeof *P.threads);
        if (!P.threads) {
            pthread_mutex_unlock(&P.mu);
            return sope__set_error(SOPE_ENOMEM, "worker pool: out of memory");
        }
        for (P.nthreads = 0; P.nthreads < want; P.nthreads++)
            if (pthread_create(&P.threads[P.nthreads], NULL, pool_main, NULL) != 0) break;
        if (P.nthreads == 0) {
            free(P.threads);
            P.threads = NULL;
            pthread_mutex_unlock(&P.mu);
            return sope__set_error(SOPE_ERROR, "worker pool: failed to start threads");
        }
        P.started = 1;
    }
    P.tasks++;
    pthread_mutex_unlock(&P.mu);
    return SOPE_OK;
}

void sope__pool_release(void)
{
    pthread_mutex_lock(&P.mu);
    P.tasks--;
    pthread_mutex_unlock(&P.mu);
}

void sope__task_init(sope_task *t, sope_next (*run)(sope_task *), void *owner)
{
    t->run = run;
    t->on_closed = NULL;
    t->owner = owner;
    t->state = SOPE__TASK_IDLE;
    t->wake_pending = 0;
    t->heap_index = NO_HEAP_INDEX;
    t->next_ready = NULL;
}

void sope__task_wake(sope_task *t)
{
    pthread_mutex_lock(&P.mu);
    switch (t->state) {
    case SOPE__TASK_RUNNING: t->wake_pending = 1; break;
    case SOPE__TASK_SLEEPING: heap_remove(t); enqueue_locked(t); break;
    case SOPE__TASK_IDLE: enqueue_locked(t); break;
    default: break; /* QUEUED: will run anyway; CLOSED: never runs again */
    }
    pthread_mutex_unlock(&P.mu);
}

void sope__task_wait_closed(sope_task *t)
{
    pthread_mutex_lock(&P.mu);
    while (t->state != SOPE__TASK_CLOSED) pthread_cond_wait(&P.closed_cv, &P.mu);
    pthread_mutex_unlock(&P.mu);
}
