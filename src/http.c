/* SPDX-License-Identifier: MIT */
/*
 * http.c - non-blocking HTTP for providers, on libcurl's multi interface.
 *
 * One I/O thread drives every transfer with curl_multi_poll. Received bytes
 * are buffered per transfer and the owning task is woken, so a streaming
 * model response holds no pool thread while it waits. Only this file knows
 * about libcurl; building without it (SOPE_WITH_CURL undefined) leaves
 * providers that need HTTP unavailable.
 *
 * A transfer is shared by its owner and the I/O thread (refcount 2). The
 * owner's release marks it cancelled and clears `wake` under the transfer's
 * lock, so the task is never woken after release returns. Lock order:
 * IO.mu, then a transfer's mu, then the pool lock (via sope__task_wake).
 *
 * With SOPE_CURL=bundled, curl uses mbedTLS, which has no access to the
 * system trust store; we locate the platform's CA bundle file instead.
 */
#define _POSIX_C_SOURCE 200809L

#include "sope_internal.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#ifndef SOPE_WITH_CURL

int sope__http_available(void)
{
    return 0;
}

sope_http *sope__http_post(const char *url, const char *const *headers, size_t nheaders, const char *body,
                           size_t body_len, const char *ca_file, sope_task *wake)
{
    (void)url, (void)headers, (void)nheaders, (void)body, (void)body_len, (void)ca_file, (void)wake;
    sope__set_error(SOPE_ERROR, "sope was built without libcurl");
    return NULL;
}

sope_http *sope__http_get(const char *url, const char *ca_file, sope_task *wake)
{
    return sope__http_post(url, NULL, 0, NULL, 0, ca_file, wake);
}

void sope__http_info(sope_http *h, char *content_type, size_t ctlen, char *url, size_t urllen)
{
    (void)h;
    if (ctlen) *content_type = '\0';
    if (urllen) *url = '\0';
}

int sope__http_take(sope_http *h, sope_buf *out, long *status, char *err, size_t errlen)
{
    (void)h, (void)out, (void)errlen;
    *status = 0;
    snprintf(err, errlen, "sope was built without libcurl");
    return 1;
}

void sope__http_release(sope_http *h)
{
    (void)h;
}

void sope__http_shutdown(void)
{
}

#else /* SOPE_WITH_CURL */

#include <curl/curl.h>

struct sope_http {
    pthread_mutex_t mu;
    int refs;
    CURL *easy;
    struct curl_slist *headers;
    char *url;
    char *body;
    size_t body_len;
    char curl_err[CURL_ERROR_SIZE]; /* written by curl on the I/O thread */
    sope_http *next;                /* IO.incoming / IO.active, under IO.mu */

    /* Guarded by mu. */
    sope_buf in;
    sope_task *wake; /* NULL once released */
    int cancelled;
    int done;
    long status;
    char err[CURL_ERROR_SIZE];
    char *content_type;  /* GET: set when done */
    char *effective_url; /* GET: after redirects, set when done */
};

static struct {
    pthread_mutex_t mu;
    int started;
    int stop;
    pthread_t thread;
    CURLM *multi;
    sope_http *incoming; /* waiting to be added by the I/O thread */
    sope_http *active;   /* inside the multi handle */
} IO = { PTHREAD_MUTEX_INITIALIZER, 0, 0, 0, NULL, NULL, NULL };

static pthread_once_t global_once = PTHREAD_ONCE_INIT;
static int global_ok;

#ifdef SOPE_CURL_BUNDLED
#include <unistd.h>

static const char *default_ca_file;

/* SSL_CERT_FILE, else the first well-known bundle that exists. */
static const char *find_ca_file(void)
{
    static const char *const known[] = {
        "/etc/ssl/cert.pem",                                  /* macOS, Alpine, BSDs */
        "/etc/ssl/certs/ca-certificates.crt",                 /* Debian, Ubuntu, Arch */
        "/etc/pki/tls/certs/ca-bundle.crt",                   /* Fedora, RHEL */
        "/etc/pki/ca-trust/extracted/pem/tls-ca-bundle.pem",  /* RHEL 7+ */
        "/etc/ssl/ca-bundle.pem",                             /* openSUSE */
    };
    const char *env = getenv("SSL_CERT_FILE");
    size_t i;
    if (env && *env) return env;
    for (i = 0; i < sizeof known / sizeof known[0]; i++)
        if (access(known[i], R_OK) == 0) return known[i];
    return NULL;
}
#endif

static void global_init(void)
{
    global_ok = curl_global_init(CURL_GLOBAL_DEFAULT) == CURLE_OK;
#ifdef SOPE_CURL_BUNDLED
    default_ca_file = find_ca_file();
#endif
}

int sope__http_available(void)
{
    pthread_once(&global_once, global_init);
    return global_ok;
}

static void destroy(sope_http *h)
{
    if (h->easy) curl_easy_cleanup(h->easy);
    curl_slist_free_all(h->headers);
    free(h->url);
    free(h->body);
    free(h->content_type);
    free(h->effective_url);
    sope__buf_free(&h->in);
    pthread_mutex_destroy(&h->mu);
    free(h);
}

static void unref(sope_http *h)
{
    int refs;
    pthread_mutex_lock(&h->mu);
    refs = --h->refs;
    pthread_mutex_unlock(&h->mu);
    if (refs == 0) destroy(h);
}

static size_t on_data(char *ptr, size_t size, size_t nmemb, void *userdata)
{
    sope_http *h = userdata;
    size_t n = size * nmemb;
    int ok;

    pthread_mutex_lock(&h->mu);
    if (h->cancelled) {
        pthread_mutex_unlock(&h->mu);
        return 0; /* aborts the transfer */
    }
    if (!h->status) curl_easy_getinfo(h->easy, CURLINFO_RESPONSE_CODE, &h->status);
    sope__buf_append(&h->in, ptr, n);
    ok = !h->in.oom;
    if (h->wake) sope__task_wake(h->wake);
    pthread_mutex_unlock(&h->mu);
    return ok ? n : 0;
}

static void finished(sope_http *h, CURLcode result)
{
    char *ct = NULL, *url = NULL;
    pthread_mutex_lock(&h->mu);
    h->done = 1;
    curl_easy_getinfo(h->easy, CURLINFO_RESPONSE_CODE, &h->status);
    curl_easy_getinfo(h->easy, CURLINFO_CONTENT_TYPE, &ct);
    curl_easy_getinfo(h->easy, CURLINFO_EFFECTIVE_URL, &url);
    if (ct) h->content_type = sope__strdup(ct);
    if (url) h->effective_url = sope__strdup(url);
    if (result != CURLE_OK)
        snprintf(h->err, sizeof h->err, "%s", h->curl_err[0] ? h->curl_err : curl_easy_strerror(result));
    if (h->wake) sope__task_wake(h->wake);
    pthread_mutex_unlock(&h->mu);
}

static void *io_main(void *arg)
{
    (void)arg;
    pthread_mutex_lock(&IO.mu);
    while (!IO.stop) {
        sope_http **pp;
        CURLMsg *msg;
        int running, left;

        while (IO.incoming) {
            sope_http *h = IO.incoming;
            IO.incoming = h->next;
            if (curl_multi_add_handle(IO.multi, h->easy) != CURLM_OK) {
                finished(h, CURLE_FAILED_INIT);
                unref(h);
                continue;
            }
            h->next = IO.active;
            IO.active = h;
        }
        for (pp = &IO.active; *pp;) { /* drop transfers their owners released */
            sope_http *h = *pp;
            int cancelled;
            pthread_mutex_lock(&h->mu);
            cancelled = h->cancelled;
            pthread_mutex_unlock(&h->mu);
            if (cancelled) {
                *pp = h->next;
                curl_multi_remove_handle(IO.multi, h->easy);
                unref(h);
            } else {
                pp = &h->next;
            }
        }
        pthread_mutex_unlock(&IO.mu);

        curl_multi_perform(IO.multi, &running);
        while ((msg = curl_multi_info_read(IO.multi, &left))) {
            sope_http *h = NULL;
            if (msg->msg != CURLMSG_DONE) continue;
            curl_easy_getinfo(msg->easy_handle, CURLINFO_PRIVATE, (char **)&h);
            finished(h, msg->data.result);
            pthread_mutex_lock(&IO.mu);
            for (pp = &IO.active; *pp; pp = &(*pp)->next)
                if (*pp == h) {
                    *pp = h->next;
                    break;
                }
            pthread_mutex_unlock(&IO.mu);
            curl_multi_remove_handle(IO.multi, h->easy);
            unref(h);
        }
        curl_multi_poll(IO.multi, NULL, 0, 1000, NULL);
        pthread_mutex_lock(&IO.mu);
    }

    while (IO.active || IO.incoming) { /* owners are gone; just free */
        sope_http *h = IO.active ? IO.active : IO.incoming;
        if (h == IO.active) {
            IO.active = h->next;
            curl_multi_remove_handle(IO.multi, h->easy);
        } else {
            IO.incoming = h->next;
        }
        unref(h);
    }
    pthread_mutex_unlock(&IO.mu);
    return NULL;
}

static int ensure_started_locked(void)
{
    if (IO.started) return 1;
    if (!(IO.multi = curl_multi_init())) return 0;
    if (pthread_create(&IO.thread, NULL, io_main, NULL) != 0) {
        curl_multi_cleanup(IO.multi);
        IO.multi = NULL;
        return 0;
    }
    IO.started = 1;
    return 1;
}

/* body == NULL: a GET that follows redirects. */
static sope_http *start(const char *url, const char *const *headers, size_t nheaders, const char *body,
                        size_t body_len, const char *ca_file, sope_task *wake)
{
    sope_http *h;
    size_t i;

    if (!sope__http_available()) {
        sope__set_error(SOPE_ERROR, "libcurl failed to initialize");
        return NULL;
    }
    h = calloc(1, sizeof *h);
    if (!h) return NULL;
    if (pthread_mutex_init(&h->mu, NULL) != 0) {
        free(h);
        return NULL;
    }
    h->refs = 2; /* owner + I/O thread */
    h->wake = wake;
    h->url = sope__strdup(url);
    h->body = body ? sope__strndup(body, body_len) : NULL;
    h->body_len = body_len;
    h->easy = curl_easy_init();
    for (i = 0; i < nheaders; i++) {
        struct curl_slist *l = curl_slist_append(h->headers, headers[i]);
        if (!l) break;
        h->headers = l;
    }
    if (!h->url || (body && !h->body) || !h->easy || i < nheaders) {
        destroy(h);
        sope__set_error(SOPE_ENOMEM, "http: out of memory");
        return NULL;
    }

    curl_easy_setopt(h->easy, CURLOPT_URL, h->url);
    if (body) {
        curl_easy_setopt(h->easy, CURLOPT_POST, 1L);
        curl_easy_setopt(h->easy, CURLOPT_POSTFIELDS, h->body);
        curl_easy_setopt(h->easy, CURLOPT_POSTFIELDSIZE_LARGE, (curl_off_t)h->body_len);
    } else {
        curl_easy_setopt(h->easy, CURLOPT_HTTPGET, 1L);
        curl_easy_setopt(h->easy, CURLOPT_FOLLOWLOCATION, 1L);
        curl_easy_setopt(h->easy, CURLOPT_MAXREDIRS, 5L);
        curl_easy_setopt(h->easy, CURLOPT_TIMEOUT, 60L);
        curl_easy_setopt(h->easy, CURLOPT_ACCEPT_ENCODING, ""); /* whatever this curl can decode */
#if LIBCURL_VERSION_NUM >= 0x075500
        curl_easy_setopt(h->easy, CURLOPT_PROTOCOLS_STR, "http,https");
        curl_easy_setopt(h->easy, CURLOPT_REDIR_PROTOCOLS_STR, "http,https");
#else
        curl_easy_setopt(h->easy, CURLOPT_PROTOCOLS, (long)(CURLPROTO_HTTP | CURLPROTO_HTTPS));
        curl_easy_setopt(h->easy, CURLOPT_REDIR_PROTOCOLS, (long)(CURLPROTO_HTTP | CURLPROTO_HTTPS));
#endif
    }
    curl_easy_setopt(h->easy, CURLOPT_HTTPHEADER, h->headers);
    curl_easy_setopt(h->easy, CURLOPT_WRITEFUNCTION, on_data);
    curl_easy_setopt(h->easy, CURLOPT_WRITEDATA, h);
    curl_easy_setopt(h->easy, CURLOPT_PRIVATE, (char *)h);
    curl_easy_setopt(h->easy, CURLOPT_ERRORBUFFER, h->curl_err);
    curl_easy_setopt(h->easy, CURLOPT_NOSIGNAL, 1L);
    curl_easy_setopt(h->easy, CURLOPT_CONNECTTIMEOUT, 30L);
    curl_easy_setopt(h->easy, CURLOPT_LOW_SPEED_LIMIT, 1L); /* abort a stream silent for 5 minutes */
    curl_easy_setopt(h->easy, CURLOPT_LOW_SPEED_TIME, 300L);
    curl_easy_setopt(h->easy, CURLOPT_USERAGENT, "sope/" SOPE_VERSION_STRING);
#ifdef SOPE_CURL_BUNDLED
    if (!ca_file) ca_file = default_ca_file;
#endif
    if (ca_file) curl_easy_setopt(h->easy, CURLOPT_CAINFO, ca_file); /* curl copies it */

    pthread_mutex_lock(&IO.mu);
    if (!ensure_started_locked()) {
        pthread_mutex_unlock(&IO.mu);
        destroy(h);
        sope__set_error(SOPE_ERROR, "http: failed to start the I/O thread");
        return NULL;
    }
    h->next = IO.incoming;
    IO.incoming = h;
    curl_multi_wakeup(IO.multi);
    pthread_mutex_unlock(&IO.mu);
    return h;
}

sope_http *sope__http_post(const char *url, const char *const *headers, size_t nheaders, const char *body,
                           size_t body_len, const char *ca_file, sope_task *wake)
{
    return start(url, headers, nheaders, body ? body : "", body_len, ca_file, wake);
}

sope_http *sope__http_get(const char *url, const char *ca_file, sope_task *wake)
{
    return start(url, NULL, 0, NULL, 0, ca_file, wake);
}

void sope__http_info(sope_http *h, char *content_type, size_t ctlen, char *url, size_t urllen)
{
    pthread_mutex_lock(&h->mu);
    snprintf(content_type, ctlen, "%s", h->content_type ? h->content_type : "");
    snprintf(url, urllen, "%s", h->effective_url ? h->effective_url : "");
    pthread_mutex_unlock(&h->mu);
}

int sope__http_take(sope_http *h, sope_buf *out, long *status, char *err, size_t errlen)
{
    int done;
    pthread_mutex_lock(&h->mu);
    if (h->in.len) {
        sope__buf_append(out, h->in.ptr, h->in.len);
        sope__buf_consume(&h->in, h->in.len);
    }
    *status = h->status; /* set by the I/O thread; easy handles are not thread-safe */
    snprintf(err, errlen, "%s", h->err);
    done = h->done;
    pthread_mutex_unlock(&h->mu);
    return done;
}

void sope__http_release(sope_http *h)
{
    if (!h) return;
    pthread_mutex_lock(&h->mu);
    h->cancelled = 1;
    h->wake = NULL;
    pthread_mutex_unlock(&h->mu);
    pthread_mutex_lock(&IO.mu);
    if (IO.multi) curl_multi_wakeup(IO.multi);
    pthread_mutex_unlock(&IO.mu);
    unref(h);
}

void sope__http_shutdown(void)
{
    pthread_mutex_lock(&IO.mu);
    if (!IO.started) {
        pthread_mutex_unlock(&IO.mu);
        return;
    }
    IO.stop = 1;
    curl_multi_wakeup(IO.multi);
    pthread_mutex_unlock(&IO.mu);

    pthread_join(IO.thread, NULL);

    pthread_mutex_lock(&IO.mu);
    curl_multi_cleanup(IO.multi);
    IO.multi = NULL;
    IO.started = 0;
    IO.stop = 0;
    pthread_mutex_unlock(&IO.mu);
}

#endif /* SOPE_WITH_CURL */
