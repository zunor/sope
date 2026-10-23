/* SPDX-License-Identifier: MIT */
/*
 * agent.h - the agent object, shared by agent.c (public API, events,
 * lifecycle) and loop.c (turn execution, subagents). Private.
 *
 * Agents form a tree: the root is what sope_agent_new returns; subagents are
 * children spawned by the root's `agent` tool. The whole tree shares the
 * root's lock, event queue and pending-call registry, so one sope_poll (or
 * one fd) observes everything and sope_tool_result routes to any member.
 */
#ifndef SOPE_AGENT_H
#define SOPE_AGENT_H

#include "sope_internal.h"

typedef struct ev_node {
    struct ev_node *next;
    uint32_t type;
    int32_t code;
    uint64_t turn_id;
    uint64_t call_id;
    uint64_t agent_id;
    char *name;
    size_t name_len;
    char *data;
    size_t data_len;
} ev_node;

typedef struct msg_node { /* queued input, one per turn */
    struct msg_node *next;
    uint64_t turn_id;
    int compact; /* sope_compact: text holds optional instructions */
    char *text;
    size_t len;
    sope_image *images; /* sope_attach_image calls before the sope_send */
    size_t n_images;
} msg_node;

typedef struct tool_def {
    struct tool_def *next;
    char *name;
    char *description;
    char *input_schema;
} tool_def;

typedef struct option_kv {
    struct option_kv *next;
    char *key;
    char *value;
} option_kv;

typedef struct subagent_def {
    struct subagent_def *next;
    char *name;
    char *description;   /* when the model should use it */
    char *system_prompt;
    char *model;         /* NULL: inherit */
    char **tools;        /* NULL: all host tools */
    size_t n_tools;
    int32_t max_rounds;  /* 0: inherit */
} subagent_def;

typedef enum { PENDING_TOOL, PENDING_SUBAGENT, PENDING_BUILTIN } pending_kind;

typedef struct tool_run tool_run; /* a built-in tool call (tools.h) */

typedef struct pending_call {
    struct pending_call *next;
    uint64_t call_id;
    struct sope_agent *owner; /* agent whose turn waits for it */
    pending_kind kind;
    char *name;     /* tool name, for SOPE_EVENT_TOOL_END */
    uint64_t turn_id;
    tool_run *run;  /* built-in waiting for sope_permit; NULL once answered */
    int done;
    int is_error;
    char *content;
    size_t len;
    sope_image *images; /* a built-in's result images (read, web_fetch) */
    size_t n_images;
} pending_call;

typedef enum { PHASE_START, PHASE_CALL, PHASE_TOOLS, PHASE_COMPACT } turn_phase;

typedef enum { PERMIT_ASK, PERMIT_ALLOW, PERMIT_DENY } permit_mode;

typedef struct file_state { /* a file the model has read or written */
    struct file_state *next;
    char *path;
    int64_t mtime_sec, mtime_nsec;
    int64_t size;
} file_state;

typedef struct bg_shell { /* bash run_in_background */
    struct bg_shell *next;
    uint32_t id;
    char *command;
    sope_proc *proc;
    uint64_t read_pos; /* output offset bash_output has returned up to */
} bg_shell;

typedef struct turn_state {
    int active;
    msg_node *msg;
    turn_phase phase;
    uint64_t round;
    int32_t max_rounds;
    const sope_provider *provider;
    sope_call *call;     /* current model call, PHASE_CALL and PHASE_COMPACT */
    sope_message *asst;  /* assistant message of the last call, PHASE_TOOLS only */
    char *system;
    sope_tool_spec *specs; /* snapshot of offered tools for this turn; strings owned */
    const struct sope_builtin **spec_builtin; /* per spec: the built-in it runs, or NULL */
    size_t n_specs;
    uint64_t compact_threshold; /* option compact.threshold; 0: never compact automatically */
    int compact_tried;          /* compaction already ran (or failed) before this round */
    sope_message *held;         /* the turn's user message, kept out of a compaction at turn start */
    char *cwd;                  /* option cwd: where built-in tools work */
    permit_mode permit;         /* option permissions */
} turn_state;

struct sope_agent {
    sope_task task;
    struct sope_agent *root;   /* self for the root */
    struct sope_agent *parent; /* NULL for the root */
    uint64_t agent_id;         /* 0 for the root; spawning call id for subagents */
    uint64_t parent_turn_id;   /* subagents: the parent turn that spawned them */
    pthread_mutex_t *mu;       /* &root->mu_storage */

    /* ---- root only, guarded by *mu ---- */
    pthread_mutex_t mu_storage;
    pthread_cond_t poll_cv;
    ev_node *ev_head, *ev_tail;
    ev_node *delivered; /* last event returned by sope_poll */
    pending_call *pending;
    uint64_t next_call_id;
    int fd_read, fd_write; /* -1 until sope_agent_fd */
    int fd_signaled;
    subagent_def *subagents;
    bg_shell *shells;
    uint32_t next_shell_id;

    /* ---- every agent, guarded by *mu ---- */
    tool_def *tools;
    option_kv *options;
    int closing;          /* close requested */
    int closed;           /* fully closed: no more events from this agent */
    uint64_t active_turn; /* 0 if none */
    int cancel_requested; /* applies to active_turn */
    int reset_requested;
    uint64_t next_turn_id;
    msg_node *in_head, *in_tail;
    struct sope_agent *children; /* live subagents of the running turn */
    struct sope_agent *sibling;
    tool_run *runs;      /* built-in tool calls running for the current turn */
    file_state *files;   /* what read/write/edit have seen; edits require a fresh read */
    char **tool_filter;  /* subagents: tools their type allows; NULL: all */
    char *history_json;  /* the last sope_agent_history result */
    sope_image *attached; /* sope_attach_image, waiting for the next sope_send */
    size_t n_attached;
    size_t n_tool_filter;

    /* ---- owned by the running task, no lock ---- */
    turn_state turn;
    sope_history history;
    uint64_t context_tokens; /* size of the history as of the last model call */
    int turns_finished;
    int32_t last_stop;
};

/* agent.c */
int sope__push_event_locked(sope_agent_t *a, uint32_t type, uint64_t turn_id, uint64_t call_id, int32_t code,
                            const char *name, size_t name_len, const char *data, size_t data_len);
int sope__push_event(sope_agent_t *a, uint32_t type, uint64_t turn_id, uint64_t call_id, int32_t code,
                     const char *name, size_t name_len, const char *data, size_t data_len);
/* Marks the tree's queue readable when the root closed; *mu held. */
void sope__signal_closed_locked(sope_agent_t *root);
char *sope__option_dup_locked(sope_agent_t *a, const char *key);
void sope__agent_free_memory(sope_agent_t *a);
void sope__msg_node_free(msg_node *m);

/* loop.c */
sope_next sope__agent_run(sope_task *task);
void sope__history_clear(sope_history *h);
/* The history as a JSON array (sope.h: sope_agent_history); malloc'd, NULL on OOM. */
char *sope__history_json(const sope_history *h, size_t *len);
/* Parses such an array into *out; SOPE_EINVAL (err says why) or SOPE_ENOMEM. */
int sope__history_parse(sope_history *out, const char *json, size_t len, char *err, size_t cap);

#endif /* SOPE_AGENT_H */
