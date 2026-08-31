/**
 * Qwen3.8-Max training/benchmark loop — 20 consecutive consultations in ONE
 * temporary chat, measuring end-to-end latency and recording every failure.
 * Human-authorised run (sending is explicit), so allowSubmit is set once here.
 */
import { ExtensionTransport } from "../dist/web/transport.js";
import { BrowserTab } from "../dist/web/actions.js";
import { classifyAction } from "../dist/web/guard.js";
import { readDomains } from "../dist/web/state.js";

const URL_TEMP = "https://chat.qwen.ai/?temporary-chat=true";
const WANT_MODEL = "Qwen3.8-Max";
const QUESTIONS = [
  "بكلمة واحدة: ما عاصمة اليابان؟",
  "بكلمة واحدة: ما أكبر كوكب في المجموعة الشمسية؟",
  "بكلمة واحدة: ما رمز عنصر الحديد الكيميائي؟",
  "بجملة قصيرة: ما الفرق بين HTTP و HTTPS؟",
  "بكلمة واحدة: كم عدد قارات العالم؟",
  "بجملة قصيرة: ما وظيفة الـ DNS؟",
  "بكلمة واحدة: ما لغة البرمجة التي ابتكرها Guido van Rossum؟",
  "بجملة قصيرة: ما الفرق بين RAM و ROM؟",
  "بكلمة واحدة: ما أطول نهر في العالم؟",
  "بجملة قصيرة: ما معنى API؟",
  "بكلمة واحدة: في أي عام هبط الإنسان على القمر؟",
  "بجملة قصيرة: ما فائدة الـ index في قواعد البيانات؟",
  "بكلمة واحدة: ما عملة سويسرا؟",
  "بجملة قصيرة: ما الفرق بين git merge و git rebase؟",
  "بكلمة واحدة: ما أسرع حيوان بري؟",
  "بجملة قصيرة: ما هو الـ load balancer؟",
  "بكلمة واحدة: كم ضلعاً للمسدس؟",
  "بجملة قصيرة: لماذا نستخدم Docker؟",
  "بكلمة واحدة: ما عاصمة كندا؟",
  "بجملة قصيرة: ما الفرق بين SQL و NoSQL؟",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const errors = [];
const note = (round, kind, detail) => {
  errors.push({ round, kind, detail });
  process.stdout.write(`   ! [${kind}] ${detail}\n`);
};

// ---- guard check once, exactly as the CLI would ----
const decision = classifyAction({
  action: "click",
  readOnly: false,
  label: "Send",
  url: URL_TEMP,
  allowlist: readDomains(),
  allowSubmit: true,
});
if (decision.decision !== "allow") {
  console.log(`guard refused: ${decision.reason}`);
  process.exit(3);
}

const t = await ExtensionTransport.createTab({ url: "about:blank" });
const tab = BrowserTab.fromTransport(t);

async function evalJson(code) {
  const r = await tab.evaluate(code);
  if (!r.ok) throw new Error(r.error || "evaluate failed");
  return typeof r.value === "string" ? JSON.parse(r.value) : r.value;
}

async function openFresh() {
  await tab.navigate(URL_TEMP);
  await sleep(2500);
  // dismiss the rating popup if it is covering the UI
  await tab.evaluate(
    `(()=>{const c=[...document.querySelectorAll('span,button')].find(e=>(e.innerText||'').trim()==='Close');if(c)c.click();return 1})()`,
  );
}

async function currentModel() {
  return await evalJson(
    `JSON.stringify((()=>{const e=[...document.querySelectorAll('div')].find(x=>/^Qwen[0-9.]+-(Max|Plus|Turbo)$/.test((x.innerText||'').trim())&&x.children.length<4);return e?e.innerText.trim():null})())`,
  );
}

async function selectModel(want) {
  const now = await currentModel();
  if (now === want) return { switched: false, model: now };
  const snap = await tab.snapshot();
  const btn = snap.nodes.find((n) => /^Qwen[0-9.]+-(Max|Plus|Turbo)$/.test((n.name || "").trim()));
  if (!btn) throw new Error("model button not found");
  const c1 = await tab.click(btn.ref);
  if (!c1.ok) throw new Error(`model menu click failed: ${c1.error}`);
  await sleep(1200);
  const snap2 = await tab.snapshot();
  const item = snap2.nodes.find((n) => (n.name || "").trim().startsWith(want) && n.ref !== btn.ref);
  if (!item) throw new Error(`model "${want}" not in the menu`);
  const c2 = await tab.click(item.ref);
  if (!c2.ok) throw new Error(`model pick failed: ${c2.error}`);
  await sleep(1500);
  return { switched: true, model: await currentModel() };
}

/** Thinking mode: Auto (default) | Thinking | Fast. Fast skips the reasoning pass. */
async function clickByExactText(text) {
  // The dropdown entries carry no accessible name that snapshot() can key on, so
  // locate by exact leaf text and dispatch the same TRUSTED input a click would.
  const rect = await evalJson(
    `JSON.stringify((()=>{const el=[...document.querySelectorAll('*')].filter(e=>(e.innerText||'').trim()===${JSON.stringify(text)}&&e.children.length===0).pop();if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2,vw:innerWidth,vh:innerHeight}})())`,
  );
  if (!rect) throw new Error(`option "${text}" not found on the page`);
  if (rect.x < 0 || rect.y < 0 || rect.x > rect.vw || rect.y > rect.vh) {
    throw new Error(`option "${text}" is outside the viewport`);
  }
  await t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
  await sleep(50);
  await t.send("Input.dispatchMouseEvent", {
    type: "mousePressed", button: "left", clickCount: 1, buttons: 1, x: rect.x, y: rect.y,
  });
  await sleep(50);
  await t.send("Input.dispatchMouseEvent", {
    type: "mouseReleased", button: "left", clickCount: 1, buttons: 0, x: rect.x, y: rect.y,
  });
}

async function selectThinking(want) {
  const snap = await tab.snapshot();
  const ctl = snap.nodes.find((n) => /thinking/i.test(n.name || ""));
  if (!ctl) throw new Error("thinking control not found");
  const c1 = await tab.click(ctl.ref);
  if (!c1.ok) throw new Error(`thinking menu click failed: ${c1.error}`);
  await sleep(1200);
  await clickByExactText(want);
  await sleep(800);
  return await evalJson(
    `JSON.stringify((()=>{const i=[...document.querySelectorAll('input')].find(e=>/thinking/i.test(e.getAttribute('aria-label')||''));const d=i?i.closest('div'):null;return d?(d.innerText||'').trim().split('\\n')[0]:null})())`,
  );
}

/** Poll until the answer is complete: send button back + text stable. */
async function waitForAnswer(prevCount, timeoutMs = 90000) {
  const started = Date.now();
  let last = "";
  let stable = 0;
  while (Date.now() - started < timeoutMs) {
    const s = await evalJson(
      `JSON.stringify((()=>{const e=[...document.querySelectorAll('[class*=markdown]')];const b=[...document.querySelectorAll('button')].some(x=>/stop/i.test((x.getAttribute('aria-label')||x.innerText||'').trim()));return {count:e.length,text:e.length?e[e.length-1].innerText.trim():'',streaming:b}})())`,
    );
    if (s.count > prevCount && s.text && !s.streaming) {
      if (s.text === last) {
        stable++;
        if (stable >= 2) return { text: s.text, ms: Date.now() - started, count: s.count };
      } else {
        stable = 0;
        last = s.text;
      }
    }
    await sleep(250);
  }
  throw new Error(`timeout after ${timeoutMs}ms`);
}

async function ask(round, question) {
  const t0 = Date.now();
  const before = await evalJson(
    `JSON.stringify(document.querySelectorAll('[class*=markdown]').length)`,
  );
  const f = await tab.fill("textarea", question);
  if (!f.ok) throw new Error(`fill failed: ${f.error}`);
  const c = await tab.click(".send-button");
  if (!c.ok) throw new Error(`send failed: ${c.error}`);
  const a = await waitForAnswer(before);
  return { ms: Date.now() - t0, answer: a.text };
}

console.log(`=== Qwen ${WANT_MODEL} — 20 rounds · thinking=Fast ===`);
await openFresh();
const m = await selectModel(WANT_MODEL);
let thinking = "Auto";
try {
  thinking = await selectThinking("Fast");
} catch (e) {
  note(0, "thinking", String(e.message || e));
}
console.log(
  `model: ${m.model}${m.switched ? " (switched)" : " (already active)"} · thinking: ${thinking}\n`,
);

const results = [];
for (let i = 0; i < QUESTIONS.length; i++) {
  const round = i + 1;
  let attempt = 0;
  while (attempt < 2) {
    attempt++;
    try {
      const r = await ask(round, QUESTIONS[i]);
      results.push({ round, ms: r.ms, ok: true, retried: attempt > 1 });
      console.log(
        `#${String(round).padStart(2)} ${(r.ms / 1000).toFixed(1)}s  ${r.answer.replace(/\s+/g, " ").slice(0, 62)}`,
      );
      break;
    } catch (err) {
      note(round, attempt === 1 ? "retryable" : "failed", String(err.message || err));
      if (attempt >= 2) {
        results.push({ round, ms: null, ok: false });
      } else {
        // recovery: re-open a fresh temporary chat and re-select the model
        try {
          await openFresh();
          await selectModel(WANT_MODEL);
        } catch (e2) {
          note(round, "recovery-failed", String(e2.message || e2));
        }
      }
    }
  }
}

const ok = results.filter((r) => r.ok);
const times = ok.map((r) => r.ms).sort((a, b) => a - b);
const avg = times.reduce((a, b) => a + b, 0) / (times.length || 1);
console.log(`\n=== النتيجة ===`);
console.log(`نجحت: ${ok.length}/${results.length} · أعيدت المحاولة في: ${ok.filter((r) => r.retried).length}`);
if (times.length) {
  console.log(
    `الزمن (ثانية) — الأسرع ${(times[0] / 1000).toFixed(1)} · الوسيط ${(times[Math.floor(times.length / 2)] / 1000).toFixed(1)} · المتوسط ${(avg / 1000).toFixed(1)} · الأبطأ ${(times[times.length - 1] / 1000).toFixed(1)}`,
  );
}
console.log(`الأخطاء المرصودة: ${errors.length}`);
for (const e of errors) console.log(`  round ${e.round} · ${e.kind}: ${e.detail.slice(0, 120)}`);
await tab.close();
process.exit(0);
