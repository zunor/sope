/* SPDX-License-Identifier: MIT */
#define _POSIX_C_SOURCE 200809L
#if defined(__APPLE__)
#define _DARWIN_C_SOURCE
#else
#define _DEFAULT_SOURCE
#endif
#include "sope.h"
#include "sope_sqlite.h"
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#define CHECK(v) do { if (!(v)) { fprintf(stderr,"%s:%d: %s (%s)\n",__FILE__,__LINE__,#v,sope_last_error()); exit(1); } } while (0)
static sope_agent_t *open_runtime(const char *dir)
{
    sope_agent_t *a;
    CHECK(sope_agent_open(&a,dir)==SOPE_OK);
    CHECK(sope_agent_set_option(a,"mock.delay_ms","0")==SOPE_OK);
    CHECK(sope_tool_register(a,"echo","","{}")==SOPE_OK);
    const char policy[]="{\"tools\":[\"echo\",\"read\"],\"authorize\":true,\"environment\":{\"PATH\":\"/usr/bin:/bin\"}}";
    CHECK(sope_agent_policy(a,policy,sizeof policy-1)==SOPE_OK);
    CHECK(sope_agent_seal(a,"host-v1","env-v1")==SOPE_OK);
    return a;
}
static sope_event_t until(sope_agent_t *a, uint32_t type)
{
    sope_event_t ev={.size=sizeof ev};
    do { CHECK(sope_poll(a,&ev,5000)==1); } while(ev.type!=type);
    return ev;
}
static void sql(sqlite3 *db,const char *statement) { CHECK(sqlite3_exec(db,statement,NULL,NULL,NULL)==SQLITE_OK); }
static sqlite3_int64 scalar(sqlite3 *db, const char *query)
{
    sqlite3_stmt *s; CHECK(sqlite3_prepare_v2(db,query,-1,&s,NULL)==SQLITE_OK);
    CHECK(sqlite3_step(s)==SQLITE_ROW);
    sqlite3_int64 value=sqlite3_column_int64(s,0);sqlite3_finalize(s);return value;
}
static void check_cursor(sope_agent_t *a, sqlite3 *db)
{
    const char *json; CHECK(sope_agent_status(a,&json,NULL)==SOPE_OK);
    const char *cursor=strstr(json,"\"last_sequence\":\"");CHECK(cursor);
    CHECK(strtoull(cursor+strlen("\"last_sequence\":\""),NULL,10)==(unsigned long long)scalar(db,"SELECT COALESCE(MAX(seq),0) FROM stream"));
}
static void test_stream_transactions(void)
{
    char dir[]="/tmp/sope-stream-XXXXXX";CHECK(mkdtemp(dir));
    char path[1024];snprintf(path,sizeof path,"%s/execution.sqlite",dir);
    sope_agent_t *a=open_runtime(dir);
    sqlite3 *db;CHECK(sqlite3_open(path,&db)==SQLITE_OK);
    uint64_t id; const char *json;
    CHECK(sope_submit(a,"receipt","!echo {}",8,&id)==SOPE_OK);
    sope_event_t gate=until(a,SOPE_EVENT_PERMISSION);CHECK(sope_permit(a,gate.call_id,1,NULL,0)==SOPE_OK);
    sope_event_t call=until(a,SOPE_EVENT_TOOL_CALL);
    /* Fail the public completion, after the receipt INSERT has executed. */
    sql(db,"CREATE TRIGGER fail_completion BEFORE INSERT ON stream WHEN NEW.type=13 BEGIN SELECT RAISE(FAIL,'injected'); END");
    CHECK(sope_tool_result(a,call.call_id,0,"receipt",7)==SOPE_ERROR);
    sope_event_t end=until(a,SOPE_EVENT_TURN_END);CHECK(end.code==SOPE_STOP_ERROR);
    CHECK(scalar(db,"SELECT COUNT(*) FROM results")==0);
    CHECK(scalar(db,"SELECT COUNT(*) FROM events WHERE kind='result'")==0);
    CHECK(scalar(db,"SELECT COUNT(*) FROM stream WHERE type=13")==0);
    CHECK(sope_agent_wait(a,0)==SOPE_ERROR);
    check_cursor(a,db);
    sope_agent_free(a);sql(db,"DROP TRIGGER fail_completion");
    a=open_runtime(dir);
    CHECK(sope_agent_recovery(a,&json,NULL)==SOPE_OK && strstr(json,"echo"));
    CHECK(sope_agent_resolve(a,call.call_id,0,"receipt",7)==SOPE_OK);
    CHECK(scalar(db,"SELECT COUNT(*) FROM results")==1);
    CHECK(scalar(db,"SELECT COUNT(*) FROM stream WHERE type=13")==1);
    CHECK(sope_agent_resume(a)==SOPE_OK);until(a,SOPE_EVENT_TURN_END);
    /* COMPACT is inserted before the outcome. A failed outcome must roll back
     * both the event and the published watermark, not leave a phantom cursor. */
    sql(db,"CREATE TRIGGER fail_terminal BEFORE INSERT ON outcomes BEGIN SELECT RAISE(FAIL,'injected'); END");
    CHECK(sope_compact(a,NULL,0,&id)==SOPE_OK);
    end=until(a,SOPE_EVENT_TURN_END);CHECK(end.code==SOPE_STOP_ERROR && !end.sequence);
    CHECK(scalar(db,"SELECT COUNT(*) FROM stream WHERE type=11")==0);
    check_cursor(a,db);
    sope_agent_free(a);sql(db,"DROP TRIGGER fail_terminal");
    a=open_runtime(dir);CHECK(sope_agent_resume(a)==SOPE_OK);
    end=until(a,SOPE_EVENT_TURN_END);CHECK(end.code==SOPE_STOP_END_TURN);
    check_cursor(a,db);sope_agent_free(a);sqlite3_close(db);
    char command[1200];snprintf(command,sizeof command,"rm -rf %s",dir);CHECK(system(command)==0);
}
int main(void)
{
    char dir[]="/tmp/sope-runtime-XXXXXX";CHECK(mkdtemp(dir));
    sope_agent_t *a=open_runtime(dir);
    CHECK(sope_agent_set_option(a,"model","changed")==SOPE_EBUSY);
    CHECK(sope_tool_register(a,"other","","{}")==SOPE_EBUSY);
    CHECK(sope_agent_policy(a,"{\"tools\":[]}",12)==SOPE_EBUSY);
    CHECK(sope_agent_set_option(a,"openai.api_key","rotate")==SOPE_OK);
    CHECK(sope_agent_set_option(a,"openai.api_key","bad\r\nkey")==SOPE_EINVAL);
    CHECK(sope_agent_set_option(a,"openai.wire_api","unknown")==SOPE_EINVAL);
    CHECK(sope_agent_wait(a,1)==SOPE_ETIMEOUT);
    uint64_t id,duplicate;const char input[]="!echo {\"value\":\"evidence\"}";
    CHECK(sope_submit(a,"stable-key",input,sizeof input-1,&id)==SOPE_OK);
    CHECK(sope_submit(a,"stable-key",input,sizeof input-1,&duplicate)==SOPE_OK && id==duplicate);
    CHECK(sope_submit(a,"stable-key","different",9,NULL)==SOPE_ECONFLICT);
    sope_event_t gate=until(a,SOPE_EVENT_PERMISSION);
    CHECK(sope_tool_result(a,gate.call_id,0,"bypass",6)==SOPE_ENOTFOUND);
    CHECK(sope_permit(a,gate.call_id,1,NULL,0)==SOPE_OK);
    sope_event_t call=until(a,SOPE_EVENT_TOOL_CALL);
    CHECK(sope_agent_suspend(a)==SOPE_OK);
    CHECK(sope_agent_wait(a,5000)==SOPE_OK);
    CHECK(sope_agent_resume(a)==SOPE_EBUSY);
    const char *json;
    CHECK(sope_agent_recovery(a,&json,NULL)==SOPE_OK && strstr(json,"echo"));
    CHECK(sope_agent_resolve(a,call.call_id,0,"KEY_RESULT",10)==SOPE_OK);
    CHECK(sope_agent_resume(a)==SOPE_OK);
    sope_event_t end=until(a,SOPE_EVENT_TURN_END);CHECK(end.code==SOPE_STOP_END_TURN && end.sequence);
    CHECK(sope_agent_outcome(a,id,&json,NULL)==SOPE_OK && strstr(json,"KEY_RESULT"));
    CHECK(sope_agent_events(a,end.sequence-1,1,&json,NULL)==SOPE_OK && strstr(json,"\"type\":4"));
    sope_agent_free(a);

    /* A failed terminal transaction must not consume the input or expose a
     * durable success. Recovery reuses the committed tool receipt. */
    a=open_runtime(dir);
    CHECK(sope_submit(a,"terminal-fault",input,sizeof input-1,&id)==SOPE_OK);
    gate=until(a,SOPE_EVENT_PERMISSION);CHECK(sope_permit(a,gate.call_id,1,NULL,0)==SOPE_OK);
    call=until(a,SOPE_EVENT_TOOL_CALL);
    char path[1024];snprintf(path,sizeof path,"%s/execution.sqlite",dir);
    sqlite3 *db;CHECK(sqlite3_open(path,&db)==SQLITE_OK);
    sql(db,"CREATE TRIGGER fail_terminal BEFORE INSERT ON outcomes BEGIN SELECT RAISE(FAIL,'injected'); END;");
    CHECK(sope_tool_result(a,call.call_id,0,"COMMITTED_RESULT",16)==SOPE_OK);
    end=until(a,SOPE_EVENT_TURN_END);CHECK(end.code==SOPE_STOP_ERROR && end.sequence==0);
    CHECK(sope_agent_outcome(a,id,&json,NULL)==SOPE_ENOTFOUND);
    CHECK(sope_agent_status(a,&json,NULL)==SOPE_OK && strstr(json,"storage_failed"));
    sope_agent_free(a);sql(db,"DROP TRIGGER fail_terminal");sqlite3_close(db);
    a=open_runtime(dir);CHECK(sope_agent_recovery(a,&json,NULL)==SOPE_OK && strstr(json,"\"calls\":[]"));
    CHECK(sope_agent_resume(a)==SOPE_OK);end=until(a,SOPE_EVENT_TURN_END);CHECK(end.code==SOPE_STOP_END_TURN);
    CHECK(sope_agent_outcome(a,id,&json,NULL)==SOPE_OK && strstr(json,"COMMITTED_RESULT"));
    sope_agent_free(a);test_stream_transactions();CHECK(sope_shutdown()==SOPE_OK);
    char command[1200];snprintf(command,sizeof command,"rm -rf %s",dir);CHECK(system(command)==0);
    puts("runtime contract, authorization, suspension and terminal rollback passed");return 0;
}
