// End-to-end extension check (needs `npm i playwright && npx playwright install chromium`; Google Chrome ignores
// --load-extension, so this uses Playwright's Chromium). Run setup first, registering the profile dir used here:
//   python3 scripts/fw.py setup --user-data-dir /tmp/fw-profile [--gemini-key-file KEY]
//   PROFILE=/tmp/fw-profile node tests/extension_e2e.mjs
// Loads ~/.french-weave/extension, serves a fake x.com timeline (synthetic tweets), and prints what happened:
// native host sync, real Gemini swaps (a couple of requests), hover tip, click flip, health tweet untouched,
// links intact, seen/flip events flushed back to the word state.
import { chromium } from 'playwright';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { mkdtempSync, readFileSync } from 'node:fs';

const EXT = join(process.env.FRENCH_WEAVE_HOME || join(homedir(), '.french-weave'), 'extension');
const tweets = [
  ['t1', 'en', 'Finally shipped the new search page and it is very fast now, but the old filters still need work.'],
  ['t2', 'en', 'I always forget my umbrella, so of course it rained again today and I got soaked without one.'],
  ['t3', 'en', 'Maybe the best part of the weekend was cooking with friends and trying a new recipe together.'],
  ['t4', 'en', 'Went to the doctor about the migraine medication and the symptoms are still there, ugh.'],
  ['t5', 'en', 'Reading <a href="/someone">@someone</a> and their thread about compilers, also very good, check <a href="https://t.co/abc"><span>https://</span>example.com</a> now'],
];
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Home / X</title></head><body><main>${tweets
  .map(([id, lang, t]) => `<article data-testid="tweet" id="${id}"><div lang="${lang}" dir="auto" data-testid="tweetText"><span>${t}</span></div></article>`)
  .join('\n')}</main></body></html>`;

const userDataDir = process.env.PROFILE || mkdtempSync('/tmp/fw-profile-');
const ctx = await chromium.launchPersistentContext(userDataDir, {
  headless: true,
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const out = {};
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  out.extensionId = sw.url().split('/')[2];
  for (let i = 0; i < 40 && !(await sw.evaluate(() => !!globalThis.chrome?.storage)); i++) await new Promise((r) => setTimeout(r, 250));
  // Wait for the install-time sync from the native host.
  let state = {};
  for (let i = 0; i < 40 && !state.wordState; i++) {
    state = await sw.evaluate(() => chrome.storage.local.get(['wordState', 'hostKey']));
    if (!state.wordState) await new Promise((r) => setTimeout(r, 500));
  }
  out.synced = state.wordState ? { stage: state.wordState.stage, words: state.wordState.words.map((w) => w.fr), version: state.wordState.version } : null;
  out.hostKeyFromSetup = !!state.hostKey;

  await ctx.route('https://x.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  const page = await ctx.newPage();
  page.on('console', (m) => { if (/french-weave/.test(m.text())) (out.console ||= []).push(m.text()); });
  await page.goto('https://x.com/home');
  await page.waitForSelector('.fw-word', { timeout: 60000 }).catch(() => {});
  await page.waitForTimeout(3000);
  out.swaps = await page.$$eval('.fw-word', (els) => els.map((e) => ({ tweet: e.closest('article').id, fr: e.dataset.fr, en: e.dataset.en, tip: e.dataset.tip })));
  out.healthTouched = await page.$$eval('#t4 .fw-word', (els) => els.length);
  out.linksIntact = await page.$eval('#t5', (el) => [...el.querySelectorAll('a')].map((a) => a.textContent));
  out.texts = await page.$$eval('[data-testid=tweetText]', (els) => els.map((e) => e.textContent));
  if (out.swaps.length) {
    const first = page.locator('.fw-word').first();
    await first.hover();
    out.hoverAfter = await first.evaluate((e) => getComputedStyle(e, '::after').content);
    await first.click();
    out.afterClick = await first.evaluate((e) => ({ text: e.textContent, english: e.classList.contains('fw-en') }));
    await first.click();
    out.afterSecondClick = await first.textContent();
    await first.click(); // leave it flipped to English: one flip event
    // Events: seen + flip are queued, then flushed to the host after ~10 s.
    await page.waitForTimeout(13000);
    out.pendingAfterFlush = await sw.evaluate(() => chrome.storage.local.get('pendingEvents').then((o) => o.pendingEvents));
  }
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${out.extensionId}/src/popup.html`);
  await popup.waitForTimeout(1500);
  out.popup = await popup.$eval('body', (b) => b.innerText);
} finally {
  await ctx.close();
}
console.log(JSON.stringify(out, null, 1));
