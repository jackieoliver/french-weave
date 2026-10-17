import { describe, test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { MODEL_CONFIG, CHOICES, HAIKU_CHOICE, configFor, modelLabel, haikuLevelsText } from '../src/model-config.js';
import { cleanSettings } from '../src/settings.js';
import { modelOptions, modelNote, servedLabel, nextText, claudeKeySet } from '../src/popup-model.js';
import { refresh, STATE_KEY } from '../src/hostsource.js';
import { ANTHROPIC_URL } from '../src/anthropic.js';
import { API_BASE } from '../src/gemini.js';
import { hashKey } from '../src/hash.js';

// 0.2.9: the reader updated to 0.2.7 and could not find Claude Haiku anywhere in the popup. The Model menu now offers
// it (first at every level), Auto says what it does, a "Next batch" line names the model for the next batch, and the
// worker tells the native host which version it runs (fw.py check), and checks for an update every 5 minutes.
const CHAIN = MODEL_CONFIG.default.chain;
const DIRECT = { provider: 'anthropic', model: 'claude-haiku-5-5', thinking: 'low', timeoutMs: 35000, maxPassages: 4 };
const ROUTED = { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', thinking: 'low', timeoutMs: 35000 };

describe('Claude Haiku as the popup choice', () => {
  test('configFor: Haiku first at every level, Anthropic key preferred, else OpenRouter, the chain as fallback', () => {
    for (const level of [0, 1, 2, 3, 4]) {
      expect(configFor('French', HAIKU_CHOICE, undefined, level, { anthropic: true, openrouter: true }).chain).toEqual([DIRECT, ...CHAIN]);
      expect(configFor('Spanish', HAIKU_CHOICE, undefined, level, { anthropic: true }).chain).toEqual([DIRECT, ...CHAIN]);
      expect(configFor('French', HAIKU_CHOICE, undefined, level, { openrouter: true }).chain).toEqual([ROUTED, ...CHAIN]);
      // Without either key there is no Haiku step: the Gemini chain as on Auto.
      expect(configFor('French', HAIKU_CHOICE, undefined, level, {}).chain).toEqual(CHAIN);
    }
    expect(configFor('French', HAIKU_CHOICE, undefined, 3, { anthropic: true }).design).toBe('candidates');
    // Auto is unchanged: Haiku only at Levels 1-2.
    expect(configFor('French', 'auto', undefined, 3, { anthropic: true }).chain).toEqual(CHAIN);
    expect(configFor('French', 'auto', undefined, 2, { anthropic: true }).chain).toEqual([DIRECT, ...CHAIN]);
  });

  test('the menu lists Auto, Claude Haiku, then the Gemini models; settings keep the choice', () => {
    expect(Object.keys(CHOICES)).toEqual(['auto', HAIKU_CHOICE, 'gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'gemini-3.8-flash']);
    expect(CHOICES.auto).toBe('Auto (Haiku at L1-2, else Gemini)');
    expect(CHOICES[HAIKU_CHOICE]).toBe('Claude Haiku 5.5 (low)');
    expect(haikuLevelsText({ default: { levelFirst: { levels: [2, 1] } } })).toBe('L1-2');
    expect(haikuLevelsText({ default: { levelFirst: { levels: [1, 3] } } })).toBe('L1, 3');
    expect(cleanSettings({ modelChoice: HAIKU_CHOICE }).modelChoice).toBe(HAIKU_CHOICE);
    expect(cleanSettings({ modelChoice: 'claude-opus' }).modelChoice).toBe('auto');
    expect(cleanSettings({ modelChoice: 'gemini-3.8-flash' }).modelChoice).toBe('gemini-3.8-flash');
  });

  test('popup text: Haiku can only be picked with a Claude key; the next and last batch name the model', () => {
    const noKey = { config: { settings: { modelChoice: HAIKU_CHOICE } } };
    expect(claudeKeySet(noKey)).toBe(false);
    expect(modelOptions(noKey)[1]).toEqual({ value: HAIKU_CHOICE, label: 'Claude Haiku 5.5 (low): needs a key', disabled: true });
    expect(modelNote(noKey)).toBe('Haiku needs an Anthropic or OpenRouter key (Backup and paid keys); Gemini serves until then.');
    for (const key of ['anthropicKey', 'hostAnthropicKey', 'openRouterKey', 'hostOpenRouterKey']) {
      const st = { ...noKey, [key]: true };
      expect(modelOptions(st)[1]).toEqual({ value: HAIKU_CHOICE, label: 'Claude Haiku 5.5 (low)', disabled: false });
      expect(modelNote(st)).toBe('');
    }
    expect(modelOptions(noKey).filter((o) => o.disabled)).toHaveLength(1);
    expect(modelNote({ config: { settings: { modelChoice: 'auto' } } })).toBe('');

    expect(servedLabel({ model: 'claude-haiku-5-5', provider: 'anthropic', keyName: 'anthropic' })).toBe('Claude Haiku 5.5 low (Anthropic)');
    expect(servedLabel({ model: 'anthropic/claude-haiku-5.5', provider: 'openrouter', keyName: 'openrouter' })).toBe('Claude Haiku 5.5 low (OpenRouter)');
    expect(servedLabel({ model: 'gemini-3.1-flash-lite', provider: 'gemini', keyName: 'backup' })).toBe('Gemini 3.1 Flash-Lite (backup key)');
    expect(servedLabel({ model: 'openai/gpt-6-luna', provider: 'openrouter', keyName: 'openrouter' })).toBe('gpt-6-luna (OpenRouter)');
    expect(servedLabel(null)).toBe('');
    expect(modelLabel('claude-haiku-5-5')).toBe('Claude Haiku 5.5 low');

    const gemini = { tier: 'gemini', level: 2 };
    expect(nextText({ config: gemini, next: { model: 'claude-haiku-5-5', provider: 'anthropic', keyName: 'anthropic', level: 2 } }))
      .toBe('Claude Haiku 5.5 low (Anthropic), Level 2');
    expect(nextText({ config: { ...gemini, level: 3 }, next: { model: 'gemini-3.1-flash-lite', provider: 'gemini', keyName: 'main', level: 3 } }))
      .toBe('Gemini 3.1 Flash-Lite, Level 3');
    expect(nextText({ config: gemini, next: null })).toBe('No model free right now (limits reached), Level 2');
    expect(nextText({ config: { tier: 'local', level: 1 } })).toBe('Built-in list (no model), Level 1');
    expect(nextText({ config: { tier: 'none', level: 1 } })).toBe('None until you add a Gemini key');
  });
});

// The popup page itself (happy-dom), with a fake worker status.
async function openPopup(tag, status) {
  const html = (await Bun.file(new URL('../src/popup.html', import.meta.url)).text()).replace(/<script[^>]*><\/script>/, '');
  const win = new Window({ url: 'chrome-extension://fw-test/src/popup.html' });
  win.document.write(html);
  const sent = [];
  Object.assign(globalThis, {
    window: win, document: win.document,
    chrome: {
      runtime: { id: 'fw-test', sendMessage: async (msg) => { sent.push(msg); return msg.type === 'status' ? structuredClone(status) : { ok: true }; } },
      tabs: { query: async () => [{ id: 1, url: 'https://example.com/' }], create: async () => {} },
      permissions: { contains: async () => true },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
    },
  });
  await import(`../src/popup.js?${tag}`);
  await new Promise((r) => setTimeout(r, 30));
  return { doc: win.document, sent };
}

test('popup: the Model menu shows Claude Haiku and the Next batch line names the model', async () => {
  const saved = Object.fromEntries(['chrome', 'document', 'window'].map((k) => [k, globalThis[k]]));
  const settings = { enabled: true, newSitesEnabled: true, siteOverrides: {}, levelOverride: 0, modelChoice: HAIKU_CHOICE,
    openRouterDailyUsd: 0.25, anthropicDailyUsd: 5 };
  const config = { settings, hasKey: true, tier: 'gemini', paused: false, origins: ['<all_urls>'], stage: 2, level: 2 };
  try {
    const { doc, sent } = await openPopup('haiku-key', { config, anthropicKey: true, words: 0, fetchedAt: 0,
      next: { model: 'claude-haiku-5-5', provider: 'anthropic', keyName: 'anthropic', level: 2 },
      lastServed: { model: 'gemini-3.1-flash-lite', provider: 'gemini', keyName: 'main' }, served: { counts: { 'claude-haiku-5-5': 3 } } });
    const options = [...doc.querySelectorAll('#model option')].map((o) => [o.value, o.textContent, o.disabled]);
    expect(options.slice(0, 2)).toEqual([['auto', 'Auto (Haiku at L1-2, else Gemini)', false], [HAIKU_CHOICE, 'Claude Haiku 5.5 (low)', false]]);
    expect(doc.getElementById('model').value).toBe(HAIKU_CHOICE);
    expect(doc.getElementById('nextInfo').textContent).toBe('Claude Haiku 5.5 low (Anthropic), Level 2');
    expect(doc.getElementById('modelInfo').textContent).toBe('Gemini 3.1 Flash-Lite; today: Claude Haiku 5.5 low 3');
    expect(doc.getElementById('modelNote').textContent).toBe('');
    // Picking it saves the choice.
    const menu = doc.getElementById('model');
    menu.value = 'auto';
    menu.dispatchEvent(new window.Event('change'));
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.find((m) => m.type === 'save')).toEqual({ type: 'save', settings: { modelChoice: 'auto' } });

    const none = await openPopup('haiku-nokey', { config: { ...config, level: 3 }, words: 0, fetchedAt: 0,
      next: { model: 'gemini-3.1-flash-lite', provider: 'gemini', keyName: 'main', level: 3 } });
    const haiku = none.doc.querySelector(`#model option[value="${HAIKU_CHOICE}"]`);
    expect([haiku.textContent, haiku.disabled]).toEqual(['Claude Haiku 5.5 (low): needs a key', true]);
    expect(none.doc.getElementById('modelNote').textContent).toContain('Haiku needs an Anthropic or OpenRouter key');
    expect(none.doc.getElementById('nextInfo').textContent).toBe('Gemini 3.1 Flash-Lite, Level 3');
    expect(none.doc.getElementById('modelInfo').textContent).toBe('none yet');
  } finally {
    Object.assign(globalThis, saved);
  }
});

// A fake Chrome around the real worker (background.js), storage in data.
async function startWorker(data, tag, { native = async () => ({ ok: false }), version = '0.2.9' } = {}) {
  const on = (arr = []) => ({ addListener: (fn) => arr.push(fn) });
  const listeners = [];
  const installed = [];
  const alarmed = [];
  const alarms = [];
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
    runtime: { id: 'fw-test', getURL: (path) => `chrome-extension://fw-test/${path}`, getManifest: () => ({ version }),
      onMessage: on(listeners), onInstalled: on(installed), onStartup: on(), sendNativeMessage: (_host, msg) => native(msg),
      reload: () => {} },
    action: { setBadgeText: async () => {} },
    tabs: { query: async () => [], sendMessage: async () => {} },
    alarms: { create: (name, info) => { alarms.push([name, info.periodInMinutes]); }, onAlarm: on(alarmed) },
    permissions: { getAll: async () => ({ origins: ['<all_urls>'] }), onAdded: on(), onRemoved: on() },
    scripting: { getRegisteredContentScripts: async () => [], updateContentScripts: async () => {}, unregisterContentScripts: async () => {}, registerContentScripts: async () => {} },
  };
  await import(`../src/background.js?${tag}`);
  const dispatch = (msg, sender) => new Promise((done) => { if (!listeners.some((fn) => fn(msg, sender, done))) done(undefined); });
  return { dispatch, installed, alarmed, alarms };
}
const POPUP = { id: 'fw-test', url: 'chrome-extension://fw-test/src/popup.html' };
const PAGE = { id: 'fw-test', tab: { id: 1, title: 'Notes' }, url: 'https://example.com/article' };
const WORDS = [{ fr: 'et', en: 'and', hint: 'ay', status: 'active' }];
const wait = (ms = 30) => new Promise((r) => setTimeout(r, ms));

test('worker: Haiku picked serves first at Level 3; Next follows keys, caps and choice', async () => {
  const saved = Object.fromEntries(['chrome', 'fetch'].map((k) => [k, globalThis[k]]));
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('chrome-extension://')) return { ok: true, json: async () => ({ version: '0.2.9' }) };
    const user = url === ANTHROPIC_URL ? JSON.parse(init.body).messages.at(-1).content : JSON.parse(init.body).contents[0].parts[0].text;
    const items = JSON.parse(user.replace(/^[^[]*/, '').replace(/\n[^\]]*$/, ''));
    const keep = JSON.stringify({ passages: items.map(({ id, candidates }) => ({ id, topic: 'ok', keep: (candidates || []).map((c) => c.n) })) });
    if (url === ANTHROPIC_URL) {
      calls.push('anthropic');
      return { ok: true, status: 200, text: async () => JSON.stringify({ type: 'message', stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: 'text', text: keep }] }) };
    }
    calls.push(String(url).slice(API_BASE.length).split(':')[0]);
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: keep }] } }] }) };
  };
  const data = { settings: { enabled: true, newSitesEnabled: true, levelOverride: 3, modelChoice: HAIKU_CHOICE },
    apiKey: 'synthetic-main', anthropicKey: 'synthetic-anthropic',
    [STATE_KEY]: { version: 't.1', stage: 3, paused: false, sites: 'all', fetchedAt: Date.now(), words: WORDS } };
  try {
    const { dispatch } = await startWorker(data, 'haiku-worker');
    const st = await dispatch({ type: 'status' }, POPUP);
    expect(st.next).toEqual({ model: 'claude-haiku-5-5', provider: 'anthropic', keyName: 'anthropic', level: 3 });
    expect(nextText(st)).toBe('Claude Haiku 5.5 low (Anthropic), Level 3');
    for (const k of Object.keys(st)) if (typeof st[k] === 'string') expect(st[k]).not.toContain('synthetic'); // no key reaches the popup
    expect(JSON.stringify(st)).not.toContain('synthetic');

    const { revision } = await dispatch({ type: 'config' }, PAGE);
    const text = 'The cat and the dog sleep all day long in the sun.';
    const res = await dispatch({ type: 'swaps', revision, items: [{ key: `${revision}:${hashKey(text)}`, text }] }, PAGE);
    expect(res.error).toBeUndefined();
    expect(calls).toEqual(['anthropic']);
    expect((await dispatch({ type: 'status' }, POPUP)).lastServed).toMatchObject({ model: 'claude-haiku-5-5', provider: 'anthropic' });

    // Auto at Level 3: Gemini first.
    await dispatch({ type: 'save', settings: { modelChoice: 'auto' } }, POPUP);
    expect((await dispatch({ type: 'status' }, POPUP)).next).toEqual({ model: 'gemini-3.1-flash-lite', provider: 'gemini', keyName: 'main', level: 3 });
    // Haiku picked but the Anthropic cap set to 0: no Haiku step, Gemini next.
    await dispatch({ type: 'save', settings: { modelChoice: HAIKU_CHOICE, anthropicDailyUsd: 0 } }, POPUP);
    expect((await dispatch({ type: 'status' }, POPUP)).next).toMatchObject({ model: 'gemini-3.1-flash-lite', keyName: 'main' });
    // Only an OpenRouter key: Haiku through OpenRouter.
    await dispatch({ type: 'save', anthropicKey: '', openRouterKey: 'synthetic-openrouter', settings: { anthropicDailyUsd: 5 } }, POPUP);
    expect((await dispatch({ type: 'status' }, POPUP)).next).toEqual({ model: 'anthropic/claude-haiku-5.5', provider: 'openrouter', keyName: 'openrouter', level: 3 });
    // The main key out of today's quota for the first Gemini model: the backup key, else the next model.
    await dispatch({ type: 'save', openRouterKey: '', backupKey: 'synthetic-backup' }, POPUP);
    data.dailyQuota = { 'gemini-3.1-flash-lite': Date.now() + 3600000 };
    expect((await dispatch({ type: 'status' }, POPUP)).next).toMatchObject({ model: 'gemini-3.1-flash-lite', keyName: 'backup' });
    // No Gemini key: the built-in list, no model.
    await dispatch({ type: 'save', apiKey: '', backupKey: '' }, POPUP);
    const local = await dispatch({ type: 'status' }, POPUP);
    expect(local.next).toBeNull();
    expect(nextText(local)).toBe('Built-in list (no model), Level 3');
  } finally {
    Object.assign(globalThis, saved);
  }
}, 30000);

describe('update proof', () => {
  test('the state request carries the running version; without one it is the old message', async () => {
    const storage = { data: {}, async get(keys) { return Object.fromEntries(keys.filter((k) => k in this.data).map((k) => [k, this.data[k]])); },
      async set(v) { Object.assign(this.data, v); } };
    const sent = [];
    const send = async (msg) => { sent.push(msg); return { ok: true, version: 'v1', stage: 1, words: WORDS }; };
    await refresh({ storage, send, version: '0.2.9' });
    await refresh({ storage, send });
    expect(sent).toEqual([{ type: 'state', extension: '0.2.9' }, { type: 'state' }]);
    // A host before 0.2.9 answers the same way whatever extra field comes along: nothing else changes.
    expect(storage.data[STATE_KEY].words.map((w) => w.fr)).toEqual(['et']);
  });

  test('worker: reports its version on each sync and right after a reload; update check every 5 minutes', async () => {
    const saved = Object.fromEntries(['chrome', 'fetch'].map((k) => [k, globalThis[k]]));
    let disk = '0.2.9';
    const fetched = [];
    globalThis.fetch = async (url) => { fetched.push(String(url)); return { ok: true, json: async () => ({ version: disk }) }; };
    const sent = [];
    const native = async (msg) => { sent.push(msg); return msg.type === 'state' ? { ok: true, version: 'v1', stage: 1, words: WORDS } : { ok: true, applied: 0 }; };
    try {
      // Reloaded into 0.2.9 after 0.2.8 reported: the new worker tells the host at once, without onInstalled.
      const data = { settings: { enabled: true }, versionReported: { version: '0.2.8', at: 1 } };
      const w = await startWorker(data, 'report-reload', { native });
      await wait();
      expect(sent).toEqual([{ type: 'state', extension: '0.2.9' }]);
      expect(data.versionReported.version).toBe('0.2.9');
      expect(data.versionReported.at).toBeGreaterThan(1);

      // onInstalled arms both alarms: word sync every 30 minutes, the update check every 5.
      w.installed.forEach((fn) => fn({ reason: 'update' }));
      await wait();
      expect(w.alarms).toEqual([['sync', 30], ['update', 5]]);
      expect(sent.at(-1)).toEqual({ type: 'state', extension: '0.2.9' });

      // The update alarm only checks the manifest on disk; the sync alarm also syncs, with the version.
      const before = sent.length;
      fetched.length = 0;
      w.alarmed.forEach((fn) => fn({ name: 'update' }));
      await wait();
      expect(sent.length).toBe(before);
      expect(fetched).toEqual(['chrome-extension://fw-test/manifest.json']);
      w.alarmed.forEach((fn) => fn({ name: 'sync' }));
      await wait();
      expect(sent.slice(before)).toEqual([{ type: 'state', extension: '0.2.9' }]);

      // Same version already reported (an ordinary worker restart): no extra host call at start.
      const quiet = [];
      await startWorker({ settings: { enabled: true }, versionReported: { version: '0.2.9', at: 5 } }, 'report-same',
        { native: async (msg) => { quiet.push(msg); return { ok: false }; } });
      await wait();
      expect(quiet).toEqual([]);
      // A host that doesn't answer (missing, or refuses): nothing is recorded as reported.
      const lost = { settings: { enabled: true }, versionReported: { version: '0.2.8', at: 1 } };
      await startWorker(lost, 'report-nohost', { native: async () => ({ ok: false, error: 'unknown message type' }) });
      await wait();
      expect(lost.versionReported).toEqual({ version: '0.2.8', at: 1 });
    } finally {
      Object.assign(globalThis, saved);
    }
  }, 30000);
});
