#!/usr/bin/env node
/**
 * When does the Send button actually become clickable?
 *
 * Observation from the stream trace: sending took 3.2 seconds, and it did not
 * take them in the network — the click reported success and nothing happened, so
 * the run sat through a 2s timeout and only got through on the Enter fallback.
 * The trace also showed a state nobody here had looked at: the button carries a
 * DISABLED flag.
 *
 * The obvious hypothesis is that the button is disabled while the composer is
 * empty and needs a moment after typing before it accepts a click — which would
 * mean the tool has been clicking a dead button on every single consultation and
 * paying a timeout to recover. This measures exactly that instead of assuming it.
 *
 * Usage: node tools/observe-send.mjs
 */
import { ExtensionTransport } from "../dist/web/transport.js";
import { BrowserTab } from "../dist/web/actions.js";
import { COMPOSER_READY_JS } from "../dist/web/widgets/qwen-composer.js";

const STATE = `(() => {
  const b = document.querySelector('.send-button');
  const ta = document.querySelector('textarea');
  if (!b) return JSON.stringify({ missing: true });
  const cs = getComputedStyle(b);
  return JSON.stringify({
    label: b.getAttribute('aria-label') || '',
    ariaDisabled: b.getAttribute('aria-disabled'),
    domDisabled: Boolean(b.disabled),
    classDisabled: /disabled/i.test(b.className || ''),
    pointer: cs.pointerEvents,
    opacity: cs.opacity,
    composer: ta ? (ta.value || '').length : null,
  });
})()`;

async function state(tab) {
  const r = await tab.evaluate(STATE);
  try {
    return JSON.parse(String(r.value));
  } catch {
    return null;
  }
}

const transport = await ExtensionTransport.createTab({ url: "https://chat.qwen.ai/" });
const tab = BrowserTab.fromTransport(transport);
if (!(await tab.waitFor({ untilJs: COMPOSER_READY_JS, timeoutMs: 30000 })).ok) {
  console.error("الصفحة لم تكتمل");
  process.exit(4);
}

console.log("قبل الكتابة:", JSON.stringify(await state(tab)));

const t0 = Date.now();
await tab.fill("textarea", "اكتب سطراً واحداً فقط: ما لون السماء؟");
console.log(`الكتابة استغرقت ${Date.now() - t0}ms`);

// Sample the button every 50ms and report the moment it stops being disabled.
let enabledAt = null;
let prev = null;
const t1 = Date.now();
for (let i = 0; i < 60; i++) {
  const s = await state(tab);
  const key = JSON.stringify(s);
  if (key !== prev) {
    console.log(`  +${String(Date.now() - t1).padStart(5)}ms  ${key}`);
    prev = key;
  }
  const disabled = s && (s.ariaDisabled === "true" || s.domDisabled || s.classDisabled || s.pointer === "none");
  if (s && !disabled && enabledAt === null) enabledAt = Date.now() - t1;
  await new Promise((r) => setTimeout(r, 50));
}

console.log(
  enabledAt === null
    ? "\nالزر لم يصبح قابلاً للنقر خلال 3s"
    : `\nالزر صار قابلاً للنقر بعد ${enabledAt}ms من انتهاء الكتابة`,
);

const t2 = Date.now();
const click = await tab.click(".send-button");
const gone = await tab.waitFor({
  untilJs: `((document.querySelector('textarea')||{}).value||'').length === 0`,
  timeoutMs: 4000,
  intervalMs: 50,
});
console.log(
  `النقر: ok=${click.ok} · فرغ المحرّر بعد ${Date.now() - t2}ms · نجح=${gone.ok}`,
);

await transport.close?.();
