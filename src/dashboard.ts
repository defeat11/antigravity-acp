/**
 * Multi-lane live dashboard — one localhost HTTP + SSE server that shows several
 * parallel sub-agents side by side (one column per task). Used by `fanout`.
 */

import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

export interface Lane {
  id: string;
  label: string;
}

export interface DashboardMeta {
  title: string;
  concurrency: number;
}

export interface LaneEvent {
  lane: string;
  t: number;
  type: "run" | "conn" | "tool" | "msg" | "thought" | "status" | "done" | "error";
  text?: string;
  title?: string;
  kind?: string;
  status?: string;
}

export interface Dashboard {
  readonly url: string;
  push(event: LaneEvent): void;
  renderStaticHtml(): string;
  close(): Promise<void>;
}

export async function startDashboard(meta: DashboardMeta, lanes: Lane[]): Promise<Dashboard> {
  const events: LaneEvent[] = [];
  const clients = new Set<ServerResponse>();

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/" || url.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderHtml(meta, lanes, null));
    } else if (url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write("retry: 2000\n\n");
      for (const e of events) res.write(`data: ${JSON.stringify(e)}\n\n`);
      clients.add(res);
      req.on("close", () => clients.delete(res));
    } else {
      res.writeHead(404);
      res.end();
    }
  });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as AddressInfo).port;

  return {
    url: `http://127.0.0.1:${port}`,
    push(event) {
      events.push(event);
      const line = `data: ${JSON.stringify(event)}\n\n`;
      for (const c of clients) {
        try {
          c.write(line);
        } catch {
          /* gone */
        }
      }
    },
    renderStaticHtml() {
      return renderHtml(meta, lanes, events);
    },
    close() {
      return new Promise<void>((resolve) => {
        for (const c of clients) {
          try {
            c.end();
          } catch {
            /* ignore */
          }
        }
        server.close(() => resolve());
      });
    },
  };
}

function renderHtml(meta: DashboardMeta, lanes: Lane[], embedded: LaneEvent[] | null): string {
  const data = JSON.stringify({ meta, lanes, events: embedded });
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Antigravity ACP — fan-out</title>
<style>
  :root{--bg:#faf9f5;--surface:#fff;--surface2:#f1efe8;--text:#1a1a18;--muted:#6b6a64;--faint:#9a988f;--border:rgba(0,0,0,.12);--ok:#0f6e56;--okbg:#e1f5ee;--run:#185fa5;--err:#a32d2d;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  @media(prefers-color-scheme:dark){:root{--bg:#1f1e1c;--surface:#2a2926;--surface2:#33322e;--text:#ecebe6;--muted:#a8a69d;--faint:#7d7b73;--border:rgba(255,255,255,.14);--ok:#5dcaa5;--okbg:#0f3d33;--run:#85b7eb;--err:#f09595}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;-webkit-font-smoothing:antialiased}
  .wrap{max-width:1200px;margin:0 auto;padding:24px 18px 70px}
  .top{display:flex;align-items:center;gap:12px;flex-wrap:wrap;margin-bottom:16px}
  h1{font-size:17px;font-weight:500;margin:0}
  .chip{font-size:12px;padding:3px 10px;border-radius:8px;background:var(--surface2);color:var(--muted)}
  .clock{margin-left:auto;font-family:var(--mono);font-size:13px;color:var(--faint)}
  .grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:14px}
  .lane{border:.5px solid var(--border);border-radius:12px;overflow:hidden;background:var(--surface)}
  .lh{display:flex;align-items:center;gap:8px;padding:10px 13px;border-bottom:.5px solid var(--border)}
  .lh .name{font-weight:500;font-size:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
  .st{margin-left:auto;font-size:11px;padding:2px 9px;border-radius:999px;background:var(--surface2);color:var(--muted)}
  .st.run{background:transparent;color:var(--run)}
  .st.ok{background:var(--okbg);color:var(--ok)}
  .st.err{background:transparent;color:var(--err)}
  .feed{padding:9px 13px;display:flex;flex-direction:column;gap:7px;max-height:420px;overflow:auto}
  .row{display:flex;gap:8px;font-size:13px;line-height:1.5;animation:in .3s ease}
  @keyframes in{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}
  .ts{font-family:var(--mono);font-size:11px;color:var(--faint);min-width:40px}
  .tool{color:var(--ok)}
  .msg{color:var(--text)}
  .thought{color:var(--muted);font-style:italic}
  .err{color:var(--err)}
  .spin{display:inline-block;width:8px;height:8px;border-radius:50%;background:var(--run);animation:p 1.2s infinite}
  @keyframes p{0%,100%{opacity:.3}50%{opacity:1}}
</style></head>
<body><div class="wrap">
  <div class="top">
    <h1 id="title">Antigravity fan-out</h1>
    <span class="chip" id="meta"></span>
    <span class="clock" id="clock">0.0s</span>
  </div>
  <div class="grid" id="grid"></div>
</div>
<script>
const BOOT = ${data};
const grid = document.getElementById("grid");
const esc = s => (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;");
const stamp = ms => "<span class='ts'>"+(ms/1000).toFixed(1)+"s</span>";
const lanes = {};
let started = null, done = 0, total = (BOOT.lanes||[]).length;

document.getElementById("title").textContent = BOOT.meta.title;
function setMeta(){ document.getElementById("meta").textContent = "concurrency "+BOOT.meta.concurrency+" · "+done+"/"+total+" done"; }

function makeLane(l){
  const el=document.createElement("div"); el.className="lane";
  el.innerHTML="<div class='lh'><span class='spin' id='sp-"+l.id+"'></span><span class='name' title='"+esc(l.label)+"'>"+esc(l.label)+"</span><span class='st' id='st-"+l.id+"'>queued</span></div><div class='feed' id='fd-"+l.id+"'></div>";
  grid.appendChild(el);
  lanes[l.id]={feed:el.querySelector("#fd-"+l.id),st:el.querySelector("#st-"+l.id),sp:el.querySelector("#sp-"+l.id)};
}
(BOOT.lanes||[]).forEach(makeLane);
setMeta();

function row(L,t,cls,html){ const d=document.createElement("div"); d.className="row"; d.innerHTML=stamp(t)+"<span class='"+cls+"' style='flex:1'>"+html+"</span>"; L.feed.appendChild(d); L.feed.scrollTop=L.feed.scrollHeight; }
function setSt(L,txt,cls){ L.st.textContent=txt; L.st.className="st "+(cls||""); }

function add(e){
  const L=lanes[e.lane]; if(!L) return;
  if(started===null) started=e.t; document.getElementById("clock").textContent=(e.t/1000).toFixed(1)+"s";
  if(e.type==="run"){ setSt(L,"running","run"); row(L,e.t,"thought","▶ "+esc(e.text)); }
  else if(e.type==="conn"){ row(L,e.t,"thought",esc(e.text)); }
  else if(e.type==="status"){ setSt(L,esc(e.text),"run"); }
  else if(e.type==="tool"){ row(L,e.t,"tool","✎ "+esc(e.title)); }
  else if(e.type==="thought"){ row(L,e.t,"thought",esc((e.text||"").slice(0,160))); }
  else if(e.type==="msg"){ row(L,e.t,"msg",esc((e.text||"").slice(0,400))); }
  else if(e.type==="done"){ setSt(L,"done","ok"); L.sp.style.display="none"; row(L,e.t,"tool","✓ "+esc(e.text)); done++; setMeta(); }
  else if(e.type==="error"){ setSt(L,"failed","err"); L.sp.style.display="none"; row(L,e.t,"err","✕ "+esc(e.text)); done++; setMeta(); }
}

if(BOOT.events){ BOOT.events.forEach(add); }
else { const es=new EventSource("/events"); es.onmessage=ev=>{ try{add(JSON.parse(ev.data));}catch(_){} }; }
</script></body></html>`;
}
