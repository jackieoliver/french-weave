// End-to-end extension check (needs `npm i playwright && npx playwright install chromium`; Google Chrome ignores
// --load-extension, so this uses Playwright's Chromium). Run setup first, registering the profile dir used here:
//   python3 scripts/fw.py setup --user-data-dir /tmp/fw-profile [--gemini-key-file KEY]
//   PROFILE=/tmp/fw-profile node tests/extension_e2e.mjs
// To leave your own setup alone, give both commands a scratch FRENCH_WEAVE_HOME (and setup a scratch HOME, so
// it writes no host manifest into your real browsers).
// Loads a temporary copy of ~/.french-weave/extension (or $FRENCH_WEAVE_HOME/extension) with website access
// granted up front, since Chrome's grant dialog can't be clicked from a script. Serves a fake x.com timeline and a
// fake article on another site (synthetic text), and prints what happened: native host sync, real Gemini swaps
// (a few requests), instant hover tip with a peek only after a dwell, click flip, health text untouched, links and
// forms intact, seen/flip events flushed back to the word state, forged page events ignored, no swaps on webmail,
// and the article reverting when its site is turned off. Expected for the tip: tipWithoutWait and hoverAfter show the gloss text,
// peeksAfterQuickPass is 0 and peeksAfterDwell is 1 (on a profile that hasn't peeked at that word today).
// With an Anthropic key too (setup's --anthropic-key-file), every level sends each batch to Claude Haiku 5.5 first,
// direct to Anthropic; with only an OpenRouter key (--openrouter-key-file), through OpenRouter. servedCounts names the
// model behind each batch, lastProvider the provider of the last, anthropicUsd and openRouterUsd today's spend, and
// batches lists each model request the worker made (provider, HTTP status, milliseconds, tokens; never the key).
// E2E_LEVEL=1..4 forces that level from the popup before any page loads (level reports the one in effect).
// E2E_MODEL=<choice> and E2E_REASONING=<level> pick that Model and Reasoning in the popup the same way.
// The popup's Model and Reasoning menus (popupModelOptions, popupReasoningOptions; "!" marks one that can't be
// picked), its header (popupVersion), Mode line (popupMode), Next batch line (popupNext) and
// what the native host recorded as the running version (extensionSeen) are printed; E2E_SCREENSHOT=<file.png> also
// saves the popup as an image.
// CHROMIUM_PATH: a Chromium binary to use instead of the one this Playwright version expects.
// Website access is granted only for the test sites (x.com, reading.example, safety.example, mail.google.com), as a
// reader who allows sites one at a time has it, so a model API without a manifest host permission (api.anthropic.com)
// is reached the way it is for them, as a CORS request; E2E_ALL_SITES=1 grants every site instead.
// Without a key (setup without --gemini-key-file, and none pasted), the same run checks the no-key mode: tier is
// "local", the popup says "Built-in list, no key", swaps come only from the built-in list, modelCalls is 0, and a page
// whose title names a sensitive topic gets no swaps (sensitiveTitleSwaps 0; with a key, Gemini judges each passage).
import { chromium } from 'playwright';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { cpSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';

const STATE_DIR = process.env.FRENCH_WEAVE_HOME || join(homedir(), '.french-weave');
const INSTALLED = join(STATE_DIR, 'extension');
const EXT = mkdtempSync(join(tmpdir(), 'fw-ext-'));
cpSync(INSTALLED, EXT, { recursive: true });
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
const TEST_SITES = ['https://x.com/*', 'https://reading.example/*', 'https://safety.example/*', 'https://mail.google.com/*'];
manifest.host_permissions.push(...(process.env.E2E_ALL_SITES ? manifest.optional_host_permissions : TEST_SITES)); // same key, same ID
writeFileSync(join(EXT, 'manifest.json'), JSON.stringify(manifest));
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

const ARTICLE_URL = 'https://reading.example/2026/10/notes';
const article = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Notes</title></head><body>
<header><nav><a href="/">Home</a> and <a href="/about">About</a></nav></header>
<main><article>
<h1>What I learned from a slow week</h1>
<p id="a1">The garden was very quiet this week, and I finally read the book my friend gave me last year.</p>
<p id="a2">Maybe the best part was walking home every evening without my phone, because the light was always so warm.</p>
<p id="a3">My doctor changed the dose of my medication, and the side effects are still there, so I am resting.</p>
<p id="a4">We also cooked a big dinner together now that the kitchen is finally fixed, and it was a lot of fun.</p>
<form><p id="a5">Write your comment here and tell us what you think about the article today.</p><textarea></textarea></form>
</article></main></body></html>`;

const userDataDir = process.env.PROFILE || mkdtempSync(join(tmpdir(), 'fw-profile-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH }
    : { channel: 'chromium' }), // the default headless shell cannot load extensions
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
  if (process.env.E2E_LEVEL) {
    await sw.evaluate((level) => chrome.storage.local.get('settings')
      .then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, levelOverride: level } })), Number(process.env.E2E_LEVEL));
  }
  if (process.env.E2E_MODEL) {
    await sw.evaluate((modelChoice) => chrome.storage.local.get('settings')
      .then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, modelChoice } })), process.env.E2E_MODEL);
  }
  // Each model request the worker makes: provider, status, time to the reply, and tokens (Anthropic's usage). The
  // worker calls the global fetch, so wrapping it here sees every request; nothing of the request is kept.
  await sw.evaluate(() => {
    const real = globalThis.fetch;
    globalThis.__fwBatches = [];
    globalThis.fetch = async (url, init, ...rest) => {
      const host = (() => { try { return new URL(String(url)).hostname; } catch { return ''; } })();
      const provider = { 'api.anthropic.com': 'anthropic', 'openrouter.ai': 'openrouter', 'generativelanguage.googleapis.com': 'gemini' }[host];
      if (!provider) return real(url, init, ...rest);
      const started = performance.now();
      const entry = { provider, at: new Date().toISOString() };
      globalThis.__fwBatches.push(entry);
      try {
        const res = await real(url, init, ...rest);
        Object.assign(entry, { status: res.status, ms: Math.round(performance.now() - started) });
        if (provider === 'anthropic' && res.ok) {
          res.clone().json().then((d) => { entry.usage = d.usage; entry.model = d.model; entry.stop = d.stop_reason; }).catch(() => {});
        }
        return res;
      } catch (e) {
        Object.assign(entry, { error: String(e?.name || 'error'), ms: Math.round(performance.now() - started) });
        throw e;
      }
    };
  });

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
    const peeks = () => sw.evaluate(() => chrome.storage.local.get('seenSent').then((o) => (o.seenSent?.words || []).filter((w) => w.startsWith('peek:'))));
    const peeksBefore = (await peeks()).length;
    // The gloss shows on the hover itself (read straight away, no wait); a quick pass is not a peek.
    await first.hover();
    out.tipWithoutWait = await page.evaluate(() => document.querySelector('fw-gloss.fw-gloss-on')?.textContent || '');
    await page.mouse.move(0, 0);
    await page.waitForTimeout(1000);
    out.peeksAfterQuickPass = (await peeks()).length - peeksBefore;
    await first.hover();
    await page.waitForTimeout(1000); // staying on the word counts as one peek
    out.hoverAfter = await page.evaluate(() => document.querySelector('fw-gloss.fw-gloss-on')?.textContent || '');
    out.peeksAfterDwell = (await peeks()).length - peeksBefore;
    await first.click();
    out.afterClick = await first.evaluate((e) => ({ text: e.textContent, english: e.classList.contains('fw-en') }));
    await first.click();
    out.afterSecondClick = await first.textContent();
    await first.click(); // leave it flipped to English: one flip event
    // Events: seen + flip are queued, then flushed to the host after ~10 s.
    await page.waitForTimeout(13000);
    out.pendingAfterFlush = await sw.evaluate(() => chrome.storage.local.get('pendingEvents').then((o) => o.pendingEvents));
    out.identifyingAttrs = await page.$$eval('[data-fw-key],[data-fw-word]', (els) => els.length);
    // The page itself can't forge events: synthetic clicks and hovers, on a real swap or on its own fw-word span.
    out.forged = await page.evaluate(async () => {
      const real = document.querySelector('.fw-word');
      const before = real.textContent;
      const fake = Object.assign(document.createElement('span'), { className: 'fw-word', textContent: 'très' });
      fake.dataset.fwWord = 'très';
      document.querySelector('main').append(fake);
      for (const el of [real, fake]) {
        el.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
        el.dispatchEvent(new MouseEvent('click', { bubbles: true }));
        el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      }
      await new Promise((r) => setTimeout(r, 1500));
      return { realUnchanged: real.textContent === before, fakeUnchanged: fake.textContent === 'très' };
    });
    out.forged.pending = await sw.evaluate(() => chrome.storage.local.get('pendingEvents').then((o) => o.pendingEvents || []));
  }
  // A plain article on another site: the dynamically registered content script runs there too.
  for (let i = 0; i < 40; i++) {
    const ids = await sw.evaluate(() => chrome.scripting.getRegisteredContentScripts().then((s) => s.map((x) => x.id)));
    if (ids.includes('weave-sites')) break;
    await new Promise((r) => setTimeout(r, 250));
  }
  await ctx.route('https://reading.example/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: article }));
  const reading = await ctx.newPage();
  reading.on('console', (m) => { if (/french-weave/.test(m.text())) (out.console ||= []).push(m.text()); });
  await reading.goto(ARTICLE_URL);
  await reading.waitForSelector('.fw-word', { timeout: 60000 }).catch(() => {});
  await reading.waitForTimeout(3000);
  out.articleSwaps = await reading.$$eval('.fw-word', (els) => els.map((e) => ({ p: e.closest('[id]')?.id || e.parentElement.tagName, fr: e.dataset.fr, en: e.dataset.en })));
  out.articleHealthTouched = await reading.$$eval('#a3 .fw-word', (els) => els.length);
  out.articleFormTouched = await reading.$$eval('form .fw-word', (els) => els.length);
  out.articleNavIntact = await reading.$eval('nav', (n) => n.textContent);

  // A page whose title names a sensitive topic: without a key, none of its passages get swaps.
  await ctx.route('https://safety.example/**', (route) => route.fulfill({ status: 200, contentType: 'text/html',
    body: article.replace('<title>Notes</title>', '<title>Springfield Crime Rates</title>') }));
  const sensitive = await ctx.newPage();
  await sensitive.goto('https://safety.example/report');
  await sensitive.waitForTimeout(6000);
  out.sensitiveTitleSwaps = await sensitive.$$eval('.fw-word', (els) => els.length);

  // Webmail starts off even with every site on: no swaps, so no page text sent.
  await ctx.route('https://mail.google.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: article }));
  const calls = () => sw.evaluate(() => chrome.storage.local.get('modelCalls').then((o) => o.modelCalls?.count || 0));
  const callsBeforeMail = await calls();
  const mail = await ctx.newPage();
  await mail.goto('https://mail.google.com/mail/u/0/');
  await mail.waitForTimeout(8000);
  out.mailSwaps = await mail.$$eval('.fw-word', (els) => els.length);
  out.mailModelCalls = (await calls()) - callsBeforeMail;

  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${out.extensionId}/src/popup.html`);
  await popup.waitForTimeout(1500);
  out.popup = await popup.$eval('body', (b) => b.innerText);
  out.tier = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'status' }).then((s) => s.config.tier));
  out.popupTier = await popup.$eval('#tierInfo', (e) => e.textContent);
  out.modelCalls = await calls(); // Gemini requests this profile made today
  // Which models served today's batches, and today's OpenRouter spend: with an OpenRouter key (setup's
  // --openrouter-key-file), Claude Haiku 5.5 serves first.
  const served = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'status' })
    .then((s) => ({ last: s.lastServed?.model || '', lastProvider: s.lastServed?.provider || '', counts: s.served?.counts || {},
      openRouterUsd: s.openRouter?.usd || 0, anthropicUsd: s.anthropic?.usd || 0, anthropicBlocked: s.anthropic?.blocked || '',
      level: s.config?.level, modelError: s.modelStatus?.error || '' })));
  Object.assign(out, { lastServed: served.last, lastProvider: served.lastProvider, servedCounts: served.counts,
    openRouterUsd: served.openRouterUsd, anthropicUsd: served.anthropicUsd, anthropicBlocked: served.anthropicBlocked, level: served.level,
    modelError: served.modelError });
  out.batches = await sw.evaluate(() => globalThis.__fwBatches || null);
  out.popupAnthropicInfo = await popup.$eval('#anthropicInfo', (e) => e.textContent);
  out.popupModel = await popup.$eval('#model', (e) => e.value);
  out.popupModelOptions = await popup.$$eval('#model option', (os) => os.map((o) => `${o.disabled ? '!' : ''}${o.textContent}`));
  out.popupNext = await popup.$eval('#nextInfo', (e) => e.textContent);
  out.popupModelNote = await popup.$eval('#modelNote', (e) => e.textContent);
  if (process.env.E2E_SCREENSHOT) {
    await popup.setViewportSize({ width: 300, height: 900 });
    await popup.screenshot({ path: process.env.E2E_SCREENSHOT, fullPage: true });
  }
  const seenFile = join(STATE_DIR, 'extension-seen.json');
  out.extensionSeen = existsSync(seenFile) ? JSON.parse(readFileSync(seenFile, 'utf8')) : null;
  // Your words: collapsed at first; opened, it lists the synced learning and shaky words.
  const wordList = () => popup.$eval('#wordList', (d) => ({ open: d.open, counts: d.querySelector('[data-counts]').textContent,
    rows: [...d.querySelectorAll('.word')].map((r) => `${r.dataset.status}: ${r.innerText.replace(/\s+/g, ' ')}`) }));
  out.popupWordsOpenAtStart = (await wordList()).open;
  await popup.click('#wordList summary');
  out.popupWords = await wordList();
  // Turning the site off from the popup reverts the open article.
  await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'save', siteOverride: { host: 'reading.example', enabled: false } }));
  await reading.waitForTimeout(1500);
  out.articleSwapsAfterSiteOff = await reading.$$eval('.fw-word', (els) => els.length);
  out.articleTextAfterSiteOff = await reading.$eval('#a1', (e) => e.textContent);
} finally {
  await ctx.close();
}
console.log(JSON.stringify(out, null, 1));
