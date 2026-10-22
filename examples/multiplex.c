/* SPDX-License-Identifier: MIT */
/* multiplex.c - one thread drives many agents through their readable fds.
 *
 * Each agent's fd is readable exactly while sope_poll would not block, so a
 * host can fold sope into any poll/epoll/kqueue/libuv loop: wait on the fds,
 * then drain the ready agents with non-blocking sope_poll calls. */
#include <sope.h>

#include <poll.h>
#include <stdio.h>
#include <string.h>

#define N 8

int main(void)
{
    sope_agent_t *agents[N];
    struct pollfd fds[N];
    int i, remaining = N;

    for (i = 0; i < N; i++) {
        char msg[32];
        if (sope_agent_new(&agents[i]) != SOPE_OK) return 1;
        sope_agent_set_option(agents[i], "mock.delay_ms", "10");
        fds[i].fd = sope_agent_fd(agents[i]);
        fds[i].events = POLLIN;
        snprintf(msg, sizeof msg, "hello from host %d", i);
        sope_send(agents[i], msg, strlen(msg), NULL);
    }

    while (remaining > 0) {
        if (poll(fds, N, -1) < 0) break;
        for (i = 0; i < N; i++) {
            sope_event_t ev;
            if (!(fds[i].revents & POLLIN)) continue;
            ev.size = sizeof ev;
            while (sope_poll(agents[i], &ev, 0) == 1) {
                if (ev.type == SOPE_EVENT_TURN_END) {
                    printf("agent %d finished its turn\n", i);
                    fds[i].fd = -1; /* stop watching it */
                    remaining--;
                }
            }
        }
    }

    for (i = 0; i < N; i++) sope_agent_free(agents[i]);
    return 0;
}
