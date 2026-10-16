import { describe, test, expect } from 'bun:test';
import { requestSwaps, attemptsFor } from '../src/engine.js';
import { MODEL_CONFIG } from '../src/model-config.js';
import { OPENROUTER_URL, toOpenRouterBody } from '../src/openrouter.js';
import { API_BASE } from '../src/gemini.js';
import { countOpenRouter, openRouterToday, openRouterBlocked } from '../src/quota.js';
import { openRouterText } from '../src/modelerror.js';
import { memoryStorage } from '../src/cache.js';
import { hashKey } from '../src/hash.js';
import { STATE_KEY } from '../src/hostsource.js';

const CHAIN = MODEL_CONFIG.default.chain;
const WORDS = [{ fr: 'et', en: 'and', hint: 'ay', status: 'active' }];
const BATCH = [{ id: 'a', text: 'The cat and the dog sleep all day long.' }];
const KEYS = { main: 'synthetic-main', backup: 'synthetic-backup', openrouter: 'synthetic-openrouter' };
const DAY = 'GenerateRequestsPerDayPerProjectPerModel-FreeTier';
const MINUTE = 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier';
const quota429 = (quotaId) => ({ ok: false, status: 429, text: async () => JSON.stringify({ error: { status: 'RESOURCE_EXHAUSTED', details: [
  { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId, quotaValue: '500' }] },
  { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: quotaId === DAY ? '3600s' : '30s' }] } }) });
const status = (code) => ({ ok: false, status: code, text: async () => '{}' });
const keepAll = (body) => {
  const items = JSON.parse(body.contents?.[0].parts[0].text.replace(/^Passages:\n/, '') || '[]');
  return JSON.stringify({ passages: items.map(({ id, candidates }) => ({ id, topic: 'ok', keep: candidates.map((c) => c.n) })) });
};
const geminiOk = (body) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: keepAll(body) }] } }] }) });
const routerOk = (init, cost = 0.0006) => {
  const sent = JSON.parse(init.body);
  const user = sent.messages.at(-1).content;
  return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: keepAll({ contents: [{ parts: [{ text: user }] }] }) } }], usage: { cost } }) };
};

// Who each request went to: "<model> <key>" for Gemini, "openrouter <model> <key>" for OpenRouter.
function recorder(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (url === OPENROUTER_URL) {
      const who = `openrouter ${JSON.parse(init.body).model} ${init.headers.Authorization.replace('Bearer ', '')}`;
      calls.push(who);
      return answer(who, init);
    }
    const who = `${url.slice(API_BASE.length).split(':')[0]} ${init.headers['x-goog-api-key']}`;
    calls.push(who);
    return answer(who, init);
  };
  return { calls, fetchImpl };
}
const run = (fetchImpl, extra = {}) => requestSwaps({ keys: KEYS, chain: CHAIN, design: 'candidates', level: 2, batch: BATCH, words: WORDS,
  language: 'French', fetchImpl, ...extra });

describe('model chain', () => {
  test('order: main key, backup key, then the next model, OpenRouter last', async () => {
    const { calls, fetchImpl } = recorder((who, init) => (who.startsWith('openrouter') ? routerOk(init) : quota429(MINUTE)));
    const spend = [];
    const r = await run(fetchImpl, { onOpenRouter: async (x) => { spend.push(x); } });
    expect(calls).toEqual([
      'gemini-3.1-flash-lite synthetic-main', 'gemini-3.1-flash-lite synthetic-backup',
      'gemini-3.5-flash-lite synthetic-main', 'gemini-3.5-flash-lite synthetic-backup',
      'openrouter openai/gpt-6-luna synthetic-openrouter',
    ]);
    expect(r).toMatchObject({ model: 'openai/gpt-6-luna', provider: 'openrouter', keyName: 'openrouter', step: 3, costUsd: 0.0006 });
    expect(r.results.a.map((s) => s.f)).toEqual(['et']);
    expect(spend).toEqual([{ costUsd: 0.0006, status: 200 }]);
    expect(attemptsFor(CHAIN, { main: 'k' }).map((a) => a.slot)).toEqual(['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']);
  });
  test('the first answer wins; a per-day 429 is kept per key and model', async () => {
    const daily = new Map();
    const { calls, fetchImpl } = recorder((who, init) => (who === 'gemini-3.1-flash-lite synthetic-main' ? quota429(DAY) : geminiOk(JSON.parse(init.body))));
    const r = await run(fetchImpl, { daily });
    expect(calls).toEqual(['gemini-3.1-flash-lite synthetic-main', 'gemini-3.1-flash-lite synthetic-backup']);
    expect(r).toMatchObject({ model: 'gemini-3.1-flash-lite', keyName: 'backup', step: 1 });
    expect([...daily.keys()]).toEqual(['gemini-3.1-flash-lite']); // the main key's slot only
    calls.length = 0;
    await run(fetchImpl, { daily });
    expect(calls).toEqual(['gemini-3.1-flash-lite synthetic-backup']); // the spent main key is skipped
  });
  test('a busy or slow model moves to the next step without trying the backup key on it', async () => {
    for (const fail of [() => status(503), () => { throw new DOMException('timed out', 'TimeoutError'); }]) {
      const cooldown = new Map();
      const { calls, fetchImpl } = recorder((who, init) => (who.startsWith('gemini-3.1') ? fail() : geminiOk(JSON.parse(init.body))));
      const r = await run(fetchImpl, { cooldown });
      expect(calls).toEqual(['gemini-3.1-flash-lite synthetic-main', 'gemini-3.5-flash-lite synthetic-main']);
      expect(r).toMatchObject({ model: 'gemini-3.5-flash-lite', step: 2 });
      expect(cooldown.has('gemini-3.1-flash-lite') && cooldown.has('backup:gemini-3.1-flash-lite')).toBe(true);
    }
  });
  test('without an OpenRouter key (or past its cap) OpenRouter is never called', async () => {
    const { calls, fetchImpl } = recorder(() => quota429(MINUTE));
    const error = await run(fetchImpl, { keys: { main: KEYS.main } }).catch((e) => e);
    expect(calls).toEqual(['gemini-3.1-flash-lite synthetic-main', 'gemini-3.5-flash-lite synthetic-main']);
    expect(error).toMatchObject({ kind: 'rate', status: 429 });
  });
  test('a 402 is reported to the worker and the batch fails', async () => {
    const seen = [];
    const { fetchImpl } = recorder((who) => (who.startsWith('openrouter') ? status(402) : quota429(MINUTE)));
    const error = await run(fetchImpl, { onOpenRouter: async (x) => { seen.push(x); } }).catch((e) => e);
    expect(seen).toEqual([{ costUsd: 0, status: 402 }]);
    expect(error.message).toContain('OpenRouter openai/gpt-6-luna: HTTP 402');
    expect(error.kind).toBe('rate'); // the popup names the Gemini failure; the OpenRouter line says why it stopped
  });
  test('a batch without candidates makes no request', async () => {
    const { calls, fetchImpl } = recorder(() => status(500));
    const r = await run(fetchImpl, { batch: [{ id: 'a', text: 'The cat sleeps all day long here.' }] });
    expect(calls).toEqual([]);
    expect(r).toMatchObject({ skipped: true, results: { a: [] } });
  });
  test('OpenRouter body: schema as response_format, required parameters, reasoning off, usage; Gemma gets no thinking', async () => {
    const gemini = { systemInstruction: { parts: [{ text: 'S' }] }, contents: [{ parts: [{ text: 'U' }] }],
      generationConfig: { responseMimeType: 'application/json', responseSchema: { type: 'object' }, thinkingConfig: { thinkingLevel: 'low' } } };
    expect(toOpenRouterBody('openai/gpt-6-luna', gemini, { thinking: 'off' })).toEqual({
      model: 'openai/gpt-6-luna',
      messages: [{ role: 'system', content: 'S' }, { role: 'user', content: 'U' }],
      usage: { include: true },
      reasoning: { enabled: false },
      provider: { require_parameters: true },
      response_format: { type: 'json_schema', json_schema: { name: 'weave', strict: false, schema: { type: 'object' } } },
    });
    let sent = null;
    const fetchImpl = async (url, init) => { sent = JSON.parse(init.body); return status(500); };
    await requestSwaps({ keys: { main: 'k' }, chain: [{ provider: 'gemini', model: 'gemma-4-31b-it', thinking: 'low', timeoutMs: 1000 }],
      design: 'candidates', level: 2, batch: BATCH, words: WORDS, fetchImpl }).catch(() => {});
    expect(sent.generationConfig.thinkingConfig).toBeUndefined();
  });
});

describe('OpenRouter spend', () => {
  test('counted per day; the cap and a 402 stop it until tomorrow; the popup says which', async () => {
    const storage = memoryStorage();
    await countOpenRouter(storage, { costUsd: 0.2, status: 200 }, '2026-10-16');
    expect(openRouterBlocked(await openRouterToday(storage, '2026-10-16'), 0.25)).toBe('');
    await countOpenRouter(storage, { costUsd: 0.06, status: 200 }, '2026-10-16');
    const today = await openRouterToday(storage, '2026-10-16');
    expect(today.usd).toBeCloseTo(0.26);
    expect(openRouterBlocked(today, 0.25)).toBe('cap');
    expect(openRouterBlocked(await openRouterToday(storage, '2026-10-17'), 0.25)).toBe(''); // a new day
    await countOpenRouter(storage, { costUsd: 0, status: 402 }, '2026-10-17');
    const broke = await openRouterToday(storage, '2026-10-17');
    expect(openRouterBlocked(broke, 5)).toBe('credits');
    expect(openRouterText({ openRouterKey: true, openRouter: { ...today, blocked: 'cap' } }, 0.25))
      .toBe('OpenRouter today: $0.2600 of $0.25. Daily cap reached: stopped until tomorrow.');
    expect(openRouterText({ openRouterKey: true, openRouter: { ...broke, blocked: 'credits' } }, 0.25)).toContain('Credits used up (402)');
    expect(openRouterText({ openRouterKey: false }, 0.25)).toContain('Optional');
  });

  // The real worker: OpenRouter after Gemini, spend kept, the cap and a 402 stop it, the title guard sends nothing.
  test('worker: spend cap, 402 and the title guard', async () => {
    const saved = Object.fromEntries(['chrome', 'fetch'].map((k) => [k, globalThis[k]]));
    const data = {
      settings: { enabled: true, newSitesEnabled: true },
      apiKey: 'synthetic-main', openRouterKey: 'synthetic-openrouter-key',
      [STATE_KEY]: { version: 't.1', stage: 1, paused: false, sites: 'all', fetchedAt: Date.now(), words: WORDS },
    };
    const calls = [];
    let router = (init) => routerOk(init, 0.2);
    const on = (arr = []) => ({ addListener: (fn) => arr.push(fn) });
    const listeners = [];
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
      runtime: { id: 'fw-test', getURL: (path) => `chrome-extension://fw-test/${path}`, getManifest: () => ({ version: '0.2.1' }),
        onMessage: on(listeners), onInstalled: on(), onStartup: on(), sendNativeMessage: async () => ({ ok: false }) },
      action: { setBadgeText: async () => {} },
      tabs: { query: async () => [], sendMessage: async () => {} },
      alarms: { create: async () => {}, onAlarm: on() },
      permissions: { getAll: async () => ({ origins: ['<all_urls>'] }), onAdded: on(), onRemoved: on() },
      scripting: { getRegisteredContentScripts: async () => [], updateContentScripts: async () => {}, unregisterContentScripts: async () => {}, registerContentScripts: async () => {} },
    };
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('chrome-extension://')) return { ok: true, json: async () => ({ version: '0.2.1' }) };
      if (url === OPENROUTER_URL) { calls.push('openrouter'); expect(init.headers.Authorization).toBe('Bearer synthetic-openrouter-key'); return router(init); }
      calls.push('gemini');
      return quota429(DAY);
    };
    try {
      await import('../src/background.js?chain');
      const dispatch = (msg, sender) => new Promise((done) => { if (!listeners.some((fn) => fn(msg, sender, done))) done(undefined); });
      const popup = { id: 'fw-test', url: 'chrome-extension://fw-test/src/popup.html' };
      const page = (title) => ({ id: 'fw-test', tab: { id: 1, title }, url: 'https://example.com/article' });
      const ask = async (text, title = 'Cats') => {
        const { revision } = await dispatch({ type: 'config' }, page(title));
        return dispatch({ type: 'swaps', revision, items: [{ key: `${revision}:${hashKey(text)}`, text }] }, page(title));
      };
      // Both Gemini steps are spent for the day; OpenRouter answers and costs $0.20.
      const first = await ask('The cat and the dog sleep all day long.');
      expect(calls).toEqual(['gemini', 'gemini', 'openrouter']);
      expect(Object.values(first.results)[0].map((s) => s.f)).toEqual(['et']);
      let st = await dispatch({ type: 'status' }, popup);
      expect(st.modelStatus).toMatchObject({ model: 'openai/gpt-6-luna', provider: 'openrouter' });
      expect(st.lastServed).toMatchObject({ model: 'openai/gpt-6-luna', keyName: 'openrouter' });
      expect(st.openRouter).toMatchObject({ usd: 0.2, blocked: '' });
      expect(st.served.counts).toEqual({ 'openai/gpt-6-luna': 1 });
      expect(JSON.stringify(st)).not.toContain('synthetic-openrouter-key');
      // $0.40 is past the $0.25 cap: the next batch makes no request at all.
      await ask('The bird and the fish swim all day long.');
      expect(calls).toEqual(['gemini', 'gemini', 'openrouter', 'openrouter']);
      st = await dispatch({ type: 'status' }, popup);
      expect(st.openRouter).toMatchObject({ usd: 0.4, blocked: 'cap' });
      const capped = await ask('The cow and the goat eat all day long.');
      expect(calls.length).toBe(4);
      expect(capped.error).toMatch(/^Daily Gemini limit reached/);
      expect((await dispatch({ type: 'status' }, popup)).lastServed.model).toBe('openai/gpt-6-luna'); // kept through the failure
      // A higher cap lets it run again until a 402 says the credits are gone.
      await dispatch({ type: 'save', settings: { openRouterDailyUsd: 5 } }, popup);
      router = () => status(402);
      await ask('The fox and the hen run all day long.');
      expect(calls.length).toBe(5);
      st = await dispatch({ type: 'status' }, popup);
      expect(st.openRouter.blocked).toBe('credits');
      await ask('The owl and the bat fly all night long.');
      expect(calls.length).toBe(5);
      // Title guard: a money page gets no swaps and no request, not even from the cache.
      const guarded = await ask('The cat and the dog sleep all day long.', 'The best index funds to buy this year');
      expect(Object.values(guarded.results)).toEqual([[]]);
      expect(calls.length).toBe(5);
    } finally {
      Object.assign(globalThis, saved);
    }
  }, 30000);
});
