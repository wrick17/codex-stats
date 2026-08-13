#!/usr/bin/env bun
import { homedir, hostname, platform, arch, tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { watch } from "node:fs";
import { mkdir, readdir, readFile, rename, unlink, writeFile } from "node:fs/promises";

export const ACTIVITY_SYNC_MS = 180000;
export const RETRY_MS = 300000;
export const BATCH_SIZE = 100;
export const DASHBOARD_PORT = 47821;
export const activityDelay = (timerKind) => timerKind==="activity" ? null : ACTIVITY_SYNC_MS;
export const selectMissing = (pending, ids) => { const missing=new Set(ids); return pending.filter(({session})=>missing.has(session.id)); };

export function queueReconcileBatch(state,files,limit=BATCH_SIZE) {
  const existing=Object.values(state.pending).filter((entry)=>entry?.reconcile).length, room=Math.max(0,limit-existing);
  if(!room) return 0;
  const unique=new Map();
  for(const path of files) { const session=state.files[path]?.session; if(session?.id&&session.startedAt) unique.set(session.id,session); }
  const sessions=[...unique.values()].sort((a,b)=>a.id.localeCompare(b.id));
  if(!sessions.length) return 0;
  const saved=state.reconcileCursor, start=Number.isSafeInteger(saved)&&saved>=0&&saved<sessions.length?saved:0, batch=sessions.slice(start,start+room);
  for(const session of batch) if(!state.pending[session.id]) { const next=publicSession(session); state.pending[session.id]={fingerprint:JSON.stringify(next),session:next,reconcile:true}; }
  state.reconcileCursor=start+batch.length>=sessions.length?0:start+batch.length;
  return batch.length;
}

const PUBLIC_SESSION_KEYS = [
  "id", "startedAt", "endedAt", "cwdLabel", "repo", "branch", "source", "cliVersion", "model", "effort",
  "status", "inputTokens", "cachedInputTokens", "cacheWriteTokens", "outputTokens", "reasoningTokens", "totalTokens",
  "durationMs", "userMessages", "assistantMessages", "turnCount", "toolCount", "errorCount", "subagentCount", "tools", "skills",
];

export const publicSession = (session) => ({
  ...Object.fromEntries(PUBLIC_SESSION_KEYS.map((key) => [key, session[key]])),
  skills: session.skills || {},
});

export function skillReads(input) {
  if (typeof input !== "string") return [];
  const skills = new Set();
  const directRead = /\brtk\s+(?:proxy\s+)?(?:cat\b|sed\b[^;&|\n]{0,120})[^;&|\n]*?\/skills\/([^/"'\s;|&`]+)\/SKILL\.md\b/g;
  for (const match of input.matchAll(directRead)) skills.add(match[1]);
  return [...skills];
}

export function queueSession(state, session) {
  if (!session.id || !session.startedAt) return false;
  const next = publicSession(session);
  const nextFingerprint = JSON.stringify(next);
  if ((state.pending[session.id]?.fingerprint || state.synced[session.id]) === nextFingerprint) return false;
  state.pending[session.id] = { fingerprint: nextFingerprint, session: next };
  return true;
}

export function recoverSessions(state, reconcile=false) {
  let recovered = 0;
  for (const [path, entry] of Object.entries(state.files)) {
    const fileId = basename(path).match(/([0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})\.jsonl$/)?.[1];
    const session = entry?.session;
    if (!fileId || !session) continue;
    if (!Object.hasOwn(session, "skills")) {
      entry.offset = 0;
      entry.session = freshSession();
      recovered++;
    } else if (session.id === fileId) {
      if (reconcile) {
        const next=publicSession(session), fingerprint=JSON.stringify(next);
        if (!state.pending[session.id]) { state.pending[session.id]={fingerprint,session:next,reconcile:true}; recovered++; }
      } else if (queueSession(state, session)) recovered++;
    } else if (!state.synced[fileId] && !state.pending[fileId]) {
      entry.offset = 0;
      entry.session = freshSession();
      recovered++;
    }
  }
  return recovered;
}

export const freshSession = () => ({
  id: null, startedAt: null, endedAt: null, cwdLabel: null, repo: null, branch: null, source: null,
  cliVersion: null, model: null, effort: null, status: "active", inputTokens: 0, cachedInputTokens: 0,
  cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, durationMs: 0,
  userMessages: 0, assistantMessages: 0, turnCount: 0, toolCount: 0, errorCount: 0, subagentCount: 0,
  tools: {}, skills: {}, _firstTs: null, _lastTs: null, _turns: {}, _subagents: {},
});

const noteTime = (session, timestamp) => {
  if (!timestamp) return;
  session._firstTs = !session._firstTs || timestamp < session._firstTs ? timestamp : session._firstTs;
  session._lastTs = !session._lastTs || timestamp > session._lastTs ? timestamp : session._lastTs;
};

export function parseLine(session, line) {
  let record;
  try { record = JSON.parse(line); } catch { return session; }
  noteTime(session, record.timestamp);
  const payload = record.payload || {};

  if (record.type === "session_meta") {
    if (!session.id) {
      session.id = payload.id || payload.session_id || null;
      session.startedAt = payload.timestamp || record.timestamp || session.startedAt;
      session.source = payload.thread_source || (typeof payload.source === "string" ? payload.source : payload.originator) || session.source;
      session.cliVersion = payload.cli_version || session.cliVersion;
      session.branch = payload.git?.branch || session.branch;
      if (payload.cwd) {
        session.cwdLabel = basename(payload.cwd);
        session.repo = basename(payload.git?.repository_url || payload.cwd).replace(/\.git$/, "");
      }
    }
  } else if (record.type === "turn_context") {
    session.model = payload.model || session.model;
    session.effort = payload.effort || session.effort;
    if (payload.turn_id) session._turns[payload.turn_id] = 1;
  } else if (record.type === "event_msg") {
    if (payload.type === "user_message") session.userMessages++;
    if (payload.type === "agent_message" && payload.phase === "final_answer") session.assistantMessages++;
    if (payload.type === "task_started" && payload.turn_id) session._turns[payload.turn_id] = 1;
    if (payload.type === "task_complete") { session.status = "complete"; session.endedAt = record.timestamp; }
    if (["task_aborted", "turn_aborted"].includes(payload.type)) { session.status = "aborted"; session.endedAt = record.timestamp; }
    if (payload.type === "token_count" && payload.info?.total_token_usage) {
      const usage = payload.info.total_token_usage;
      session.inputTokens = Number(usage.input_tokens || 0);
      session.cachedInputTokens = Number(usage.cached_input_tokens || 0);
      session.cacheWriteTokens = Number(usage.cache_write_input_tokens || 0);
      session.outputTokens = Number(usage.output_tokens || 0);
      session.reasoningTokens = Number(usage.reasoning_output_tokens || 0);
      session.totalTokens = Number(usage.total_tokens || 0);
    }
    if (payload.type === "sub_agent_activity" && payload.agent_thread_id) session._subagents[payload.agent_thread_id] = 1;
    if (payload.type === "mcp_tool_call_end" && (payload.result?.isError || payload.result?.Err)) session.errorCount++;
  } else if (record.type === "response_item") {
    if (payload.type === "custom_tool_call" && payload.name === "exec") {
      for (const skill of skillReads(payload.input)) session.skills[skill] = (session.skills[skill] || 0) + 1;
    }
    if (["function_call", "custom_tool_call", "local_shell_call", "web_search_call"].includes(payload.type)) {
      const name = payload.name || payload.action?.type || payload.type;
      session.toolCount++;
      session.tools[name] = (session.tools[name] || 0) + 1;
    }
  }

  session.turnCount = Object.keys(session._turns).length || session.userMessages;
  session.subagentCount = Object.keys(session._subagents).length;
  if (session.status === "active") session.endedAt = session._lastTs;
  else session.endedAt ||= session._lastTs;
  if (session.startedAt && session.endedAt) session.durationMs = Math.max(0, Date.parse(session.endedAt) - Date.parse(session.startedAt));
  return session;
}

export async function jsonlFiles(root) {
  const found = [];
  async function walk(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await walk(path);
      else if (entry.name.endsWith(".jsonl")) found.push(path);
    }
  }
  await walk(join(root, "sessions"));
  await walk(join(root, "archived_sessions"));
  return found;
}

async function installationId(root) {
  return (await readFile(join(root, "installation_id"), "utf8").catch(() => hostname())).trim();
}

async function codexVersion() {
  try { return (await Bun.$`codex --version`.text()).trim().replace(/^codex-cli\s+/, ""); } catch { return null; }
}

async function collectorToken() {
  if (process.env.CODEX_STATS_TOKEN) return process.env.CODEX_STATS_TOKEN;
  if (platform() === "darwin") {
    try { return (await Bun.$`security find-generic-password -a codex-stats -s codex-stats-ingest -w`.text()).trim(); } catch {}
  }
  return null;
}

async function signature(token, timestamp, body) {
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(token), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${body}`)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

async function post(url, body, token) {
  const timestamp = Date.now().toString();
  const headers = { "Content-Type": "application/json", "X-Codex-Token":token, "X-Codex-Timestamp": timestamp, "X-Codex-Signature": await signature(token, timestamp, body) };
  if (platform()!=="darwin") return fetch(url,{method:"POST",headers,body});
  const bodyPath=join(tmpdir(),`codex-stats-${process.pid}-${crypto.randomUUID()}.json`);
  await writeFile(bodyPath,body,{mode:0o600});
  try {
    const config=Object.entries(headers).map(([name,value])=>`header = "${name}: ${value}"`).join("\n");
    const child=Bun.spawn(["/usr/bin/curl","--silent","--show-error","--write-out","\n%{http_code}","--request","POST","--data-binary",`@${bodyPath}`,url,"--config","-"],{stdin:"pipe",stdout:"pipe",stderr:"pipe"});
    child.stdin.write(config); child.stdin.end();
    const [exitCode,output,error]=await Promise.all([child.exited,new Response(child.stdout).text(),new Response(child.stderr).text()]);
    const match=output.match(/\n(\d{3})$/), status=match?Number(match[1]):0, text=match?output.slice(0,-4):output||error;
    return {ok:exitCode===0&&status>=200&&status<300,status:status||500,text:async()=>text};
  } finally { await unlink(bodyPath).catch(()=>{}); }
}

async function loadState(path) {
  let saved;
  try { saved = JSON.parse(await readFile(path, "utf8")); } catch { saved = {}; }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) saved = {};
  const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return { files: object(saved.files), synced: object(saved.synced), pending: object(saved.pending), reconcileCursor:Number.isSafeInteger(saved.reconcileCursor)&&saved.reconcileCursor>=0?saved.reconcileCursor:0 };
}

async function saveState(path, state) {
  const temporary = `${path}.${process.pid}.tmp`;
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  await writeFile(temporary, JSON.stringify(state), { mode: 0o600 });
  await rename(temporary, path);
}

async function sync(reconcile=false) {
  const codexRoot = process.env.CODEX_HOME || join(homedir(), ".codex");
  const statePath = join(homedir(), ".codex-stats", "state.json");
  const state = await loadState(statePath);
  let changed = recoverSessions(state,reconcile);

  const files=await jsonlFiles(codexRoot);
  for (const path of files) {
    const previous = state.files[path] || { offset: 0, session: freshSession() };
    const file = Bun.file(path);
    if (file.size < previous.offset) { previous.offset = 0; previous.session = freshSession(); }
    if (file.size === previous.offset) continue;
    const bytes = new Uint8Array(await file.slice(previous.offset).arrayBuffer());
    const newline = bytes.lastIndexOf(10);
    if (newline < 0) continue;
    const complete = bytes.slice(0, newline + 1);
    for (const line of new TextDecoder().decode(complete).split("\n")) if (line) parseLine(previous.session, line);
    previous.offset += complete.byteLength;
    state.files[path] = previous;
    if (queueSession(state, previous.session)) changed++;
  }

  if(!reconcile) queueReconcileBatch(state,files);

  await saveState(statePath, state);
  const allPending=Object.values(state.pending).filter((entry)=>entry?.session?.id&&entry.fingerprint);
  const pending=reconcile?allPending:[...allPending.filter((entry)=>!entry.reconcile),...allPending.filter((entry)=>entry.reconcile).slice(0,BATCH_SIZE)];
  const parsed=Object.values(state.files).filter((entry)=>entry?.session?.id).length;
  if (!pending.length) {
    console.log("codex-stats: nothing new");
    return {found:files.length,parsed,uploaded:0,current:parsed};
  }
  const endpoint = process.env.CODEX_STATS_URL || "https://codex-stats.pages.dev";
  const token = await collectorToken();
  if (!token) throw new Error("Set CODEX_STATS_TOKEN (or add codex-stats-ingest to macOS Keychain)");
  const id = await installationId(codexRoot);
  const system = { id, name: process.env.CODEX_STATS_SYSTEM || hostname(), hostname: hostname(), platform: platform(), arch: arch(), codexVersion: await codexVersion() };
  const base=endpoint.replace(/\/$/,"");
  let uploaded=0, current=0;
  for (let offset=0;offset<pending.length;offset+=BATCH_SIZE) {
    const batch=pending.slice(offset,offset+BATCH_SIZE);
    const historical=batch.filter((entry)=>entry.reconcile), required=batch.filter((entry)=>!entry.reconcile);
    if (historical.length) {
      const manifest=JSON.stringify({systemId:id,sessions:historical.map(({session})=>({id:session.id,updatedAt:session.endedAt||session.startedAt}))});
      const check=await post(`${base}/api/missing`,manifest,token);
      if (!check.ok) throw new Error(`Reconciliation failed (${check.status}): ${await check.text()}`);
      required.push(...selectMissing(historical,JSON.parse(await check.text()).missing||[]));
    }
    if (required.length) {
      const body=JSON.stringify({system,sessions:required.map(({session})=>session)});
      const response=await post(`${base}/api/ingest`,body,token);
      if (!response.ok) throw new Error(`Sync failed (${response.status}): ${await response.text()}`);
    }
    uploaded+=required.length;
    current+=batch.length-required.length;
    for (const {fingerprint,session} of batch) {
      state.synced[session.id]=fingerprint;
      delete state.pending[session.id];
    }
    await saveState(statePath,state);
  }
  console.log(`codex-stats: synced ${uploaded} sessions${current ? ` (${current} already current)` : changed<pending.length ? " including retries" : ""}`);
  return {found:files.length,parsed,uploaded,current};
}

const html = (value) => String(value??"").replace(/[&<>"']/g,(char)=>({"&":"&amp;","<":"&lt;",">":"&gt;",'"':"&quot;","'":"&#39;"})[char]);
const localTime = (value) => value ? new Date(value).toLocaleString() : "Not yet";

export function localDashboardPage(status,nonce) {
  const result=status.result||{};
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Codex Stats · Local</title><style>
  :root{color-scheme:dark;--ink:#e9e4d8;--muted:#8c928d;--line:#30352f;--green:#a9c181;--amber:#e0a56b;--red:#df7d76;background:#101210;font-family:SFMono-Regular,Menlo,Monaco,monospace}*{box-sizing:border-box}body{margin:0;min-height:100vh;background:radial-gradient(circle at 80% 0,#20271e 0,transparent 35%),#101210;color:var(--ink)}main{width:min(840px,calc(100% - 32px));margin:clamp(36px,9vh,100px) auto}header{border-top:1px solid var(--line);padding-top:18px;display:flex;justify-content:space-between;gap:24px;align-items:start}.eyebrow{color:var(--amber);font-size:11px;letter-spacing:.16em;text-transform:uppercase}h1{font-family:"Iowan Old Style",Georgia,serif;font-weight:500;font-size:clamp(34px,7vw,68px);line-height:.94;margin:12px 0}.state{display:flex;align-items:center;gap:9px;text-transform:uppercase;font-size:12px}.state i{width:9px;height:9px;border-radius:50%;background:${status.phase==="error"?"var(--red)":status.phase==="syncing"?"var(--amber)":"var(--green)"};box-shadow:0 0 14px currentColor}.grid{display:grid;grid-template-columns:repeat(4,1fr);border:1px solid var(--line);margin:38px 0}.cell{padding:20px;min-height:112px;border-right:1px solid var(--line)}.cell:last-child{border:0}.cell span{display:block;color:var(--muted);font-size:10px;text-transform:uppercase;letter-spacing:.12em}.cell strong{display:block;font-size:17px;margin-top:17px;font-weight:500;overflow-wrap:anywhere}.wide{display:grid;grid-template-columns:1fr auto;gap:24px;align-items:end;padding:18px 0;border-bottom:1px solid var(--line)}.wide p{margin:7px 0 0;color:var(--muted);font-size:12px;overflow-wrap:anywhere}.actions{display:flex;gap:10px}.button,button{appearance:none;border:1px solid var(--line);background:#191c18;color:var(--ink);padding:12px 16px;font:inherit;font-size:12px;text-decoration:none;cursor:pointer}.primary{background:var(--green);border-color:var(--green);color:#11150f;font-weight:700}.error{color:var(--red);margin:18px 0;font-size:12px}footer{margin-top:32px;color:var(--muted);font-size:10px;letter-spacing:.08em;text-transform:uppercase}@media(max-width:620px){header,.wide{display:block}.state{margin-top:18px}.grid{grid-template-columns:1fr 1fr}.cell:nth-child(2){border-right:0}.cell{border-bottom:1px solid var(--line);min-height:94px}.actions{margin-top:18px}.button,button{flex:1}}
  </style></head><body><main><header><div><div class="eyebrow">Loopback control panel</div><h1>Codex Stats</h1></div><div class="state"><i></i>${html(status.phase)}</div></header>
  <section class="grid"><div class="cell"><span>Files found</span><strong>${html(result.found??"—")}</strong></div><div class="cell"><span>Sessions parsed</span><strong>${html(result.parsed??"—")}</strong></div><div class="cell"><span>Last upload</span><strong>${html(result.uploaded??"—")}</strong></div><div class="cell"><span>Already current</span><strong>${html(result.current??"—")}</strong></div></section>
  <section class="wide"><div><div class="eyebrow">Last successful check</div><p>${html(localTime(status.lastSuccessAt))}</p></div><div class="actions"><a class="button" href="/">Refresh</a><form method="post" action="/sync"><input type="hidden" name="csrf" value="${html(nonce)}"><button class="primary" type="submit">Sync now</button></form></div></section>
  <section class="wide"><div><div class="eyebrow">Machine</div><p>${html(status.system)}</p></div><div><div class="eyebrow">Next automatic sync</div><p>${html(localTime(status.nextRunAt))}</p></div></section>
  <section class="wide"><div><div class="eyebrow">Codex home</div><p>${html(status.root)}</p></div></section>
  <section class="wide"><div><div class="eyebrow">Backend</div><p>${html(status.endpoint)}</p></div></section>${status.error?`<p class="error">${html(status.error)}</p>`:""}
  <footer>127.0.0.1 only · manual refresh · no polling</footer></main></body></html>`;
}

export async function localDashboardResponse(request,status,nonce,syncNow,port=DASHBOARD_PORT) {
  const url=new URL(request.url), allowed=new Set([`http://127.0.0.1:${port}`,`http://localhost:${port}`]);
  const headers={"Cache-Control":"no-store","Content-Security-Policy":"default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'","X-Content-Type-Options":"nosniff"};
  if (!allowed.has(url.origin)) return new Response("Forbidden",{status:403,headers});
  if (request.method==="GET"&&url.pathname==="/") return new Response(localDashboardPage(status,nonce),{headers:{...headers,"Content-Type":"text/html; charset=utf-8"}});
  if (request.method==="POST"&&url.pathname==="/sync") {
    if (!allowed.has(request.headers.get("Origin"))||!request.headers.get("Content-Type")?.startsWith("application/x-www-form-urlencoded")||(await request.formData()).get("csrf")!==nonce) return new Response("Forbidden",{status:403,headers});
    await syncNow();
    return new Response(null,{status:303,headers:{...headers,Location:"/"}});
  }
  return new Response("Not found",{status:404,headers});
}

async function checkCredential() {
  const root=process.env.CODEX_HOME||join(homedir(),".codex"), token=await collectorToken();
  if (!token) return 2;
  const body=JSON.stringify({systemId:await installationId(root),sessions:[]});
  try {
    const response=await post(`${(process.env.CODEX_STATS_URL||"https://codex-stats.pages.dev").replace(/\/$/,"")}/api/missing`,body,token);
    if (response.ok) return 0;
    return response.status===401 ? 2 : 1;
  } catch { return 1; }
}

async function main() {
  if (process.argv.includes("--check")) { process.exitCode=await checkCredential(); return; }
  if (!process.argv.includes("--watch")) return sync(true);
  const root = process.env.CODEX_HOME || join(homedir(), ".codex");
  let timer = null;
  let timerKind = null;
  let syncing = false;
  let rerunMode = null;
  let initial = true;
  const endpoint=process.env.CODEX_STATS_URL||"https://codex-stats.pages.dev", system=process.env.CODEX_STATS_SYSTEM||hostname();
  const port=Number(process.env.CODEX_STATS_PORT)||DASHBOARD_PORT, nonce=crypto.randomUUID();
  const status={phase:"starting",system,endpoint,root,lastSuccessAt:null,nextRunAt:null,result:null,error:null};
  const arm = (delay,kind="activity",reconcile=false) => {
    if (timer) clearTimeout(timer);
    timerKind=kind;
    status.nextRunAt=new Date(Date.now()+delay).toISOString();
    timer = setTimeout(() => { timer = null; timerKind=null; status.nextRunAt=null; void run(reconcile,kind==="retry"); }, delay);
  };
  const run = async (reconcile=initial,retry=false) => {
    if (syncing) { rerunMode=rerunMode===true||reconcile; return; }
    syncing = true;
    status.phase="syncing"; status.error=null; status.nextRunAt=null;
    let failed = false;
    try { status.result=await sync(reconcile); status.lastSuccessAt=new Date().toISOString(); initial=false; }
    catch (error) { failed = true; status.error=error.message; console.error(`codex-stats: ${error.message}`); }
    finally {
      syncing = false;
      status.phase=failed?"error":"watching";
      if (rerunMode!==null) { const mode=rerunMode; rerunMode=null; arm(0,"activity",mode); }
      else if (failed && !retry && !timer) arm(RETRY_MS,"retry",reconcile);
    }
  };
  const schedule = () => {
    const delay=activityDelay(timerKind);
    if(delay!==null) arm(delay,"activity",false);
  };
  const watchers = ["sessions", "archived_sessions"].map((name) => {
    try { return watch(join(root, name), { recursive: true }, (_event, file) => { if (!file || file.endsWith(".jsonl")) schedule(); }); }
    catch { return null; }
  }).filter(Boolean);
  if (!watchers.length) throw new Error(`No Codex session directories found under ${root}`);
  await run();
  console.log("codex-stats: syncing every 3 minutes while Codex is active");
  let dashboard;
  try {
    dashboard=Bun.serve({hostname:"127.0.0.1",port,fetch:(request)=>localDashboardResponse(request,status,nonce,async()=>{ if(timer){clearTimeout(timer);timer=null;timerKind=null;status.nextRunAt=null;} await run(true); },port)});
    console.log(`codex-stats: local dashboard http://127.0.0.1:${port}`);
  } catch(error) { console.error(`codex-stats: local dashboard unavailable: ${error.message}`); }
  const stop = () => { if (timer) clearTimeout(timer); watchers.forEach((watcher) => watcher.close()); dashboard?.stop(); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (import.meta.main) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
