/**
 * Live session viewer — a tiny localhost HTTP + SSE server that streams an ACP
 * session to a browser in real time, and can render a self-contained static
 * replay of the same session. Used by `delegate` so a human can watch the
 * Antigravity sub-agent work live while Claude only reads a compact summary.
 */

import { createServer, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { appendFeedback } from "./feedback.js";

export interface ViewerMeta {
  task: string;
  model: string;
  account?: string;
  cwd: string;
  /** When true, the live page shows a one-click feedback bar. */
  feedback?: boolean;
}

export interface ViewerEvent {
  t: number;
  type: "conn" | "prompt" | "run" | "tool" | "msg" | "thought" | "done" | "error";
  text?: string;
  title?: string;
  kind?: string;
  status?: string;
}

export interface Viewer {
  readonly url: string;
  push(event: ViewerEvent): void;
  renderStaticHtml(): string;
  getEvents(): ViewerEvent[];
  /** Resolves true if the user submitted feedback within `timeoutMs`, else false. */
  waitForFeedback(timeoutMs: number): Promise<boolean>;
  close(): Promise<void>;
}

export async function startViewer(meta: ViewerMeta): Promise<Viewer> {
  const events: ViewerEvent[] = [];
  const clients = new Set<ServerResponse>();
  let feedbackGot = false;
  let feedbackResolve: ((v: boolean) => void) | null = null;

  const server = createServer((req, res) => {
    const url = req.url ?? "/";
    if (url === "/feedback" && req.method === "POST") {
      let body = "";
      req.on("data", (c) => {
        body += c;
        if (body.length > 8000) body = body.slice(0, 8000);
      });
      req.on("end", () => {
        try {
          const j = JSON.parse(body || "{}") as { rating?: "up" | "down" | number; note?: string };
          appendFeedback({
            rating: j.rating ?? null,
            note: j.note || undefined,
            source: "viewer",
            task: meta.task,
            model: meta.model,
            cwd: meta.cwd,
          });
        } catch {
          /* ignore malformed body */
        }
        feedbackGot = true;
        if (feedbackResolve) {
          feedbackResolve(true);
          feedbackResolve = null;
        }
        res.writeHead(204);
        res.end();
      });
      return;
    }
    if (url === "/" || url.startsWith("/?")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(renderHtml(meta, null));
    } else if (url === "/events") {
      res.writeHead(200, {
        "content-type": "text/event-stream",
        "cache-control": "no-cache",
        connection: "keep-alive",
      });
      res.write(`retry: 2000\n\n`);
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
  const url = `http://127.0.0.1:${port}`;

  return {
    url,
    push(event) {
      events.push(event);
      const line = `data: ${JSON.stringify(event)}\n\n`;
      for (const c of clients) {
        try {
          c.write(line);
        } catch {
          /* client gone */
        }
      }
    },
    renderStaticHtml() {
      return renderHtml(meta, events);
    },
    getEvents() {
      return events.slice();
    },
    waitForFeedback(timeoutMs: number) {
      if (feedbackGot) return Promise.resolve(true);
      return new Promise<boolean>((resolve) => {
        feedbackResolve = resolve;
        setTimeout(() => {
          if (feedbackResolve) {
            feedbackResolve = null;
            resolve(false);
          }
        }, timeoutMs).unref();
      });
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

/**
 * Render the viewer page. When `embedded` is null the page connects to `/events`
 * (live); when an array is given it replays those events (self-contained file).
 */
function renderHtml(meta: ViewerMeta, embedded: ViewerEvent[] | null): string {
  const data = JSON.stringify({ meta, events: embedded });
  return `<!DOCTYPE html>
<html lang="en"><head><meta charset="utf-8"/>
<meta name="viewport" content="width=device-width, initial-scale=1"/>
<title>Antigravity ACP — session</title>
<style>
  :root{--bg:#faf9f5;--surface:#fff;--surface2:#f1efe8;--text:#1a1a18;--muted:#6b6a64;--faint:#9a988f;--border:rgba(0,0,0,.12);--accent:#185fa5;--ok:#0f6e56;--teal:#0f6e56;--tealbg:#e1f5ee;--mono:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace}
  @media(prefers-color-scheme:dark){:root{--bg:#1f1e1c;--surface:#2a2926;--surface2:#33322e;--text:#ecebe6;--muted:#a8a69d;--faint:#7d7b73;--border:rgba(255,255,255,.14);--accent:#85b7eb;--ok:#5dcaa5;--teal:#9fe1cb;--tealbg:#0f3d33}}
  *{box-sizing:border-box}
  body{margin:0;background:var(--bg);color:var(--text);font-family:ui-sans-serif,system-ui,-apple-system,"Segoe UI",sans-serif;line-height:1.6;-webkit-font-smoothing:antialiased}
  .wrap{max-width:720px;margin:0 auto;padding:28px 20px 80px}
  .head{display:flex;align-items:center;gap:10px;flex-wrap:wrap;margin-bottom:14px}
  .dot{width:9px;height:9px;border-radius:50%;background:var(--faint)}
  .dot.live{background:var(--ok);box-shadow:0 0 0 0 rgba(15,110,86,.5);animation:pulse 1.6s infinite}
  @keyframes pulse{0%{box-shadow:0 0 0 0 rgba(15,110,86,.5)}70%{box-shadow:0 0 0 7px rgba(15,110,86,0)}100%{box-shadow:0 0 0 0 rgba(15,110,86,0)}}
  h1{font-size:17px;font-weight:500;margin:0}
  .chip{font-size:12px;padding:3px 10px;border-radius:8px;background:var(--surface2);color:var(--muted)}
  .clock{margin-left:auto;font-family:var(--mono);font-size:13px;color:var(--faint)}
  .task{background:var(--surface2);border-radius:12px;padding:11px 15px;font-size:14px;margin-bottom:20px}
  .task .lbl{font-size:11px;color:var(--faint);font-family:var(--mono);margin-bottom:3px}
  .ev{display:flex;gap:12px;align-items:flex-start;margin-bottom:11px;animation:in .35s ease}
  @keyframes in{from{opacity:0;transform:translateY(6px)}to{opacity:1;transform:none}}
  .ts{font-family:var(--mono);font-size:12px;color:var(--faint);min-width:46px;padding-top:2px}
  .card{flex:1;border:.5px solid var(--border);border-radius:12px;padding:9px 13px;display:flex;align-items:center;gap:10px}
  .badge{margin-left:auto;font-size:11px;padding:2px 9px;border-radius:999px;background:var(--tealbg);color:var(--teal)}
  .ico{font-size:16px}
  .bubble{flex:1;border:.5px solid var(--border);border-radius:12px;padding:11px 15px}
  .bubble .lbl{font-size:11px;color:var(--faint);margin-bottom:6px}
  .bubble code{font-family:var(--mono);font-size:12.5px;background:var(--surface2);padding:1px 5px;border-radius:4px}
  .line{font-size:13px;color:var(--muted)}
  .ok{color:var(--ok);font-weight:500}
  .foot{margin-top:18px;font-size:12px;color:var(--faint);font-family:var(--mono)}
</style></head>
<body><div class="wrap">
  <div class="head">
    <span class="dot" id="dot"></span>
    <h1>Antigravity ACP</h1>
    <span class="chip" id="model"></span>
    <span class="chip" id="account"></span>
    <span class="clock" id="clock">0.0s</span>
  </div>
  <div class="task"><div class="lbl">session/prompt →</div><div id="task"></div></div>
  <div id="tl"></div>
  <div class="foot" id="foot"></div>
  <div id="fb" style="display:none;margin-top:18px;border-top:.5px solid var(--border);padding-top:14px">
    <div style="font-size:14px;color:var(--text);margin-bottom:8px">كيف كانت النتيجة؟ · How was it?</div>
    <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
      <button class="fbb" data-r="up" style="font-size:18px;padding:4px 12px;border:.5px solid var(--border);border-radius:8px;background:transparent;cursor:pointer">👍</button>
      <button class="fbb" data-r="down" style="font-size:18px;padding:4px 12px;border:.5px solid var(--border);border-radius:8px;background:transparent;cursor:pointer">👎</button>
      <input id="fbnote" placeholder="ملاحظة اختيارية / optional note" style="flex:1;min-width:160px;padding:8px 10px;border:.5px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text)"/>
      <button id="fbsend" style="padding:8px 16px;border:.5px solid var(--border);border-radius:8px;background:var(--surface);color:var(--text);cursor:pointer">إرسال</button>
      <span id="fbok" style="display:none;color:var(--ok);font-size:14px">شكراً! 🙏</span>
    </div>
  </div>
</div>
<script>
const BOOT = ${data};
const tl = document.getElementById("tl");
const esc = s => (s||"").replace(/&/g,"&amp;").replace(/</g,"&lt;");
const fmtMsg = s => esc(s).split("\\n").map(l => l.replace(/\\[([^\\]]+)\\]/g,"<code>$1</code>")).join("<br>");
const stamp = ms => "<span class='ts'>"+(ms/1000).toFixed(1)+"s</span>";
let started = null;
function clock(ms){ document.getElementById("clock").textContent=(ms/1000).toFixed(1)+"s"; }
function add(e){
  if(started===null) started=e.t;
  clock(e.t);
  if(e.type==="conn"){ row(e.t,"<span class='line'><span class='ok'>●</span> "+esc(e.text)+"</span>"); return; }
  if(e.type==="run"){ row(e.t,"<span class='line'>▶ "+esc(e.text)+" started</span>"); return; }
  if(e.type==="tool"){ row(e.t,"<div class='card'><span class='ico'>✎</span><span style='font-weight:500;font-size:14px'>"+esc(e.title)+"</span><span class='badge'>"+esc(e.kind||"")+" · done</span></div>"); return; }
  if(e.type==="thought"){ row(e.t,"<span class='line' style='font-style:italic'>"+fmtMsg(e.text)+"</span>"); return; }
  if(e.type==="msg"){ row(e.t,"<div class='bubble'><div class='lbl'>✦ assistant</div><div style='font-size:14px'>"+fmtMsg(e.text)+"</div></div>"); return; }
  if(e.type==="done"){ row(e.t,"<span class='line ok'>✓ "+esc(e.text)+"</span>"); finish(); return; }
  if(e.type==="error"){ row(e.t,"<span class='line' style='color:#c0392b'>✕ "+esc(e.text)+"</span>"); finish(); return; }
}
function row(t,html){ const d=document.createElement("div"); d.className="ev"; d.innerHTML=stamp(t)+"<div style='flex:1'>"+html+"</div>"; tl.appendChild(d); }
function finish(){ const dot=document.getElementById("dot"); dot.className="dot"; }
function setMeta(m){ document.getElementById("model").textContent="model: "+m.model; document.getElementById("account").textContent="account: "+(m.account||"default"); document.getElementById("task").textContent=m.task; document.getElementById("foot").textContent="cwd: "+m.cwd; }

if(BOOT.events){ setMeta(BOOT.meta); BOOT.events.forEach(add); }
else {
  setMeta(BOOT.meta);
  document.getElementById("dot").className="dot live";
  const es=new EventSource("/events");
  es.onmessage=ev=>{ try{ add(JSON.parse(ev.data)); }catch(_){} };
  es.onerror=()=>{ finish(); };
  if(BOOT.meta.feedback){
    const fb=document.getElementById("fb"); fb.style.display="block";
    let rating=null;
    fb.querySelectorAll(".fbb").forEach(b=>b.onclick=()=>{ rating=b.dataset.r; fb.querySelectorAll(".fbb").forEach(x=>x.style.outline=""); b.style.outline="2px solid var(--ok)"; });
    document.getElementById("fbsend").onclick=()=>{
      const note=document.getElementById("fbnote").value;
      fetch("/feedback",{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify({rating,note})})
        .then(()=>{ document.getElementById("fbok").style.display="inline"; })
        .catch(()=>{ document.getElementById("fbok").textContent="(تعذّر الإرسال)"; document.getElementById("fbok").style.display="inline"; });
    };
  }
}
</script></body></html>`;
}
