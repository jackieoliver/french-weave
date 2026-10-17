import { test, expect } from 'bun:test';
import { PENDING_KEY, STATE_KEY } from '../src/hostsource.js';

// The real service worker (fresh module copy via ?background) with a minimal fake chrome: no page, no Gemini.
test('worker: update badge follows the manifest on disk; concurrent page events are all queued', async () => {
  const saved = Object.fromEntries(['chrome', 'fetch', 'setTimeout'].map((k) => [k, globalThis[k]]));
  // The worker's 10 s event flush would otherwise fire during a later test file, against that file's fake chrome.
  const realTimeout = globalThis.setTimeout;
  const held = [];
  globalThis.setTimeout = (fn, ms, ...rest) => (ms >= 10000 ? (held.push(fn), 0) : realTimeout(fn, ms, ...rest));
  const data = {
    settings: { enabled: true, newSitesEnabled: true },
    apiKey: 'synthetic-key',
    [STATE_KEY]: { version: 't.1', stage: 1, paused: false, sites: 'all', fetchedAt: 1,
      words: [{ fr: 'et', en: 'and', hint: 'ay', status: 'active' }, { fr: 'très', en: 'very', hint: 'treh', status: 'shaky' },
        { fr: 'mais', en: 'but', hint: 'meh', status: 'active' }] },
  };
  const tick = () => new Promise((done) => realTimeout(done, 1));
  const listeners = [];
  const badges = [];
  let diskVersion = '0.2.1';
  const on = (arr = []) => ({ addListener: (fn) => arr.push(fn) });
  globalThis.chrome = {
    storage: { local: {
      async setAccessLevel() {},
      // A tick between read and write, like real chrome.storage: unserialized read-modify-writes lose data here.
      async get(keys) {
        await tick();
        const pick = keys == null ? Object.keys(data) : typeof keys === 'string' ? [keys] : keys;
        return structuredClone(Object.fromEntries(pick.filter((k) => k in data).map((k) => [k, data[k]])));
      },
      async set(values) { await tick(); for (const [k, v] of Object.entries(values)) data[k] = structuredClone(v); },
      async remove(keys) { for (const k of keys) delete data[k]; },
    } },
    runtime: {
      id: 'fw-test', getURL: (path) => `chrome-extension://fw-test/${path}`, getManifest: () => ({ version: '0.2.1' }),
      onMessage: on(listeners), onInstalled: on(), onStartup: on(),
      sendNativeMessage: async () => ({ ok: false }),
    },
    action: { setBadgeText: async ({ text }) => { badges.push(text); } },
    tabs: { query: async () => [], sendMessage: async () => {} },
    alarms: { create: async () => {}, onAlarm: on() },
    permissions: { getAll: async () => ({ origins: ['<all_urls>'] }), onAdded: on(), onRemoved: on() },
    scripting: { getRegisteredContentScripts: async () => [], updateContentScripts: async () => {},
      unregisterContentScripts: async () => {}, registerContentScripts: async () => {} },
  };
  globalThis.fetch = async (url) => {
    expect(url).toBe('chrome-extension://fw-test/manifest.json'); // never the network
    return { ok: true, json: async () => ({ version: diskVersion }) };
  };
  const dispatch = (msg, sender) => new Promise((done) => {
    if (!listeners.some((fn) => fn(msg, sender, done))) done(undefined);
  });
  const popup = { id: 'fw-test', url: 'chrome-extension://fw-test/src/popup.html' };
  const page = { id: 'fw-test', tab: { id: 1 }, url: 'https://example.com/article' };
  try {
    await import('../src/background.js?background');

    // 0.2.1 regression: after a plugin update replaced the folder on disk, Chrome kept running the old copy with
    // no sign that a reload was needed. The popup's status reports the waiting version and the icon shows NEW.
    expect((await dispatch({ type: 'status' }, popup)).update).toBe('');
    expect(badges.at(-1)).toBe('');
    diskVersion = '0.2.2';
    // 0.2.9: the popup first says "Updating to 0.2.2…", then asks for the reload; this fake Chrome can't reload.
    expect(await dispatch({ type: 'status' }, popup)).toMatchObject({ update: '', updating: '0.2.2' });
    expect(await dispatch({ type: 'applyUpdate' }, popup)).toMatchObject({ ok: true, waiting: '0.2.2', reloading: false });
    expect(await dispatch({ type: 'status' }, popup)).toMatchObject({ update: '0.2.2', updating: '' });
    expect(badges.at(-1)).toBe('NEW');
    diskVersion = '0.2.1'; // reloaded: the running copy matches the disk again
    expect((await dispatch({ type: 'status' }, popup)).update).toBe('');
    expect(badges.at(-1)).toBe('');

    // 0338f19 regression: concurrent events from a page each did their own storage read-modify-write, and all but
    // one were lost. All three must reach the queue.
    const replies = await Promise.all([
      dispatch({ type: 'event', word: 'et', event: 'seen' }, page),
      dispatch({ type: 'event', word: 'très', event: 'flip' }, page),
      dispatch({ type: 'event', word: 'mais', event: 'peek' }, page),
    ]);
    expect(replies).toEqual([{ ok: true }, { ok: true }, { ok: true }]);
    expect(data[PENDING_KEY].map((e) => `${e.word}:${e.kind}`).sort()).toEqual(['et:seen', 'mais:peek', 'très:flip']);
    expect(held.length).toBeGreaterThan(0); // the flush was scheduled (and is dropped with this fake chrome)
  } finally {
    Object.assign(globalThis, saved);
  }
}, 30000);
