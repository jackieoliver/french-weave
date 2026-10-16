import { test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { hashKey } from '../src/hash.js';
import { DAILY_MODEL_CALLS } from '../src/quota.js';

// Same harness as runtime.test.js (fresh module copies via ?churn): a paragraph with live text.
test('churn: live text stops costing model calls, and a page that undoes swaps stops getting them', async () => {
  const win = new Window({ url: 'https://example.com/article' });
  const originalGlobals = Object.fromEntries(['chrome', 'fetch', 'document', 'window', 'location', 'MutationObserver', 'IntersectionObserver', 'setInterval'].map((k) => [k, globalThis[k]]));
  const local = { settings: { apiKey: 'synthetic-gemini', enabled: true, levelOverride: 1 } }; // 0.1 kept the key in settings
  const messageListeners = [], contentListeners = [];
  const toPages = [];
  const pageReplies = []; // replies to the content script's own requests // everything the worker sends to content scripts
  const originEvents = { added: [], removed: [] };
  let accessLevel;
  let origins = ['https://*/*', 'http://*/*'];
  let modelCalls = 0;
  let modelThrows = 0;
  let delayed = null;
  let release;
  const hostEvents = [];
  let hostState = { version: 'test.1', stage: 1, paused: false, prefs: { extension_sites: 'ask' }, words: [
    { fr: 'et', en: 'and', hint: 'ay', status: 'active' },
    { fr: 'très', en: 'very', hint: 'treh', status: 'shaky' },
  ] };
  const listener = (arr) => ({ addListener: (fn) => arr.push(fn) });
  const storageArea = (data) => ({
    async setAccessLevel(v) { accessLevel = v.accessLevel; },
    async get(keys) { return structuredClone(keys == null ? data : Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter((k) => k in data).map((k) => [k, data[k]]))); },
    async set(values) { for (const [k, v] of Object.entries(values)) data[k] = structuredClone(v); },
    async remove(keys) { for (const k of keys) delete data[k]; },
  });
  const page = () => ({ id: 'fw-test', tab: { id: 1 }, url: win.location.href });
  const popup = { id: 'fw-test', url: 'chrome-extension://fw-test/src/popup.html' };
  const dispatch = (msg, sender) => new Promise((done, reject) => {
    let handled = false;
    try { for (const fn of messageListeners) if (fn(msg, sender, done)) handled = true; }
    catch (e) { reject(e); }
    if (!handled) done(undefined);
  });
  const io = [];
  class IO {
    constructor(callback, options) { this.cb = callback; this.options = options; this.elements = new Set(); io.push(this); }
    observe(el) { this.elements.add(el); if (this.options.rootMargin) queueMicrotask(() => { if (this.elements.has(el)) this.cb([{ target: el, isIntersecting: true, intersectionRatio: 1 }]); }); }
    unobserve(el) { this.elements.delete(el); }
    disconnect() { this.elements.clear(); }
  }
  const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  Object.assign(globalThis, {
    window: win, document: win.document, location: win.location, MutationObserver: win.MutationObserver, IntersectionObserver: IO,
    setInterval: win.setInterval.bind(win),
    chrome: {
      storage: { local: storageArea(local) },
      runtime: {
        id: 'fw-test', getURL: (path) => `chrome-extension://fw-test/${path}`,
        onMessage: listener(messageListeners), onInstalled: listener([]), onStartup: listener([]),
        sendMessage: (msg) => dispatch(msg, page()).then((r) => { pageReplies.push(JSON.stringify(r ?? null)); return r; }),
        sendNativeMessage: async (_host, msg) => {
          if (msg.type === 'state') return { ok: true, ...structuredClone(hostState), geminiKey: 'synthetic-host' };
          if (msg.type === 'events') { hostEvents.push(...msg.events); return { ok: true, applied: msg.events.length }; }
          return { ok: false };
        },
      },
      tabs: { query: async () => [{ id: 1, url: win.location.href }], sendMessage: async (_id, msg) => { toPages.push(JSON.stringify(msg)); for (const fn of contentListeners) fn(msg); } },
      alarms: { create: async () => {}, onAlarm: listener([]) },
      permissions: { getAll: async () => ({ origins }), onAdded: listener(originEvents.added), onRemoved: listener(originEvents.removed) },
      scripting: { getRegisteredContentScripts: async () => [], updateContentScripts: async () => {}, unregisterContentScripts: async () => {}, registerContentScripts: async () => {} },
    },
    fetch: async (url, init) => {
      expect(url.startsWith('https://generativelanguage.googleapis.com/')).toBe(true);
      expect(init.headers['x-goog-api-key']).toBe('synthetic-gemini'); // a pasted key wins over the setup key
      modelCalls++;
      if (modelThrows > 0) { modelThrows--; throw new TypeError('Failed to fetch'); }
      if (delayed) { release = () => { delayed = null; }; await new Promise((done) => { const free = release; release = () => { free(); done(); }; }); }
      const body = JSON.parse(init.body);
      const items = JSON.parse(body.contents[0].parts[0].text.replace(/^Passages:\n/, ''));
      // Free-form replies carry swaps; the candidates design (the default) keeps candidate numbers.
      const passages = items.map(({ id, text, candidates = [] }) => ({ id, swaps: text.includes(' and ') ? [{ o: 'and', f: 'et', ctx: '' }] : [],
        keep: candidates.filter((c) => c.o === 'and').map((c) => c.n) }));
      return reply({ candidates: [{ content: { parts: [{ text: JSON.stringify({ passages }) }] } }] });
    },
  });
  const call = (msg) => dispatch(msg, popup);
  const wait = (ms = 400) => new Promise((done) => setTimeout(done, ms));
  try {
    await import('../src/background.js?churn');
    await call({ type: 'save', settings: { newSitesEnabled: true } });
    const beforeContent = messageListeners.length;
    win.document.body.innerHTML = '<main><p id="tick">Big summer sale and free shipping ends in 59 seconds today.</p></main>';
    await import('../src/content.js?churn');
    contentListeners.push(...messageListeners.splice(beforeContent));
    await wait();
    const first = modelCalls;
    const el = win.document.querySelector('#tick');
    for (let s = 58; s > 38; s--) { el.textContent = `Big summer sale and free shipping ends in ${s} seconds today.`; await wait(450); }
    // A 1 Hz countdown used to cost one Gemini call per tick (20 here); now it stops after a few.
    expect(modelCalls - first).toBeLessThanOrEqual(3);
    // A page that undoes every swap (here a script restoring the text) is not repainted forever.
    const fought = win.document.createElement('p');
    const original = 'Our team walks home and talks about the long week.';
    fought.textContent = original;
    win.document.querySelector('main').append(fought); await wait();
    expect(fought.querySelector('.fw-word')).not.toBeNull();
    let restores = 0;
    new win.MutationObserver(() => { if (fought.querySelector('.fw-word')) setTimeout(() => { restores++; fought.textContent = original; }, 0); })
      .observe(fought, { childList: true, subtree: true });
    fought.textContent = original;
    await wait(1000);
    expect(restores).toBeLessThanOrEqual(6);
    // Other text on the page still gets French.
    const calm = win.document.createElement('p');
    calm.textContent = 'We read books and listen to music every quiet evening.';
    win.document.querySelector('main').append(calm); await wait();
    expect(calm.querySelector('.fw-word')?.textContent).toBe('et');
  } finally {
    await win.happyDOM.close();
    Object.assign(globalThis, originalGlobals);
  }
}, 30000);
