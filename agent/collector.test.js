import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ACTIVITY_SYNC_MS, BATCH_SIZE, DASHBOARD_PORT, activityDelay, freshSession, jsonlFiles, localDashboardResponse, parseLine, publicSession, queueReconcileBatch, queueSession, recoverSessions, selectMissing, skillReads, weeklyUsageFromResponse } from "./collector.js";

describe("collector", () => {
  test("keeps only aggregate session metadata and latest cumulative usage", () => {
    const session = freshSession();
    parseLine(session, JSON.stringify({ type: "session_meta", timestamp: "2026-08-13T10:00:00Z", payload: { id: "abc", cwd: "/Users/me/secret-project", cli_version: "0.147.0" } }));
    parseLine(session, JSON.stringify({ type: "turn_context", timestamp: "2026-08-13T10:01:00Z", payload: { turn_id: "one", model: "gpt-5.6-sol", effort: "high" } }));
    parseLine(session, JSON.stringify({ type: "response_item", timestamp: "2026-08-13T10:02:00Z", payload: { type: "function_call", name: "exec_command", arguments: "SECRET" } }));
    parseLine(session, JSON.stringify({ type: "response_item", timestamp: "2026-08-13T10:02:30Z", payload: { type: "custom_tool_call", name: "exec", input: 'const r = await tools.exec_command({"cmd":"rtk cat /Users/me/.agents/skills/frontend-design/SKILL.md"});' } }));
    parseLine(session, JSON.stringify({ type: "event_msg", timestamp: "2026-08-13T10:03:00Z", payload: { type: "token_count", info: { total_token_usage: { input_tokens: 100, cached_input_tokens: 40, output_tokens: 20, reasoning_output_tokens: 5, total_tokens: 120 } } } }));
    parseLine(session, JSON.stringify({ type: "event_msg", timestamp: "2026-08-13T10:03:00Z", payload: { type: "mcp_tool_call_end", result: { Err: {} } } }));
    expect(session).toMatchObject({ id: "abc", cwdLabel: "secret-project", repo: "secret-project", model: "gpt-5.6-sol", turnCount: 1, toolCount: 2, tools: { exec_command: 1, exec: 1 }, skills: { "frontend-design": 1 }, totalTokens: 120, durationMs: 180000 });
    const state = { synced: {}, pending: {} };
    expect(queueSession(state, session)).toBe(true);
    expect(queueSession(state, session)).toBe(false);
    expect(publicSession(session)).toMatchObject({ id: "abc", errorCount: 1 });
    expect(JSON.stringify(state.pending)).not.toMatch(/SECRET|\/Users\/me\/|_turns|_subagents|SKILL\.md/);
    state.synced.abc = state.pending.abc.fingerprint;
    delete state.pending.abc;
    expect(queueSession(state, session)).toBe(false);
    session.totalTokens++;
    expect(queueSession(state, session)).toBe(true);
  });

  test("attributes cumulative token deltas to each model without inherited subagent usage", () => {
    const session=freshSession();
    const usage=(input,cached,cacheWrite,output,reasoning=0)=>JSON.stringify({type:"event_msg",payload:{type:"token_count",info:{total_token_usage:{input_tokens:input,cached_input_tokens:cached,cache_write_input_tokens:cacheWrite,output_tokens:output,reasoning_output_tokens:reasoning}}}});
    parseLine(session,JSON.stringify({type:"session_meta",payload:{id:"child",thread_source:"subagent"}}));
    parseLine(session,usage(100,40,5,20,2));
    parseLine(session,JSON.stringify({type:"turn_context",payload:{model:"gpt-luna"}}));
    parseLine(session,usage(150,60,8,30,5));
    parseLine(session,usage(150,60,8,30,5));
    parseLine(session,JSON.stringify({type:"turn_context",payload:{model:"gpt-sol"}}));
    parseLine(session,usage(300150,60060,10008,1030,7));

    expect(session).toMatchObject({inputTokens:300050,cachedInputTokens:60020,cacheWriteTokens:10003,outputTokens:1010,reasoningTokens:5,totalTokens:301060,model:"gpt-sol"});
    expect(session.modelUsage).toEqual({
      "gpt-luna":{inputTokens:50,cachedInputTokens:20,cacheWriteTokens:3,outputTokens:10,reasoningTokens:3},
      "gpt-sol":{inputTokens:300000,cachedInputTokens:60000,cacheWriteTokens:10000,outputTokens:1000,reasoningTokens:2,longInputTokens:300000,longCachedInputTokens:60000,longCacheWriteTokens:10000,longOutputTokens:1000,longReasoningTokens:2},
    });
    expect(publicSession(session)).not.toHaveProperty("_tokenUsage");
  });

  test("syncs at most every three active minutes without postponing the timer", () => {
    expect(activityDelay(null)).toBe(180_000);
    expect(activityDelay("activity")).toBeNull();
    expect(activityDelay("retry")).toBe(180_000);
    expect(ACTIVITY_SYNC_MS).toBe(180_000);
    expect(BATCH_SIZE).toBe(100);
  });

  test("keeps only the weekly percentage remaining and reset time from OpenAI usage", () => {
    expect(weeklyUsageFromResponse({rate_limit:{primary_window:{used_percent:27,reset_at:1787201417}}})).toEqual({remainingPercent:73,resetsAt:1787201417});
    expect(weeklyUsageFromResponse({rate_limit:{primary_window:{used_percent:101,reset_at:1787201417}}})).toBeNull();
  });

  test("serves loopback status and protects manual sync", async () => {
    const status={phase:"watching",system:"Test Mac",endpoint:"https://example.test",root:"/tmp/.codex",lastSuccessAt:null,nextRunAt:null,result:{found:12,parsed:12,uploaded:2,current:10},error:null};
    let runs=0;
    const request=(path,init)=>new Request(`http://127.0.0.1:${DASHBOARD_PORT}${path}`,init);
    const page=await localDashboardResponse(request("/"),status,"secret",async()=>runs++);
    expect(page.status).toBe(200);
    expect(page.headers.get("Cache-Control")).toBe("no-store");
    expect(await page.text()).toContain("Sessions parsed");
    expect((await localDashboardResponse(request("/sync",{method:"POST",headers:{Origin:"https://evil.test"},body:new URLSearchParams({csrf:"secret"})}),status,"secret",async()=>runs++)).status).toBe(403);
    expect((await localDashboardResponse(request("/sync",{method:"POST",headers:{Origin:`http://127.0.0.1:${DASHBOARD_PORT}`},body:new URLSearchParams({csrf:"secret"})}),status,"secret",async()=>runs++)).status).toBe(303);
    expect(runs).toBe(1);
  });

  test("uploads only sessions the owner-scoped backend reports missing", () => {
    const pending=["old","missing","changed"].map((id)=>({session:{id}}));
    expect(selectMissing(pending,["missing","changed"]).map(({session})=>session.id)).toEqual(["missing","changed"]);
  });

  test("rotates bounded proactive reconciliation without replacing changed sessions", () => {
    const session=(id)=>({...freshSession(),id,startedAt:"2026-01-01T00:00:00Z"});
    const state={files:{a:{session:session("a")},b:{session:session("b")},c:{session:session("c")},stale:{session:session("stale")},duplicate:{session:session("a")}},synced:{},pending:{b:{fingerprint:"changed",session:session("b")}},reconcileCursor:0};
    const files=["c","a","b","duplicate"];
    expect(queueReconcileBatch(state,files,2)).toBe(2);
    expect(state.pending.a.reconcile).toBe(true);
    expect(state.pending.b).toMatchObject({fingerprint:"changed"});
    expect(state.reconcileCursor).toBe(2);
    state.pending={};
    expect(queueReconcileBatch(state,files,2)).toBe(1);
    expect(Object.keys(state.pending)).toEqual(["c"]);
    state.pending={a:{fingerprint:"old",session:session("a"),reconcile:true}};
    state.reconcileCursor=Infinity;
    expect(queueReconcileBatch(state,files,2)).toBe(1);
    expect(Object.keys(state.pending).sort()).toEqual(["a"]);
    expect(state.reconcileCursor).toBe(1);
  });

  test("discovers history in a custom Codex home", async () => {
    const root=await mkdtemp(join(tmpdir(),"codex-stats-test-"));
    try {
      await mkdir(join(root,"sessions","2026"),{recursive:true});
      await mkdir(join(root,"archived_sessions"),{recursive:true});
      await writeFile(join(root,"sessions","2026","one.jsonl"),"{}\n");
      await writeFile(join(root,"archived_sessions","two.jsonl"),"{}\n");
      expect((await jsonlFiles(root)).map((path)=>path.slice(root.length+1)).sort()).toEqual(["archived_sessions/two.jsonl","sessions/2026/one.jsonl"]);
    } finally { await rm(root,{recursive:true,force:true}); }
  });

  test("reconciles previously synced sessions after service start or reinstall", () => {
    const id="019fea4f-89ba-7c71-b93d-53002d3bf32d";
    const path=`/tmp/rollout-2026-01-01T00-00-00-${id}.jsonl`;
    const session={...freshSession(),id,startedAt:"2026-01-01T00:00:00Z"};
    const state={files:{[path]:{offset:100,session}},synced:{[id]:"already-synced"},pending:{}};

    expect(recoverSessions(state,true)).toBe(1);
    expect(state.pending[id].session).toMatchObject({id,startedAt:"2026-01-01T00:00:00Z"});
    expect(state.pending[id].reconcile).toBe(true);
    session.totalTokens=1;
    expect(queueSession(state,session)).toBe(true);
    expect(state.pending[id].reconcile).toBeUndefined();
  });

  test("counts only direct structural skill file reads", () => {
    expect(skillReads('rtk cat /opt/skills/ponytail/SKILL.md && rtk sed -n "1,200p" /opt/skills/cloudflare/SKILL.md')).toEqual(["ponytail", "cloudflare"]);
    expect(skillReads('rtk rg "SKILL.md" /opt/skills')).toEqual([]);
  });

  test("reparses a collapsed historical subagent once and keeps its first session identity", () => {
    const parentId = "019fea4f-89ba-7c71-b93d-53002d3bf32d";
    const childId = "019feb8f-207c-77a1-a251-2cf9a0c5ddbd";
    const parent = { ...freshSession(), id: parentId, startedAt: "2026-01-01T00:00:00Z" };
    const childPath = `/tmp/rollout-2026-01-01T00-00-00-${childId}.jsonl`;
    const state = { files: { [childPath]: { offset: 100, session: parent } }, synced: { [parentId]: "already-synced" }, pending: {} };

    expect(recoverSessions(state)).toBe(1);
    expect(state.files[childPath]).toMatchObject({ offset: 0, session: { id: null } });
    parseLine(state.files[childPath].session, JSON.stringify({ type: "session_meta", timestamp: "2026-01-01T01:00:00Z", payload: { id: childId, thread_source: "subagent" } }));
    parseLine(state.files[childPath].session, JSON.stringify({ type: "session_meta", timestamp: "2026-01-01T00:00:00Z", payload: { id: parentId, source: "vscode" } }));
    expect(state.files[childPath].session).toMatchObject({ id: childId, source: "subagent" });
    expect(queueSession(state, state.files[childPath].session)).toBe(true);
    state.synced[childId] = state.pending[childId].fingerprint;
    delete state.pending[childId];
    expect(recoverSessions(state)).toBe(0);
  });

  test("reparses pre-aggregate state once", () => {
    const id = "019fea4f-89ba-7c71-b93d-53002d3bf32d";
    const legacy = { ...freshSession(), id, startedAt: "2026-01-01T00:00:00Z" };
    delete legacy.skills;
    delete legacy.modelUsage;
    const path = `/tmp/rollout-2026-01-01T00-00-00-${id}.jsonl`;
    const state = { files: { [path]: { offset: 100, session: legacy } }, synced: { [id]: "already-synced" }, pending: {} };

    expect(recoverSessions(state)).toBe(1);
    expect(state.files[path]).toMatchObject({ offset: 0, session: { id: null, skills: {}, modelUsage: {} } });
  });
});
