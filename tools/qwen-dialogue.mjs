/**
 * Multi-turn idea exchange with Qwen (Thinking mode), where we bring our own
 * proposals into the conversation instead of only asking.
 *
 * Usage: node tools/qwen-dialogue.mjs
 */
import { ExtensionTransport, ensureExtensionReady } from "../dist/web/transport.js";
import { BrowserTab } from "../dist/web/actions.js";

const URL_CHAT = "https://chat.qwen.ai/";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const TURNS = [
  `أنا وكيل برمجي (Claude) أبني مع صاحبي نظاماً اسمه ACP WebBridge: يعطي وكيل AI تحكماً بمتصفح Chrome حقيقي عبر CDP، بلا Playwright وبلا أعلام أتمتة، فالإدخال يصل بـ isTrusted=true و navigator.webdriver يبقى false. استخدامه الوحيد حالياً: استشارتك أنت عبر chat.qwen.ai بحساب المستخدم.

الموجود اليوم: أوامر navigate/snapshot/click/fill/press/evaluate/screenshot عبر CLI · snapshot يعطي مراجع @eN + نص الصفحة · حارس أمان (قائمة نطاقات، قراءة افتراضياً، أزرار الإرسال تحتاج إذناً بشرياً) · جلسات مسمّاة تعود لمحادثتها حتى بعد إغلاق المتصفح · اعتناء ذاتي يفتح المتصفح والخادم المحلي وحده (25-42 ثانية من الصفر) · توازٍ 6 محادثات في 23.8 ثانية · استشارة واحدة وسيطها 3.8 ثانية.

سؤالي المحدد في محورين: (أ) التحكم السريع — ما الذي يقلّل الاحتكاك والرحلات ذهاباً وإياباً؟ (ب) التعلّم السريع — ما الذي يجعل النظام يتحسّن مع الاستخدام بدل إعادة اكتشاف كل موقع من الصفر؟

أعطني 5 أفكار مركّزة فقط، كل واحدة بسطرين: ماذا تحل، وأكبر مقايضة فيها. لا تقترح إضعاف الحارس ولا التخفّي ولا حل الكابتشا.`,

  `أفكار جيدة. أشاركك الآن أربع أفكار من عندي — انقدها بصراحة وقل أيها يستحق البناء وأيها وهم:
1) أمر مركّب واحد يجمع: اكتب + أرسل + انتظر الاكتمال + اقرأ. السبب: الاستشارة 3.8 ثانية داخل الموقع لكنها 8.8 عبر سطر الأوامر، والفارق كله رحلات وعمليات.
2) بدائية «انتظر حتى شرط JS» بدل النوم الثابت.
3) ذاكرة محدِّدات ذاتية الإصلاح: أخزّن المحدِّد الناجح، وعند فشله أعيد اشتقاقه من لقطة الوصولية وأحدّثه تلقائياً مع تسجيل الفرق، فيصير تغيّر الواجهة مرئياً بدل أن يكسرني صامتاً.
4) وضع تعلّم: يستخدم الإنسان الموقع يدوياً مرة بينما يسجّل النظام تفاعله ثم يولّد مسودة دليل للموقع.
كن ناقداً لا مجاملاً.`,

  `خلاصة أخيرة من فضلك، مركّزة جداً:

رتّب كل ما طرحناه معاً (أفكارك الخمس + أفكاري الأربع بعد نقدك) في **ثلاث أفكار فقط** تستحق التنفيذ أولاً، بمعيار القيمة مقسومة على الجهد.

لكل واحدة: اسم قصير · ما الذي يتحسّن قياسياً (رقم إن أمكن) · أول خطوة تنفيذية ملموسة · أكبر خطر.
ثم سطر أخير واحد: ما الفكرة التي **لا** تستحق البناء الآن ولماذا.`,
];

const ready = await ensureExtensionReady();
if (ready.actions.length) console.log(`(اعتناء ذاتي: ${ready.actions.join(" · ")})`);
if (!ready.ready) {
  console.log("الإضافة لم تتصل — تأكد أن مفتاح الإضافة ON في كروم.");
  process.exit(4);
}

const t = await ExtensionTransport.createTab({ url: "about:blank" });
const tab = BrowserTab.fromTransport(t);

async function evalJson(code) {
  const r = await tab.evaluate(code);
  if (!r.ok) throw new Error(r.error || "evaluate failed");
  return typeof r.value === "string" ? JSON.parse(r.value) : r.value;
}

async function waitForAnswer(prevCount, timeoutMs = 180000) {
  const started = Date.now();
  let last = "";
  let stable = 0;
  while (Date.now() - started < timeoutMs) {
    const s = await evalJson(
      `JSON.stringify((()=>{const e=[...document.querySelectorAll('[class*=markdown]')];const b=[...document.querySelectorAll('button')].some(x=>/stop/i.test((x.getAttribute('aria-label')||x.innerText||'').trim()));return {count:e.length,text:e.length?e[e.length-1].innerText.trim():'',streaming:b}})())`,
    );
    if (s.count > prevCount && s.text && !s.streaming) {
      if (s.text === last) {
        if (++stable >= 3) return { text: s.text, ms: Date.now() - started };
      } else {
        stable = 0;
        last = s.text;
      }
    }
    await sleep(400);
  }
  throw new Error(`timeout after ${timeoutMs}ms`);
}

await tab.navigate(URL_CHAT);
await sleep(3000);
await tab.evaluate(
  `(()=>{const c=[...document.querySelectorAll('span,button')].find(e=>(e.innerText||'').trim()==='Close');if(c)c.click();return 1})()`,
);

// Thinking mode — explicitly requested for this session by the human.
const ctlSnap = await tab.snapshot();
const ctl = ctlSnap.nodes.find((n) => /thinking/i.test(n.name || ""));
if (ctl) {
  await tab.click(ctl.ref);
  await sleep(1200);
  const rect = await evalJson(
    `JSON.stringify((()=>{const el=[...document.querySelectorAll('*')].filter(e=>(e.innerText||'').trim()==='Thinking'&&e.children.length===0).pop();if(!el)return null;el.scrollIntoView({block:'center'});const r=el.getBoundingClientRect();return{x:r.left+r.width/2,y:r.top+r.height/2}})())`,
  );
  if (rect) {
    await t.send("Input.dispatchMouseEvent", { type: "mouseMoved", x: rect.x, y: rect.y });
    await t.send("Input.dispatchMouseEvent", { type: "mousePressed", button: "left", clickCount: 1, buttons: 1, x: rect.x, y: rect.y });
    await t.send("Input.dispatchMouseEvent", { type: "mouseReleased", button: "left", clickCount: 1, buttons: 0, x: rect.x, y: rect.y });
  }
  await sleep(800);
}
const mode = await evalJson(
  `JSON.stringify((()=>{const s=document.querySelector('.ant-select-selection-item');return s?s.innerText.trim():null})())`,
);
console.log(`=== حوار مع Qwen · وضع التفكير: ${mode} ===\n`);

for (let i = 0; i < TURNS.length; i++) {
  const before = await evalJson(`JSON.stringify(document.querySelectorAll('[class*=markdown]').length)`);
  const f = await tab.fill("textarea", TURNS[i]);
  if (!f.ok) throw new Error(`fill failed: ${f.error}`);

  // A long message grows the composer and can push the send button below the
  // fold; the viewport guard then (correctly) refuses to click blind coordinates.
  // Scroll it back into view and retry before giving up.
  let c = await tab.click(".send-button");
  if (!c.ok) {
    await tab.evaluate(
      `(()=>{const b=document.querySelector('.send-button');if(b)b.scrollIntoView({block:'center'});window.scrollTo(0,document.body.scrollHeight);return 1})()`,
    );
    await sleep(600);
    c = await tab.click(".send-button");
  }
  if (!c.ok) throw new Error(`send failed: ${c.error}`);
  const a = await waitForAnswer(before);
  console.log(`\n########## دور ${i + 1} (${(a.ms / 1000).toFixed(1)}s) ##########\n`);
  console.log(a.text);
  await sleep(1500);
}

const url = await evalJson(`JSON.stringify(location.href)`);
console.log(`\n=== انتهى · رابط المحادثة: ${url} ===`);
process.exit(0);
