#!/usr/bin/env bun
import { homedir, hostname, platform, arch } from "node:os";
import { basename, dirname, join } from "node:path";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";

export const freshSession = () => ({
  id: null, startedAt: null, endedAt: null, cwdLabel: null, repo: null, branch: null, source: null,
  cliVersion: null, model: null, effort: null, status: "active", inputTokens: 0, cachedInputTokens: 0,
  cacheWriteTokens: 0, outputTokens: 0, reasoningTokens: 0, totalTokens: 0, durationMs: 0,
  userMessages: 0, assistantMessages: 0, turnCount: 0, toolCount: 0, errorCount: 0, subagentCount: 0,
  tools: {}, _firstTs: null, _lastTs: null, _turns: {}, _subagents: {},
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
    session.id = payload.id || payload.session_id || session.id;
    session.startedAt = payload.timestamp || record.timestamp || session.startedAt;
    session.source = payload.source || payload.originator || session.source;
    session.cliVersion = payload.cli_version || session.cliVersion;
    session.branch = payload.git?.branch || session.branch;
    if (payload.cwd) {
      session.cwdLabel = basename(payload.cwd);
      session.repo = basename(payload.git?.repository_url || payload.cwd).replace(/\.git$/, "");
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
    if (payload.type === "mcp_tool_call_end" && payload.result?.isError) session.errorCount++;
  } else if (record.type === "response_item") {
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
  const headers = { "Content-Type": "application/json", "X-Codex-Timestamp": timestamp, "X-Codex-Signature": await signature(token, timestamp, body) };
  if (platform() !== "darwin") return fetch(url, { method: "POST", headers, body });
  const process = Bun.spawn(["/usr/bin/curl", "--fail-with-body", "--silent", "--show-error", "-X", "POST",
    "-H", "Content-Type: application/json", "-H", `X-Codex-Timestamp: ${timestamp}`, "-H", `X-Codex-Signature: ${headers["X-Codex-Signature"]}`,
    "--data-binary", "@-", url], { stdin: "pipe", stdout: "pipe", stderr: "pipe" });
  process.stdin.write(body);
  process.stdin.end();
  const [exitCode, output, error] = await Promise.all([process.exited, new Response(process.stdout).text(), new Response(process.stderr).text()]);
  return { ok: exitCode === 0, status: exitCode === 0 ? 200 : 500, text: async () => output || error };
}

async function sync() {
  const codexRoot = process.env.CODEX_HOME || join(homedir(), ".codex");
  const stateDir = join(homedir(), ".codex-stats");
  const statePath = join(stateDir, "state.json");
  const state = JSON.parse(await readFile(statePath, "utf8").catch(() => '{"files":{}}'));
  const changed = [];

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
    if (previous.session.id && previous.session.startedAt) changed.push(previous.session);
  }

  if (!changed.length) return console.log("codex-stats: nothing new");
  const endpoint = process.env.CODEX_STATS_URL || "https://codex-stats.pages.dev";
  const token = await collectorToken();
  if (!token) throw new Error("Set CODEX_STATS_TOKEN (or add codex-stats-ingest to macOS Keychain)");
  const id = await installationId(codexRoot);
  for (let i = 0; i < changed.length; i += 200) {
    const body = JSON.stringify({ system: { id, name: process.env.CODEX_STATS_SYSTEM || hostname(), hostname: hostname(), platform: platform(), arch: arch(), codexVersion: await codexVersion() }, sessions: changed.slice(i, i + 200) });
    const response = await post(`${endpoint.replace(/\/$/, "")}/api/ingest`, body, token);
    if (!response.ok) throw new Error(`Sync failed (${response.status}): ${await response.text()}`);
  }
  await mkdir(stateDir, { recursive: true });
  await writeFile(statePath, JSON.stringify(state));
  console.log(`codex-stats: synced ${changed.length} sessions`);
}

if (import.meta.main) sync().catch((error) => { console.error(error.message); process.exitCode = 1; });
