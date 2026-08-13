const $ = (id) => document.getElementById(id);
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const number = new Intl.NumberFormat("en");
const esc = (value) => String(value ?? "—").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
const fmtTokens = (value) => compact.format(Number(value || 0));
const fmtTime = (ms) => ms >= 3600000 ? `${(ms / 3600000).toFixed(1)}h` : ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 1000)}s`;
const fmtDate = (value) => value ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "—";

function demoData() {
  const daily = Array.from({ length: 30 }, (_, i) => ({ day: new Date(Date.now() - (29 - i) * 86400000).toISOString().slice(0, 10), sessions: [1,3,2,7,4,0,2,5,3,8][i % 10], tokens: [82000,260000,173000,611000,309000,0,135000,440000,230000,720000][i % 10], tools: 4 + i * 2, duration_ms: (i + 2) * 340000 }));
  return { summary: { sessions: 114, tokens: 8274000, input_tokens: 7340000, cached_tokens: 5840000, output_tokens: 934000, reasoning_tokens: 388000, duration_ms: 74200000, tools: 1281, prompts: 364, errors: 7, systems: 3, repos: 18 }, daily,
    systems: [{id:"studio",name:"Studio Mac",platform:"darwin",arch:"arm64",codex_version:"0.147.0",last_seen_at:new Date().toISOString(),sessions:62,tokens:4920000},{id:"air",name:"Travel Air",platform:"darwin",arch:"arm64",codex_version:"0.147.0",last_seen_at:new Date(Date.now()-3600000).toISOString(),sessions:38,tokens:2510000},{id:"linux",name:"Build Box",platform:"linux",arch:"x64",codex_version:"0.146.0",last_seen_at:new Date(Date.now()-86400000).toISOString(),sessions:14,tokens:844000}],
    models: [{name:"gpt-5.6-sol",sessions:73,tokens:5840000},{name:"gpt-5.6-terra",sessions:31,tokens:1910000},{name:"gpt-5.6-luna",sessions:10,tokens:524000}], repos: [{name:"apps",sessions:44,tokens:3120000},{name:"mfe",sessions:29,tokens:2100000},{name:"better-source-control",sessions:21,tokens:1840000},{name:"bot_hq",sessions:11,tokens:760000}], tools: [{name:"exec_command",count:487},{name:"apply_patch",count:214},{name:"devtools",count:176},{name:"web",count:93},{name:"collaboration",count:71}],
    recent: Array.from({length:10},(_,i)=>({started_at:new Date(Date.now()-i*9300000).toISOString(),repo:["apps","mfe","better-source-control"][i%3],system:["Studio Mac","Travel Air","Build Box"][i%3],model:i%3?"gpt-5.6-sol":"gpt-5.6-terra",effort:"high",status:i===4?"aborted":"complete",total_tokens:42000+i*8900,output_tokens:3200,duration_ms:840000+i*110000,tool_count:8+i,error_count:i===4?1:0})) };
}

function renderTrend(rows) {
  if (!rows.length) return $("trend").innerHTML = '<p class="empty">No activity in this window.</p>';
  const width = 1000, height = 250, pad = 30, max = Math.max(...rows.map((d) => Number(d.tokens)), 1), sessionMax = Math.max(...rows.map((d) => Number(d.sessions)), 1), step = (width - pad * 2) / rows.length, barWidth = Math.max(4, step * .58);
  const bars = rows.map((d,i) => { const h=Number(d.tokens)/max*(height-pad*2), x=pad+i*step+(step-barWidth)/2; return `<rect class="token-bar" x="${x}" y="${height-pad-h}" width="${barWidth}" height="${h}" rx="2"><title>${d.day}: ${number.format(d.tokens)} tokens</title></rect><circle class="session-dot" cx="${x+barWidth/2}" cy="${height-pad-(Number(d.sessions)/sessionMax)*44}" r="3"><title>${d.sessions} sessions</title></circle>`; }).join("");
  const labels = rows.filter((_, i) => i % Math.ceil(rows.length / 6) === 0).map((d) => `<text x="${pad+rows.indexOf(d)*step}" y="246">${d.day.slice(5)}</text>`).join("");
  $("trend").innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${[.25,.5,.75,1].map(n=>`<line class="grid" x1="${pad}" y1="${height-pad-n*(height-pad*2)}" x2="${width-pad}" y2="${height-pad-n*(height-pad*2)}"/>`).join("")}${bars}${labels}</svg>`;
}

function renderHeatmap(rows) {
  const byDay = Object.fromEntries(rows.map((d) => [d.day, Number(d.sessions)]));
  const days = Array.from({ length: 56 }, (_, i) => new Date(Date.now() - (55-i)*86400000).toISOString().slice(0,10));
  const max = Math.max(...Object.values(byDay), 1);
  $("heatmap").innerHTML = days.map((day) => { const count=byDay[day]||0, level=count ? Math.max(1,Math.ceil(count/max*4)) : 0; return `<i class="l${level}" data-tip="${day} · ${count} sessions"></i>`; }).join("");
  $("active-days").textContent = `${rows.filter((d)=>Number(d.sessions)).length} active days`;
}

function renderRing(summary) {
  const parts = [{name:"Fresh input",value:Math.max(0,Number(summary.input_tokens)-Number(summary.cached_tokens)),color:"#f1a33c"},{name:"Cached input",value:Number(summary.cached_tokens),color:"#718442"},{name:"Visible output",value:Math.max(0,Number(summary.output_tokens)-Number(summary.reasoning_tokens)),color:"#65c7cb"},{name:"Reasoning",value:Number(summary.reasoning_tokens),color:"#a98070"}];
  const total = Math.max(parts.reduce((n,p)=>n+p.value,0),1); let cursor=0;
  const stops = parts.map((p) => { const start=cursor; cursor+=p.value/total*100; return `${p.color} ${start}% ${cursor}%`; }).join(",");
  $("token-ring").innerHTML = `<div class="ring" style="background:conic-gradient(${stops})"><b>${fmtTokens(summary.tokens)}</b></div><div class="ring-legend">${parts.map(p=>`<div><i style="background:${p.color}"></i><span>${p.name}</span><b>${fmtTokens(p.value)}</b></div>`).join("")}</div>`;
}

function renderRanks(id, rows, valueKey = "tokens") {
  const max = Math.max(...rows.map((row)=>Number(row[valueKey])),1);
  $(id).innerHTML = rows.length ? rows.slice(0,8).map(row=>`<div class="rank"><div class="rank-line"><span title="${esc(row.name)}">${esc(row.name)}</span><b>${valueKey === "count" ? number.format(row[valueKey]) : fmtTokens(row[valueKey])}</b></div><div class="bar"><i style="width:${Number(row[valueKey])/max*100}%"></i></div></div>`).join("") : '<p class="empty">No data yet.</p>';
}

function render(data) {
  const s=data.summary;
  $("kpi-sessions").textContent=number.format(s.sessions); $("kpi-systems").textContent=`across ${s.systems} systems`;
  $("kpi-tokens").textContent=fmtTokens(s.tokens); $("kpi-cache").textContent=`${s.input_tokens ? Math.round(s.cached_tokens/s.input_tokens*100) : 0}% input cached`;
  $("kpi-time").textContent=fmtTime(s.duration_ms); $("kpi-prompts").textContent=`${number.format(s.prompts)} prompts`;
  $("kpi-tools").textContent=number.format(s.tools); $("kpi-errors").textContent=`${number.format(s.errors)} errors observed`;
  renderTrend(data.daily); renderHeatmap(data.daily); renderRing(s); renderRanks("models",data.models); renderRanks("repos",data.repos); renderRanks("tools",data.tools,"count");
  $("machines").innerHTML=data.systems.map(m=>`<article class="machine"><h3>${esc(m.name)}</h3><span>${esc(m.platform)} / ${esc(m.arch)} · Codex ${esc(m.codex_version)}</span><div class="machine-stats"><div>Sessions<b>${number.format(m.sessions)}</b></div><div>Tokens<b>${fmtTokens(m.tokens)}</b></div><div>Last seen<b>${fmtDate(m.last_seen_at).split(",")[0]}</b></div></div></article>`).join("");
  $("recent").innerHTML=data.recent.map(r=>`<tr><td>${fmtDate(r.started_at)}</td><td class="repo-cell">${esc(r.repo)}</td><td>${esc(r.system)}</td><td>${esc(r.model)} / ${esc(r.effort)}</td><td>${fmtTokens(r.total_tokens)}</td><td>${fmtTime(r.duration_ms)}</td><td>${number.format(r.tool_count)}</td><td><span class="status ${esc(r.status)}">${esc(r.status)}</span></td></tr>`).join("");
  const select=$("system"), selected=select.value; select.innerHTML='<option value="all">All systems</option>'+data.systems.map(m=>`<option value="${esc(m.id)}">${esc(m.name)}</option>`).join(""); select.value=[...select.options].some(o=>o.value===selected)?selected:"all";
  $("sync-status").textContent = data.systems.length ? `Synced ${fmtDate(data.systems.map(s=>s.last_seen_at).sort().at(-1))}` : "No collectors yet";
}

function toast(message) { $("toast").textContent=message; $("toast").classList.add("show"); setTimeout(()=>$("toast").classList.remove("show"),4500); }

async function load() {
  if (new URLSearchParams(location.search).has("demo")) return render(demoData());
  const identity=window.Shoo?.getIdentity();
  if (!identity?.token) return showAuth();
  const response=await fetch(`/api/stats?days=${$("days").value}&system=${encodeURIComponent($("system").value)}`,{headers:{Authorization:`Bearer ${identity.token}`}});
  if (response.status===401) { window.Shoo.clearIdentity(); return showAuth(); }
  if (!response.ok) throw new Error((await response.json()).error||"Could not load stats");
  render(await response.json());
}

function showAuth() { $("dashboard").hidden=true; $("auth-gate").hidden=false; $("sign-out").hidden=true; $("sync-status").textContent="Private dashboard"; }

window.addEventListener("DOMContentLoaded", async () => {
  const demo=new URLSearchParams(location.search).has("demo"); $("dashboard").hidden=false; $("sign-out").hidden=demo;
  try { await load(); } catch(error) { toast(error.message); }
  $("days").addEventListener("change",()=>load().catch(e=>toast(e.message))); $("system").addEventListener("change",()=>load().catch(e=>toast(e.message)));
  $("sign-in").addEventListener("click",()=>window.Shoo.startSignIn({requestPii:true,returnTo:"/"}));
  $("sign-out").addEventListener("click",()=>{window.Shoo?.clearIdentity();showAuth();});
});
