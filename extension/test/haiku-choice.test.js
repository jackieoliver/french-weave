import { describe, test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { MODEL_CONFIG, CHOICES, HAIKU_CHOICE, configFor, modelLabel, reasoningLevels } from '../src/model-config.js';
import { cleanSettings } from '../src/settings.js';
import { modelOptions, reasoningOptions, modelNote, modeText, servedLabel, nextText, claudeKeySet, versionText,
  updateText } from '../src/popup-model.js';
import { refresh, STATE_KEY } from '../src/hostsource.js';
import { ANTHROPIC_URL } from '../src/anthropic.js';
import { API_BASE } from '../src/gemini.js';
import { hashKey } from '../src/hash.js';

// 0.2.9: the reader updated to 0.2.7 and could not find Claude Haiku anywhere in the popup (Jackie: "dont hide it out
// under"). The Model menu now starts with Recommended (what it resolves to: Claude Haiku first at every level with a
// Claude key, else Gemini) and lists each model; a Reasoning menu sets the first model's reasoning; a Mode line says
// what that comes to, a "Next batch" line which model serves next; the header shows the version and channel, and
// "Updating to X…" / "Updated to X". The worker tells the native host which version it runs (fw.py check) and checks
// for an update every 5 minutes.
const CHAIN = MODEL_CONFIG.default.chain;
const DIRECT = { provider: 'anthropic', model: 'claude-haiku-5-5', thinking: 'low', timeoutMs: 35000, maxPassages: 4 };
const ROUTED = { provider: 'openrouter', model: 'anthropic/claude-haiku-5.5', thinking: 'low', timeoutMs: 35000 };
const BOTH = { anthropic: true, openrouter: true };

describe('Model and Reasoning choices', () => {
  test('configFor: Recommended and Claude Haiku put Haiku first at every level (Anthropic key, else OpenRouter)', () => {
    for (const choice of ['auto', HAIKU_CHOICE]) {
      for (const level of [1, 2, 3, 4]) {
        expect(configFor('French', choice, undefined, level, BOTH).chain).toEqual([DIRECT, ...CHAIN]);
        expect(configFor('Spanish', choice, undefined, level, { anthropic: true }).chain).toEqual([DIRECT, ...CHAIN]);
        expect(configFor('French', choice, undefined, level, { openrouter: true }).chain).toEqual([ROUTED, ...CHAIN]);
        // Without a Claude key there is no Haiku step: the Gemini chain.
        expect(configFor('French', choice, undefined, level, {}).chain).toEqual(CHAIN);
      }
    }
    // A Gemini model picked: it goes first, the rest of the chain behind it, no Haiku.
    expect(configFor('French', 'gemini-3.5-flash-lite', undefined, 3, BOTH).chain.map((s) => s.model))
      .toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'openai/gpt-6-luna']);
  });

  test('configFor: a reasoning level applies to the first step when it takes it, else Recommended', () => {
    const first = (choice, reasoning, has = BOTH) => configFor('French', choice, undefined, 2, has, reasoning).chain;
    expect(first('auto', 'off')[0]).toEqual({ ...DIRECT, thinking: 'off' });
    expect(first(HAIKU_CHOICE, 'high')[0]).toEqual({ ...DIRECT, thinking: 'high' });
    expect(first(HAIKU_CHOICE, 'medium', { openrouter: true })[0]).toEqual({ ...ROUTED, thinking: 'medium' });
    expect(first('auto', 'high').slice(1)).toEqual(CHAIN); // the fallback steps keep their own
    expect(first('gemini-3.5-flash-lite', 'minimal')[0]).toMatchObject({ model: 'gemini-3.5-flash-lite', thinking: 'minimal' });
    expect(first('gemini-3.8-flash', 'auto')[0]).toMatchObject({ model: 'gemini-3.8-flash', thinking: 'low' });
    // Not a level the first step takes: Recommended (Haiku has no minimal; Gemini is never "off" here).
    expect(first('auto', 'minimal')[0]).toEqual(DIRECT);
    expect(first('gemini-3.1-flash-lite', 'off')[0]).toEqual(CHAIN[0]);
    // Recommended without a Claude key: the level goes to Gemini 3.1 Flash-Lite, the first step then.
    expect(first('auto', 'high', {})[0]).toEqual({ ...CHAIN[0], thinking: 'high' });
    expect(reasoningLevels(DIRECT)).toEqual(['off', 'low', 'medium', 'high']);
    expect(reasoningLevels(ROUTED)).toEqual(['off', 'low', 'medium', 'high']);
    expect(reasoningLevels(CHAIN[0])).toEqual(['minimal', 'low', 'medium', 'high']);
    expect(reasoningLevels(CHAIN[2])).toEqual([]); // gpt-6-luna: never first by choice
  });

  test('the menu lists Recommended, then each model; settings keep the choices and migrate old ones', () => {
    expect(Object.entries(CHOICES)).toEqual([['auto', 'Recommended'], [HAIKU_CHOICE, 'Claude Haiku 5.5'],
      ['gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite'], ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite'],
      ['gemini-3.8-flash', 'Gemini 3.8 Flash (paid key)']]);
    expect(cleanSettings({})).toMatchObject({ modelChoice: 'auto', reasoning: 'auto' });
    // 0.2.8 and earlier stored 'auto' (now Recommended) or a Gemini model; 0.1 kept the model under "model".
    expect(cleanSettings({ modelChoice: 'auto' })).toMatchObject({ modelChoice: 'auto', reasoning: 'auto' });
    expect(cleanSettings({ modelChoice: 'gemini-3.5-flash-lite' }).modelChoice).toBe('gemini-3.5-flash-lite');
    expect(cleanSettings({ model: 'gemini-3.8-flash' }).modelChoice).toBe('gemini-3.8-flash');
    expect(cleanSettings({ modelChoice: HAIKU_CHOICE, reasoning: 'high' })).toMatchObject({ modelChoice: HAIKU_CHOICE, reasoning: 'high' });
    expect(cleanSettings({ modelChoice: 'claude-opus', reasoning: 'max' })).toMatchObject({ modelChoice: 'auto', reasoning: 'auto' });
  });

  test('popup text: menus, note, Mode line, Next and Last batch, header', () => {
    const haiku = { model: 'claude-haiku-5-5', provider: 'anthropic', thinking: 'low' };
    const gemini = { model: 'gemini-3.1-flash-lite', provider: 'gemini', thinking: 'medium' };
    const config = (settings, extra = {}) => ({ tier: 'gemini', level: 2, settings: { modelChoice: 'auto', reasoning: 'auto', levelOverride: 0, ...settings }, ...extra });
    const withKey = { config: config({}), anthropicKey: true, first: haiku, firstDefault: haiku, recommended: haiku };
    const noKey = { config: config({ modelChoice: HAIKU_CHOICE }), first: gemini, firstDefault: gemini, recommended: gemini };

    expect(claudeKeySet(noKey)).toBe(false);
    expect(modelOptions(withKey).map((o) => [o.value, o.label, o.disabled])).toEqual([
      ['auto', 'Recommended (Claude Haiku 5.5)', false], [HAIKU_CHOICE, 'Claude Haiku 5.5', false],
      ['gemini-3.1-flash-lite', 'Gemini 3.1 Flash-Lite', false], ['gemini-3.5-flash-lite', 'Gemini 3.5 Flash-Lite', false],
      ['gemini-3.8-flash', 'Gemini 3.8 Flash (paid key)', false]]);
    expect(modelOptions(noKey).slice(0, 2)).toEqual([{ value: 'auto', label: 'Recommended (Gemini 3.1 Flash-Lite)', disabled: false },
      { value: HAIKU_CHOICE, label: 'Claude Haiku 5.5: needs a Claude key', disabled: true }]);
    for (const key of ['anthropicKey', 'hostAnthropicKey', 'openRouterKey', 'hostOpenRouterKey']) {
      expect(modelOptions({ ...noKey, [key]: true })[1].disabled).toBe(false);
      expect(modelNote({ ...noKey, [key]: true })).toBe('');
    }
    expect(modelNote(noKey)).toBe('Claude Haiku needs a Claude key: an Anthropic key, or an OpenRouter key (Backup and paid keys).');
    expect(modelNote(withKey)).toBe('');

    expect(reasoningOptions(withKey)).toEqual({ selected: 'auto', options: [{ value: 'auto', label: 'Recommended (low)' },
      ...['off', 'low', 'medium', 'high'].map((l) => ({ value: l, label: l }))] });
    expect(reasoningOptions(noKey).options.map((o) => o.label)).toEqual(['Recommended (medium)', 'minimal', 'low', 'medium', 'high']);
    // A saved level the model doesn't take shows as Recommended.
    expect(reasoningOptions({ ...withKey, config: config({ reasoning: 'minimal' }) }).selected).toBe('auto');
    expect(reasoningOptions({ ...withKey, config: config({ reasoning: 'high' }) }).selected).toBe('high');

    expect(modeText(withKey)).toBe('Mode: Recommended → Claude Haiku 5.5 · low reasoning · Level 2 (Auto)');
    expect(modeText({ ...withKey, config: config({ modelChoice: HAIKU_CHOICE, reasoning: 'off', levelOverride: 3 }, { level: 3 }),
      first: { ...haiku, thinking: 'off' } })).toBe('Mode: Claude Haiku 5.5 · reasoning off · Level 3 (set here)');
    expect(modeText({ ...noKey, config: config({ modelChoice: 'gemini-3.5-flash-lite' }),
      first: { model: 'gemini-3.5-flash-lite', provider: 'gemini', thinking: 'high' } })).toBe('Mode: Gemini 3.5 Flash-Lite · high reasoning · Level 2 (Auto)');
    expect(modeText({ config: config({}, { tier: 'local', level: 1 }) })).toBe('Mode: built-in list, no model · Level 1 (Auto)');
    expect(modeText({ config: config({}, { tier: 'none' }) })).toBe('Mode: none until you add a Gemini key');

    expect(servedLabel({ model: 'claude-haiku-5-5', provider: 'anthropic', keyName: 'anthropic' })).toBe('Claude Haiku 5.5 (Anthropic)');
    expect(servedLabel({ model: 'anthropic/claude-haiku-5.5', provider: 'openrouter', keyName: 'openrouter' })).toBe('Claude Haiku 5.5 (OpenRouter)');
    expect(servedLabel({ model: 'gemini-3.1-flash-lite', provider: 'gemini', keyName: 'backup' })).toBe('Gemini 3.1 Flash-Lite (backup key)');
    expect(servedLabel({ model: 'openai/gpt-6-luna', provider: 'openrouter', keyName: 'openrouter' })).toBe('gpt-6-luna (OpenRouter)');
    expect(servedLabel(null)).toBe('');
    expect(modelLabel('claude-haiku-5-5')).toBe('Claude Haiku 5.5');

    expect(nextText({ ...withKey, next: { model: 'claude-haiku-5-5', provider: 'anthropic', keyName: 'anthropic', level: 2 } }))
      .toBe('Claude Haiku 5.5 (Anthropic), Level 2');
    expect(nextText({ ...withKey, next: null })).toBe('No model free right now (limits reached), Level 2');
    expect(nextText({ config: { tier: 'local', level: 1 } })).toBe('Built-in list (no model), Level 1');
    expect(nextText({ config: { tier: 'none', level: 1 } })).toBe('None until you add a Gemini key');

    expect(versionText({ version: '0.2.9', channel: 'dev' })).toBe('0.2.9 · dev build');
    expect(versionText({ version: '0.2.9', channel: '' })).toBe('0.2.9');
    expect(updateText({ updating: '0.2.10' })).toBe('Updating to 0.2.10…');
    expect(updateText({ updated: '0.2.9' })).toBe('Updated to 0.2.9');
    expect(updateText({})).toBe('');
  });
});

// The popup page itself (happy-dom), with a fake worker status.
async function openPopup(tag, status) {
  const html = (await Bun.file(new URL('../src/popup.html', import.meta.url)).text()).replace(/<script[^>]*><\/script>/, '');
  const win = new Window({ url: 'chrome-extension://fw-test/src/popup.html' });
  win.document.write(html);
  const sent = [];
  let reply = status;
  Object.assign(globalThis, {
    window: win, document: win.document,
    chrome: {
      runtime: { id: 'fw-test', sendMessage: async (msg) => { sent.push(msg); return msg.type === 'status' ? structuredClone(reply) : { ok: true }; } },
      tabs: { query: async () => [{ id: 1, url: 'https://example.com/' }], create: async () => {} },
      permissions: { contains: async () => true },
      storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
    },
  });
  await import(`../src/popup.js?${tag}`);
  await new Promise((r) => setTimeout(r, 30));
  return { doc: win.document, sent, setReply: (r) => { reply = r; } };
}

test('popup: header, Model and Reasoning menus, Mode and Next lines; an update says so before it reloads', async () => {
  const saved = Object.fromEntries(['chrome', 'document', 'window'].map((k) => [k, globalThis[k]]));
  const settings = { enabled: true, newSitesEnabled: true, siteOverrides: {}, levelOverride: 0, modelChoice: 'auto', reasoning: 'auto',
    openRouterDailyUsd: 0.25, anthropicDailyUsd: 5 };
  const config = { settings, hasKey: true, tier: 'gemini', paused: false, origins: ['<all_urls>'], stage: 2, level: 2 };
  const haiku = { model: 'claude-haiku-5-5', provider: 'anthropic', thinking: 'low' };
  const status = { config, anthropicKey: true, words: 0, fetchedAt: 0, version: '0.2.9', channel: 'dev', updated: '0.2.9', updating: '', update: '',
    first: haiku, firstDefault: haiku, recommended: haiku,
    next: { model: 'claude-haiku-5-5', provider: 'anthropic', keyName: 'anthropic', level: 2 },
    lastServed: { model: 'gemini-3.1-flash-lite', provider: 'gemini', keyName: 'main' }, served: { counts: { 'claude-haiku-5-5': 3 } } };
  try {
    const { doc, sent, setReply } = await openPopup('menus', status);
    const text = (id) => doc.getElementById(id).textContent;
    expect(doc.querySelector('h1').textContent).toBe('French Weave 0.2.9 · dev build');
    expect(text('versionInfo')).toBe('Updated to 0.2.9');
    const options = (id) => [...doc.querySelectorAll(`#${id} option`)].map((o) => `${o.disabled ? '!' : ''}${o.textContent}`);
    expect(options('model')).toEqual(['Recommended (Claude Haiku 5.5)', 'Claude Haiku 5.5', 'Gemini 3.1 Flash-Lite',
      'Gemini 3.5 Flash-Lite', 'Gemini 3.8 Flash (paid key)']);
    expect(doc.getElementById('model').value).toBe('auto');
    expect(options('reasoning')).toEqual(['Recommended (low)', 'off', 'low', 'medium', 'high']);
    expect(doc.getElementById('reasoning').value).toBe('auto');
    expect(text('modeInfo')).toBe('Mode: Recommended → Claude Haiku 5.5 · low reasoning · Level 2 (Auto)');
    expect(text('nextInfo')).toBe('Claude Haiku 5.5 (Anthropic), Level 2');
    expect(text('modelInfo')).toBe('Gemini 3.1 Flash-Lite; today: Claude Haiku 5.5 3');
    expect(text('modelNote')).toBe('');
    // "Updated to" stays for this popup after the next status (which no longer carries it).
    setReply({ ...status, updated: '' });
    const reasoning = doc.getElementById('reasoning');
    reasoning.value = 'high';
    reasoning.dispatchEvent(new window.Event('change'));
    await new Promise((r) => setTimeout(r, 20));
    expect(sent.find((m) => m.type === 'save')).toEqual({ type: 'save', settings: { reasoning: 'high' } });
    expect(text('versionInfo')).toBe('Updated to 0.2.9');
    expect(sent.some((m) => m.type === 'applyUpdate')).toBe(false);

    // Without a Claude key and Claude Haiku saved: listed, not pickable, with a note; Gemini runs.
    const gemini = { model: 'gemini-3.1-flash-lite', provider: 'gemini', thinking: 'medium' };
    const none = await openPopup('nokey', { ...status, anthropicKey: false, channel: '', updated: '',
      config: { ...config, settings: { ...settings, modelChoice: HAIKU_CHOICE } }, first: gemini, firstDefault: gemini, recommended: gemini,
      next: { model: 'gemini-3.1-flash-lite', provider: 'gemini', keyName: 'main', level: 2 }, lastServed: null, served: null });
    const haikuOption = none.doc.querySelector(`#model option[value="${HAIKU_CHOICE}"]`);
    expect([haikuOption.textContent, haikuOption.disabled]).toEqual(['Claude Haiku 5.5: needs a Claude key', true]);
    expect(none.doc.querySelector('#model option[value="auto"]').textContent).toBe('Recommended (Gemini 3.1 Flash-Lite)');
    expect(none.doc.getElementById('modelNote').textContent).toContain('Claude Haiku needs a Claude key');
    expect(none.doc.getElementById('modeInfo').textContent).toBe('Mode: Gemini 3.1 Flash-Lite · medium reasoning · Level 2 (Auto)');
    expect(none.doc.querySelector('h1').textContent).toBe('French Weave 0.2.9');
    expect(none.doc.getElementById('versionInfo').textContent).toBe('');

    // A newer copy on disk: "Updating to 0.2.10…" first, then the popup asks for the reload.
    const upd = await openPopup('updating', { ...status, updated: '', updating: '0.2.10' });
    expect(upd.doc.getElementById('versionInfo').textContent).toBe('Updating to 0.2.10…');
    expect(upd.sent.some((m) => m.type === 'applyUpdate')).toBe(false);
    await new Promise((r) => setTimeout(r, 1600));
    expect(upd.sent.filter((m) => m.type === 'applyUpdate')).toHaveLength(1);
  } finally {
    Object.assign(globalThis, saved);
  }
}, 10000);

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

test('worker: Claude Haiku at Level 3 with the chosen reasoning; menus follow keys; a model change resets reasoning', async () => {
  const saved = Object.fromEntries(['chrome', 'fetch'].map((k) => [k, globalThis[k]]));
  const calls = [];
  globalThis.fetch = async (url, init) => {
    if (String(url).startsWith('chrome-extension://')) return { ok: true, json: async () => ({ version: '0.2.9' }) };
    const body = JSON.parse(init.body);
    const user = url === ANTHROPIC_URL ? body.messages.at(-1).content : body.contents[0].parts[0].text;
    const items = JSON.parse(user.replace(/^[^[]*/, '').replace(/\n[^\]]*$/, ''));
    const keep = JSON.stringify({ passages: items.map(({ id, candidates }) => ({ id, topic: 'ok', keep: (candidates || []).map((c) => c.n) })) });
    if (url === ANTHROPIC_URL) {
      calls.push(`anthropic ${body.thinking.type} ${body.output_config.effort}`);
      return { ok: true, status: 200, text: async () => JSON.stringify({ type: 'message', stop_reason: 'end_turn',
        usage: { input_tokens: 100, output_tokens: 10 }, content: [{ type: 'text', text: keep }] }) };
    }
    calls.push(`${String(url).slice(API_BASE.length).split(':')[0]} ${body.generationConfig.thinkingConfig?.thinkingLevel}`);
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: keep }] } }] }) };
  };
  const data = { settings: { enabled: true, newSitesEnabled: true, levelOverride: 3, modelChoice: 'auto', reasoning: 'high' },
    apiKey: 'synthetic-main', anthropicKey: 'synthetic-anthropic',
    [STATE_KEY]: { version: 't.1', stage: 3, paused: false, sites: 'all', fetchedAt: Date.now(), words: WORDS } };
  const ask = async (dispatch, text) => {
    const { revision } = await dispatch({ type: 'config' }, PAGE);
    return dispatch({ type: 'swaps', revision, items: [{ key: `${revision}:${hashKey(text)}`, text }] }, PAGE);
  };
  try {
    const { dispatch } = await startWorker(data, 'haiku-worker');
    let st = await dispatch({ type: 'status' }, POPUP);
    expect(st).toMatchObject({ first: { model: 'claude-haiku-5-5', provider: 'anthropic', thinking: 'high' },
      firstDefault: { model: 'claude-haiku-5-5', thinking: 'low' }, recommended: { model: 'claude-haiku-5-5' },
      next: { model: 'claude-haiku-5-5', provider: 'anthropic', keyName: 'anthropic', level: 3 }, version: '0.2.9', channel: '' });
    expect(modeText(st)).toBe('Mode: Recommended → Claude Haiku 5.5 · high reasoning · Level 3 (set here)');
    expect(JSON.stringify(st)).not.toContain('synthetic'); // no key reaches the popup

    expect((await ask(dispatch, 'The cat and the dog sleep all day long in the sun.')).error).toBeUndefined();
    expect(calls).toEqual(['anthropic adaptive high']);
    expect((await dispatch({ type: 'status' }, POPUP)).lastServed).toMatchObject({ model: 'claude-haiku-5-5', provider: 'anthropic' });
    // Reasoning off: thinking disabled.
    await dispatch({ type: 'save', settings: { reasoning: 'off' } }, POPUP);
    calls.length = 0;
    await ask(dispatch, 'The bird and the fish swim all day long in the lake.');
    expect(calls).toEqual(['anthropic disabled low']);

    // A Gemini model picked: "off" isn't one of its levels, so reasoning goes back to Recommended.
    await dispatch({ type: 'save', settings: { modelChoice: 'gemini-3.5-flash-lite' } }, POPUP);
    expect(data.settings).toMatchObject({ modelChoice: 'gemini-3.5-flash-lite', reasoning: 'auto' });
    st = await dispatch({ type: 'status' }, POPUP);
    expect(st.first).toEqual({ model: 'gemini-3.5-flash-lite', provider: 'gemini', thinking: 'low' });
    expect(st.next).toEqual({ model: 'gemini-3.5-flash-lite', provider: 'gemini', keyName: 'main', level: 3 });
    // A level it takes stays when the model changes again to one that also takes it.
    await dispatch({ type: 'save', settings: { reasoning: 'minimal' } }, POPUP);
    await dispatch({ type: 'save', settings: { modelChoice: 'gemini-3.1-flash-lite' } }, POPUP);
    expect(data.settings.reasoning).toBe('minimal');
    calls.length = 0;
    await ask(dispatch, 'The cow and the goat eat all day long in the field.');
    expect(calls).toEqual(['gemini-3.1-flash-lite minimal']);

    // Claude Haiku picked, its key capped at 0: no Haiku step, Gemini next.
    await dispatch({ type: 'save', settings: { modelChoice: HAIKU_CHOICE, anthropicDailyUsd: 0 } }, POPUP);
    expect((await dispatch({ type: 'status' }, POPUP)).next).toMatchObject({ model: 'gemini-3.1-flash-lite', keyName: 'main' });
    // Only an OpenRouter key: Haiku through OpenRouter.
    await dispatch({ type: 'save', anthropicKey: '', openRouterKey: 'synthetic-openrouter', settings: { anthropicDailyUsd: 5 } }, POPUP);
    expect((await dispatch({ type: 'status' }, POPUP)).next).toEqual({ model: 'anthropic/claude-haiku-5.5', provider: 'openrouter', keyName: 'openrouter', level: 3 });
    // The main key out of today's quota for the first Gemini model: the backup key, else the next model.
    await dispatch({ type: 'save', openRouterKey: '', backupKey: 'synthetic-backup' }, POPUP);
    data.dailyQuota = { 'gemini-3.1-flash-lite': Date.now() + 3600000 };
    st = await dispatch({ type: 'status' }, POPUP);
    expect(st.next).toMatchObject({ model: 'gemini-3.1-flash-lite', keyName: 'backup' });
    expect(st.recommended).toEqual({ model: 'gemini-3.1-flash-lite', provider: 'gemini', thinking: 'medium' });
    // No Gemini key: the built-in list, no model.
    await dispatch({ type: 'save', apiKey: '', backupKey: '' }, POPUP);
    const local = await dispatch({ type: 'status' }, POPUP);
    expect(local.next).toBeNull();
    expect(nextText(local)).toBe('Built-in list (no model), Level 3');
  } finally {
    Object.assign(globalThis, saved);
  }
}, 30000);

test('worker: "Updated to X" once after an update; the channel from the native host', async () => {
  const saved = Object.fromEntries(['chrome', 'fetch'].map((k) => [k, globalThis[k]]));
  globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: '0.2.9' }) });
  try {
    // Reloaded into 0.2.9 by 0.2.8's update check (no popup version recorded before 0.2.9).
    const a = await startWorker({ settings: { enabled: true }, reloadedFor: '0.2.9' }, 'updated-reload');
    expect((await a.dispatch({ type: 'status' }, POPUP)).updated).toBe('0.2.9');
    expect((await a.dispatch({ type: 'status' }, POPUP)).updated).toBe('');
    // A popup last opened on 0.2.8, now 0.2.9 however it got there (a Chrome restart, the reload arrow).
    const b = await startWorker({ settings: { enabled: true }, popupVersion: '0.2.8' }, 'updated-restart');
    expect((await b.dispatch({ type: 'status' }, POPUP)).updated).toBe('0.2.9');
    expect((await b.dispatch({ type: 'status' }, POPUP)).updated).toBe('');
    // A first install: nothing to announce.
    const c = await startWorker({ settings: { enabled: true } }, 'updated-first');
    expect((await c.dispatch({ type: 'status' }, POPUP)).updated).toBe('');

    // The host says "dev" (plugin from the french-weave-dev marketplace); anything not a plain word is dropped.
    for (const [channel, shown] of [['dev', 'dev'], [undefined, ''], ['<b>x</b>', '']]) {
      const data = { settings: { enabled: true } };
      const w = await startWorker(data, `channel-${shown || 'none'}-${String(channel).length}`, {
        native: async (msg) => (msg.type === 'state' ? { ok: true, version: 'v1', stage: 1, words: WORDS, ...(channel ? { channel } : {}) } : { ok: true }) });
      await w.dispatch({ type: 'syncWords' }, POPUP);
      const st = await w.dispatch({ type: 'status' }, POPUP);
      expect([st.channel, versionText(st)]).toEqual([shown, shown ? `0.2.9 · ${shown} build` : '0.2.9']);
    }
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
