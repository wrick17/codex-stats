import { describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { aggregateSkills, estimatedCost, ingestSessions, onRequest, parsePrices, SESSION_UPSERT_SQL, statsScope, statsWindow } from "./[[path]].js";

async function signedIngest(body, token="secret") {
  const text=typeof body === "string" ? body : JSON.stringify(body), timestamp=Date.now().toString();
  const key=await crypto.subtle.importKey("raw",new TextEncoder().encode(token),{name:"HMAC",hash:"SHA-256"},false,["sign"]);
  const signature=[...new Uint8Array(await crypto.subtle.sign("HMAC",key,new TextEncoder().encode(`${timestamp}.${text}`)))].map((byte)=>byte.toString(16).padStart(2,"0")).join("");
  return {token,request:new Request("https://preview.pages.dev/api/ingest",{method:"POST",headers:{"X-Codex-Timestamp":timestamp,"X-Codex-Signature":signature},body:text})};
}

describe("daily API price estimate", () => {
  test("keeps fixed windows and makes lifetime unbounded", () => {
    expect(statsWindow("7",1_000_000)).toEqual({days:7,since:new Date(1_000_000-7*86400000).toISOString()});
    expect(statsWindow("90",1_000_000).days).toBe(90);
    expect(statsWindow("lifetime",1_000_000)).toEqual({days:"lifetime",since:null});
    expect(statsWindow("365",1_000_000).days).toBe(30);
    expect(statsScope("lifetime","all",1_000_000)).toMatchObject({where:"1=1",args:[]});
    expect(statsScope("lifetime","machine",1_000_000)).toMatchObject({where:"1=1 AND system_id = ?",args:["machine"]});
  });

  test("parses flagship standard and grouped Codex rates", () => {
    const rates=parsePrices(`### Standard pricing data
| Model | Short context input | Short context cached input | Short context cache writes | Short context output | Long context input |
| --- | --- | --- | --- | --- | --- |
| gpt-5.6-sol | $5.00 | $0.50 | $6.25 | $30.00 | $10.00 |
### Batch pricing data
| gpt-5.6-sol | $2.50 | $0.25 | $3.125 | $15.00 | $5.00 |
Standard
### Grouped Pricing Table data
| Model | Modality | Input | Cached input | Output |
| gpt-realtime | Text | $4.00 | $0.40 | $24.00 |
### Grouped Pricing Table data
| Category | Model | Input | Cached input | Output |
| --- | --- | --- | --- | --- |
| Codex | gpt-5.3-codex | $1.75 | $0.175 | $14.00 |
Fast mode
### Grouped Pricing Table data
| Category | Model | Input | Cached input | Output |
| Codex | gpt-5.3-codex | $3.50 | $0.35 | $28.00 |
`);
    expect(rates["gpt-5.6-sol"]).toEqual({ input:5, cached:.5, cacheWrite:6.25, output:30 });
    expect(rates["gpt-5.3-codex"].output).toBe(14);
    expect(rates["gpt-5.3-codex"].cacheWrite).toBe(1.75);
    expect(rates["gpt-realtime"]).toBeUndefined();
  });

  test("prices totals and days from the same session rows", () => {
    const rates={
      "gpt-5.6-sol":{input:5,cached:.5,cacheWrite:6.25,output:30},
      "gpt-5.3-codex":{input:1.75,cached:.175,cacheWrite:1.75,output:14},
    };
    const result=estimatedCost([
      {day:"2026-08-12",model:"gpt-5.6-sol",input_tokens:1_000_000,cached_input_tokens:500_000,cache_write_tokens:100_000,output_tokens:100_000},
      {day:"2026-08-13",model:"gpt-5.3-codex",input_tokens:1_000_000,cached_input_tokens:500_000,cache_write_tokens:100_000,output_tokens:100_000},
      {day:"2026-08-13",model:"unknown",input_tokens:100_000,output_tokens:0},
      {day:"2026-08-14",model:"unknown",input_tokens:100_000,output_tokens:0},
    ],rates);
    expect(result.usd).toBeCloseTo(8.2375);
    expect(result.daily.map(({day,usd})=>[day,usd])).toEqual([["2026-08-12",5.875],["2026-08-13",2.3625],["2026-08-14",0]]);
    expect(result.daily[2].coverage).toBe(0);
    expect(result.coverage).toBeCloseTo(2_200_000/2_400_000);
  });

  test("attributes daily sessions, chart tokens, and cost by model", () => {
    const rates={"gpt-priced":{input:1,cached:0,cacheWrite:1,output:2}};
    const {dailyModels}=estimatedCost([
      {day:"2026-08-13",model:"gpt-priced",total_tokens:120,input_tokens:100,output_tokens:20},
      {day:"2026-08-13",model:"gpt-priced",total_tokens:60,input_tokens:50,output_tokens:10},
      {day:"2026-08-13",model:null,total_tokens:300,input_tokens:250,output_tokens:50},
      {day:"2026-08-14",model:"gpt-priced",total_tokens:30,input_tokens:20,output_tokens:10},
    ],rates);
    expect(dailyModels["2026-08-13"].map(({usd,...model})=>model)).toEqual([
      {model:"Unknown",sessions:1,tokens:300},
      {model:"gpt-priced",sessions:2,tokens:180},
    ]);
    expect(dailyModels["2026-08-13"][1].usd).toBeCloseTo(0.00021);
    expect(dailyModels["2026-08-14"][0]).toMatchObject({model:"gpt-priced",sessions:1,tokens:30});
    expect(dailyModels["2026-08-14"][0].usd).toBeCloseTo(0.00004);
  });
});

describe("ingest backend", () => {
  test("normalizes a large payload for one json_each statement", () => {
    const sessions=ingestSessions([
      {id:"a",startedAt:"2026-08-13T00:00:00Z",inputTokens:-4,tools:{exec:2},skills:{imagegen:2}},
      {id:null,startedAt:"2026-08-13T00:00:00Z"},
    ],"machine","2026-08-13T01:00:00Z");
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({uid:"machine:a",inputTokens:0,toolsJson:'{"exec":2}',skillsJson:'{"imagegen":2}'});
    expect(SESSION_UPSERT_SQL).toContain("FROM json_each(?)");
  });

  test("set-upserts skills and preserves them when an older collector omits the field", () => {
    const db=new Database(":memory:");
    db.run(`CREATE TABLE sessions (uid TEXT PRIMARY KEY,id TEXT,system_id TEXT,started_at TEXT,ended_at TEXT,cwd_label TEXT,repo TEXT,branch TEXT,source TEXT,cli_version TEXT,model TEXT,effort TEXT,status TEXT,input_tokens INTEGER,cached_input_tokens INTEGER,cache_write_tokens INTEGER,output_tokens INTEGER,reasoning_tokens INTEGER,total_tokens INTEGER,duration_ms INTEGER,user_messages INTEGER,assistant_messages INTEGER,turn_count INTEGER,tool_count INTEGER,error_count INTEGER,subagent_count INTEGER,tools_json TEXT,skills_json TEXT,updated_at TEXT)`);
    const rows=ingestSessions([{id:"a",startedAt:"2026-08-13",totalTokens:10,skills:{imagegen:2}},{id:"b",startedAt:"2026-08-13",totalTokens:20}],"machine","now");
    db.query(SESSION_UPSERT_SQL).run(JSON.stringify(rows));
    const older=ingestSessions([{id:"a",startedAt:"2026-08-13",totalTokens:30}],"machine","later");
    db.query(SESSION_UPSERT_SQL).run(JSON.stringify(older));
    expect(db.query("SELECT id,total_tokens,skills_json FROM sessions ORDER BY id").all()).toEqual([
      {id:"a",total_tokens:30,skills_json:'{"imagegen":2}'},
      {id:"b",total_tokens:20,skills_json:null},
    ]);
    db.close();
  });

  test("ranks valid skill usage from existing stats rows", () => {
    expect(aggregateSkills([
      {skills_json:'{"imagegen":2,"cloudflare":1}'},
      {skills_json:'{"cloudflare":3,"ignored":-1}'},
      {skills_json:null},
      {skills_json:"invalid"},
    ])).toEqual([{name:"cloudflare",count:4},{name:"imagegen",count:2}]);
  });

  test("authenticated ingest executes exactly two D1 statements", async () => {
    const {request,token}=await signedIngest({system:{id:"machine",name:"Mac"},sessions:[{id:"a",startedAt:"2026-08-13"},{id:"b",startedAt:"2026-08-13"}]});
    const prepared=[];
    const DB={prepare(sql){prepared.push(sql); return {bind(...args){return {sql,args};}};},async batch(statements){expect(statements).toHaveLength(2);}};
    const response=await onRequest({request,env:{DB,INGEST_TOKEN:token},params:{path:["ingest"]}});
    expect(prepared).toHaveLength(2);
    expect(await response.json()).toMatchObject({ok:true,accepted:2});
    expect(response.headers.get("Cache-Control")).toContain("no-store");
  });

  test("separates request errors from backend failures", async () => {
    const malformed=await signedIngest("{");
    const bad=await onRequest({request:malformed.request,env:{INGEST_TOKEN:malformed.token},params:{path:["ingest"]}});
    expect(bad.status).toBe(400);
    const valid=await signedIngest({system:{id:"machine"},sessions:[]});
    const DB={prepare(sql){return {bind(...args){return {sql,args};}};},async batch(){throw new Error("schema missing");}};
    const failed=await onRequest({request:valid.request,env:{DB,INGEST_TOKEN:valid.token},params:{path:["ingest"]}});
    expect(failed.status).toBe(500);
    expect(await failed.json()).toEqual({error:"Request failed"});
    const unauthorized=await onRequest({request:new Request("https://codex-stats.pages.dev/api/me"),env:{},params:{path:["me"]}});
    expect(unauthorized.status).toBe(401);
    expect(unauthorized.headers.get("Cache-Control")).toContain("no-store");
  });

  test("caps a single collector request at 1000 sessions", async () => {
    const signed=await signedIngest({system:{id:"machine"},sessions:Array.from({length:1001},(_,id)=>({id:String(id),startedAt:"2026-08-13"}))});
    const response=await onRequest({request:signed.request,env:{INGEST_TOKEN:signed.token},params:{path:["ingest"]}});
    expect(response.status).toBe(400);
  });

  test("keeps the json_each binding below D1's string limit", async () => {
    const sessions=Array.from({length:250},(_,id)=>({id:String(id),startedAt:"2026-08-13",tools:{large:"x".repeat(8000)}}));
    const signed=await signedIngest({system:{id:"machine"},sessions});
    const response=await onRequest({request:signed.request,env:{INGEST_TOKEN:signed.token},params:{path:["ingest"]}});
    expect(response.status).toBe(413);
  });

});
