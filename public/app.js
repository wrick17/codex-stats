const $ = (id) => document.getElementById(id);
const localDemoAllowed = ["localhost", "127.0.0.1"].includes(location.hostname);
const demoMode = localDemoAllowed;
const enrollment = (()=>{ try { const url=new URL(new URLSearchParams(location.search).get("enroll")); return url.protocol==="http:"&&["127.0.0.1","localhost"].includes(url.hostname)?url:null; } catch { return null; } })();
let loadVersion = 0;
const filterKey="codex-stats:filters", validWindows=new Set(["7","30","90","lifetime"]);
function storedFilters(){ try{ const value=JSON.parse(localStorage.getItem(filterKey)||"{}"); return {days:validWindows.has(value.days)?value.days:"30",system:typeof value.system==="string"&&value.system?value.system:"all"}; }catch{return {days:"30",system:"all"};} }
let requestedSystem="all";
function persistFilters(){ try{ localStorage.setItem(filterKey,JSON.stringify({days:validWindows.has($("days")?.value)?$("days").value:"30",system:requestedSystem||"all"})); }catch{} }
const compact = new Intl.NumberFormat("en", { notation: "compact", maximumFractionDigits: 1 });
const number = new Intl.NumberFormat("en");
const esc = (value) => String(value ?? "—").replace(/[&<>"]/g, (char) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[char]);
const fmtTokens = (value) => compact.format(Number(value || 0));
const fmtTime = (ms) => ms >= 3600000 ? `${(ms / 3600000).toFixed(1)}h` : ms >= 60000 ? `${Math.round(ms / 60000)}m` : `${Math.round(ms / 1000)}s`;
const fmtDate = (value) => value ? new Intl.DateTimeFormat("en", { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(value)) : "—";
const fmtDay = (value) => new Intl.DateTimeFormat("en", { month: "short", day: "numeric", year: "numeric", timeZone: "UTC" }).format(new Date(`${value}T00:00:00Z`));
const fmtCost = (value) => Number(value) > 0 && Number(value) < .01 ? "<$0.01" : new Intl.NumberFormat("en-US", { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(Number(value || 0));

function demoData() {
  let seed=0xc0de2026;
  const random=()=>((seed=Math.imul(seed,1664525)+1013904223>>>0)/4294967296);
  const daily = Array.from({ length: 365 }, (_, i) => { const sessions=random()<.23?0:1+Math.floor(random()*8), tokens=sessions?Math.round((45000+random()*690000)/1000)*1000:0; return { day:new Date(Date.now()-(364-i)*86400000).toISOString().slice(0,10), sessions, tokens, tools:sessions*Math.floor(3+random()*12), duration_ms:sessions*Math.floor(240000+random()*1200000) }; });
  const modelNames=["gpt-5.6-sol","gpt-5.6-terra","gpt-5.6-luna"], dailyModels=Object.fromEntries(daily.map((row,i)=>{ const active=Math.min(modelNames.length,row.sessions), weights=[.54+(i%5)*.025,.29+((i*3)%4)*.02,.17], total=weights.slice(0,active).reduce((sum,value)=>sum+value,0); let tokens=0,sessions=0; return [row.day,modelNames.slice(0,active).map((model,index)=>{ const last=index===active-1, modelTokens=last?row.tokens-tokens:Math.round(row.tokens*weights[index]/total), modelSessions=last?row.sessions-sessions:Math.max(1,Math.round(row.sessions*weights[index]/total)); tokens+=modelTokens; sessions+=modelSessions; return {model,tokens:modelTokens,sessions:modelSessions,usd:modelTokens/8274000*34.72}; }).filter(model=>model.sessions>0)]; }));
  return { summary: { sessions: 114, tokens: 8274000, input_tokens: 7340000, cached_tokens: 5840000, output_tokens: 934000, reasoning_tokens: 388000, duration_ms: 74200000, tools: 1281, prompts: 364, errors: 7, systems: 3, repos: 18 }, estimatedCost:{usd:34.72,coverage:1,ratesFetchedAt:new Date().toISOString(),daily:Object.fromEntries(daily.map((row)=>[row.day,row.tokens/8274000*34.72]))}, daily, dailyModels,
    systems: [{id:"studio",name:"Studio Mac",platform:"darwin",arch:"arm64",codex_version:"0.147.0",last_seen_at:new Date().toISOString(),sessions:62,tokens:4920000},{id:"air",name:"Travel Air",platform:"darwin",arch:"arm64",codex_version:"0.147.0",last_seen_at:new Date(Date.now()-3600000).toISOString(),sessions:38,tokens:2510000},{id:"linux",name:"Build Box",platform:"linux",arch:"x64",codex_version:"0.146.0",last_seen_at:new Date(Date.now()-86400000).toISOString(),sessions:14,tokens:844000}],
    models: [{name:"gpt-5.6-sol",sessions:73,tokens:5840000},{name:"gpt-5.6-terra",sessions:31,tokens:1910000},{name:"gpt-5.6-luna",sessions:10,tokens:524000}], repos: [{name:"apps",sessions:44,tokens:3120000},{name:"mfe",sessions:29,tokens:2100000},{name:"better-source-control",sessions:21,tokens:1840000},{name:"bot_hq",sessions:11,tokens:760000}], skills: [{name:"frontend-design",count:84},{name:"cloudflare",count:61},{name:"ponytail",count:49},{name:"openai-docs",count:27}],
    recent: Array.from({length:10},(_,i)=>({started_at:new Date(Date.now()-i*9300000).toISOString(),repo:["apps","mfe","better-source-control"][i%3],system:["Studio Mac","Travel Air","Build Box"][i%3],model:i%3?"gpt-5.6-sol":"gpt-5.6-terra",effort:"high",status:i===4?"aborted":"complete",total_tokens:42000+i*8900,output_tokens:3200,duration_ms:840000+i*110000,tool_count:8+i,error_count:i===4?1:0})) };
}

function dailyWindow(rows, window, costs = {}, dailyModels = {}) {
  const byDay=Object.fromEntries(rows.map((row)=>[row.day,row])), byCost=Array.isArray(costs)?Object.fromEntries(costs.map((cost)=>[cost.day,cost])):costs;
  const sorted=rows.map((row)=>row.day).sort(), end=window==="lifetime"&&sorted.length?new Date(`${sorted.at(-1)}T00:00:00Z`):new Date(), start=window==="lifetime"&&sorted.length?new Date(`${sorted[0]}T00:00:00Z`):new Date(end);
  end.setUTCHours(0,0,0,0); start.setUTCHours(0,0,0,0); if(window!=="lifetime") start.setUTCDate(end.getUTCDate()-Number(window)+1);
  const length=Math.max(0,Math.round((end-start)/86400000)+1);
  return Array.from({length},(_,i)=>{ const day=new Date(start); day.setUTCDate(start.getUTCDate()+i); const key=day.toISOString().slice(0,10), row=byDay[key]||{day:key,sessions:0,tokens:0,tools:0,duration_ms:0}, cost=byCost[key]; return {...row,estimated_cost:Number(cost?.usd??cost??row.estimated_cost??0),models:dailyModels?.[key]||row.models||[]}; });
}

const tooltipData=(row)=>`data-tooltip="day" data-tooltip-kind="trend" data-date="${row.day}" data-tokens="${Number(row.tokens||0)}" data-sessions="${Number(row.sessions||0)}" data-cost="${Number(row.estimated_cost||0)}" data-models="${esc(JSON.stringify(row.models||[]))}"`;

function renderTrend(rows, lifetime) {
  if (!rows.length) return $("trend").innerHTML = '<p class="empty">No activity in this window.</p>';
  const width = 1000, height = 250, pad = 30, tokenValues=rows.map(d=>Number(d.tokens)), sessionValues=rows.map(d=>Number(d.sessions)), max = Math.max(...tokenValues, 1), sessionMax = Math.max(...sessionValues, 1), step = (width - pad * 2) / rows.length, barWidth = Math.max(.75, step * .64);
  const points=rows.map((d,i)=>({x:pad+(i+.5)*step,tokenY:height-pad-tokenValues[i]/max*(height-pad*2),sessionY:height-pad-sessionValues[i]/sessionMax*(height-pad*2)}));
  const marks = rows.map((d,i) => { const p=points[i], h=height-pad-p.tokenY, x=p.x-barWidth/2, sessions=Number(d.sessions); return `<g class="trend-day"><rect class="token-bar" x="${x}" y="${p.tokenY}" width="${barWidth}" height="${h}" rx="${Math.min(2,barWidth/2)}"/><circle class="session-dot" cx="${p.x}" cy="${height-pad-(sessions/sessionMax)*44}" r="${Math.max(1,Math.min(3,barWidth))}"/><rect class="trend-hit" x="${pad+i*step}" y="${pad}" width="${step}" height="${height-pad*2}" ${tooltipData(d)}/></g>`; }).join("");
  const labels = rows.filter((_, i) => i % Math.ceil(rows.length / 6) === 0).map((d) => `<text x="${pad+rows.indexOf(d)*step}" y="246">${lifetime?d.day.slice(0,7):d.day.slice(5)}</text>`).join("");
  $("trend").setAttribute("aria-label",`Bar chart of daily token and session usage for ${lifetime?"lifetime":`${rows.length} days`}`);
  $("trend-mode").textContent=lifetime?"Lifetime":`Last ${rows.length} days`;
  $("trend").innerHTML = `<svg viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${marks}${labels}</svg>`;
}

function renderHeatmap(rows, label) {
  const byDay = Object.fromEntries(rows.map((d) => [d.day, d]));
  if(!rows.length){ $("heatmap").innerHTML=""; $("month-labels").innerHTML=""; $("active-days").textContent="0 active days"; return; }
  const columns=53, rowsCount=7, today=new Date(); today.setUTCHours(0,0,0,0); const yearStart=new Date(today); yearStart.setUTCDate(today.getUTCDate()-364); const frameEnd=new Date(today); frameEnd.setUTCDate(today.getUTCDate()+(6-today.getUTCDay())); const frameStart=new Date(frameEnd); frameStart.setUTCDate(frameEnd.getUTCDate()-(columns*7-1));
  const cells=Array.from({length:columns*rowsCount},(_,i)=>{ const date=new Date(frameStart); date.setUTCDate(frameStart.getUTCDate()+i); return date; }), heatmap=$("heatmap"), shell=heatmap.closest(".cadence-calendar");
  shell.style.setProperty("--columns",columns); shell.style.setProperty("--rows",rowsCount);
  const monthAt=new Map(); let previousMonth=""; cells.forEach((date,i)=>{ const month=new Intl.DateTimeFormat("en",{month:"short",timeZone:"UTC"}).format(date); if(month!==previousMonth){ monthAt.set(Math.floor(i/7),month); previousMonth=month; } });
  $("month-labels").innerHTML=`<span></span>${Array.from({length:columns},(_,i)=>`<span>${monthAt.get(i)||""}</span>`).join("")}`;
  const visibleRows=rows.filter(row=>{ const date=new Date(`${row.day}T00:00:00Z`); return date>=yearStart&&date<=today; }), max=Math.max(...visibleRows.map((d)=>Number(d.sessions)),1);
  heatmap.innerHTML=cells.map(date=>{ const day=date.toISOString().slice(0,10), row=byDay[day]; if(!row||date<yearStart||date>today) return '<i class="outside" aria-hidden="true"></i>'; const count=Number(row.sessions||0),level=count?Math.max(1,Math.ceil(count/max*4)):0; return `<i class="l${level}" aria-hidden="true" ${tooltipData(row)}></i>`; }).join("");
  const active=visibleRows.filter((d)=>Number(d.sessions)).length;
  heatmap.setAttribute("aria-label",`Rolling-year session activity calendar for ${label}. ${active} active days visible.`);
  $("active-days").textContent=`${active} active days`;
}

function renderRing(summary) {
  const parts = [{name:"Fresh input",value:Math.max(0,Number(summary.input_tokens)-Number(summary.cached_tokens)),color:"#d69362"},{name:"Cached input",value:Number(summary.cached_tokens),color:"#74816d"},{name:"Visible output",value:Math.max(0,Number(summary.output_tokens)-Number(summary.reasoning_tokens)),color:"#768f93"},{name:"Reasoning",value:Number(summary.reasoning_tokens),color:"#a77f72"}];
  const total = Math.max(parts.reduce((n,p)=>n+p.value,0),1); let cursor=0;
  const stops = parts.map((p) => { const start=cursor; cursor+=p.value/total*100; return `${p.color} ${start}% ${cursor}%`; }).join(",");
  $("token-ring").innerHTML = `<div class="ring" style="background:conic-gradient(${stops})"><b>${fmtTokens(summary.tokens)}</b></div><div class="ring-legend">${parts.map(p=>`<div><i style="background:${p.color}"></i><span>${p.name}</span><b>${fmtTokens(p.value)}</b></div>`).join("")}</div>`;
}

function renderRanks(id, rows, valueKey = "tokens") {
  const max = Math.max(...rows.map((row)=>Number(row[valueKey])),1);
  $(id).innerHTML = rows.length ? rows.slice(0,8).map(row=>{ const value=valueKey === "count" ? number.format(row[valueKey]) : `${number.format(row[valueKey])} tokens`, tip=`${row.name} · ${value}`; return `<div class="rank" data-tooltip="${esc(tip)}"><div class="rank-line"><span>${esc(row.name)}</span><b>${valueKey === "count" ? value : fmtTokens(row[valueKey])}</b></div><div class="bar"><i style="width:${Number(row[valueKey])/max*100}%"></i></div></div>`; }).join("") : '<p class="empty">No data yet.</p>';
}

function setupTooltip() {
  const tooltip=document.createElement("div"); tooltip.className="chart-tooltip"; tooltip.setAttribute("aria-hidden","true"); document.body.append(tooltip);
  let target;
  const place=(x,y)=>{ const gap=12, left=Math.min(innerWidth-tooltip.offsetWidth-gap,Math.max(gap,x+gap)), bottom=innerHeight-y+gap; tooltip.style.left=`${left}px`; if(y-tooltip.offsetHeight-gap>gap){ tooltip.style.top="auto"; tooltip.style.bottom=`${bottom}px`; }else{ tooltip.style.top=`${y+gap}px`; tooltip.style.bottom="auto"; } };
  const show=(element,x,y)=>{ target=element; let models=[]; try{ models=JSON.parse(element.dataset.models||"[]"); }catch{} const modelRows=models.map(model=>`<div class="tooltip-model"><b>${esc(model.model||model.name)}</b><span>${fmtTokens(model.tokens)} tok</span><span>${number.format(model.sessions)} ses</span><strong>${fmtCost(model.usd??model.estimated_cost)}</strong></div>`).join(""); tooltip.innerHTML=element.dataset.tooltipKind === "trend" ? `<b>${fmtDay(element.dataset.date)}</b>${modelRows?`<div class="tooltip-models"><em>Models</em>${modelRows}</div>`:""}<div class="tooltip-totals"><span><i class="tokens"></i>Tokens<strong>${number.format(element.dataset.tokens)}</strong></span><span><i class="sessions"></i>Sessions<strong>${number.format(element.dataset.sessions)}</strong></span><span><i class="cost"></i>API estimate<strong>${fmtCost(element.dataset.cost)}</strong></span></div>` : `<b>${esc(element.dataset.tooltip)}</b>`; tooltip.classList.add("visible"); place(x,y); };
  const hide=()=>{ target=undefined; tooltip.classList.remove("visible"); };
  document.addEventListener("pointerover",event=>{ const element=event.target.closest?.("[data-tooltip]"); if(element) show(element,event.clientX,event.clientY); });
  document.addEventListener("pointermove",event=>{ if(target) place(event.clientX,event.clientY); });
  document.addEventListener("pointerout",event=>{ if(target && !event.relatedTarget?.closest?.("[data-tooltip]")) hide(); });
  document.addEventListener("pointerdown",event=>{ const element=event.target.closest?.("[data-tooltip]"); if(element) show(element,event.clientX,event.clientY); });
}

function render(data) {
  const s=data.summary, window=$("days").value, daily=dailyWindow(data.daily,window,data.estimatedCost?.daily,data.dailyModels);
  $("kpi-sessions").textContent=number.format(s.sessions); $("kpi-systems").textContent=`across ${s.systems} systems`;
  $("kpi-tokens").textContent=fmtTokens(s.tokens); $("kpi-cache").textContent=`${s.input_tokens ? Math.round(s.cached_tokens/s.input_tokens*100) : 0}% input cached`;
  $("kpi-time").textContent=fmtTime(s.duration_ms); $("kpi-prompts").textContent=`${number.format(s.prompts)} prompts`;
  $("kpi-tools").textContent=number.format(s.tools); $("kpi-errors").textContent=`${number.format(s.errors)} errors observed`;
  $("kpi-cost").textContent=fmtCost(data.estimatedCost?.usd); $("kpi-cost-note").textContent=`${Math.round((data.estimatedCost?.coverage??1)*100)}% priced`;
  renderTrend(daily,window==="lifetime"); renderHeatmap(daily,window==="lifetime"?"lifetime":`${window} days`); renderRing(s); renderRanks("models",data.models); renderRanks("repos",data.repos); renderRanks("skills",data.skills||[],"count");
  $("machines").innerHTML=data.systems.map(m=>`<article class="machine"><h3>${esc(m.name)}</h3><span>${esc(m.platform)} / ${esc(m.arch)} · Codex ${esc(m.codex_version)}</span><div class="machine-stats"><div>Sessions<b>${number.format(m.sessions)}</b></div><div>Tokens<b>${fmtTokens(m.tokens)}</b></div><div>Last seen<b>${fmtDate(m.last_seen_at).split(",")[0]}</b></div></div></article>`).join("");
  $("recent").innerHTML=data.recent.map(r=>`<tr><td>${fmtDate(r.started_at)}</td><td class="repo-cell">${esc(r.repo)}</td><td>${esc(r.system)}</td><td>${esc(r.model)} / ${esc(r.effort)}</td><td>${fmtTokens(r.total_tokens)}</td><td>${fmtTime(r.duration_ms)}</td><td>${number.format(r.tool_count)}</td><td><span class="status ${esc(r.status)}">${esc(r.status)}</span></td></tr>`).join("");
  const select=$("system"), selected=requestedSystem||select.value; select.innerHTML='<option value="all">All systems</option>'+data.systems.map(m=>`<option value="${esc(m.id)}">${esc(m.name)}</option>`).join(""); select.value=[...select.options].some(o=>o.value===selected)?selected:"all"; requestedSystem=select.value; persistFilters();
  $("sync-status").textContent = demoMode ? "Demo data" : data.systems.length ? `Synced ${fmtDate(data.systems.map(s=>s.last_seen_at).sort().at(-1))}` : "No collectors yet";
}

function toast(message) { $("toast").textContent=message; $("toast").classList.add("show"); setTimeout(()=>$("toast").classList.remove("show"),4500); }

async function load() {
  const version=++loadVersion;
  if (demoMode) return render(demoData());
  const identity=window.Shoo?.getIdentity();
  if (!identity?.token) return showAuth();
  if (enrollment) {
    const response=await fetch("/api/enroll",{method:"POST",headers:{Authorization:`Bearer ${identity.token}`}});
    if (!response.ok) return rejectIdentity(response);
    const {credential}=await response.json();
    const form=document.createElement("form"), field=document.createElement("input");
    form.method="POST"; form.action=enrollment.href; field.type="hidden"; field.name="credential"; field.value=credential;
    form.append(field); document.body.append(form); showAuth("Completing authorization in the local installer..."); $("sign-in").hidden=true; form.submit(); return;
  }
  const url=new URL("/api/stats",location.origin); url.searchParams.set("days",$("days").value); url.searchParams.set("system",requestedSystem||"all");
  const response=await fetch(url,{headers:{Authorization:`Bearer ${identity.token}`}});
  if(version!==loadVersion || demoMode) return;
  if (!response.ok) return rejectIdentity(response);
  const data=await response.json(); if(version===loadVersion && !demoMode) { $("dashboard").hidden=false; $("auth-gate").hidden=true; $("sign-out").hidden=false; render(data); }
}

async function rejectIdentity(response) { const message=(await response.json().catch(()=>({}))).error||"Authorization failed"; window.Shoo?.clearIdentity(); showAuth(message); toast(message); }
function showAuth(message) { $("dashboard").hidden=true; $("auth-gate").hidden=false; $("sign-out").hidden=true; $("sign-in").hidden=false; $("sync-status").textContent="Private dashboard"; if(enrollment){ $("auth-title").textContent="Authorize this Mac"; $("auth-copy").textContent=message||"Sign in as wrick17@gmail.com to allow this collector to upload your Codex activity."; $("sign-in").textContent="Authorize with Google ↗"; } }

window.addEventListener("DOMContentLoaded", async () => {
  setupTooltip();
  const restored=storedFilters(); $("days").value=restored.days; requestedSystem=restored.system;
  $("dashboard").hidden=!demoMode; $("sign-out").hidden=true;
  $("demo-badge").hidden=!demoMode;
  try { await load(); } catch(error) { toast(error.message); }
  $("days").addEventListener("change",()=>{persistFilters();load().catch(e=>toast(e.message));}); $("system").addEventListener("change",()=>{requestedSystem=$("system").value;persistFilters();load().catch(e=>toast(e.message));});
  $("sign-in").addEventListener("click",()=>window.Shoo.startSignIn({requestPii:true,returnTo:location.pathname+location.search+location.hash}));
  $("sign-out").addEventListener("click",()=>{window.Shoo?.clearIdentity();showAuth();});
});
