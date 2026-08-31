#!/usr/bin/env node
/**
 * Watch ONE answer stream, 10 times a second, and write down what the page does.
 *
 * This exists because the waiting rules were tuned against arithmetic — answers
 * that arrive as a single token. "42" has no stream, no pauses and no button
 * states worth the name, so every number derived from it describes a case that
 * does not occur in real use. Tuning on it produced confident thresholds with no
 * evidence underneath.
 *
 * So: ask for something that actually streams, sample fast, record raw
 * observations, and only afterwards decide what the thresholds should be.
 *
 * The number that matters is the LAST one printed: the longest stretch where the
 * page looked finished — no Stop button, text unchanged — and then produced more
 * text anyway. Any completion rule shorter than that truncates answers, and every
 * rule longer than it is merely slow. It cannot be guessed; it has to be watched.
 *
 * Usage: node tools/observe-stream.mjs ["<prompt>"] [--mode Fast|Thinking]
 */
import { ExtensionTransport } from "../dist/web/transport.js";
import { BrowserTab } from "../dist/web/actions.js";
import { COMPOSER_READY_JS, ensureMode, readMode } from "../dist/web/widgets/qwen-composer.js";

const argv = process.argv.slice(2);
const modeIdx = argv.indexOf("--mode");
const MODE = modeIdx >= 0 ? argv[modeIdx + 1] : "Fast";
const PROMPT =
  argv.find((a) => !a.startsWith("--") && a !== MODE) ??
  "اكتب قصة قصيرة من أربعة أسطر عن نجّار وجد صندوقاً قديماً.";
const TICK = 100;

const PROBE = `(() => {
  const stop = document.querySelector("[aria-label='Stop']");
  const send = document.querySelector('.send-button');
  const md = [...document.querySelectorAll('[class*=markdown]')];
  const tops = md.filter(e => !e.parentElement || !e.parentElement.closest('[class*=markdown]'));
  const fresh = tops.filter(e => !e.hasAttribute('data-acp-seen'));
  const text = fresh.map(e => (e.innerText || '').trim()).filter(Boolean).join('\\n\\n');
  const ta = document.querySelector('textarea');
  return JSON.stringify({
    len: text.length,
    stop: Boolean(stop),
    sendLabel: send ? (send.getAttribute('aria-label') || '') : null,
    sendDisabled: send ? Boolean(send.getAttribute('aria-disabled') === 'true' || send.disabled || /disabled/i.test(send.className)) : null,
    composer: ta ? (ta.value || '').length : null,
    // Anything that looks like a cooldown or a limit notice, so we find out
    // whether one exists instead of assuming it does not.
    notice: [...document.querySelectorAll('[role=alert], [class*=toast], .ant-message, [class*=notification], [class*=cooldown], [class*=limit]')]
      .map(e => (e.innerText || '').trim()).filter(t => t && t.length < 160).join(' | '),
  });
})()`;

async function probe(tab) {
  const r = await tab.evaluate(PROBE);
  if (!r.ok || typeof r.value !== "string") return null;
  try {
    return JSON.parse(r.value);
  } catch {
    return null;
  }
}

const transport = await ExtensionTransport.createTab({ url: "https://chat.qwen.ai/" });
const tab = BrowserTab.fromTransport(transport);

const ready = await tab.waitFor({ untilJs: COMPOSER_READY_JS, timeoutMs: 30000 });
if (!ready.ok) {
  console.error("الصفحة لم تكتمل");
  process.exit(4);
}
await ensureMode(tab, MODE);
console.log(`الوضع: ${(await readMode(tab)).value} · العيّنة كل ${TICK}ms`);
console.log(`الطلب: ${PROMPT}\n`);

// Stamp what exists so "fresh" means this answer only.
await tab.evaluate(`(() => {
  const md = [...document.querySelectorAll('[class*=markdown]')];
  md.filter(e => !e.parentElement || !e.parentElement.closest('[class*=markdown]'))
    .forEach(e => e.setAttribute('data-acp-seen','1'));
  return 1;
})()`);

const before = await probe(tab);
console.log(`قبل الإرسال: زر=${before?.sendLabel ?? "—"} معطّل=${before?.sendDisabled} إيقاف=${before?.stop}`);

await tab.fill("textarea", PROMPT);
const t0 = Date.now();

// PROVE the send happened before watching for an answer.
//
// The first version of this tool ignored the click result and then sat for
// ninety seconds recording a page that had never been asked anything. An
// observation tool that cannot tell "no answer yet" from "no question sent"
// measures nothing — the same failure it was written to investigate.
const sendClick = await tab.click(".send-button");
let sent = (
  await tab.waitFor({
    untilJs: `((document.querySelector('textarea')||{}).value||'').length === 0`,
    timeoutMs: 2000,
    intervalMs: 60,
  })
).ok;
if (!sent) {
  await tab.evaluate(`(()=>{const t=document.querySelector('textarea');if(t)t.focus();return 1})()`);
  await tab.press("Enter");
  sent = (
    await tab.waitFor({
      untilJs: `((document.querySelector('textarea')||{}).value||'').length === 0`,
      timeoutMs: 2000,
      intervalMs: 60,
    })
  ).ok;
}
if (!sent) {
  console.error(`لم يُرسل السؤال (click ok=${sendClick.ok}: ${sendClick.error ?? ""}) — لا معنى للرصد`);
  process.exit(4);
}
console.log(`أُرسل بعد ${Date.now() - t0}ms\n`);

const trace = [];
let lastLen = 0;
let lastGrowth = t0;
let maxGap = 0;
// The dangerous window: page looked done (no Stop, no growth) and then grew.
let lookedDoneSince = null;
let worstFalseFinish = 0;

while (Date.now() - t0 < 90000) {
  await new Promise((r) => setTimeout(r, TICK));
  const p = await probe(tab);
  if (!p) continue;
  const at = Date.now() - t0;
  const grew = p.len > lastLen;

  if (grew) {
    maxGap = Math.max(maxGap, Date.now() - lastGrowth);
    lastGrowth = Date.now();
    if (lookedDoneSince !== null) {
      // It grew after looking finished — that is a false finish, and its length
      // is the floor for any completion rule.
      worstFalseFinish = Math.max(worstFalseFinish, at - lookedDoneSince);
      lookedDoneSince = null;
    }
    lastLen = p.len;
  } else if (!p.stop && p.len > 0) {
    if (lookedDoneSince === null) lookedDoneSince = at;
  }

  trace.push({ at, len: p.len, stop: p.stop, send: p.sendLabel, dis: p.sendDisabled, notice: p.notice });
  // Stop only when it has been quiet for a long, deliberately generous time.
  if (!p.stop && p.len > 0 && Date.now() - lastGrowth > 6000) break;
}

// Print a compact trace: only the ticks where something changed.
let prev = null;
for (const s of trace) {
  const key = `${s.len}|${s.stop}|${s.send}|${s.dis}|${s.notice}`;
  if (key === prev) continue;
  prev = key;
  console.log(
    `${String(s.at).padStart(6)}ms  حروف=${String(s.len).padStart(5)}  إيقاف=${s.stop ? "نعم" : "لا "}  زر=${s.send ?? "—"}  معطّل=${s.dis}` +
      (s.notice ? `  إشعار: ${s.notice}` : ""),
  );
}

console.log(`\nالإجمالي: ${((Date.now() - t0) / 1000).toFixed(1)}s · الطول النهائي: ${lastLen} حرف`);
console.log(`أطول فجوة بين نموّين: ${maxGap}ms`);
console.log(`أطول «انتهاء كاذب» (بدا منتهياً ثم نما): ${worstFalseFinish}ms`);
console.log(
  worstFalseFinish > 0
    ? `=> أي نافذة ثبات أقل من ${worstFalseFinish}ms كانت ستبتر هذا الجواب.`
    : `=> لم يظهر انتهاء كاذب في هذه العيّنة.`,
);

// A second message, to find out whether the site imposes a cooldown at all.
console.log(`\n— رسالة ثانية فوراً، بحثاً عن تهدئة —`);
const t1 = Date.now();
await tab.fill("textarea", "اكتب سطراً واحداً فقط: ما اسم النجّار؟");
const send2 = await tab.click(".send-button");
let acceptedAt = null;
for (let i = 0; i < 60; i++) {
  await new Promise((r) => setTimeout(r, TICK));
  const p = await probe(tab);
  if (p && p.composer === 0) {
    acceptedAt = Date.now() - t1;
    break;
  }
  if (p?.notice) console.log(`  إشعار: ${p.notice}`);
}
console.log(
  acceptedAt === null
    ? `  الرسالة الثانية لم تُقبل خلال 6s (click ok=${send2.ok})`
    : `  قُبلت الرسالة الثانية بعد ${acceptedAt}ms — لا تهدئة تمنع الإرسال المتتالي`,
);

await transport.close?.();
