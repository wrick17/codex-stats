import { createRemoteJWKSet, jwtVerify } from "jose";

const jwks = createRemoteJWKSet(new URL("https://shoo.dev/.well-known/jwks.json"));
const json = (data, status = 200) => Response.json(data, { status, headers: { "Cache-Control": "no-store" } });

async function owner(request, env) {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new Error("Sign in required");
  const origin = new URL(request.url).origin;
  const { payload } = await jwtVerify(token, jwks, {
    issuer: "https://shoo.dev",
    audience: `origin:${origin}`,
  });
  if (!payload.pairwise_sub || !payload.email_verified || payload.email?.toLowerCase() !== env.OWNER_EMAIL?.toLowerCase()) {
    throw new Error("This dashboard is private");
  }
  return payload;
}

const clean = (value, max = 120) => (typeof value === "string" ? value.slice(0, max) : null);
const integer = (value) => Math.max(0, Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0);

async function ingest(request, env) {
  const timestamp = request.headers.get("X-Codex-Timestamp") || "";
  const signature = request.headers.get("X-Codex-Signature") || "";
  const text = await request.text();
  if (!env.INGEST_TOKEN || Math.abs(Date.now() - Number(timestamp)) > 300000) return json({ error: "Invalid collector signature" }, 401);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.INGEST_TOKEN), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${text}`)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (signature.length !== expected.length || ![...signature].every((char, index) => char === expected[index])) return json({ error: "Invalid collector signature" }, 401);

  const body = JSON.parse(text);
  if (!body?.system?.id || !Array.isArray(body.sessions) || body.sessions.length > 250) {
    return json({ error: "Expected a system and up to 250 sessions" }, 400);
  }

  const now = new Date().toISOString();
  const system = body.system;
  const statements = [env.DB.prepare(`
    INSERT INTO systems (id, name, hostname, platform, arch, codex_version, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, hostname=excluded.hostname,
      platform=excluded.platform, arch=excluded.arch, codex_version=excluded.codex_version,
      last_seen_at=excluded.last_seen_at
  `).bind(clean(system.id, 80), clean(system.name, 80) || "Unknown system", clean(system.hostname, 120),
    clean(system.platform, 40), clean(system.arch, 40), clean(system.codexVersion, 40), now)];

  for (const session of body.sessions) {
    if (!session?.id || !session?.startedAt) continue;
    const tools = session.tools && typeof session.tools === "object" ? JSON.stringify(session.tools).slice(0, 8000) : "{}";
    statements.push(env.DB.prepare(`
      INSERT INTO sessions (uid,id,system_id,started_at,ended_at,cwd_label,repo,branch,source,cli_version,model,effort,status,
        input_tokens,cached_input_tokens,cache_write_tokens,output_tokens,reasoning_tokens,total_tokens,duration_ms,
        user_messages,assistant_messages,turn_count,tool_count,error_count,subagent_count,tools_json,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
      ON CONFLICT(uid) DO UPDATE SET ended_at=excluded.ended_at,cwd_label=excluded.cwd_label,repo=excluded.repo,
        branch=excluded.branch,source=excluded.source,cli_version=excluded.cli_version,model=excluded.model,
        effort=excluded.effort,status=excluded.status,input_tokens=excluded.input_tokens,
        cached_input_tokens=excluded.cached_input_tokens,cache_write_tokens=excluded.cache_write_tokens,
        output_tokens=excluded.output_tokens,reasoning_tokens=excluded.reasoning_tokens,total_tokens=excluded.total_tokens,
        duration_ms=excluded.duration_ms,user_messages=excluded.user_messages,assistant_messages=excluded.assistant_messages,
        turn_count=excluded.turn_count,tool_count=excluded.tool_count,error_count=excluded.error_count,
        subagent_count=excluded.subagent_count,tools_json=excluded.tools_json,updated_at=excluded.updated_at
    `).bind(`${system.id}:${session.id}`, clean(session.id, 80), clean(system.id, 80), clean(session.startedAt, 40),
      clean(session.endedAt, 40), clean(session.cwdLabel, 100), clean(session.repo, 100), clean(session.branch, 120),
      clean(session.source, 60), clean(session.cliVersion, 40), clean(session.model, 80), clean(session.effort, 20),
      clean(session.status, 20) || "active", integer(session.inputTokens), integer(session.cachedInputTokens),
      integer(session.cacheWriteTokens), integer(session.outputTokens), integer(session.reasoningTokens),
      integer(session.totalTokens), integer(session.durationMs), integer(session.userMessages), integer(session.assistantMessages),
      integer(session.turnCount), integer(session.toolCount), integer(session.errorCount), integer(session.subagentCount), tools, now));
  }

  await env.DB.batch(statements);
  return json({ ok: true, accepted: statements.length - 1, syncedAt: now });
}

async function stats(request, env) {
  await owner(request, env);
  const url = new URL(request.url);
  const days = [7, 30, 90, 365].includes(Number(url.searchParams.get("days"))) ? Number(url.searchParams.get("days")) : 30;
  const system = clean(url.searchParams.get("system"), 80);
  const since = new Date(Date.now() - days * 86400000).toISOString();
  const where = `started_at >= ?${system && system !== "all" ? " AND system_id = ?" : ""}`;
  const bind = (statement) => system && system !== "all" ? statement.bind(since, system) : statement.bind(since);

  const [summary, daily, systems, models, repos, recent, rows] = await env.DB.batch([
    bind(env.DB.prepare(`SELECT COUNT(*) sessions, COALESCE(SUM(total_tokens),0) tokens,
      COALESCE(SUM(input_tokens),0) input_tokens, COALESCE(SUM(cached_input_tokens),0) cached_tokens,
      COALESCE(SUM(output_tokens),0) output_tokens, COALESCE(SUM(reasoning_tokens),0) reasoning_tokens,
      COALESCE(SUM(duration_ms),0) duration_ms, COALESCE(SUM(tool_count),0) tools,
      COALESCE(SUM(user_messages),0) prompts, COALESCE(SUM(error_count),0) errors,
      COUNT(DISTINCT system_id) systems, COUNT(DISTINCT repo) repos FROM sessions WHERE ${where}`)),
    bind(env.DB.prepare(`SELECT date(started_at) day, COUNT(*) sessions, SUM(total_tokens) tokens,
      SUM(tool_count) tools, SUM(duration_ms) duration_ms FROM sessions WHERE ${where} GROUP BY day ORDER BY day`)),
    env.DB.prepare(`SELECT s.id, s.name, s.platform, s.arch, s.codex_version, s.last_seen_at,
      COUNT(x.uid) sessions, COALESCE(SUM(x.total_tokens),0) tokens FROM systems s LEFT JOIN sessions x
      ON x.system_id=s.id AND x.started_at >= ? GROUP BY s.id ORDER BY tokens DESC`).bind(since),
    bind(env.DB.prepare(`SELECT COALESCE(model,'Unknown') name, COUNT(*) sessions, SUM(total_tokens) tokens,
      SUM(output_tokens) output_tokens FROM sessions WHERE ${where} GROUP BY model ORDER BY tokens DESC LIMIT 12`)),
    bind(env.DB.prepare(`SELECT COALESCE(repo,'Unknown') name, COUNT(*) sessions, SUM(total_tokens) tokens,
      SUM(duration_ms) duration_ms FROM sessions WHERE ${where} GROUP BY repo ORDER BY tokens DESC LIMIT 12`)),
    bind(env.DB.prepare(`SELECT x.id, x.started_at, x.ended_at, x.repo, x.branch, x.model, x.effort, x.status,
      x.total_tokens, x.output_tokens, x.duration_ms, x.tool_count, x.error_count, s.name system
      FROM sessions x JOIN systems s ON s.id=x.system_id WHERE ${where.replaceAll("started_at", "x.started_at")} ORDER BY x.started_at DESC LIMIT 30`)),
    bind(env.DB.prepare(`SELECT tools_json FROM sessions WHERE ${where}`)),
  ]);

  const toolTotals = {};
  for (const row of rows.results) {
    try { for (const [name, count] of Object.entries(JSON.parse(row.tools_json))) toolTotals[name] = (toolTotals[name] || 0) + Number(count); } catch {}
  }

  return json({
    range: { days, since }, summary: summary.results[0], daily: daily.results,
    systems: systems.results, models: models.results, repos: repos.results, recent: recent.results,
    tools: Object.entries(toolTotals).sort((a, b) => b[1] - a[1]).slice(0, 15).map(([name, count]) => ({ name, count })),
  });
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const path = Array.isArray(params.path) ? params.path.join("/") : params.path || "";
  try {
    if (request.method === "POST" && path === "ingest") return await ingest(request, env);
    if (request.method === "GET" && path === "stats") return await stats(request, env);
    if (request.method === "GET" && path === "me") {
      const identity = await owner(request, env);
      return json({ name: identity.name, email: identity.email, picture: identity.picture });
    }
    return json({ error: "Not found" }, 404);
  } catch (error) {
    return json({ error: error instanceof Error ? error.message : "Request failed" }, 401);
  }
}
