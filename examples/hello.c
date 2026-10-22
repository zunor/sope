/* hello.c - the smallest complete host: send one message, stream the reply. */
#include <sope.h>

#include <stdio.h>
#include <string.h>

int main(int argc, char **argv)
{
    const char *msg = argc > 1 ? argv[1] : "hello, sope";
    sope_agent_t *agent;
    sope_event_t ev;
    int rc;

    if (sope_agent_new(&agent) != SOPE_OK) {
        fprintf(stderr, "sope_agent_new: %s\n", sope_last_error());
        return 1;
    }
    sope_send(agent, msg, strlen(msg), NULL);

    for (;;) {
        ev.size = sizeof ev;
        rc = sope_poll(agent, &ev, -1);
        if (rc != 1) break;
        if (ev.type == SOPE_EVENT_TEXT_DELTA) {
            fwrite(ev.data, 1, ev.data_len, stdout);
            fflush(stdout);
        } else if (ev.type == SOPE_EVENT_TURN_END) {
            putchar('\n');
            break;
        }
    }

    sope_agent_free(agent);
    return rc < 0 ? 1 : 0;
}
