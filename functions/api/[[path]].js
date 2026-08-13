import { createRemoteJWKSet, jwtVerify } from "jose";

const jwks = createRemoteJWKSet(new URL("https://shoo.dev/.well-known/jwks.json"));
const noStore = {
  "Cache-Control": "no-store, no-cache, must-revalidate, max-age=0",
  "CDN-Cache-Control": "no-store",
  "Cloudflare-CDN-Cache-Control": "no-store",
  "Pragma": "no-cache",
  "Expires": "0",
};
const json = (data, status = 200) => Response.json(data, { status, headers:noStore });
class HttpError extends Error { constructor(status, message) { super(message); this.status=status; } }

async function owner(request, env) {
  const token = request.headers.get("Authorization")?.replace(/^Bearer\s+/i, "");
  if (!token) throw new HttpError(401, "Sign in required");
  const origin = new URL(request.url).origin;
  let payload;
  try {
    ({ payload } = await jwtVerify(token, jwks, { issuer:"https://shoo.dev", audience:`origin:${origin}` }));
  } catch { throw new HttpError(401, "Sign in required"); }
  if (!payload.pairwise_sub || !payload.email_verified || payload.email?.toLowerCase() !== env.OWNER_EMAIL?.toLowerCase()) {
    throw new HttpError(401, "This dashboard is private");
  }
  return payload;
}

const clean = (value, max = 120) => (typeof value === "string" ? value.slice(0, max) : null);
const integer = (value) => Math.max(0, Number.isFinite(Number(value)) ? Math.trunc(Number(value)) : 0);
const PRICING_URL = "https://developers.openai.com/api/docs/pricing.md";

export function parsePrices(markdown) {
  const rates = {};
  let section = "";
  let tier = "";
  for (const line of markdown.split("\n")) {
    if (["Standard","Batch","Flex","Fast mode"].includes(line.trim())) tier = line.trim();
    if (line.startsWith("### ")) section = line.slice(4);
    const cells = line.split("|").slice(1,-1).map((cell)=>cell.trim());
    const money = (cell) => Number(cell?.replace(/[$,]/g,"")) || 0;
    if (section === "Standard pricing data" && cells[0]?.startsWith("gpt-") && cells.length >= 5) {
      rates[cells[0].replace(/\s+\(.*/,"")] = { input:money(cells[1]), cached:money(cells[2]), cacheWrite:money(cells[3]), output:money(cells[4]) };
    } else if (tier === "Standard" && section === "Grouped Pricing Table data" && cells[0] === "Codex" && cells[1]?.startsWith("gpt-") && cells.length >= 5) {
      const input = money(cells[2]);
      rates[cells[1]] = { input, cached:money(cells[3]), cacheWrite:input, output:money(cells[4]) };
    }
  }
  return rates;
}

const priceResult = (row, day) => ({
  rates: JSON.parse(row?.rates_json || "{}"), source:row?.source_url || PRICING_URL,
  fetchedAt:row?.fetched_at || null, stale:!row?.fetched_at?.startsWith(day),
});

async function stalePrices(env, day) {
  const stale = await env.DB.prepare("SELECT rates_json, source_url, fetched_at FROM pricing_cache WHERE day < ? AND rates_json <> '{}' ORDER BY day DESC LIMIT 1").bind(day).first();
  if (!stale) return priceResult(null, day);
  await env.DB.prepare("UPDATE pricing_cache SET rates_json=?, source_url=?, fetched_at=? WHERE day=?")
    .bind(stale.rates_json, stale.source_url, stale.fetched_at, day).run();
  return priceResult(stale, day);
}

async function prices(env, day, cached) {
  if (cached === undefined) cached = await env.DB.prepare("SELECT rates_json, source_url, fetched_at FROM pricing_cache WHERE day=?").bind(day).first();
  if (cached) return Object.keys(JSON.parse(cached.rates_json)).length ? priceResult(cached, day) : stalePrices(env, day);
  const gate = await env.DB.prepare("INSERT OR IGNORE INTO pricing_cache (day,rates_json,source_url,fetched_at) VALUES (?,'{}',?,'')").bind(day,PRICING_URL).run();
  if (!gate.meta.changes) return stalePrices(env, day);
  try {
    const response = await fetch(PRICING_URL, { headers:{ Accept:"text/markdown" } });
    if (!response.ok) throw new Error("Pricing fetch failed");
    const rates = parsePrices(await response.text());
    if (!Object.keys(rates).length) throw new Error("Pricing parse failed");
    const fetchedAt = new Date().toISOString();
    await env.DB.prepare("UPDATE pricing_cache SET rates_json=?, source_url=?, fetched_at=? WHERE day=?").bind(JSON.stringify(rates),PRICING_URL,fetchedAt,day).run();
    return { rates, source:PRICING_URL, fetchedAt, stale:false };
  } catch {
    return stalePrices(env, day);
  }
}

export function estimatedCost(rows, rates) {
  const totals = { usd:0, pricedTokens:0, totalTokens:0 };
  const days = new Map();
  const modelsByDay = new Map();
  for (const row of rows) {
    const input=Number(row.input_tokens||0), cached=Number(row.cached_input_tokens||0), cacheWrite=Number(row.cache_write_tokens||0), output=Number(row.output_tokens||0), rate=rates[row.model];
    const tokens=Number(row.total_tokens ?? input+output), model=row.model || "Unknown";
    const day = days.get(row.day) || { day:row.day, usd:0, pricedTokens:0, totalTokens:0 };
    const dayModels = modelsByDay.get(row.day) || new Map();
    const contribution = dayModels.get(model) || { model, sessions:0, tokens:0, usd:0 };
    contribution.sessions += 1;
    contribution.tokens += tokens;
    dayModels.set(model,contribution);
    modelsByDay.set(row.day,dayModels);
    day.totalTokens += input + output;
    totals.totalTokens += input + output;
    days.set(row.day, day);
    if (!rate) continue;
    const usd = (Math.max(0,input-cached-cacheWrite)*rate.input + cached*rate.cached + cacheWrite*rate.cacheWrite + output*rate.output) / 1e6;
    contribution.usd += usd;
    day.usd += usd;
    day.pricedTokens += input + output;
    totals.usd += usd;
    totals.pricedTokens += input + output;
  }
  return {
    usd:totals.usd, coverage:totals.totalTokens ? totals.pricedTokens/totals.totalTokens : 1,
    daily:[...days.values()].sort((a,b)=>a.day.localeCompare(b.day)).map((day)=>({ day:day.day, usd:day.usd, coverage:day.totalTokens ? day.pricedTokens/day.totalTokens : 1 })),
    dailyModels:Object.fromEntries([...modelsByDay].sort(([a],[b])=>a.localeCompare(b)).map(([day,models])=>[
      day,[...models.values()].sort((a,b)=>b.tokens-a.tokens || a.model.localeCompare(b.model)),
    ])),
  };
}

export function aggregateSkills(rows) {
  const totals = new Map();
  for (const row of rows) {
    try {
      const skills = JSON.parse(row.skills_json);
      if (!skills || typeof skills !== "object" || Array.isArray(skills)) continue;
      for (const [name,count] of Object.entries(skills)) {
        const skill=clean(name,120), uses=integer(count);
        if (skill && uses) totals.set(skill,(totals.get(skill)||0)+uses);
      }
    } catch {}
  }
  return [...totals].sort((a,b)=>b[1]-a[1] || a[0].localeCompare(b[0])).slice(0,15)
    .map(([name,count])=>({name,count}));
}

export function ingestSessions(sessions, systemId, now) {
  return sessions.flatMap((session) => {
    const id = clean(session?.id, 80), startedAt = clean(session?.startedAt, 40);
    if (!id || !startedAt) return [];
    return [{
      uid:`${systemId}:${id}`, id, systemId, startedAt, endedAt:clean(session.endedAt, 40),
      cwdLabel:clean(session.cwdLabel, 100), repo:clean(session.repo, 100), branch:clean(session.branch, 120),
      source:clean(session.source, 60), cliVersion:clean(session.cliVersion, 40), model:clean(session.model, 80),
      effort:clean(session.effort, 20), status:clean(session.status, 20) || "active",
      inputTokens:integer(session.inputTokens), cachedInputTokens:integer(session.cachedInputTokens),
      cacheWriteTokens:integer(session.cacheWriteTokens), outputTokens:integer(session.outputTokens),
      reasoningTokens:integer(session.reasoningTokens), totalTokens:integer(session.totalTokens),
      durationMs:integer(session.durationMs), userMessages:integer(session.userMessages),
      assistantMessages:integer(session.assistantMessages), turnCount:integer(session.turnCount),
      toolCount:integer(session.toolCount), errorCount:integer(session.errorCount),
      subagentCount:integer(session.subagentCount),
      toolsJson:session.tools && typeof session.tools === "object" ? JSON.stringify(session.tools).slice(0, 8000) : "{}",
      skillsJson:session.skills && typeof session.skills === "object" ? JSON.stringify(session.skills).slice(0,8000) : null,
      updatedAt:now,
    }];
  });
}

export const SESSION_UPSERT_SQL = `
  INSERT INTO sessions (uid,id,system_id,started_at,ended_at,cwd_label,repo,branch,source,cli_version,model,effort,status,
    input_tokens,cached_input_tokens,cache_write_tokens,output_tokens,reasoning_tokens,total_tokens,duration_ms,
    user_messages,assistant_messages,turn_count,tool_count,error_count,subagent_count,tools_json,skills_json,updated_at)
  SELECT
    json_extract(value,'$.uid'), json_extract(value,'$.id'), json_extract(value,'$.systemId'),
    json_extract(value,'$.startedAt'), json_extract(value,'$.endedAt'), json_extract(value,'$.cwdLabel'),
    json_extract(value,'$.repo'), json_extract(value,'$.branch'), json_extract(value,'$.source'),
    json_extract(value,'$.cliVersion'), json_extract(value,'$.model'), json_extract(value,'$.effort'),
    json_extract(value,'$.status'), json_extract(value,'$.inputTokens'), json_extract(value,'$.cachedInputTokens'),
    json_extract(value,'$.cacheWriteTokens'), json_extract(value,'$.outputTokens'), json_extract(value,'$.reasoningTokens'),
    json_extract(value,'$.totalTokens'), json_extract(value,'$.durationMs'), json_extract(value,'$.userMessages'),
    json_extract(value,'$.assistantMessages'), json_extract(value,'$.turnCount'), json_extract(value,'$.toolCount'),
    json_extract(value,'$.errorCount'), json_extract(value,'$.subagentCount'), json_extract(value,'$.toolsJson'),
    json_extract(value,'$.skillsJson'),
    json_extract(value,'$.updatedAt')
  FROM json_each(?) WHERE 1
  ON CONFLICT(uid) DO UPDATE SET ended_at=excluded.ended_at,cwd_label=excluded.cwd_label,repo=excluded.repo,
    branch=excluded.branch,source=excluded.source,cli_version=excluded.cli_version,model=excluded.model,
    effort=excluded.effort,status=excluded.status,input_tokens=excluded.input_tokens,
    cached_input_tokens=excluded.cached_input_tokens,cache_write_tokens=excluded.cache_write_tokens,
    output_tokens=excluded.output_tokens,reasoning_tokens=excluded.reasoning_tokens,total_tokens=excluded.total_tokens,
    duration_ms=excluded.duration_ms,user_messages=excluded.user_messages,assistant_messages=excluded.assistant_messages,
    turn_count=excluded.turn_count,tool_count=excluded.tool_count,error_count=excluded.error_count,
    subagent_count=excluded.subagent_count,tools_json=excluded.tools_json,
    skills_json=COALESCE(excluded.skills_json,sessions.skills_json),updated_at=excluded.updated_at
`;

export function statsWindow(value, now=Date.now()) {
  if (value === "lifetime") return { days:"lifetime", since:null };
  const days = [7,30,90].includes(Number(value)) ? Number(value) : 30;
  return { days, since:new Date(now-days*86400000).toISOString() };
}

export function statsScope(value, system, now=Date.now()) {
  const range = statsWindow(value,now), filteredSystem = system && system !== "all";
  return {
    ...range,
    where:`${range.since ? "started_at >= ?" : "1=1"}${filteredSystem ? " AND system_id = ?" : ""}`,
    args:[range.since,filteredSystem && system].filter(Boolean),
  };
}

async function ingest(request, env) {
  const timestamp = request.headers.get("X-Codex-Timestamp") || "";
  const signature = request.headers.get("X-Codex-Signature") || "";
  const text = await request.text();
  if (!env.INGEST_TOKEN || Math.abs(Date.now() - Number(timestamp)) > 300000) return json({ error: "Invalid collector signature" }, 401);
  const key = await crypto.subtle.importKey("raw", new TextEncoder().encode(env.INGEST_TOKEN), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const expected = [...new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(`${timestamp}.${text}`)))].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  if (signature.length !== expected.length || ![...signature].every((char, index) => char === expected[index])) return json({ error: "Invalid collector signature" }, 401);

  let body;
  try { body = JSON.parse(text); } catch { return json({ error:"Invalid JSON" }, 400); }
  if (typeof body?.system?.id !== "string" || !body.system.id || !Array.isArray(body.sessions) || body.sessions.length > 1000) {
    return json({ error: "Expected a system and up to 1000 sessions" }, 400);
  }

  const now = new Date().toISOString();
  const system = body.system, systemId = clean(system.id, 80), sessions = ingestSessions(body.sessions, systemId, now);
  const sessionJson = JSON.stringify(sessions);
  if (new TextEncoder().encode(sessionJson).byteLength > 1_900_000) return json({ error:"Session batch is too large" }, 413);
  const statements = [env.DB.prepare(`
    INSERT INTO systems (id, name, hostname, platform, arch, codex_version, last_seen_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET name=excluded.name, hostname=excluded.hostname,
      platform=excluded.platform, arch=excluded.arch, codex_version=excluded.codex_version,
      last_seen_at=excluded.last_seen_at
  `).bind(systemId, clean(system.name, 80) || "Unknown system", clean(system.hostname, 120),
    clean(system.platform, 40), clean(system.arch, 40), clean(system.codexVersion, 40), now),
    env.DB.prepare(SESSION_UPSERT_SQL).bind(sessionJson)];

  await env.DB.batch(statements);
  return json({ ok: true, accepted:sessions.length, syncedAt: now });
}

async function stats(request, env) {
  await owner(request, env);
  const url = new URL(request.url);
  const system = clean(url.searchParams.get("system"), 80);
  const { days, since, where, args } = statsScope(url.searchParams.get("days"),system);
  const today = new Date().toISOString().slice(0,10);
  const bind = (statement) => statement.bind(...args);
  const systemJoin = `x.system_id=s.id${since ? " AND x.started_at >= ?" : ""}`;

  const [summary, daily, systems, models, repos, recent, rows, priceCache] = await env.DB.batch([
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
      ON ${systemJoin} GROUP BY s.id ORDER BY tokens DESC`).bind(...[since].filter(Boolean)),
    bind(env.DB.prepare(`SELECT COALESCE(model,'Unknown') name, COUNT(*) sessions, SUM(total_tokens) tokens,
      SUM(output_tokens) output_tokens FROM sessions WHERE ${where} GROUP BY model ORDER BY tokens DESC LIMIT 12`)),
    bind(env.DB.prepare(`SELECT COALESCE(repo,'Unknown') name, COUNT(*) sessions, SUM(total_tokens) tokens,
      SUM(duration_ms) duration_ms FROM sessions WHERE ${where} GROUP BY repo ORDER BY tokens DESC LIMIT 12`)),
    bind(env.DB.prepare(`SELECT x.id, x.started_at, x.ended_at, x.repo, x.branch, x.model, x.effort, x.status,
      x.total_tokens, x.output_tokens, x.duration_ms, x.tool_count, x.error_count, s.name system
      FROM sessions x JOIN systems s ON s.id=x.system_id WHERE ${where.replaceAll("started_at", "x.started_at")} ORDER BY x.started_at DESC LIMIT 30`)),
    bind(env.DB.prepare(`SELECT date(started_at) day, skills_json, model, total_tokens, input_tokens, cached_input_tokens, cache_write_tokens, output_tokens FROM sessions WHERE ${where}`)),
    env.DB.prepare("SELECT rates_json, source_url, fetched_at FROM pricing_cache WHERE day=?").bind(today),
  ]);

  const pricing = await prices(env,today,priceCache.results[0] || null);
  const { dailyModels, ...cost } = estimatedCost(rows.results,pricing.rates);
  return json({
    range: { days, since }, summary: summary.results[0], daily: daily.results,
    systems: systems.results, models: models.results, repos: repos.results, recent: recent.results,
    skills:aggregateSkills(rows.results),
    dailyModels,
    estimatedCost: { ...cost, source:pricing.source, ratesFetchedAt:pricing.fetchedAt, stale:pricing.stale },
  });
}

export async function onRequest(context) {
  const { request, env, params } = context;
  const path = Array.isArray(params.path) ? params.path.join("/") : params.path || "";
  try {
    let response;
    if (request.method === "POST" && path === "ingest") response = await ingest(request, env);
    else if (request.method === "GET" && path === "stats") response = await stats(request, env);
    if (request.method === "GET" && path === "me") {
      const identity = await owner(request, env);
      response = json({ name: identity.name, email: identity.email, picture: identity.picture });
    }
    return response || json({ error: "Not found" }, 404);
  } catch (error) {
    const status = error instanceof HttpError ? error.status : 500;
    return json({ error:status === 500 ? "Request failed" : error.message }, status);
  }
}
