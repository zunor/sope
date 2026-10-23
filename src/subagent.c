/* SPDX-License-Identifier: MIT */
/*
 * subagent.c - subagents: their types, and the children the built-in
 * `agent` tool spawns.
 *
 * Subagents follow the usual agent-tool design: the model calls `agent`; we
 * spawn a child agent with its own history, the type's system prompt and a
 * filtered tool set (never `agent` itself, so no recursion), run it as its
 * own task (so several run in parallel), and return its final message as
 * the tool result. A child shares the root's lock and event queue, tags its
 * events with agent_id = the spawning call id, and closes after one turn.
 *
 * Types are registered on the root (sope_subagent_register); every agent
 * starts with "general-purpose".
 */
#define _POSIX_C_SOURCE 200809L

#include "agent.h"

#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static const char GENERAL_PURPOSE_PROMPT[] =
    "You are a subagent. Given the task below, use the tools available to complete it. Complete the task "
    "fully, but do not gold-plate. When you are done, respond with a concise report of what you did and any "
    "key findings; the caller relays it to the user, so include only the essentials.";

static const char GENERAL_PURPOSE[] =
    "{\"name\":\"general-purpose\",\"description\":\"General-purpose agent for researching complex "
    "questions and executing multi-step tasks. Use it to work on an independent subtask in a fresh "
    "context, or to run several subtasks in parallel.\",\"tools\":\"*\",\"system_prompt\":\"-\"}";

/* ------------------------------------------------------------------------ */
/* types                                                                     */
/* ------------------------------------------------------------------------ */

void sope__subagent_free(subagent_def *d)
{
    size_t i;
    if (!d) return;
    free(d->name);
    free(d->description);
    free(d->system_prompt);
    free(d->model);
    for (i = 0; i < d->n_tools; i++) free(d->tools[i]);
    free(d->tools);
    free(d);
}

/* Parses a subagent definition. On failure sets the error, stores its code
 * in *rc and returns NULL. */
subagent_def *sope__subagent_parse(const char *json, size_t len, int *rc)
{
    sope_json *root = sope__json_parse(json, len);
    const sope_json *name, *desc, *prompt, *model, *tools, *rounds;
    subagent_def *d = NULL;
    size_t n = 0;

    *rc = SOPE_EINVAL;
    if (!root || root->type != SOPE_JSON_OBJECT) {
        sope__set_error(SOPE_EINVAL, "sope_subagent_register: definition is not a JSON object");
        goto done;
    }
    name = sope__json_get(root, "name");
    desc = sope__json_get(root, "description");
    prompt = sope__json_get(root, "system_prompt");
    model = sope__json_get(root, "model");
    tools = sope__json_get(root, "tools");
    rounds = sope__json_get(root, "max_rounds");

    if (!sope__json_string(name, &n) || !sope__valid_name(name->str, n)) {
        sope__set_error(SOPE_EINVAL, "sope_subagent_register: \"name\" must be 1-64 chars of [A-Za-z0-9_-]");
        goto done;
    }
    if (!sope__json_string(desc, &n) || !n || !sope__json_string(prompt, &n) || !n) {
        sope__set_error(SOPE_EINVAL, "sope_subagent_register: \"description\" and \"system_prompt\" are required");
        goto done;
    }
    if (tools && !(tools->type == SOPE_JSON_ARRAY || (tools->type == SOPE_JSON_STRING && !strcmp(tools->str, "*")))) {
        sope__set_error(SOPE_EINVAL, "sope_subagent_register: \"tools\" must be an array of names or \"*\"");
        goto done;
    }

    d = calloc(1, sizeof *d);
    if (!d || !(d->name = sope__strdup(name->str)) || !(d->description = sope__strdup(desc->str)) ||
        !(d->system_prompt = sope__strdup(prompt->str)) ||
        (sope__json_string(model, NULL) && !(d->model = sope__strdup(model->str))))
        goto oom;
    d->max_rounds = (int32_t)sope__json_number(rounds, 0);
    if (tools && tools->type == SOPE_JSON_ARRAY) {
        const sope_json *t;
        d->tools = calloc(tools->count ? tools->count : 1, sizeof *d->tools);
        if (!d->tools) goto oom;
        for (t = tools->child; t; t = t->next) {
            if (t->type != SOPE_JSON_STRING) continue;
            if (!(d->tools[d->n_tools] = sope__strdup(t->str))) goto oom;
            d->n_tools++;
        }
    }
    *rc = SOPE_OK;
    goto done;

oom:
    sope__subagent_free(d);
    d = NULL;
    *rc = sope__set_error(SOPE_ENOMEM, "sope_subagent_register: out of memory");
done:
    sope__json_free(root);
    return d;
}

subagent_def *sope__subagent_general_purpose(int *rc)
{
    /* Parsed like a user definition; its prompt is filled in here. */
    subagent_def *d = sope__subagent_parse(GENERAL_PURPOSE, sizeof GENERAL_PURPOSE - 1, rc);
    if (!d) return NULL;
    free(d->system_prompt);
    if (!(d->system_prompt = sope__strdup(GENERAL_PURPOSE_PROMPT))) {
        sope__subagent_free(d);
        *rc = sope__set_error(SOPE_ENOMEM, "sope_agent_new: out of memory");
        return NULL;
    }
    return d;
}

void sope__subagent_add(sope_agent_t *a, subagent_def *d)
{
    subagent_def **pp;
    pp = &a->subagents;
    while (*pp && strcmp((*pp)->name, d->name) != 0) pp = &(*pp)->next;
    if (*pp) {
        d->next = (*pp)->next;
        sope__subagent_free(*pp);
    }
    *pp = d;
}

int sope__subagent_spec_locked(const sope_agent_t *a, sope_buf *desc, sope_buf *schema)
{
    const subagent_def *d;
    sope__buf_appends(desc,
                      "Launch a subagent to handle a complex, multi-step task autonomously in its own context.\n\n"
                      "Available agent types:\n");
    for (d = a->root->subagents; d; d = d->next) sope__buf_appendf(desc, "- %s: %s\n", d->name, d->description);
    sope__buf_appends(desc,
                      "\nUsage notes:\n"
                      "- Launch several agents concurrently whenever possible, using multiple agent tool calls in "
                      "one response.\n"
                      "- The subagent cannot see this conversation: give it a complete, self-contained task.\n"
                      "- Its final report comes back to you as the tool result and is not shown to the user, so "
                      "summarize what matters.");

    sope__buf_appends(schema,
                      "{\"type\":\"object\",\"properties\":{"
                      "\"description\":{\"type\":\"string\",\"description\":\"A short (3-5 word) description of the "
                      "task\"},"
                      "\"prompt\":{\"type\":\"string\",\"description\":\"The task for the agent to perform\"},"
                      "\"subagent_type\":{\"type\":\"string\",\"description\":\"The type of agent to use; defaults "
                      "to general-purpose\",\"enum\":[");
    for (d = a->root->subagents; d; d = d->next) {
        sope__buf_append_json_string(schema, d->name, strlen(d->name));
        if (d->next) sope__buf_appends(schema, ",");
    }
    sope__buf_appends(schema, "]}},\"required\":[\"description\",\"prompt\"]}");
    return !desc->oom && !schema->oom;
}

/* ------------------------------------------------------------------------ */
/* children                                                                  */
/* ------------------------------------------------------------------------ */

static void child_closed(sope_task *task);

static int copy_options_locked(sope_agent_t *dst, const sope_agent_t *src)
{
    const option_kv *kv;
    for (kv = src->options; kv; kv = kv->next) {
        option_kv *c = calloc(1, sizeof *c);
        if (!c || !(c->key = sope__strdup(kv->key)) || !(c->value = sope__strdup(kv->value))) {
            if (c) free(c->key);
            free(c);
            return 0;
        }
        c->next = dst->options;
        dst->options = c;
    }
    return 1;
}

static int set_child_option(sope_agent_t *child, const char *key, const char *value)
{
    option_kv *kv;
    for (kv = child->options; kv; kv = kv->next)
        if (!strcmp(kv->key, key)) break;
    if (!kv) {
        if (!(kv = calloc(1, sizeof *kv)) || !(kv->key = sope__strdup(key))) {
            free(kv);
            return 0;
        }
        kv->next = child->options;
        child->options = kv;
    }
    free(kv->value);
    return (kv->value = sope__strdup(value)) != NULL;
}

static int def_allows(const subagent_def *d, const char *tool)
{
    size_t i;
    if (!d->tools) return 1;
    for (i = 0; i < d->n_tools; i++)
        if (!strcmp(d->tools[i], tool) || !strcmp(d->tools[i], "*")) return 1;
    return 0;
}

/* Builds and starts a child for one `agent` tool use. On failure returns a
 * static error message for the tool result. */
const char *sope__subagent_spawn(sope_agent_t *a, const sope_tool_use *u)
{
    sope_json *input = sope__json_parse(u->input, u->input_len);
    const char *prompt = sope__json_string(sope__json_get(input, "prompt"), NULL);
    const char *type = sope__json_string(sope__json_get(input, "subagent_type"), NULL);
    const char *err = NULL;
    sope_agent_t *child = NULL;
    const subagent_def *d;
    const tool_def *td;
    tool_def **tail;
    char rounds[16], name[65];

    if (!prompt) {
        sope__json_free(input);
        return "invalid input: \"prompt\" (string) is required";
    }
    if (!type || !*type) type = "general-purpose";

    pthread_mutex_lock(a->mu);
    for (d = a->root->subagents; d; d = d->next)
        if (!strcmp(d->name, type)) break;
    if (!d) {
        err = "unknown subagent_type";
        goto unlock;
    }
    snprintf(name, sizeof name, "%s", d->name); /* d may be replaced once we unlock */
    if (!(child = calloc(1, sizeof *child)) || !copy_options_locked(child, a) ||
        !set_child_option(child, "system", d->system_prompt) || (d->model && !set_child_option(child, "model", d->model)))
        goto oom;
    if (d->max_rounds > 0) {
        snprintf(rounds, sizeof rounds, "%d", (int)d->max_rounds);
        if (!set_child_option(child, "max_rounds", rounds)) goto oom;
    }
    if (d->tools) {
        size_t i;
        if (!(child->tool_filter = calloc(d->n_tools ? d->n_tools : 1, sizeof *child->tool_filter))) goto oom;
        for (i = 0; i < d->n_tools; i++) {
            if (!(child->tool_filter[i] = sope__strdup(d->tools[i]))) goto oom;
            child->n_tool_filter++;
        }
    }
    tail = &child->tools;
    for (td = a->tools; td; td = td->next) {
        tool_def *c;
        if (!def_allows(d, td->name)) continue;
        if (!(c = calloc(1, sizeof *c))) goto oom;
        *tail = c;
        tail = &c->next;
        if (!(c->name = sope__strdup(td->name)) || !(c->description = sope__strdup(td->description)) ||
            !(c->input_schema = sope__strdup(td->input_schema)))
            goto oom;
    }
    if (!(child->in_head = calloc(1, sizeof *child->in_head)) ||
        !(child->in_head->text = sope__strdup(prompt)))
        goto oom;
    goto unlock;

oom:
    err = "out of memory";
unlock:
    pthread_mutex_unlock(a->mu);
    if (err) {
        if (child) sope__agent_free_memory(child); /* root is NULL: freed as an unattached child */
        sope__json_free(input);
        return err;
    }

    child->root = a->root;
    child->parent = a;
    child->mu = a->mu;
    child->agent_id = u->call_id;
    child->parent_turn_id = sope__turn_id(a);
    child->in_head->turn_id = child->next_turn_id = 1;
    child->in_head->len = strlen(prompt);
    child->in_tail = child->in_head;
    sope__task_init(&child->task, sope__agent_run, child);
    child->task.on_closed = child_closed;
    sope__json_free(input);

    if (sope__push_event(a, SOPE_EVENT_SUBAGENT_START, sope__turn_id(a), u->call_id, 0, name, strlen(name), u->input,
                        u->input_len) != SOPE_OK) {
        sope__agent_free_memory(child);
        return "subagent start was not committed";
    }
    sope__pool_acquire(); /* cannot fail: the pool is running */
    pthread_mutex_lock(a->mu);
    child->sibling = a->children;
    a->children = child;
    pthread_mutex_unlock(a->mu);
    sope__task_wake(&child->task);
    return NULL;
}

/* Runs on a pool thread once a child closed: hands its final message to the
 * parent as the `agent` tool result, then frees the child. */
static void child_closed(sope_task *task)
{
    sope_agent_t *child = task->owner, *parent = child->parent, **pp;
    const sope_message *last = sope__history_last(&child->history, SOPE__MSG_ASSISTANT);
    int32_t stop = child->turns_finished ? child->last_stop : SOPE_STOP_CANCELLED;
    sope_buf result = { 0 };
    pending_call *p;

    if (stop != SOPE_STOP_END_TURN)
        sope__buf_appends(&result, stop == SOPE_STOP_CANCELLED ? "Subagent was cancelled." : "Subagent failed.");
    if (last && last->content_len) {
        if (result.len) sope__buf_appends(&result, " Partial output:\n");
        sope__buf_append(&result, last->content, last->content_len);
    }
    if (!result.len) sope__buf_appends(&result, "(no output)");

    pthread_mutex_lock(child->mu);
    p = sope__pending_find_locked(child, child->agent_id, PENDING_SUBAGENT);
    if (p && !result.oom) {
        p->content = result.ptr; /* ownership moves to the pending entry */
        p->len = result.len;
        result.ptr = NULL;
    }
    if (p) {
        p->is_error = stop != SOPE_STOP_END_TURN || result.oom;
        p->done = parent->root->suspending ? 0 : sope__journal_subagent_result(parent, p, stop);
    }
    for (pp = &parent->children; *pp; pp = &(*pp)->sibling)
        if (*pp == child) {
            *pp = child->sibling;
            break;
        }
    sope__task_wake(&parent->task);
    pthread_mutex_unlock(child->mu);

    sope__buf_free(&result);
    sope__agent_free_memory(child);
    sope__pool_release();
}
