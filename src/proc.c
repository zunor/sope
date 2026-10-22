/* SPDX-License-Identifier: MIT */
/*
 * proc.c - child processes for the bash tool, without blocking the pool.
 *
 * A command runs as `bash -c` in its own session (so the whole process
 * group can be killed), with stdin from /dev/null and stdout and stderr on
 * one pipe. One reaper thread polls every pipe, collects output and reaps
 * exits; the owning task is woken on new output and when the process is
 * done, the same way http.c wakes tasks for network transfers.
 *
 * Output keeps the first HEAD_MAX bytes and a rolling window of the last
 * TAIL_MAX bytes, so a chatty process costs bounded memory while both the
 * start (errors, usage) and the end (results) survive.
 *
 * A process is shared by its owner and the reaper (refcount 2). Lock order:
 * R.mu, then the pool lock (via sope__task_wake).
 */
#if defined(__APPLE__)
#  define _DARWIN_C_SOURCE /* POSIX_SPAWN_SETSID */
#else
#  define _GNU_SOURCE /* POSIX_SPAWN_SETSID (glibc 2.26+) */
#endif

#include "sope_internal.h"

#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <signal.h>
#include <spawn.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/wait.h>
#include <unistd.h>

extern char **environ;

#define HEAD_MAX (16 * 1024)
#define TAIL_MAX (256 * 1024)
#define REAP_INTERVAL_MS 50

struct sope_proc {
    sope_proc *next; /* R.procs */
    int refs;
    pid_t pid;
    int fd;          /* read end of the output pipe; -1 once closed */
    sope_task *wake; /* NULL: nobody to wake (background, or released) */
    int exited;      /* reaped */
    int done;        /* reaped and output drained */
    int status;      /* exit code; 128+N for signal N; -1 unknown */
    int killed;
    sope_buf head;   /* the first HEAD_MAX bytes */
    sope_buf tail;   /* bytes after head; only the last TAIL_MAX are kept */
    uint64_t tail_base; /* absolute offset of tail.ptr[0] */
    uint64_t total;  /* bytes received */
};

static struct {
    pthread_mutex_t mu;
    int started;
    int stop;
    pthread_t thread;
    int wake_fd[2];
    sope_proc *procs;
} R = { PTHREAD_MUTEX_INITIALIZER, 0, 0, 0, { -1, -1 }, NULL };

static void poke_locked(void)
{
    ssize_t r;
    if (R.wake_fd[1] < 0) return;
    do r = write(R.wake_fd[1], "!", 1);
    while (r < 0 && errno == EINTR);
}

static void proc_free(sope_proc *p)
{
    if (p->fd >= 0) close(p->fd);
    sope__buf_free(&p->head);
    sope__buf_free(&p->tail);
    free(p);
}

static void unref_locked(sope_proc *p)
{
    sope_proc **pp;
    if (--p->refs > 0) return;
    for (pp = &R.procs; *pp; pp = &(*pp)->next)
        if (*pp == p) {
            *pp = p->next;
            break;
        }
    proc_free(p);
}

static void append_output_locked(sope_proc *p, const char *s, size_t n)
{
    size_t room = p->head.len < HEAD_MAX ? HEAD_MAX - p->head.len : 0;
    size_t h = n < room ? n : room;
    if (h) sope__buf_append(&p->head, s, h);
    if (n > h) {
        if (!p->tail.len) p->tail_base = p->total + h;
        sope__buf_append(&p->tail, s + h, n - h);
        if (p->tail.len > TAIL_MAX) {
            size_t drop = p->tail.len - TAIL_MAX;
            sope__buf_consume(&p->tail, drop);
            p->tail_base += drop;
        }
    }
    p->total += n;
}

static void close_pipe_locked(sope_proc *p)
{
    if (p->fd >= 0) close(p->fd);
    p->fd = -1;
}

static void reap_locked(sope_proc *p)
{
    int st;
    pid_t r;
    if (p->exited) return;
    do r = waitpid(p->pid, &st, WNOHANG);
    while (r < 0 && errno == EINTR);
    if (r == p->pid) {
        p->exited = 1;
        p->status = WIFEXITED(st) ? WEXITSTATUS(st) : WIFSIGNALED(st) ? 128 + WTERMSIG(st) : -1;
    } else if (r < 0) { /* ECHILD: the host reaps children itself (SIGCHLD ignored) */
        if (p->fd < 0) {
            p->exited = 1;
            p->status = -1;
        }
    }
}

static void *reaper_main(void *arg)
{
    struct pollfd *fds = NULL;
    sope_proc **owners = NULL;
    size_t cap = 0;
    (void)arg;

    pthread_mutex_lock(&R.mu);
    while (!R.stop || R.procs) {
        sope_proc *p;
        size_t n = 1, i;
        int pending_exit = 0, timeout;

        for (p = R.procs; p; p = p->next) n++;
        if (n > cap) {
            struct pollfd *f = realloc(fds, n * sizeof *f);
            sope_proc **o = f ? realloc(owners, n * sizeof *o) : NULL;
            if (f) fds = f;
            if (o) owners = o;
            if (!f || !o) { /* try again shortly */
                pthread_mutex_unlock(&R.mu);
                usleep(10000);
                pthread_mutex_lock(&R.mu);
                continue;
            }
            cap = n;
        }
        fds[0].fd = R.wake_fd[0];
        fds[0].events = POLLIN;
        n = 1;
        for (p = R.procs; p; p = p->next) {
            if (!p->exited) pending_exit = 1;
            if (p->fd < 0) continue;
            fds[n].fd = p->fd;
            fds[n].events = POLLIN;
            owners[n++] = p;
        }
        timeout = pending_exit ? REAP_INTERVAL_MS : -1;
        pthread_mutex_unlock(&R.mu);

        while (poll(fds, (nfds_t)n, timeout) < 0 && errno == EINTR) {}

        pthread_mutex_lock(&R.mu);
        if (fds[0].revents) {
            char buf[64];
            while (read(R.wake_fd[0], buf, sizeof buf) > 0) {}
        }
        for (i = 1; i < n; i++) {
            char buf[16384];
            ssize_t r;
            p = owners[i];
            if (!fds[i].revents || p->fd < 0) continue;
            r = read(p->fd, buf, sizeof buf);
            if (r > 0) {
                append_output_locked(p, buf, (size_t)r);
                if (p->wake) sope__task_wake(p->wake);
            } else if (r == 0 || (errno != EINTR && errno != EAGAIN)) {
                close_pipe_locked(p);
            }
        }
        for (p = R.procs; p;) {
            sope_proc *nx = p->next;
            reap_locked(p);
            if (p->exited && !p->done) {
                /* The shell is gone. Take what is buffered, but do not wait
                 * for EOF: a background grandchild may hold the pipe open. */
                if (p->fd >= 0) {
                    char buf[16384];
                    ssize_t r;
                    while ((r = read(p->fd, buf, sizeof buf)) > 0) append_output_locked(p, buf, (size_t)r);
                    close_pipe_locked(p);
                }
                p->done = 1;
                if (p->wake) sope__task_wake(p->wake);
                unref_locked(p); /* the reaper's reference: it is finished with p */
            }
            p = nx;
        }
    }
    pthread_mutex_unlock(&R.mu);
    free(fds);
    free(owners);
    return NULL;
}

static int ensure_started_locked(void)
{
    int i;
    if (R.started) return 1;
    if (pipe(R.wake_fd) != 0) return 0;
    for (i = 0; i < 2; i++) {
        fcntl(R.wake_fd[i], F_SETFL, fcntl(R.wake_fd[i], F_GETFL) | O_NONBLOCK);
        fcntl(R.wake_fd[i], F_SETFD, FD_CLOEXEC);
    }
    if (pthread_create(&R.thread, NULL, reaper_main, NULL) != 0) {
        close(R.wake_fd[0]);
        close(R.wake_fd[1]);
        R.wake_fd[0] = R.wake_fd[1] = -1;
        return 0;
    }
    R.started = 1;
    return 1;
}

/* environ with our overrides: commands run without a terminal or a pager. */
static char **child_env(void)
{
    static const char *const overrides[] = { "PAGER=cat", "GIT_PAGER=cat", "GIT_TERMINAL_PROMPT=0",
                                             "TERM=dumb", "NO_COLOR=1" };
    size_t n = 0, k = 0, i, j;
    char **env;
    while (environ && environ[n]) n++;
    env = calloc(n + sizeof overrides / sizeof overrides[0] + 1, sizeof *env);
    if (!env) return NULL;
    for (i = 0; i < n; i++) {
        int shadowed = 0;
        for (j = 0; j < sizeof overrides / sizeof overrides[0]; j++) {
            size_t klen = (size_t)(strchr(overrides[j], '=') - overrides[j]);
            if (!strncmp(environ[i], overrides[j], klen + 1)) shadowed = 1;
        }
        if (!shadowed) env[k++] = environ[i];
    }
    for (j = 0; j < sizeof overrides / sizeof overrides[0]; j++) env[k++] = (char *)overrides[j];
    return env;
}

sope_proc *sope__proc_start(const char *command, const char *cwd, sope_task *wake, char *err, size_t errlen)
{
    static const char prologue[] = "cd -- \"$1\" || exit 1\nshift\n";
    const char *shell = access("/bin/bash", X_OK) == 0 ? "/bin/bash" : "/bin/sh";
    posix_spawn_file_actions_t fa;
    posix_spawnattr_t attr;
    sope_buf script = { 0 };
    char *argv[6];
    char **env = NULL;
    int fds[2] = { -1, -1 }, rc;
    short flags = 0;
    sope_proc *p;
    pid_t pid;

    sope__buf_appends(&script, prologue);
    sope__buf_appends(&script, command);
    p = calloc(1, sizeof *p);
    env = child_env();
    if (!p || !env || script.oom) {
        snprintf(err, errlen, "out of memory");
        goto fail;
    }
    if (pipe(fds) != 0) {
        snprintf(err, errlen, "pipe: %s", strerror(errno));
        goto fail;
    }
    fcntl(fds[0], F_SETFD, FD_CLOEXEC);
    fcntl(fds[0], F_SETFL, fcntl(fds[0], F_GETFL) | O_NONBLOCK);

    posix_spawn_file_actions_init(&fa);
    posix_spawn_file_actions_addopen(&fa, 0, "/dev/null", O_RDONLY, 0);
    posix_spawn_file_actions_adddup2(&fa, fds[1], 1);
    posix_spawn_file_actions_adddup2(&fa, fds[1], 2);
    posix_spawn_file_actions_addclose(&fa, fds[1]);
    posix_spawnattr_init(&attr);
#ifdef POSIX_SPAWN_SETSID
    flags |= POSIX_SPAWN_SETSID; /* no controlling terminal; killable as a group */
#else
    flags |= POSIX_SPAWN_SETPGROUP;
    posix_spawnattr_setpgroup(&attr, 0);
#endif
#ifdef POSIX_SPAWN_CLOEXEC_DEFAULT
    flags |= POSIX_SPAWN_CLOEXEC_DEFAULT; /* inherit only 0, 1 and 2, whatever the host left open */
#endif
    {
        static const int defaults[] = { SIGPIPE, SIGINT, SIGQUIT, SIGTERM, SIGHUP, SIGCHLD,
                                        SIGTSTP, SIGTTIN, SIGTTOU, SIGALRM, SIGUSR1, SIGUSR2 };
        sigset_t none, dfl;
        size_t i;
        sigemptyset(&none);
        sigemptyset(&dfl);
        for (i = 0; i < sizeof defaults / sizeof defaults[0]; i++) sigaddset(&dfl, defaults[i]);
        posix_spawnattr_setsigmask(&attr, &none);  /* the host may block signals on this thread */
        posix_spawnattr_setsigdefault(&attr, &dfl); /* and ignore some, like SIGPIPE */
        flags |= POSIX_SPAWN_SETSIGMASK | POSIX_SPAWN_SETSIGDEF;
    }
    posix_spawnattr_setflags(&attr, flags);

    argv[0] = (char *)shell;
    argv[1] = "-c";
    argv[2] = script.ptr;
    argv[3] = "sope-bash";
    argv[4] = (char *)(cwd && *cwd ? cwd : ".");
    argv[5] = NULL;
    rc = posix_spawn(&pid, shell, &fa, &attr, argv, env);
    posix_spawn_file_actions_destroy(&fa);
    posix_spawnattr_destroy(&attr);
    close(fds[1]);
    fds[1] = -1;
    if (rc != 0) {
        snprintf(err, errlen, "cannot run %s: %s", shell, strerror(rc));
        goto fail;
    }

    p->refs = 2; /* owner + reaper */
    p->pid = pid;
    p->fd = fds[0];
    p->wake = wake;
    p->status = -1;
    pthread_mutex_lock(&R.mu);
    if (!ensure_started_locked()) {
        pthread_mutex_unlock(&R.mu);
        kill(-pid, SIGKILL);
        waitpid(pid, NULL, 0);
        snprintf(err, errlen, "cannot start the process reaper");
        goto fail;
    }
    p->next = R.procs;
    R.procs = p;
    poke_locked();
    pthread_mutex_unlock(&R.mu);
    sope__buf_free(&script);
    free(env);
    return p;

fail:
    if (fds[0] >= 0) close(fds[0]);
    if (fds[1] >= 0) close(fds[1]);
    free(p);
    free(env);
    sope__buf_free(&script);
    return NULL;
}

int sope__proc_done(sope_proc *p, int *status)
{
    int done;
    pthread_mutex_lock(&R.mu);
    done = p->done;
    if (status) *status = p->status;
    pthread_mutex_unlock(&R.mu);
    return done;
}

int sope__proc_killed(sope_proc *p)
{
    int k;
    pthread_mutex_lock(&R.mu);
    k = p->killed;
    pthread_mutex_unlock(&R.mu);
    return k;
}

uint64_t sope__proc_output(sope_proc *p, uint64_t from, sope_buf *out)
{
    uint64_t end;
    pthread_mutex_lock(&R.mu);
    end = p->total;
    if (from < p->head.len) {
        sope__buf_append(out, p->head.ptr + from, p->head.len - (size_t)from);
        from = p->head.len;
    }
    if (from < end) {
        if (from < p->tail_base) {
            sope__buf_appendf(out, "\n[... %llu bytes of output omitted ...]\n",
                              (unsigned long long)(p->tail_base - from));
            from = p->tail_base;
        }
        sope__buf_append(out, p->tail.ptr + (from - p->tail_base), (size_t)(end - from));
    }
    pthread_mutex_unlock(&R.mu);
    return end;
}

void sope__proc_set_wake(sope_proc *p, sope_task *wake)
{
    pthread_mutex_lock(&R.mu);
    p->wake = wake;
    pthread_mutex_unlock(&R.mu);
}

void sope__proc_kill(sope_proc *p)
{
    pthread_mutex_lock(&R.mu);
    if (!p->exited) {
        p->killed = 1;
        if (kill(-p->pid, SIGKILL) != 0) kill(p->pid, SIGKILL);
        poke_locked();
    }
    pthread_mutex_unlock(&R.mu);
}

void sope__proc_release(sope_proc *p)
{
    if (!p) return;
    sope__proc_kill(p);
    pthread_mutex_lock(&R.mu);
    p->wake = NULL;
    unref_locked(p); /* the reaper's reference goes once it is done, below */
    pthread_mutex_unlock(&R.mu);
}

void sope__proc_shutdown(void)
{
    pthread_mutex_lock(&R.mu);
    if (!R.started) {
        pthread_mutex_unlock(&R.mu);
        return;
    }
    R.stop = 1;
    poke_locked();
    pthread_mutex_unlock(&R.mu);
    pthread_join(R.thread, NULL);
    pthread_mutex_lock(&R.mu);
    close(R.wake_fd[0]);
    close(R.wake_fd[1]);
    R.wake_fd[0] = R.wake_fd[1] = -1;
    R.started = R.stop = 0;
    pthread_mutex_unlock(&R.mu);
}
