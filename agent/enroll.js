#!/usr/bin/env bun

const endpoint=new URL(process.env.CODEX_STATS_URL||"https://codex-stats.wrick17.com");
const nonce=crypto.randomUUID();
let finish;
const completed=new Promise((resolve,reject)=>{ finish={resolve,reject}; });
const headers={"Content-Type":"text/html; charset=utf-8","Cache-Control":"no-store"};

const server=Bun.serve({
  hostname:"127.0.0.1",
  port:0,
  async fetch(request) {
    const url=new URL(request.url);
    if (url.pathname!==`/${nonce}`) return new Response("Forbidden",{status:403,headers});
    if (request.method!=="POST") return new Response("Method not allowed",{status:405,headers});
    let credential;
    try { credential=(await request.formData()).get("credential"); } catch {}
    if (typeof credential!=="string" || !credential.startsWith("v1.") || credential.length>4096) return new Response("Invalid credential",{status:400,headers});
    const process=Bun.spawn(["/usr/bin/security","add-generic-password","-a","codex-stats","-s","codex-stats-ingest","-w",credential,"-U"],{stdout:"ignore",stderr:"ignore"});
    if (await process.exited) return new Response("Keychain write failed",{status:500,headers});
    setTimeout(finish.resolve,100);
    return new Response("<!doctype html><title>Codex Stats</title><p>This Mac is authorized. You may close this tab.</p>",{headers});
  },
});

const callback=`http://127.0.0.1:${server.port}/${nonce}`;
const authorize=new URL(endpoint);
authorize.searchParams.set("enroll",callback);
console.log("Opening the owner sign-in to authorize this Mac...");
Bun.spawn(["/usr/bin/open",authorize.href],{stdout:"ignore",stderr:"ignore"});
const timeout=setTimeout(()=>finish.reject(new Error("Collector authorization timed out")),300000);

try {
  await completed;
  console.log("This Mac is authorized for Codex Stats.");
} finally {
  clearTimeout(timeout);
  server.stop(true);
}
