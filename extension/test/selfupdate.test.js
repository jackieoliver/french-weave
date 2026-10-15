import { test, expect } from 'bun:test';
import { STATE_KEY } from '../src/hostsource.js';
import { hashKey } from '../src/hash.js';

// The real worker (fresh copy via ?selfupdate) with a fake chrome. 0.2.1 only showed a NEW badge after an update
// replaced the folder on disk; the user had to find chrome://extensions and click reload.
test('an update on disk reloads the extension once per version, after any model call in flight; NEW badge as fallback', async () => {
  const saved = Object.fromEntries(['chrome', 'fetch', 'setTimeout'].map((k) => [k, globalThis[k]]));
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => (ms >= 10000 ? 0 : realTimeout(fn, ms, ...rest));
  const data = { settings: { enabled: true, newSitesEnabled: true }, apiKey: 'synthetic-key',
    [STATE_KEY]: { version: 't.1', stage: 1, paused: false, sites: 'all', fetchedAt: Date.now(), words: [{ fr: 'et', en: 'and', hint: 'ay', status: 'active' }] } };
  const listeners = [];
  const badges = [];
  const log = [];
  let diskVersion = '0.2.1';
  let reloadThrows = false;
  let releaseModel;
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
      sendNativeMessage: async () => ({ ok: false }),
      reload: () => { log.push('reload'); if (reloadThrows) throw new Error('reload failed'); },
    },
    action: { setBadgeText: async ({ text }) => { badges.push(text); } },
    tabs: { query: async () => [], sendMessage: async () => {} },
    alarms: { create: async () => {}, onAlarm: on() },
    permissions: { getAll: async () => ({ origins: ['<all_urls>'] }), onAdded: on(), onRemoved: on() },
    scripting: { getRegisteredContentScripts: async () => [], updateContentScripts: async () => {},
      unregisterContentScripts: async () => {}, registerContentScripts: async () => {} },
  };
  globalThis.fetch = async (url, init) => {
    if (String(url).endsWith('manifest.json')) return { ok: true, json: async () => ({ version: diskVersion }) };
    log.push('model start');
    await new Promise((done) => { releaseModel = done; });
    log.push('model end');
    const items = JSON.parse(JSON.parse(init.body).contents[0].parts[0].text.replace(/^Passages:\n/, ''));
    const passages = items.map(({ id }) => ({ id, swaps: [] }));
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ passages }) }] } }] }) };
  };
  const dispatch = (msg, sender) => new Promise((done) => { if (!listeners.some((fn) => fn(msg, sender, done))) done(undefined); });
  const popup = { id: 'fw-test', url: 'chrome-extension://fw-test/src/popup.html' };
  const page = { id: 'fw-test', tab: { id: 1 }, url: 'https://example.com/article' };
  const wait = (ms = 20) => new Promise((done) => realTimeout(done, ms));
  try {
    const { RELOADED_KEY } = await import('../src/background.js?selfupdate');
    expect((await dispatch({ type: 'status' }, popup)).update).toBe('');
    expect(log).toEqual([]);

    // A model call is in flight when the update lands: the reload waits for it.
    const { revision } = await dispatch({ type: 'config' }, page);
    const text = 'Cats and dogs sleep all day long in the sun.';
    const swaps = dispatch({ type: 'swaps', revision, items: [{ key: `${revision}:${hashKey(text)}`, text }] }, page);
    await wait();
    expect(log).toEqual(['model start']);
    diskVersion = '0.2.2';
    const opened = dispatch({ type: 'status' }, popup); // opening the popup checks for an update
    await wait();
    expect(log).toEqual(['model start']);
    releaseModel();
    await swaps; await wait();
    expect(log).toEqual(['model start', 'model end', 'reload']);
    expect(data[RELOADED_KEY]).toBe('0.2.2');
    expect(badges).not.toContain('NEW');
    void opened;

    // Still running 0.2.1 after reloading for 0.2.2 (Chrome kept the old copy): never loop, show NEW instead.
    expect((await dispatch({ type: 'status' }, popup)).update).toBe('0.2.2');
    expect(log.filter((x) => x === 'reload')).toHaveLength(1);
    expect(badges.at(-1)).toBe('NEW');

    // A newer version gets one try; if reload throws, the badge is the fallback.
    diskVersion = '0.2.3';
    reloadThrows = true;
    expect((await dispatch({ type: 'status' }, popup)).update).toBe('0.2.3');
    expect(log.filter((x) => x === 'reload')).toHaveLength(2);
    expect(badges.at(-1)).toBe('NEW');
  } finally {
    Object.assign(globalThis, saved);
  }
}, 30000);
