// Usage: node tools/ui-smoke.mjs <url> [--wait-for <css-selector>] [--timeout <ms>]

import { chromium } from 'playwright';

const args = process.argv.slice(2);
if (args.length === 0) {
  console.log('UI_SMOKE: FAIL');
  console.log('Error: Missing URL argument');
  process.exit(1);
}

let url = null;
let waitForSelector = null;
let timeoutVal = 10000;

for (let i = 0; i < args.length; i++) {
  if (args[i] === '--wait-for') {
    waitForSelector = args[i + 1];
    i++;
  } else if (args[i] === '--timeout') {
    timeoutVal = parseInt(args[i + 1], 10);
    i++;
  } else if (!args[i].startsWith('--') && !url) {
    url = args[i];
  }
}

if (!url) {
  console.log('UI_SMOKE: FAIL');
  console.log('Error: Missing URL argument');
  process.exit(1);
}

if (isNaN(timeoutVal)) {
  timeoutVal = 10000;
}

const errors = [];
let browser = null;

try {
  browser = await chromium.launch({ headless: true });
  const context = await browser.newContext();
  const page = await context.newPage();

  page.on('console', msg => {
    if (msg.type() === 'error') {
      errors.push(`Console error: ${msg.text()}`);
    }
  });

  page.on('pageerror', err => {
    errors.push(`Page error: ${err.message || err}`);
  });

  await page.goto(url, { waitUntil: 'load', timeout: timeoutVal });

  if (waitForSelector) {
    await page.waitForSelector(waitForSelector, { state: 'visible', timeout: timeoutVal });
  }
} catch (err) {
  errors.push(`Failure: ${err.message}`);
} finally {
  if (browser) {
    await browser.close();
  }
}

if (errors.length === 0) {
  console.log('UI_SMOKE: PASS');
  process.exit(0);
} else {
  console.log('UI_SMOKE: FAIL');
  for (const error of errors) {
    console.log(error);
  }
  process.exit(1);
}
