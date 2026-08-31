/**
 * Multi-tab test: N independent Qwen conversations at once.
 *
 * The interesting constraint: injected input (fill/click) only lands on a
 * FOREGROUND tab, and only one tab can be foreground at a time — so the send
 * phase must be serialised. Waiting for the answer needs no foreground, so it
 * overlaps freely. This measures how much that actually buys.
 *
 * Usage: node tools/qwen-parallel.mjs [tabCount]
 */
import { ExtensionTransport } from "../dist/web/transport.js";
import { BrowserTab } from "../dist/web/actions.js";

const N = Math.max(2, Math.min(8, Number(process.argv[2]) || 4));
const URL_TEMP = "https://chat.qwen.ai/?temporary-chat=true";
const QUESTIONS = [
  "بجملة قصيرة: ما هو الـ load balancer؟",
  "بجملة قصيرة: ما الفرق بين SQL و NoSQL؟",
  "بجملة قصيرة: لماذا نستخدم Docker؟",
  "بجملة قصيرة: ما وظيفة الـ DNS؟",
  "بجملة قصيرة: ما الفرق بين TCP و UDP؟",
  "بجملة قصيرة: ما هو الـ CDN؟",
  "بجملة قصيرة: ما فائدة الـ cache؟",
  "بجملة قصيرة: ما هو الـ API gateway؟",
];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Only one tab can hold the foreground, so every input phase takes this lock. */
let chain = Promise.resolve();
const withForeground = (fn) => {
  const run = chain.then(fn, fn);
  chain = run.then(
    () => {},
    () => {},
  );
  return run;
};

async function evalJson(tab, code) {
  const r = await tab.evaluate(code);
  if (!r.ok) throw new Error(r.error || "evaluate failed");
  return typeof r.value === "string" ? JSON.parse(r.value) : r.value;
}

async function setup(i) {
  const t = await ExtensionTransport.createTab({ url: "about:blank" });
  const tab = BrowserTab.fromTransport(t);
  await tab.navigate(URL_TEMP);
  await sleep(2000);
  await tab.evaluate(
    `(()=>{const c=[...document.querySelectorAll('span,button')].find(e=>(e.innerText||'').trim()==='Close');if(c)c.click();return 1})()`,
  );
  // Background tabs are throttled, so the app can still be booting well after
  // navigate() resolves. Wait for the control instead of assuming a fixed delay,
  // and never let one slow tab abort the whole run.
  let ctlRef = null;
  for (let attempt = 0; attempt < 20 && !ctlRef; attempt++) {
    const snap = await tab.snapshot();
    const ctl = snap.nodes.find((n) => /thinking/i.test(n.name || ""));
    if (ctl) ctlRef = ctl.ref;
    else await sleep(500);
  }
  if (!ctlRef) {
    console.log(`   ! تبويب ${i + 1}: تعذّر إيجاد حقل Thinking — يكمل على Auto`);
    return { i, tab, mode: "Auto (fallback)" };
  }

  // Thinking = Fast (input phase -> needs the foreground)
  await withForeground(async () => {
    await tab.click(ctlRef);
    await sleep(1000);
    const rect = await evalJson(
      tab,
      `JSON.stringify((()=>{const el=[...document.querySelectorAll('*')].filter(e=>(e.innerText||'').trim()==='Fast'&&e.children.length===0).pop();if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})())`,
    );
    if (rect) {
      await t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
      await t.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, buttons: 1, x: rect.x, y: rect.y });
      await t.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, buttons: 0, x: rect.x, y: rect.y });
    }
    await sleep(500);
  });
  const mode = await evalJson(
    tab,
    `JSON.stringify((()=>{const i=[...document.querySelectorAll('input')].find(e=>/thinking/i.test(e.getAttribute('aria-label')||''));const d=i?i.closest('div'):null;return d?(d.innerText||'').trim().split('\\n')[0]:null})())`,
  );
  return { i, tab, mode };
}

async function waitForAnswer(tab, prevCount, timeoutMs = 60000) {
  const started = Date.now();
  let last = "";
  let stable = 0;
  while (Date.now() - started < timeoutMs) {
    const s = await evalJson(
      tab,
      `JSON.stringify((()=>{const e=[...document.querySelectorAll('[class*=markdown]')];const b=[...document.querySelectorAll('button')].some(x=>/stop/i.test((x.getAttribute('aria-label')||x.innerText||'').trim()));return {count:e.length,text:e.length?e[e.length-1].innerText.trim():'',streaming:b}})())`,
    );
    if (s.count > prevCount && s.text && !s.streaming) {
      if (s.text === last) {
        if (++stable >= 2) return s.text;
      } else {
        stable = 0;
        last = s.text;
      }
    }
    await sleep(250);
  }
  throw new Error("timeout waiting for answer");
}

console.log(`=== ${N} محادثات Qwen متوازية ===`);
const tSetup = Date.now();
const tabs = [];
for (let i = 0; i < N; i++) tabs.push(await setup(i));
console.log(`التهيئة: ${((Date.now() - tSetup) / 1000).toFixed(1)}s · أوضاع التفكير: ${tabs.map((t) => t.mode).join(", ")}\n`);

const t0 = Date.now();
const runs = tabs.map(async ({ i, tab }) => {
  const start = Date.now();
  const before = await evalJson(tab, `JSON.stringify(document.querySelectorAll('[class*=markdown]').length)`);
  let sendMs = 0;
  await withForeground(async () => {
    const s = Date.now();
    const f = await tab.fill("textarea", QUESTIONS[i]);
    if (!f.ok) throw new Error(`fill: ${f.error}`);
    const c = await tab.click(".send-button");
    if (!c.ok) throw new Error(`send: ${c.error}`);
    sendMs = Date.now() - s;
  });
  const answer = await waitForAnswer(tab, before);
  return { i, total: Date.now() - start, sendMs, answer };
});

const settled = await Promise.allSettled(runs);
const wall = Date.now() - t0;
let sum = 0;
for (const r of settled) {
  if (r.status === "fulfilled") {
    sum += r.value.total;
    console.log(
      `تبويب ${r.value.i + 1}: ${(r.value.total / 1000).toFixed(1)}s (إرسال ${(r.value.sendMs / 1000).toFixed(1)}s) — ${r.value.answer.replace(/\s+/g, " ").slice(0, 55)}`,
    );
  } else {
    console.log(`تبويب ?: فشل — ${String(r.reason?.message || r.reason).slice(0, 90)}`);
  }
}
const okCount = settled.filter((s) => s.status === "fulfilled").length;
console.log(`\n=== النتيجة ===`);
console.log(`نجح: ${okCount}/${N}`);
console.log(`الزمن الكلي بالتوازي: ${(wall / 1000).toFixed(1)}s`);
console.log(`مجموع الأزمنة لو نُفِّذت تتابعاً: ${(sum / 1000).toFixed(1)}s`);
if (okCount > 1) console.log(`المكسب: ×${(sum / wall).toFixed(1)}`);
for (const { tab } of tabs) {
  try {
    await tab.close();
  } catch {}
}
process.exit(0);
