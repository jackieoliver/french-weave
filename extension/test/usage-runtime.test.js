import { test, expect } from 'bun:test';
import { Window } from 'happy-dom';

// The real worker and content modules on a page whose URL has a path, a query and a fragment, with a fake native host
// and Gemini: the public build sends the host no usage at all; the dev build sends page views, batches, words and popup
// opens, with the site's hostname only, never the path, the page's text or a key.
test('usage log: dev build only, and only the hostname, through the real worker and content script', async () => {
  const PAGE_URL = 'https://www.example.com/2026/10/my-article-slug?q=secret-query&session=abc#frag';
  const win = new Window({ url: PAGE_URL });
  const keys = ['chrome', 'fetch', 'document', 'window', 'location', 'MutationObserver', 'IntersectionObserver', 'setInterval', 'setTimeout'];
  const originalGlobals = Object.fromEntries(keys.map((k) => [k, globalThis[k]]));
  const realTimeout = globalThis.setTimeout;
  // Long timers (the worker's event and usage flushes, the page's usage send) would fire during a later test file.
  const held = [];
  const local = { settings: { enabled: true, levelOverride: 1, newSitesEnabled: true }, apiKey: 'synthetic-gemini' };
  const messageListeners = [], contentListeners = [];
  const usageMessages = [];
  let channel = '';
  let modelCalls = 0;
  const listener = (arr) => ({ addListener: (fn) => arr.push(fn) });
  const page = () => ({ id: 'fw-test', tab: { id: 1, title: 'A slow week' }, url: win.location.href });
  const popup = { id: 'fw-test', url: 'chrome-extension://fw-test/src/popup.html' };
  const dispatch = (msg, sender) => new Promise((done, reject) => {
    let handled = false;
    try { for (const fn of messageListeners) if (fn(msg, sender, done)) handled = true; } catch (e) { reject(e); }
    if (!handled) done(undefined);
  });
  const io = [];
  class IO {
    constructor(callback, options) { this.cb = callback; this.options = options; this.elements = new Set(); io.push(this); }
    observe(el) { this.elements.add(el); if (this.options.rootMargin) queueMicrotask(() => { if (this.elements.has(el)) this.cb([{ target: el, isIntersecting: true, intersectionRatio: 1 }]); }); }
    unobserve(el) { this.elements.delete(el); }
    disconnect() { this.elements.clear(); }
  }
  Object.assign(globalThis, {
    window: win, document: win.document, location: win.location, MutationObserver: win.MutationObserver, IntersectionObserver: IO,
    setInterval: win.setInterval.bind(win),
    setTimeout: (fn, ms, ...rest) => (ms >= 5000 ? (held.push(fn), 0) : realTimeout(fn, ms, ...rest)),
    chrome: {
      storage: { local: {
        async setAccessLevel() {},
        async get(k) { return structuredClone(k == null ? local : Object.fromEntries((typeof k === 'string' ? [k] : k).filter((x) => x in local).map((x) => [x, local[x]]))); },
        async set(values) { for (const [k, v] of Object.entries(values)) local[k] = structuredClone(v); },
        async remove(k) { for (const x of k) delete local[x]; },
      } },
      runtime: {
        id: 'fw-test', getURL: (path) => `chrome-extension://fw-test/${path}`, getManifest: () => ({ version: '0.2.11' }),
        onMessage: listener(messageListeners), onInstalled: listener([]), onStartup: listener([]),
        sendMessage: (msg) => dispatch(msg, page()),
        sendNativeMessage: async (_host, msg) => {
          if (msg.type === 'state') {
            return { ok: true, version: 'v1', stage: 1, paused: false, words: [{ fr: 'et', en: 'and', hint: 'ay', status: 'active' }],
              ...(channel ? { channel } : {}) };
          }
          if (msg.type === 'events') return { ok: true, applied: msg.events.length };
          if (msg.type === 'usage') {
            usageMessages.push(structuredClone(msg));
            return channel === 'dev' ? { ok: true, appended: msg.events.length, ...(msg.today ? { today: { batches: 1, passages: 1, cached: 0, p90Ms: 1200, usd: 0 } } : {}) }
              : { ok: true, appended: 0, off: true };
          }
          return { ok: false };
        },
      },
      tabs: { query: async () => [{ id: 1, url: win.location.href }], sendMessage: async (_id, msg) => { for (const fn of contentListeners) fn(msg); } },
      alarms: { create: async () => {}, onAlarm: listener([]) },
      permissions: { getAll: async () => ({ origins: ['https://*/*', 'http://*/*'] }), onAdded: listener([]), onRemoved: listener([]) },
      scripting: { getRegisteredContentScripts: async () => [], updateContentScripts: async () => {}, unregisterContentScripts: async () => {}, registerContentScripts: async () => {} },
    },
    fetch: async (url, init) => {
      if (String(url).startsWith('chrome-extension://')) return { ok: true, json: async () => ({ version: '0.2.11' }) };
      expect(url.startsWith('https://generativelanguage.googleapis.com/')).toBe(true);
      modelCalls++;
      const body = JSON.parse(init.body);
      const items = JSON.parse(body.contents[0].parts[0].text.replace(/^Passages:\n/, ''));
      const passages = items.map(({ id, candidates = [] }) => ({ id, keep: candidates.filter((c) => c.o === 'and').map((c) => c.n) }));
      return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ passages }) }] } }] }) };
    },
  });
  const call = (msg) => dispatch(msg, popup);
  const wait = (ms = 300) => new Promise((done) => realTimeout(done, ms));
  try {
    await import('../src/background.js?usage-runtime');
    expect((await call({ type: 'syncWords' })).ok).toBe(true);
    const before = messageListeners.length;
    win.document.body.innerHTML = '<main><p id="reading">I enjoy cats and dogs every single day of the week.</p></main>';
    await import('../src/content.js?usage-runtime');
    contentListeners.push(...messageListeners.splice(before));
    await wait();
    expect(modelCalls).toBe(1);
    expect(win.document.querySelector('.fw-word')?.textContent).toBe('et');
    // Public build (no channel from the host): no usage reaches the host or storage, and pages get no usage flag.
    expect((await call({ type: 'usageToday' })).dev).toBe(false);
    expect(usageMessages).toEqual([]);
    expect(local.usageLog).toBeUndefined();
    expect((await dispatch({ type: 'config' }, page())).usage).toBeUndefined();

    // Dev build: the host says so on the next sync. A cleared cache restarts the page, so its passages go to the model again.
    channel = 'dev';
    expect((await call({ type: 'syncWords' })).ok).toBe(true);
    expect((await dispatch({ type: 'config' }, page())).usage).toBe(true);
    await dispatch({ type: 'config', load: true }, page()); // a page view
    await call({ type: 'clearCache' });
    await wait();
    expect(modelCalls).toBe(2);
    const span = win.document.querySelector('.fw-word');
    io.findLast((o) => !o.options.rootMargin).cb([{ target: span, isIntersecting: true, intersectionRatio: 1 }]);
    await wait(50);
    const today = await call({ type: 'usageToday' });
    expect(today).toMatchObject({ ok: true, dev: true, on: true, line: 'Today: 1 batches, 0% cached, p90 1.2 s, $0.0000' });
    const events = usageMessages.flatMap((m) => m.events);
    const kinds = events.map((e) => e.k);
    expect(kinds).toEqual(expect.arrayContaining(['page', 'batch', 'word', 'popup']));
    expect(events.find((e) => e.k === 'page')).toMatchObject({ domain: 'www.example.com', on: true, level: 1, tier: 'gemini', v: '0.2.11' });
    expect(events.find((e) => e.k === 'batch')).toMatchObject({ domain: 'www.example.com', level: 1, tier: 'gemini', passages: 1, cached: 0,
      outcome: 'ok', provider: 'gemini', key: 'main', step: 1, swaps: 1, byStatus: { active: 1 }, chunks: 1 });
    expect(events.find((e) => e.k === 'word')).toMatchObject({ what: 'seen', word: 'et', status: 'active', domain: 'www.example.com' });
    const all = JSON.stringify(usageMessages);
    for (const leak of ['my-article-slug', 'secret-query', 'session', 'frag', '2026/10', 'cats', 'enjoy', 'synthetic', 'A slow week']) {
      expect(all).not.toContain(leak);
    }
    // The popup's switch: off sends what is left and then nothing more.
    await call({ type: 'usageToggle', on: false });
    const sent = usageMessages.length;
    await dispatch({ type: 'config', load: true }, page());
    await call({ type: 'usageToday', open: false });
    expect(usageMessages.length).toBe(sent);
    expect(local.usageLog).toBeUndefined();
  } finally {
    await win.happyDOM.close();
    Object.assign(globalThis, originalGlobals);
  }
}, 30000);
