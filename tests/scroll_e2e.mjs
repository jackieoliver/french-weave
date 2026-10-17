// Scroll timing check for an infinite, virtualized timeline (like X's home feed): how long a newly mounted post waits
// for its first swap while the reader keeps scrolling. Same setup as tests/extension_e2e.mjs (Playwright's Chromium,
// a temporary copy of $FRENCH_WEAVE_HOME/extension, website access for x.com granted up front, the native host
// registered for PROFILE by setup). Run with a scratch HOME and FRENCH_WEAVE_HOME, never your own:
//   HOME=$T/home FRENCH_WEAVE_HOME=$T/fw python3 scripts/fw.py setup --user-data-dir $T/profile \
//     --gemini-key-file KEY --anthropic-key-file KEY --no-auto-update --keep-narration
//   HOME=$T/home FRENCH_WEAVE_HOME=$T/fw PROFILE=$T/profile E2E_LEVEL=2 node tests/scroll_e2e.mjs
// The fake x.com page keeps about 16 article elements mounted: posts are absolutely placed cells, mounted while
// within MOUNT_PX of the viewport and removed after, as X does. The reader scrolls one screen every SCROLL_GAP_MS
// (SCROLLS times), pauses PAUSE_MS, then scrolls back up two screens (remounted posts should repaint at once from the
// page's memo, with no new model request). Prints, per post, mount -> first swap and in-view -> first swap, with the
// median and p90 over posts that got a swap, how many mounted posts got none, every model request the worker made
// (provider, status, ms) and today's Anthropic spend.
// E2E_LEVEL=1..4 forces the level; CHROMIUM_PATH picks a Chromium binary; SCROLLS, SCROLL_GAP_MS, PAUSE_MS override.
import { chromium } from 'playwright';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

const INSTALLED = join(process.env.FRENCH_WEAVE_HOME || join(homedir(), '.french-weave'), 'extension');
const EXT = mkdtempSync(join(tmpdir(), 'fw-ext-'));
cpSync(INSTALLED, EXT, { recursive: true });
const manifest = JSON.parse(readFileSync(join(EXT, 'manifest.json'), 'utf8'));
manifest.host_permissions.push('https://x.com/*');
writeFileSync(join(EXT, 'manifest.json'), JSON.stringify(manifest));

const SCROLLS = Number(process.env.SCROLLS || 8);
const SCROLL_GAP_MS = Number(process.env.SCROLL_GAP_MS || 5000);
const PAUSE_MS = Number(process.env.PAUSE_MS || 20000);

// Synthetic posts (everyday topics, none the extension keeps English on purpose), long and short as on a real feed.
const POSTS = [
  'Finally shipped the new search page and it is very fast now, but the old filters still need a lot of work.',
  'I always forget my umbrella, so of course it rained again today and I walked home without one.',
  'Maybe the best part of the weekend was cooking with friends and trying a new recipe together.',
  'Hot take: the best coffee in town is at the tiny place near the station, and nobody believes me.',
  'We spent the whole afternoon at the lake with the kids, and now everyone is asleep before eight.',
  'Why does every app want me to make an account just to read one short article? Really annoying.',
  'The new album is good, but honestly the first single was better and I still listen to it every day.',
  'Is it just me or is this week going by very slowly? Monday felt like it lasted three days.',
  'My cat has decided that the keyboard is the only warm place in the house, so this post is short.',
  'Tried the new bakery on the corner this morning and the croissants are already my new favorite thing.',
  'I think the problem with most meetings is that nobody knows the question they are trying to answer.',
  'Small win: I finally cleaned my desk, and now I can see the wood again for the first time in a month.',
  'If you have never watched the sunrise from the hill behind the park, go this week, it is always worth it.',
  'Learning to play the guitar again after ten years, and my fingers are not happy about it at all.',
  'The train was late again, but I read half a book on the platform, so maybe it was not so bad after all.',
  'Our team just found a bug that has been there since the very first version, and we are all a little scared.',
  'Every time I clean the kitchen, somebody cooks something huge an hour later. It is always the same story.',
  'Today I learned that you can freeze bread and it tastes almost the same, which changes everything for me.',
  'The garden is finally growing tomatoes, and there are so many that we give them to the neighbors now.',
  'Spent two hours looking for my keys and they were in my pocket the whole time. Classic Tuesday.',
  'Good morning to everyone except the bird that sings outside my window at five in the morning.',
  'The best ideas always come in the shower, when there is no way to write them down. Why is that?',
  'Started a new book last night and stayed up way too late, because every chapter ends with a question.',
  'Remote work tip: a short walk before lunch makes the whole afternoon easier, and it costs nothing.',
  'Our dog learned to open the back door by himself, so now we have a new problem and a very proud dog.',
  'I made soup for the first time and it was actually good, so I am now an expert and will take questions.',
  'The museum was quiet this morning, and we had the big hall with the old maps almost to ourselves.',
  'Sometimes the simple answer is the right one, and we spend a week looking for a harder one anyway.',
  'Anyone else think the new phone design looks exactly like the old one, but with a different color?',
  'The library near my house now has a little room for music practice, and it is free for everyone.',
  'We tried to build the shelf without the instructions, and now there are four extra screws and a mystery.',
  'Summer is almost over and I still have not been to the beach once. Next year, maybe, I always say that.',
  'The kids made pancakes for breakfast today, and the kitchen will need a week to recover from it.',
  'My favorite thing about this city is that you can walk everywhere, and there is always a good view.',
  'I keep a list of words I like in different languages, and it is getting long now, maybe too long.',
  'Watched the game with my brother last night and we both yelled at the screen like it could hear us.',
  'Our new neighbor plays the piano every evening, and it is very good, so nobody wants to complain.',
  'The bus driver waited for me today when I was running, which was very kind, and I said thank you twice.',
  'Is there anything better than the first warm day of spring, when everyone is outside at the same time?',
  'I wrote a whole email and then forgot to send it for three days. That is my update for this week.',
  'The old bridge in the park is open again after a long time, and it looks even better than before.',
  'My grandmother still writes letters by hand, and honestly they are the best thing in my mailbox.',
  'Just finished a puzzle with a thousand pieces, and of course the last piece was under the couch.',
  'We got lost on the way to the concert, but we found a great little restaurant, so it was a good night.',
  'Pro tip: write the question down before the call, because you will always forget it in the moment.',
  'The rain finally stopped, the sky is clear, and the whole street smells like wet grass and coffee.',
  'Reading old notes from school is wild, I was so sure about things that I now know were very wrong.',
  'The best part of a long trip is coming home, making tea, and sleeping in your own bed again.',
];

const CELL_PX = 190; // about 4.5 posts a screen
const MOUNT_PX = 1100; // with a 900 px window: about 16 cells mounted, as on X
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Home / X</title><style>
body { margin: 0; font: 15px/1.4 sans-serif; } #feed { position: relative; width: 600px; margin: 0 auto; }
.cell { position: absolute; left: 0; right: 0; height: ${CELL_PX - 20}px; border-bottom: 1px solid #ddd; padding: 10px; box-sizing: border-box; }
</style></head><body><main><div id="feed"></div></main><script>
const POSTS = ${JSON.stringify(POSTS)};
const CELL = ${CELL_PX}, MOUNT = ${MOUNT_PX};
const feed = document.getElementById('feed');
feed.style.height = (POSTS.length * CELL) + 'px';
const mounted = new Map(); // index -> cell
window.__fw = { mounts: [], firstSwap: {}, inView: {} }; // mounts: { id, at, remount }
const seenIds = new Set();
function cellFor(i) {
  const cell = document.createElement('div');
  cell.className = 'cell'; cell.style.top = (i * CELL) + 'px'; cell.dataset.i = i;
  cell.innerHTML = '<article data-testid="tweet"><div lang="en" dir="auto" data-testid="tweetText"><span></span></div></article>';
  cell.querySelector('span').textContent = POSTS[i];
  return cell;
}
function layout() {
  const top = scrollY - MOUNT, bottom = scrollY + innerHeight + MOUNT;
  for (let i = 0; i < POSTS.length; i++) {
    const inside = i * CELL + CELL > top && i * CELL < bottom;
    if (inside && !mounted.has(i)) {
      const cell = cellFor(i);
      mounted.set(i, cell);
      feed.append(cell);
      __fw.mounts.push({ id: i, at: performance.now(), remount: seenIds.has(i) });
      seenIds.add(i);
    } else if (!inside && mounted.has(i)) {
      mounted.get(i).remove();
      mounted.delete(i);
    }
  }
}
// First swap per mount: the extension's .fw-word spans appearing inside a mounted cell.
new MutationObserver(() => {
  const now = performance.now();
  for (const [i, cell] of mounted) {
    if (!cell.querySelector('.fw-word')) continue;
    const m = __fw.mounts.findLast((x) => x.id === i);
    if (m && m.swapAt === undefined) m.swapAt = now;
  }
}).observe(feed, { childList: true, subtree: true });
// When each post first comes into view (any part of it inside the window).
setInterval(() => {
  for (const [i] of mounted) {
    const y = i * CELL - scrollY;
    if (__fw.inView[i] === undefined && y < innerHeight && y + CELL > 0) __fw.inView[i] = performance.now();
  }
}, 50);
addEventListener('scroll', layout, { passive: true });
layout();
</script></body></html>`;

const userDataDir = process.env.PROFILE || mkdtempSync(join(tmpdir(), 'fw-profile-'));
const ctx = await chromium.launchPersistentContext(userDataDir, {
  ...(process.env.CHROMIUM_PATH ? { executablePath: process.env.CHROMIUM_PATH } : { channel: 'chromium' }),
  headless: true,
  viewport: { width: 1000, height: 900 },
  args: ['--headless=new', `--disable-extensions-except=${EXT}`, `--load-extension=${EXT}`],
});
const out = {};
const pct = (xs, p) => {
  if (!xs.length) return null;
  const s = [...xs].sort((a, b) => a - b);
  return Math.round(s[Math.min(s.length - 1, Math.ceil((p / 100) * s.length) - 1)]);
};
try {
  let [sw] = ctx.serviceWorkers();
  if (!sw) sw = await ctx.waitForEvent('serviceworker', { timeout: 20000 });
  for (let i = 0; i < 40 && !(await sw.evaluate(() => !!globalThis.chrome?.storage)); i++) await new Promise((r) => setTimeout(r, 250));
  let state = {};
  for (let i = 0; i < 40 && !state.wordState; i++) {
    state = await sw.evaluate(() => chrome.storage.local.get(['wordState']));
    if (!state.wordState) await new Promise((r) => setTimeout(r, 500));
  }
  out.synced = !!state.wordState;
  out.version = await sw.evaluate(() => chrome.runtime.getManifest().version);
  if (process.env.E2E_LEVEL) {
    await sw.evaluate((level) => chrome.storage.local.get('settings')
      .then(({ settings }) => chrome.storage.local.set({ settings: { ...settings, levelOverride: level } })), Number(process.env.E2E_LEVEL));
  }
  // Every model request the worker makes (provider, status, ms); nothing of the request is kept.
  await sw.evaluate(() => {
    const real = globalThis.fetch;
    globalThis.__fwBatches = [];
    globalThis.__fwT0 = performance.now();
    globalThis.fetch = async (url, init, ...rest) => {
      const host = (() => { try { return new URL(String(url)).hostname; } catch { return ''; } })();
      const provider = { 'api.anthropic.com': 'anthropic', 'openrouter.ai': 'openrouter', 'generativelanguage.googleapis.com': 'gemini' }[host];
      if (!provider) return real(url, init, ...rest);
      const entry = { provider, start: Math.round(performance.now() - globalThis.__fwT0) };
      globalThis.__fwBatches.push(entry);
      try {
        const res = await real(url, init, ...rest);
        Object.assign(entry, { status: res.status, ms: Math.round(performance.now() - globalThis.__fwT0 - entry.start) });
        return res;
      } catch (e) {
        Object.assign(entry, { error: String(e?.name || 'error'), ms: Math.round(performance.now() - globalThis.__fwT0 - entry.start) });
        throw e;
      }
    };
  });
  await ctx.route('https://x.com/**', (route) => route.fulfill({ status: 200, contentType: 'text/html', body: html }));
  const page = await ctx.newPage();
  await page.goto('https://x.com/home');
  await page.waitForTimeout(SCROLL_GAP_MS);
  for (let n = 0; n < SCROLLS; n++) {
    await page.mouse.move(500, 450);
    await page.mouse.wheel(0, 860);
    await page.waitForTimeout(SCROLL_GAP_MS);
  }
  await page.waitForTimeout(PAUSE_MS);
  const requestsBeforeUp = await sw.evaluate(() => globalThis.__fwBatches.length);
  // Back up two screens: the posts that remount there were swapped before and should repaint from memo.
  const upAt = await page.evaluate(() => performance.now());
  await page.mouse.wheel(0, -1800);
  await page.waitForTimeout(3000);
  const fw = await page.evaluate(() => window.__fw);
  out.requestsAfterScrollUp = (await sw.evaluate(() => globalThis.__fwBatches.length)) - requestsBeforeUp;

  const first = fw.mounts.filter((m) => !m.remount);
  const swapped = first.filter((m) => m.swapAt !== undefined && m.swapAt < upAt);
  const mountToSwap = swapped.map((m) => m.swapAt - m.at);
  const viewToSwap = swapped.filter((m) => fw.inView[m.id] !== undefined).map((m) => Math.max(0, m.swapAt - fw.inView[m.id]));
  // Remounted posts that had a swap before and are now within the extension's 600 px look-ahead of the window.
  const near = await page.evaluate(() => [...document.querySelectorAll('.cell')].filter((c) => {
    const r = c.querySelector('[data-testid="tweetText"]').getBoundingClientRect();
    return r.top < innerHeight + 600 && r.bottom > -600;
  }).map((c) => Number(c.dataset.i)));
  const remounts = fw.mounts.filter((m) => m.remount && m.at >= upAt && near.includes(m.id));
  const remountsSwappedBefore = remounts.filter((m) => first.some((f) => f.id === m.id && f.swapAt !== undefined));
  out.posts = { mounted: first.length, withSwap: swapped.length, withoutSwap: first.length - swapped.length,
    inViewWithoutSwap: first.filter((m) => m.swapAt === undefined && fw.inView[m.id] !== undefined).map((m) => m.id) };
  out.mountToFirstSwapMs = { median: pct(mountToSwap, 50), p90: pct(mountToSwap, 90), max: pct(mountToSwap, 100) };
  out.inViewToFirstSwapMs = { median: pct(viewToSwap, 50), p90: pct(viewToSwap, 90), max: pct(viewToSwap, 100), n: viewToSwap.length };
  out.remount = { count: remountsSwappedBefore.length,
    repaintMs: remountsSwappedBefore.map((m) => (m.swapAt === undefined ? null : Math.round(m.swapAt - m.at))) };
  out.perPost = first.map((m) => ({ id: m.id, mountMs: Math.round(m.at), swapMs: m.swapAt === undefined ? null : Math.round(m.swapAt - m.at),
    inViewMs: fw.inView[m.id] === undefined ? null : Math.round(fw.inView[m.id]) }));
  out.swapsPerPost = await page.evaluate(() => [...document.querySelectorAll('.cell')].map((c) => [Number(c.dataset.i), c.querySelectorAll('.fw-word').length]));
  const popup = await ctx.newPage();
  await popup.goto(`chrome-extension://${sw.url().split('/')[2]}/src/popup.html`);
  const s = await popup.evaluate(() => chrome.runtime.sendMessage({ type: 'status' }));
  Object.assign(out, { level: s.config?.level, servedCounts: s.served?.counts || {}, anthropicUsd: s.anthropic?.usd || 0,
    modelError: s.modelStatus?.error || '', dropped: s.dropped });
  out.requests = await sw.evaluate(() => globalThis.__fwBatches);
} finally {
  await ctx.close();
  rmSync(EXT, { recursive: true, force: true });
}
console.log(JSON.stringify(out, null, 1));
