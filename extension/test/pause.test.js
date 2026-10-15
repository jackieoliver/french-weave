import { test, expect } from 'bun:test';
import { STATE_KEY } from '../src/hostsource.js';
import { hashKey } from '../src/hash.js';

// The real worker (fresh copy via ?pause), a fake native host and a fake Gemini. Regression: after `fw.py pause`
// the worker kept its cached paused:false and sent page text to Gemini until the next 30-minute sync.
test('pause from Claude Code stops Gemini calls at the next request once the host check is due; resume returns', async () => {
  const saved = Object.fromEntries(['chrome', 'fetch', 'setTimeout'].map((k) => [k, globalThis[k]]));
  const realNow = Date.now;
  let clock = realNow();
  Date.now = () => clock;
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => (ms >= 10000 ? 0 : realTimeout(fn, ms, ...rest)); // no 10 s event flush
  const words = [{ fr: 'et', en: 'and', hint: 'ay', status: 'active' }];
  let host = { ok: true, version: 'p.1', stage: 1, paused: false, words };
  let hostReads = 0;
  const data = { settings: { enabled: true, newSitesEnabled: true }, apiKey: 'synthetic-key' };
  const listeners = [];
  const on = (arr = []) => ({ addListener: (fn) => arr.push(fn) });
  globalThis.chrome = {
    storage: { local: {
      async setAccessLevel() {},
      async get(keys) {
        const pick = keys == null ? Object.keys(data) : typeof keys === 'string' ? [keys] : keys;
        return structuredClone(Object.fromEntries(pick.filter((k) => k in data).map((k) => [k, data[k]])));
      },
      async set(values) { for (const [k, v] of Object.entries(values)) data[k] = structuredClone(v); },
      async remove(keys) { for (const k of keys) delete data[k]; },
    } },
    runtime: {
      id: 'fw-test', getURL: (path) => `chrome-extension://fw-test/${path}`, getManifest: () => ({ version: '0.2.1' }),
      onMessage: on(listeners), onInstalled: on(), onStartup: on(),
      sendNativeMessage: async (_h, msg) => { if (msg.type === 'state') { hostReads++; return structuredClone(host); } return { ok: true, applied: 0 }; },
    },
    action: { setBadgeText: async () => {} },
    tabs: { query: async () => [], sendMessage: async () => {} },
    alarms: { create: async () => {}, onAlarm: on() },
    permissions: { getAll: async () => ({ origins: ['<all_urls>'] }), onAdded: on(), onRemoved: on() },
    scripting: { getRegisteredContentScripts: async () => [], updateContentScripts: async () => {},
      unregisterContentScripts: async () => {}, registerContentScripts: async () => {} },
  };
  let geminiCalls = 0;
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('manifest.json')) return { ok: true, json: async () => ({ version: '0.2.1' }) };
    geminiCalls++;
    const items = JSON.parse(JSON.parse(init.body).contents[0].parts[0].text.replace(/^Passages:\n/, ''));
    const passages = items.map(({ id }) => ({ id, swaps: [{ o: 'and', f: 'et', ctx: '' }] }));
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ passages }) }] } }] }) };
  };
  const dispatch = (msg, sender) => new Promise((done) => { if (!listeners.some((fn) => fn(msg, sender, done))) done(undefined); });
  const popup = { id: 'fw-test', url: 'chrome-extension://fw-test/src/popup.html' };
  const page = { id: 'fw-test', tab: { id: 1 }, url: 'https://example.com/article' };
  const ask = async (text) => {
    const { revision } = await dispatch({ type: 'config' }, page);
    return dispatch({ type: 'swaps', revision, items: [{ key: `${revision}:${hashKey(text)}`, text }] }, page);
  };
  try {
    const { HOST_CHECK_MS } = await import('../src/background.js?pause');
    await dispatch({ type: 'syncWords' }, popup);
    expect(data[STATE_KEY].paused).toBe(false);
    const readsAfterSync = hostReads;
    expect((await ask('Cats and dogs sleep all day long here.')).results).toBeDefined();
    expect(geminiCalls).toBe(1);
    expect(hostReads).toBe(readsAfterSync); // a fresh sync is not repeated: no extra host call per request

    host = { ...host, paused: true }; // fw.py pause
    clock += HOST_CHECK_MS - 1000;
    await ask('Birds and bees fly over the garden now.');
    expect(geminiCalls).toBe(2); // within the window the cached state still says on
    clock += 2000; // the check is due: the next request reads the host first and sends nothing
    const reply = await ask('Fish and frogs swim in the old pond.');
    expect(reply.stale).toBe(true);
    expect(geminiCalls).toBe(2);
    expect(data[STATE_KEY].paused).toBe(true);
    expect((await dispatch({ type: 'config' }, page)).paused).toBe(true);

    host = { ...host, paused: false }; // fw.py resume: a page load after the window notices it
    clock += HOST_CHECK_MS + 1;
    await dispatch({ type: 'config' }, page);
    await new Promise((done) => realTimeout(done, 20));
    expect((await dispatch({ type: 'config' }, page)).paused).toBe(false);
    await ask('Mice and rats run under the floor today.');
    expect(geminiCalls).toBe(3);
  } finally {
    Date.now = realNow;
    Object.assign(globalThis, saved);
  }
}, 30000);
