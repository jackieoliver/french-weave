import { describe, test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { hashKey } from '../src/hash.js';
import { STATE_KEY, localDay } from '../src/hostsource.js';
import { ANTHROPIC_URL } from '../src/anthropic.js';
import { pickBatch } from '../src/pick.js';

const tick = (ms = 0) => new Promise((done) => setTimeout(done, ms));
const keepAll = (text) => JSON.stringify({ passages: JSON.parse(text.replace(/^Passages:\n/, '')).map(({ id, candidates }) => ({ id, topic: 'ok', keep: candidates.map((c) => c.n) })) });

// The real worker with a fake chrome and fetch. hold: a promise each model request waits on (to keep it out).
async function worker(tag, { data, host, fetchModel }) {
  const on = (arr = []) => ({ addListener: (fn) => arr.push(fn) });
  const listeners = [];
  globalThis.chrome = {
    storage: { local: {
      async setAccessLevel() {},
      async get(keys) {
        await tick();
        const pick = keys == null ? Object.keys(data) : typeof keys === 'string' ? [keys] : keys;
        return structuredClone(Object.fromEntries(pick.filter((k) => k in data).map((k) => [k, data[k]])));
      },
      async set(values) { await tick(); for (const [k, v] of Object.entries(values)) data[k] = structuredClone(v); },
      async remove(keys) { for (const k of keys) delete data[k]; },
    } },
    runtime: {
      id: 'fw-test', getURL: (path) => `chrome-extension://fw-test/${path}`, getManifest: () => ({ version: '0.2.10' }),
      onMessage: on(listeners), onInstalled: on(), onStartup: on(),
      sendNativeMessage: async (_h, msg) => (msg.type === 'state' ? { ok: true, ...structuredClone(host()) } : { ok: true }),
    },
    action: { setBadgeText: async () => {} },
    tabs: { query: async () => [], sendMessage: async () => {} },
    alarms: { create: async () => {}, onAlarm: on() },
    permissions: { getAll: async () => ({ origins: ['<all_urls>'] }), onAdded: on(), onRemoved: on() },
    scripting: { getRegisteredContentScripts: async () => [], updateContentScripts: async () => {},
      unregisterContentScripts: async () => {}, registerContentScripts: async () => {} },
  };
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('chrome-extension://')) return { ok: true, json: async () => ({ version: '0.2.10' }) };
    return fetchModel(String(url), init);
  };
  await import(`../src/background.js?scroll-${tag}`);
  return (msg, sender) => new Promise((done) => { if (!listeners.some((fn) => fn(msg, sender, done))) done(undefined); });
}
const page = { id: 'fw-test', tab: { id: 1, title: 'Home / X' }, url: 'https://x.com/home' };
const popup = { id: 'fw-test', url: 'chrome-extension://fw-test/src/popup.html' };
const WORDS = [{ fr: 'et', en: 'and', hint: 'ay', status: 'active' }];
const baseData = (extra = {}) => ({
  settings: { enabled: true, newSitesEnabled: true },
  apiKey: 'synthetic-gemini', anthropicKey: 'synthetic-anthropic',
  [STATE_KEY]: { version: 't.1', stage: 1, paused: false, sites: 'all', fetchedAt: Date.now(), words: WORDS },
  ...extra,
});
const texts = (n) => Array.from({ length: n }, (_, i) => `Post number ${i} says the cat and the dog sleep all day long.`);
const ask = async (dispatch, text) => {
  const { revision } = await dispatch({ type: 'config' }, page);
  return dispatch({ type: 'swaps', revision, items: [{ key: `${revision}:${hashKey(text)}`, text }] }, page);
};
const saved = () => Object.fromEntries(['chrome', 'fetch'].map((k) => [k, globalThis[k]]));

describe('worker: model calls under scrolling', () => {
  test('paid batches run several at once (up to 4); Gemini requests stay one at a time', async () => {
    const keep = saved();
    try {
      const out = { anthropic: 0, gemini: 0 };
      const most = { anthropic: 0, gemini: 0 };
      const fetchModel = async (url, init) => {
        const who = url === ANTHROPIC_URL ? 'anthropic' : 'gemini';
        most[who] = Math.max(most[who], ++out[who]);
        await tick(30);
        out[who]--;
        if (who === 'anthropic') {
          return { ok: true, status: 200, text: async () => JSON.stringify({ stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 50 },
            content: [{ type: 'text', text: keepAll(JSON.parse(init.body).messages.at(-1).content) }] }) };
        }
        return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: keepAll(JSON.parse(init.body).contents[0].parts[0].text) }] } }] }) };
      };
      const data = baseData();
      const dispatch = await worker('paid', { data, host: () => data[STATE_KEY], fetchModel });
      const replies = await Promise.all(texts(7).map((t) => ask(dispatch, t)));
      expect(replies.every((r) => Object.values(r.results)[0]?.[0]?.f === 'et')).toBe(true);
      expect(most.anthropic).toBe(4);
      expect(most.gemini).toBe(0);

      // Gemini only (no Anthropic key): batches go in together, their requests one at a time.
      const data2 = baseData({ anthropicKey: '' });
      const dispatch2 = await worker('gemini', { data: data2, host: () => data2[STATE_KEY], fetchModel });
      const replies2 = await Promise.all(texts(5).map((t) => ask(dispatch2, `${t} Again.`)));
      expect(replies2.every((r) => Object.values(r.results)[0]?.[0]?.f === 'et')).toBe(true);
      expect(most.gemini).toBe(1);
      expect(data2.modelCalls.count).toBe(5); // every Gemini request counted toward the local cap
    } finally {
      Object.assign(globalThis, keep);
    }
  }, 30000);

  test('near the Anthropic cap, parallel batches pass it only as one at a time would; the rest go to Gemini', async () => {
    const keep = saved();
    try {
      const calls = { anthropic: 0, gemini: 0 };
      let out = 0;
      let most = 0;
      const fetchModel = async (url, init) => {
        if (url === ANTHROPIC_URL) {
          calls.anthropic++;
          most = Math.max(most, ++out);
          await tick(30);
          out--;
          // 20,000 output tokens: $0.01 at Haiku 5.5's price, enough to cross the cap.
          return { ok: true, status: 200, text: async () => JSON.stringify({ stop_reason: 'end_turn', usage: { input_tokens: 100, output_tokens: 20000 },
            content: [{ type: 'text', text: keepAll(JSON.parse(init.body).messages.at(-1).content) }] }) };
        }
        calls.gemini++;
        return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: keepAll(JSON.parse(init.body).contents[0].parts[0].text) }] } }] }) };
      };
      const today = localDay();
      const data = baseData({ anthropicDay: { day: today, usd: 4.995, stopped: '' } });
      const dispatch = await worker('cap', { data, host: () => data[STATE_KEY], fetchModel });
      const replies = await Promise.all(texts(4).map((t) => ask(dispatch, `${t} Capped.`)));
      expect(replies.every((r) => Object.values(r.results)[0]?.[0]?.f === 'et')).toBe(true);
      expect(calls.anthropic).toBe(1);
      expect(most).toBe(1);
      expect(calls.gemini).toBe(3);
      const status = await dispatch({ type: 'status' }, popup);
      expect(status.anthropic.blocked).toBe('cap');
      expect(status.anthropic.usd).toBeCloseTo(5.00501, 6); // one request's cost past 4.995, as one at a time
    } finally {
      Object.assign(globalThis, keep);
    }
  }, 30000);

  test('a word-list change keeps cached swaps (same revision, no new request); Clear cache still asks again', async () => {
    const keep = saved();
    try {
      let requests = 0;
      const fetchModel = async (_url, init) => {
        requests++;
        return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: keepAll(JSON.parse(init.body).contents[0].parts[0].text) }] } }] }) };
      };
      const data = baseData({ anthropicKey: '' });
      let host = { version: 't.1', stage: 1, paused: false, words: WORDS };
      const dispatch = await worker('list', { data, host: () => host, fetchModel });
      await dispatch({ type: 'syncWords' }, popup);
      const text = 'The garden was quiet and the book was good today.';
      const first = await ask(dispatch, text);
      expect(Object.values(first.results)[0]?.[0]?.f).toBe('et');
      expect(requests).toBe(1);
      const before = (await dispatch({ type: 'config' }, page)).revision;
      host = { ...host, version: 't.2', words: [...WORDS, { fr: 'avec', en: 'with', hint: 'ah-vek', status: 'active' }] };
      await dispatch({ type: 'syncWords' }, popup);
      expect(data[STATE_KEY].version).toBe('t.2');
      expect((await dispatch({ type: 'config' }, page)).revision).toBe(before);
      const again = await ask(dispatch, text);
      expect(Object.values(again.results)[0]?.[0]?.f).toBe('et');
      expect(requests).toBe(1); // from the cache
      // Settings that change swaps still re-swap at once: a new level is a new revision.
      await dispatch({ type: 'save', settings: { levelOverride: 2 } }, popup);
      expect((await dispatch({ type: 'config' }, page)).revision).not.toBe(before);
      await dispatch({ type: 'save', settings: { levelOverride: 0 } }, popup);
      expect((await dispatch({ type: 'config' }, page)).revision).toBe(before);
      await dispatch({ type: 'clearCache' }, popup);
      await ask(dispatch, text);
      expect(requests).toBe(2);
    } finally {
      Object.assign(globalThis, keep);
    }
  }, 30000);
});

describe('content: what the next batch carries', () => {
  const el = (top, connected = true) => ({ isConnected: connected, getBoundingClientRect: () => ({ top, bottom: top + 100 }) });
  test('drops passages whose elements all left or changed text; nearest the window first, on-screen top to bottom', () => {
    const view = 900;
    const a = el(2000); // far below
    const b = el(300); // on screen
    const c = el(-50); // on screen, partly above
    const gone = el(400, false); // unmounted by the timeline
    const changed = el(500); // now shows other text
    const d = el(-400); // scrolled past, 300 px above
    const twice = [el(5000, false), el(950)]; // one copy unmounted, one just below
    const pending = new Map([
      ['k-a', { text: 'a', els: new Set([a]) }],
      ['k-gone', { text: 'gone', els: new Set([gone]) }],
      ['k-b', { text: 'b', els: new Set([b]) }],
      ['k-changed', { text: 'changed', els: new Set([changed]) }],
      ['k-c', { text: 'c', els: new Set([c]) }],
      ['k-d', { text: 'd', els: new Set([d]) }],
      ['k-twice', { text: 'twice', els: new Set(twice) }],
      ['k-out', { text: 'out', els: new Set([el(0)]) }],
    ]);
    const keyOf = (e) => (e === changed ? 'k-other' : [...pending].find(([, p]) => p.els.has(e))?.[0]);
    const batch = pickBatch(pending, new Set(['k-out']), keyOf, view);
    expect(batch.map((i) => i.key)).toEqual(['k-c', 'k-b', 'k-twice', 'k-d', 'k-a']);
    expect(pending.has('k-gone')).toBe(false);
    expect(pending.has('k-changed')).toBe(false);
    expect(pending.get('k-twice').els.size).toBe(1);
    expect(pending.has('k-out')).toBe(true); // already out: left alone
    expect(pickBatch(pending, new Set(), keyOf, view, 2).map((i) => i.key)).toEqual(['k-c', 'k-out']);
  });

  test('a page keeps at most 2 batches out, sends the nearest passages next, and a remounted post repaints from memo', async () => {
    const win = new Window({ url: 'https://example.com/feed' });
    const keys = ['chrome', 'document', 'window', 'location', 'MutationObserver', 'IntersectionObserver', 'setInterval'];
    const keepGlobals = Object.fromEntries(keys.map((k) => [k, globalThis[k]]));
    class IO {
      constructor(cb, options) { this.cb = cb; this.options = options; this.els = new Set(); }
      observe(e) { this.els.add(e); if (this.options.rootMargin) queueMicrotask(() => { if (this.els.has(e)) this.cb([{ target: e, isIntersecting: true, intersectionRatio: 1 }]); }); }
      unobserve(e) { this.els.delete(e); }
      disconnect() { this.els.clear(); }
    }
    const config = { settings: { enabled: true, newSitesEnabled: true, siteOverrides: {} }, level: 1, revision: 'r1', hasKey: true, tier: 'gemini', paused: false, origins: ['<all_urls>'], stage: 1 };
    const batches = [];
    let out = 0;
    let most = 0;
    const gates = [];
    const runtime = {
      id: 'fw-test',
      onMessage: { addListener: () => {} },
      sendMessage: async (msg) => {
        if (msg.type === 'config') return config;
        if (msg.type !== 'swaps') return { ok: true };
        batches.push(msg.items.map((i) => i.text));
        most = Math.max(most, ++out);
        await new Promise((go) => gates.push(go));
        out--;
        return { results: Object.fromEntries(msg.items.map((i) => [i.key, [{ o: 'and', f: 'et', g: 'and', h: 'ay', ctx: '' }]])) };
      },
    };
    Object.assign(globalThis, { window: win, document: win.document, location: win.location, MutationObserver: win.MutationObserver,
      IntersectionObserver: IO, setInterval: win.setInterval.bind(win), chrome: { runtime } });
    const openAll = async () => { while (gates.length) gates.shift()(); await tick(400); };
    // Where each post sits: its number times 200 px, minus the scroll.
    let scroll = 0;
    const post = (n) => {
      const p = win.document.createElement('p');
      p.textContent = `Post ${n}: the cat and the dog sleep all day long here.`;
      p.getBoundingClientRect = () => ({ top: n * 200 - scroll, bottom: n * 200 + 180 - scroll });
      return p;
    };
    try {
      win.document.body.innerHTML = '<main></main>';
      const main = win.document.querySelector('main');
      for (let n = 0; n < 3; n++) main.append(post(n));
      await import('../src/content.js?scroll');
      await tick(400);
      expect(batches).toHaveLength(1);
      // The reader scrolls while the first batch is out: posts 3-30 mount, then the view moves to post 20.
      for (let n = 3; n < 31; n++) main.append(post(n));
      await tick(400);
      expect(batches).toHaveLength(2); // the second one, and no more until one comes back
      scroll = 20 * 200;
      for (const p of [...main.children].filter((p) => /Post (3|4|5|6|7|8|9|10|11):/.test(p.textContent))) p.remove(); // unmounted
      while (gates.length) gates.shift()();
      await tick(400);
      expect(most).toBe(2);
      // The next batches: the posts around the view (20 and after first), none of the unmounted ones.
      const third = batches[2];
      expect(third[0]).toMatch(/^Post 20:/);
      expect(batches.slice(2).flat().some((t) => /^Post (3|4|5|6|7|8|9|10|11):/.test(t))).toBe(false);
      await openAll(); await openAll(); await openAll();
      const asked = batches.length;
      // Post 0 scrolls away and comes back as a new element with the same text: painted from memo, no request.
      const zero = main.querySelector('p');
      expect(zero.querySelector('.fw-word')?.textContent).toBe('et');
      zero.remove();
      await tick(50);
      const back = post(0);
      main.prepend(back);
      await tick(50);
      expect(back.querySelector('.fw-word')?.textContent).toBe('et');
      expect(batches.length).toBe(asked);
    } finally {
      while (gates.length) gates.shift()();
      await win.happyDOM.close();
      Object.assign(globalThis, keepGlobals);
    }
  }, 30000);
});
