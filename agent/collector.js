#!/usr/bin/env bun
import { homedir, hostname, platform, arch } from "node:os";
import { basename, dirname, join } from "node:path";
import { watch } from "node:fs";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";

export const DEBOUNCE_MS = 180000;
export const RETRY_MS = 300000;
export const BATCH_SIZE = 100;
export const debounceDelay = (lastEvent, now = Date.now()) => Math.max(0, DEBOUNCE_MS - (now - lastEvent));
export const selectMissing = (pending, ids) => { const missing=new Set(ids); return pending.filter(({session})=>missing.has(session.id)); };

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

async function jsonlFiles(root) {
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
  return fetch(url, { method: "POST", headers, body });
}

async function loadState(path) {
  let saved;
  try { saved = JSON.parse(await readFile(path, "utf8")); } catch { saved = {}; }
  if (!saved || typeof saved !== "object" || Array.isArray(saved)) saved = {};
  const object = (value) => value && typeof value === "object" && !Array.isArray(value) ? value : {};
  return { files: object(saved.files), synced: object(saved.synced), pending: object(saved.pending) };
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

  for (const path of await jsonlFiles(codexRoot)) {
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

  await saveState(statePath, state);
  const pending = Object.values(state.pending).filter((entry) => entry?.session?.id && entry.fingerprint);
  if (!pending.length) return console.log("codex-stats: nothing new");
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
  let lastEvent = 0;
  let syncing = false;
  let rerun = false;
  let initial = true;
  const arm = (delay) => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => { timer = null; void run(); }, delay);
  };
  const run = async () => {
    if (syncing) { rerun = true; return; }
    syncing = true;
    let failed = false;
    try { await sync(initial); initial=false; }
    catch (error) { failed = true; console.error(`codex-stats: ${error.message}`); }
    finally {
      syncing = false;
      if (rerun) { rerun = false; arm(debounceDelay(lastEvent)); }
      else if (failed && !timer) arm(RETRY_MS);
    }
  };
  const schedule = () => {
    lastEvent = Date.now();
    arm(DEBOUNCE_MS);
  };
  const watchers = ["sessions", "archived_sessions"].map((name) => {
    try { return watch(join(root, name), { recursive: true }, (_event, file) => { if (!file || file.endsWith(".jsonl")) schedule(); }); }
    catch { return null; }
  }).filter(Boolean);
  if (!watchers.length) throw new Error(`No Codex session directories found under ${root}`);
  await run();
  console.log("codex-stats: watching for Codex activity (3 minute debounce)");
  const stop = () => { if (timer) clearTimeout(timer); watchers.forEach((watcher) => watcher.close()); process.exit(0); };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
}

if (import.meta.main) main().catch((error) => { console.error(error.message); process.exitCode = 1; });
