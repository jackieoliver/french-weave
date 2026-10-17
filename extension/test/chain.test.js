import { describe, test, expect } from 'bun:test';
import { requestSwaps, attemptsFor } from '../src/engine.js';
import { MODEL_CONFIG, configFor } from '../src/model-config.js';
import { RESPONSE_SCHEMA } from '../src/candidates.js';
import { OPENROUTER_URL, toOpenRouterBody } from '../src/openrouter.js';
import { ANTHROPIC_URL } from '../src/anthropic.js';
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

// Who each request went to: "<model> <key>" for Gemini, "openrouter <model> <key>" for OpenRouter, "anthropic <model> <key>"
// for Anthropic.
function recorder(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    if (url === ANTHROPIC_URL) {
      const who = `anthropic ${JSON.parse(init.body).model} ${init.headers['x-api-key']}`;
      calls.push(who);
      return answer(who, init);
    }
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
// A Messages API reply that keeps every candidate, with a thinking block first as Haiku 5.5 sends one.
const anthropicOk = (init, usage = { input_tokens: 4000, output_tokens: 600, output_tokens_details: { thinking_tokens: 200 } }) => {
  const user = JSON.parse(init.body).messages.at(-1).content;
  return { ok: true, status: 200, text: async () => JSON.stringify({ type: 'message', stop_reason: 'end_turn', usage,
    content: [{ type: 'thinking', thinking: '', signature: 's' }, { type: 'text', text: keepAll({ contents: [{ parts: [{ text: user }] }] }) }] }) };
};
const lowCredit = () => ({ ok: false, status: 400, headers: { get: () => null }, text: async () => JSON.stringify({ type: 'error',
  error: { type: 'invalid_request_error', message: 'Your credit balance is too low to access the Anthropic API.' } }) });
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
  test('a refused backup key is named as the backup key; the main key stays trusted', async () => {
    const badKey = { ok: false, status: 400, text: async () => JSON.stringify({ error: { status: 'INVALID_ARGUMENT', message: 'API key not valid.' } }) };
    const { fetchImpl } = recorder((who) => (who.endsWith('synthetic-backup') ? badKey : quota429(MINUTE)));
    const error = await run(fetchImpl, { keys: { main: KEYS.main, backup: KEYS.backup } }).catch((e) => e);
    expect(error).toMatchObject({ kind: 'key', status: 400, keyName: 'backup' });
  });
  test('Gemini spent for the day: an OpenRouter failure keeps the daily notice, and its short cooldown sets the retry', async () => {
    const daily = new Map(attemptsFor(CHAIN, KEYS).filter((a) => a.step.provider === 'gemini').map((a) => [a.slot, Date.now() + 3600000]));
    const seen = [];
    const onOpenRouter = async (x) => { seen.push(x); };
    const refused = await run(recorder(() => status(401)).fetchImpl, { daily, onOpenRouter }).catch((e) => e);
    expect(refused).toMatchObject({ kind: 'daily', daily: true });
    expect(seen).toEqual([{ costUsd: 0, status: 401 }]);
    const busy = await run(recorder(() => quota429(MINUTE)).fetchImpl, { daily, onOpenRouter }).catch((e) => e);
    expect(busy.kind).toBe('daily');
    expect(busy.retryAfterMs).toBeLessThanOrEqual(60000); // OpenRouter's 429 cooldown, not Google's hour
    const broken = await run(recorder(() => status(500)).fetchImpl, { daily, onOpenRouter, cooldown: new Map() }).catch((e) => e);
    expect(broken.kind).toBe('daily');
    expect(broken.retryAfterMs).toBeLessThanOrEqual(30000); // a 500 sets no cooldown here, and may pass in seconds
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

// A fake Chrome around the real worker (background.js), storage in data; returns the message dispatcher.
async function startWorker(data, tag) {
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
  await import(`../src/background.js?${tag}`);
  return (msg, sender) => new Promise((done) => { if (!listeners.some((fn) => fn(msg, sender, done))) done(undefined); });
}

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
    expect(openRouterText({ openRouterKey: false }, 0.25)).toContain('Claude Haiku 5.5 goes first at Levels 1-2');
    await countOpenRouter(storage, { costUsd: 0, status: 401 }, '2026-10-18');
    expect(openRouterBlocked(await openRouterToday(storage, '2026-10-18'), 5)).toBe('key');
  });

  // The real worker: OpenRouter after Gemini, spend kept, the cap and a 402 stop it, the title guard sends nothing.
  test('worker: spend cap, 402 and the title guard', async () => {
    const saved = Object.fromEntries(['chrome', 'fetch'].map((k) => [k, globalThis[k]]));
    // Level 3: the Gemini chain with gpt-6-luna last (Levels 1-2 put Claude Haiku first; tested below).
    const data = {
      settings: { enabled: true, newSitesEnabled: true },
      apiKey: 'synthetic-main', openRouterKey: 'synthetic-openrouter-key',
      [STATE_KEY]: { version: 't.1', stage: 3, paused: false, sites: 'all', fetchedAt: Date.now(), words: WORDS },
    };
    const calls = [];
    let router = (init) => routerOk(init, 0.2);
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('chrome-extension://')) return { ok: true, json: async () => ({ version: '0.2.1' }) };
      if (url === OPENROUTER_URL) { calls.push('openrouter'); expect(init.headers.Authorization).toBe('Bearer synthetic-openrouter-key'); return router(init); }
      calls.push('gemini');
      return quota429(DAY);
    };
    try {
      const dispatch = await startWorker(data, 'chain');
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

  test('worker: each Gemini key has its own 500-call cap; a spent main key leaves the backup in the chain', async () => {
    const saved = Object.fromEntries(['chrome', 'fetch'].map((k) => [k, globalThis[k]]));
    const day = new Date().toLocaleDateString('en-CA');
    const data = {
      settings: { enabled: true, newSitesEnabled: true },
      apiKey: 'synthetic-main', backupKey: 'synthetic-backup', modelCalls: { day, count: 500 },
      [STATE_KEY]: { version: 't.1', stage: 1, paused: false, sites: 'all', fetchedAt: Date.now(), words: WORDS },
    };
    const used = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('chrome-extension://')) return { ok: true, json: async () => ({ version: '0.2.1' }) };
      used.push(init.headers['x-goog-api-key']);
      return geminiOk(JSON.parse(init.body));
    };
    try {
      const dispatch = await startWorker(data, 'percap');
      const page = { id: 'fw-test', tab: { id: 1, title: 'Cats' }, url: 'https://example.com/article' };
      const ask = async (text) => {
        const { revision } = await dispatch({ type: 'config' }, page);
        return dispatch({ type: 'swaps', revision, items: [{ key: `${revision}:${hashKey(text)}`, text }] }, page);
      };
      const r = await ask('The cat and the dog sleep all day long.');
      expect(Object.values(r.results)[0].map((s) => s.f)).toEqual(['et']);
      expect(used).toEqual(['synthetic-backup']);
      expect(data.modelCallsBackup).toEqual({ day, count: 1 });
      data.modelCallsBackup = { day, count: 500 };
      const capped = await ask('The bird and the fish swim all day long.');
      expect(capped.error).toBe('Daily limit of 500 model calls per key reached; French resumes tomorrow');
      expect(used.length).toBe(1);
      // The same key pasted as the backup is one key with one cap, not a way past it.
      data.backupKey = 'synthetic-main';
      const same = await ask('The cow and the goat eat all day long.');
      expect(same.error).toBe('Daily limit of 500 model calls reached; French resumes tomorrow');
      // Only a backup key: its own cap, and the cap notice (not "rejected the key") once it is spent.
      delete data.apiKey;
      data.backupKey = 'synthetic-backup';
      const only = await ask('The fox and the hen run all day long.');
      expect(only.error).toBe('Daily limit of 500 model calls per key reached; French resumes tomorrow');
      expect(used.length).toBe(1);
    } finally {
      Object.assign(globalThis, saved);
    }
  }, 30000);

  test('worker: backup and OpenRouter keys from setup join the chain; a pasted key wins over setup\'s', async () => {
    const saved = Object.fromEntries(['chrome', 'fetch'].map((k) => [k, globalThis[k]]));
    const data = { // Level 3: OpenRouter only as the last step
      settings: { enabled: true, newSitesEnabled: true },
      [STATE_KEY]: { version: 't.1', stage: 3, paused: false, sites: 'all', fetchedAt: Date.now(), words: WORDS },
    };
    const used = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('chrome-extension://')) return { ok: true, json: async () => ({ version: '0.2.1' }) };
      if (url === OPENROUTER_URL) { used.push(init.headers.Authorization); return routerOk(init); }
      const key = init.headers['x-goog-api-key'];
      used.push(key);
      return key === 'synthetic-pasted-backup' ? geminiOk(JSON.parse(init.body)) : quota429(DAY);
    };
    try {
      const dispatch = await startWorker(data, 'setupkeys');
      const popup = { id: 'fw-test', url: 'chrome-extension://fw-test/src/popup.html' };
      const page = { id: 'fw-test', tab: { id: 1, title: 'Cats' }, url: 'https://example.com/article' };
      const ask = async (text) => {
        const { revision } = await dispatch({ type: 'config' }, page);
        return dispatch({ type: 'swaps', revision, items: [{ key: `${revision}:${hashKey(text)}`, text }] }, page);
      };
      globalThis.chrome.runtime.sendNativeMessage = async () => ({ ok: true, version: 't.2', stage: 3, words: WORDS,
        geminiKey: 'synthetic-main', geminiBackupKey: 'synthetic-setup-backup', openRouterKey: 'synthetic-setup-router' });
      expect((await dispatch({ type: 'syncWords' }, popup)).ok).toBe(true);
      const st = await dispatch({ type: 'status' }, popup);
      expect(st).toMatchObject({ hostKey: true, hostBackupKey: true, hostOpenRouterKey: true, backupKey: false, openRouterKey: false });
      expect(JSON.stringify(st)).not.toContain('synthetic');
      // Both Gemini keys are spent for the day on every step; setup's OpenRouter key answers.
      const first = await ask('The cat and the dog sleep all day long.');
      expect(Object.values(first.results)[0].map((s) => s.f)).toEqual(['et']);
      expect(used).toContain('synthetic-main');
      expect(used).toContain('synthetic-setup-backup');
      expect(used.at(-1)).toBe('Bearer synthetic-setup-router');
      // A pasted backup replaces setup's for the backup slot.
      await dispatch({ type: 'save', backupKey: 'synthetic-pasted-backup' }, popup);
      used.length = 0;
      const second = await ask('The bird and the fish swim all day long.');
      expect(Object.values(second.results)[0]).toBeDefined();
      expect(used).toContain('synthetic-pasted-backup');
      expect(used).not.toContain('synthetic-setup-backup');
    } finally {
      Object.assign(globalThis, saved);
    }
  }, 30000);
});

// Levels 1-2 on Auto: Claude Haiku 5.5 through OpenRouter first, when an OpenRouter key (and no Anthropic key) is set
// and today's spend is under the cap; the Gemini chain follows. Levels 3-4 and readers without an OpenRouter key keep
// the chain as before. The direct Anthropic step is tested in the next block.
const HAIKU = 'anthropic/claude-haiku-5.5';
const ROUTER_ONLY = { openrouter: true };
const TODAY = ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite', 'openai/gpt-6-luna'];

describe('Claude Haiku first at Levels 1-2', () => {
  test('chain selection: Haiku first at Levels 1-2 in every language; Levels 3-4 and a popup pick unchanged', () => {
    for (const language of ['French', 'Spanish', 'German', 'Italian', 'Portuguese', 'Japanese', 'Korean']) {
      for (const level of [1, 2]) {
        const { design, chain } = configFor(language, 'auto', undefined, level, ROUTER_ONLY);
        expect(design).toBe('candidates');
        expect(chain.map((s) => s.model)).toEqual([HAIKU, ...TODAY]);
        expect(chain[0]).toEqual({ provider: 'openrouter', model: HAIKU, thinking: 'low', timeoutMs: 35000 });
      }
      for (const level of [3, 4, 0, undefined]) expect(configFor(language, 'auto', undefined, level, ROUTER_ONLY).chain).toEqual(CHAIN);
      expect(configFor(language, 'auto', undefined, 1).chain).toEqual(CHAIN); // no paid key: no Haiku step
    }
    // A Gemini model picked in the popup goes first, as before, with no Haiku step.
    expect(configFor('French', 'gemini-3.5-flash-lite', undefined, 1, ROUTER_ONLY).chain.map((s) => s.model))
      .toEqual(['gemini-3.5-flash-lite', 'gemini-3.1-flash-lite', 'openai/gpt-6-luna']);
  });

  test('with a key: Haiku first, "low" sent as reasoning effort, 35 s timeout, and its reply parses with the schema', async () => {
    const chain = configFor('French', 'auto', undefined, 1, ROUTER_ONLY).chain;
    const { calls, fetchImpl } = recorder((who, init) => (who.startsWith('openrouter') ? routerOk(init, 0.0018) : geminiOk(JSON.parse(init.body))));
    const sent = [];
    const timeouts = [];
    const real = AbortSignal.timeout;
    AbortSignal.timeout = (ms) => { timeouts.push(ms); return real.call(AbortSignal, ms); };
    let r;
    try {
      r = await run(async (url, init) => { if (url === OPENROUTER_URL) sent.push(JSON.parse(init.body)); return fetchImpl(url, init); }, { chain, level: 1 });
    } finally {
      AbortSignal.timeout = real;
    }
    expect(calls).toEqual([`openrouter ${HAIKU} synthetic-openrouter`]);
    expect(timeouts).toEqual([35000]);
    expect(sent[0].reasoning).toEqual({ effort: 'low' });
    expect(sent[0].response_format).toEqual({ type: 'json_schema', json_schema: { name: 'weave', strict: false, schema: RESPONSE_SCHEMA } });
    expect(sent[0].provider).toEqual({ require_parameters: true });
    expect(r).toMatchObject({ model: HAIKU, provider: 'openrouter', keyName: 'openrouter', step: 1, costUsd: 0.0018 });
    expect(r.results.a.map((s) => s.f)).toEqual(['et']);
  });

  test('without a key: the Gemini chain as today', async () => {
    const chain = configFor('French', 'auto', undefined, 2, ROUTER_ONLY).chain;
    const { calls, fetchImpl } = recorder(() => quota429(MINUTE));
    await run(fetchImpl, { chain, keys: { main: KEYS.main, backup: KEYS.backup } }).catch(() => {});
    expect(calls).toEqual(['gemini-3.1-flash-lite synthetic-main', 'gemini-3.1-flash-lite synthetic-backup',
      'gemini-3.5-flash-lite synthetic-main', 'gemini-3.5-flash-lite synthetic-backup']);
  });

  test('Haiku slow or busy: the Gemini chain answers; out of credits: no other OpenRouter step that batch', async () => {
    const chain = configFor('French', 'auto', undefined, 1, ROUTER_ONLY).chain;
    for (const fail of [() => { throw new DOMException('timed out', 'TimeoutError'); }, () => status(503)]) {
      const cooldown = new Map();
      const { calls, fetchImpl } = recorder((who, init) => (who.startsWith('openrouter') ? fail() : geminiOk(JSON.parse(init.body))));
      const r = await run(fetchImpl, { chain, cooldown });
      expect(calls).toEqual([`openrouter ${HAIKU} synthetic-openrouter`, 'gemini-3.1-flash-lite synthetic-main']);
      expect(r).toMatchObject({ model: 'gemini-3.1-flash-lite', step: 2 });
      expect(cooldown.get(`openrouter:${HAIKU}`)).toBeGreaterThan(Date.now()); // the next batches skip Haiku for a while
    }
    const seen = [];
    const { calls, fetchImpl } = recorder((who) => (who.startsWith('openrouter') ? status(402) : quota429(MINUTE)));
    await run(fetchImpl, { chain, onOpenRouter: async (x) => { seen.push(x); } }).catch(() => {});
    expect(calls.filter((c) => c.startsWith('openrouter'))).toEqual([`openrouter ${HAIKU} synthetic-openrouter`]);
    expect(seen).toEqual([{ costUsd: 0, status: 402 }]);
  });

  test('worker: Haiku first at Levels 1-2 until the spend cap; Level 3 and no key use the Gemini chain', async () => {
    const saved = Object.fromEntries(['chrome', 'fetch'].map((k) => [k, globalThis[k]]));
    const calls = [];
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('chrome-extension://')) return { ok: true, json: async () => ({ version: '0.2.1' }) };
      if (url === OPENROUTER_URL) { calls.push(JSON.parse(init.body).model); return routerOk(init, 0.2); }
      calls.push(url.slice(API_BASE.length).split(':')[0]);
      return geminiOk(JSON.parse(init.body));
    };
    const page = { id: 'fw-test', tab: { id: 1, title: 'Cats' }, url: 'https://example.com/article' };
    const popup = { id: 'fw-test', url: 'chrome-extension://fw-test/src/popup.html' };
    const asker = (dispatch) => async (text) => {
      const { revision } = await dispatch({ type: 'config' }, page);
      return dispatch({ type: 'swaps', revision, items: [{ key: `${revision}:${hashKey(text)}`, text }] }, page);
    };
    const state = (stage) => ({ version: 't.1', stage, paused: false, sites: 'all', fetchedAt: Date.now(), words: WORDS });
    try {
      // Level 1 (Claude Code stage 1) with an OpenRouter key.
      let dispatch = await startWorker({ settings: { enabled: true, newSitesEnabled: true }, apiKey: 'synthetic-main',
        openRouterKey: 'synthetic-openrouter-key', [STATE_KEY]: state(1) }, 'haiku-key');
      let ask = asker(dispatch);
      expect(Object.values((await ask('The cat and the dog sleep all day long.')).results)[0].map((s) => s.f)).toEqual(['et']);
      expect(calls).toEqual([HAIKU]);
      let st = await dispatch({ type: 'status' }, popup);
      expect(st.lastServed).toMatchObject({ model: HAIKU, provider: 'openrouter', keyName: 'openrouter' });
      expect(st.openRouter).toMatchObject({ usd: 0.2, blocked: '' });
      // Level 2 too. This batch takes the day's spend to $0.40, past the default $0.25 cap.
      await dispatch({ type: 'save', settings: { levelOverride: 2 } }, popup);
      await ask('The bird and the fish swim all day long.');
      expect(calls).toEqual([HAIKU, HAIKU]);
      st = await dispatch({ type: 'status' }, popup);
      expect(st.openRouter.blocked).toBe('cap');
      // Cap reached: Haiku is skipped and the Gemini chain answers.
      calls.length = 0;
      await ask('The cow and the goat eat all day long.');
      expect(calls).toEqual(['gemini-3.1-flash-lite']);
      expect((await dispatch({ type: 'status' }, popup)).lastServed.model).toBe('gemini-3.1-flash-lite');
      // Level 3 with the key and room under a higher cap: the Gemini chain, unchanged.
      await dispatch({ type: 'save', settings: { levelOverride: 3, openRouterDailyUsd: 5 } }, popup);
      calls.length = 0;
      await ask('The fox and the hen run all day long.');
      expect(calls).toEqual(['gemini-3.1-flash-lite']);
      // Level 1 without an OpenRouter key: the Gemini chain as today.
      dispatch = await startWorker({ settings: { enabled: true, newSitesEnabled: true }, apiKey: 'synthetic-main', [STATE_KEY]: state(1) },
        'haiku-nokey');
      ask = asker(dispatch);
      calls.length = 0;
      await ask('The owl and the bat fly all night long.');
      expect(calls).toEqual(['gemini-3.1-flash-lite']);
    } finally {
      Object.assign(globalThis, saved);
    }
  }, 30000);
});

// Levels 1-2 on Auto with an Anthropic key: the Claude Haiku 5.5 step goes direct to Anthropic, never also through
// OpenRouter; without one, OpenRouter's key as above; with neither, no Haiku step.
const DIRECT = 'claude-haiku-5-5';
const ALL_KEYS = { ...KEYS, anthropic: 'synthetic-anthropic' };

describe('Claude Haiku direct from Anthropic', () => {
  test('provider choice: Anthropic key -> direct; OpenRouter key only -> OpenRouter; neither -> no Haiku step', () => {
    const first = (has, level = 2) => configFor('French', 'auto', undefined, level, has).chain[0];
    expect(first({ anthropic: true, openrouter: true })).toEqual({ provider: 'anthropic', model: DIRECT, thinking: 'low', timeoutMs: 35000 });
    expect(first({ anthropic: true })).toMatchObject({ provider: 'anthropic', model: DIRECT });
    expect(first({ openrouter: true })).toMatchObject({ provider: 'openrouter', model: HAIKU });
    expect(first({})).toEqual(CHAIN[0]);
    expect(first({ anthropic: true, openrouter: true }, 3)).toEqual(CHAIN[0]);
    for (const has of [{ anthropic: true, openrouter: true }, { anthropic: true }, { openrouter: true }, {}]) {
      const chain = configFor('French', 'auto', undefined, 1, has).chain;
      expect(chain.filter((s) => /haiku/.test(s.model)).length).toBe(has.anthropic || has.openrouter ? 1 : 0);
      expect(chain.slice(-3)).toEqual(CHAIN); // the Gemini chain stays the fallback after it
    }
  });

  test('with both keys: one Haiku attempt, to Anthropic, which answers with usage and cost', async () => {
    const chain = configFor('French', 'auto', undefined, 2, { anthropic: true, openrouter: true }).chain;
    const { calls, fetchImpl } = recorder((who, init) => (who.startsWith('anthropic') ? anthropicOk(init) : geminiOk(JSON.parse(init.body))));
    const spend = [];
    const r = await run(fetchImpl, { chain, keys: ALL_KEYS, onAnthropic: async (x) => { spend.push(x); }, onOpenRouter: async () => { throw new Error('no OpenRouter'); } });
    expect(calls).toEqual([`anthropic ${DIRECT} synthetic-anthropic`]);
    expect(r).toMatchObject({ model: DIRECT, provider: 'anthropic', keyName: 'anthropic', step: 1,
      usage: { promptTokens: 4000, answerTokens: 400, thinkingTokens: 200 } });
    expect(r.costUsd).toBeCloseTo(0.0007, 10);
    expect(r.ms).toBeGreaterThanOrEqual(0);
    expect(r.results.a.map((s) => s.f)).toEqual(['et']);
    expect(spend).toEqual([{ costUsd: r.costUsd, status: 200 }]);
  });

  test('Anthropic slow, busy or failing: the Gemini chain answers, and OpenRouter\'s Haiku is never tried', async () => {
    const chain = configFor('French', 'auto', undefined, 1, { anthropic: true, openrouter: true }).chain;
    for (const fail of [() => { throw new DOMException('timed out', 'TimeoutError'); }, () => status(529), () => status(500), () => status(429), lowCredit]) {
      const cooldown = new Map();
      const { calls, fetchImpl } = recorder((who, init) => (who.startsWith('anthropic') ? fail() : geminiOk(JSON.parse(init.body))));
      const r = await run(fetchImpl, { chain, keys: ALL_KEYS, cooldown });
      expect(calls).toEqual([`anthropic ${DIRECT} synthetic-anthropic`, 'gemini-3.1-flash-lite synthetic-main']);
      expect(r).toMatchObject({ model: 'gemini-3.1-flash-lite', provider: 'gemini', step: 2 });
    }
    // Every Gemini step failing too: the chain ends at gpt-6-luna, with no Haiku through OpenRouter on the way.
    const { calls, fetchImpl } = recorder((who, init) => (who.startsWith('openrouter') ? routerOk(init) : who.startsWith('anthropic') ? status(529) : quota429(MINUTE)));
    const r = await run(fetchImpl, { chain, keys: ALL_KEYS });
    expect(calls.filter((c) => /haiku/.test(c))).toEqual([`anthropic ${DIRECT} synthetic-anthropic`]);
    expect(r).toMatchObject({ model: 'openai/gpt-6-luna', provider: 'openrouter' });
  });

  test('a 401, 403 or "credit balance is too low" is reported and stops every Anthropic step for the rest of the batch', async () => {
    const extra = { provider: 'anthropic', model: 'claude-other', thinking: 'off', timeoutMs: 1000 };
    const chain = [...configFor('French', 'auto', undefined, 1, { anthropic: true }).chain.slice(0, 2), extra];
    for (const [fail, report] of [[() => status(401), { costUsd: 0, status: 401 }], [() => status(403), { costUsd: 0, status: 403 }],
      [lowCredit, { costUsd: 0, status: 400, credits: true }]]) {
      const seen = [];
      const { calls, fetchImpl } = recorder((who) => (who.startsWith('anthropic') ? fail() : quota429(MINUTE)));
      const error = await run(fetchImpl, { chain, keys: { main: KEYS.main, anthropic: 'synthetic-anthropic' }, onAnthropic: async (x) => { seen.push(x); } })
        .catch((e) => e);
      expect(calls).toEqual([`anthropic ${DIRECT} synthetic-anthropic`, 'gemini-3.1-flash-lite synthetic-main']); // claude-other skipped
      expect(seen).toEqual([report]);
      expect(error.kind).toBe('rate'); // the popup names the Gemini failure; the Anthropic line says why it stopped
      expect(error.message).toContain(`Anthropic ${DIRECT}: HTTP`);
      expect(error.message).not.toContain('synthetic-anthropic');
    }
    // A 529 does not stop the provider: only that step cools down.
    const { calls, fetchImpl } = recorder((who) => (who.startsWith('anthropic') ? status(529) : quota429(MINUTE)));
    await run(fetchImpl, { chain, keys: { main: KEYS.main, anthropic: 'synthetic-anthropic' } }).catch(() => {});
    expect(calls).toEqual([`anthropic ${DIRECT} synthetic-anthropic`, 'gemini-3.1-flash-lite synthetic-main', 'anthropic claude-other synthetic-anthropic']);
  });

  test('worker: Level 2 with an Anthropic key (and an OpenRouter key) goes direct; stops, the cap and setup\'s key', async () => {
    const saved = Object.fromEntries(['chrome', 'fetch'].map((k) => [k, globalThis[k]]));
    const calls = [];
    let direct = (init) => anthropicOk(init);
    globalThis.fetch = async (url, init) => {
      if (String(url).startsWith('chrome-extension://')) return { ok: true, json: async () => ({ version: '0.2.1' }) };
      if (url === ANTHROPIC_URL) { calls.push(`anthropic ${init.headers['x-api-key']}`); return direct(init); }
      if (url === OPENROUTER_URL) { calls.push(`openrouter ${JSON.parse(init.body).model}`); return routerOk(init); }
      calls.push(url.slice(API_BASE.length).split(':')[0]);
      return geminiOk(JSON.parse(init.body));
    };
    const page = { id: 'fw-test', tab: { id: 1, title: 'Cats' }, url: 'https://example.com/article' };
    const popup = { id: 'fw-test', url: 'chrome-extension://fw-test/src/popup.html' };
    const data = { settings: { enabled: true, newSitesEnabled: true, levelOverride: 2 }, apiKey: 'synthetic-main',
      openRouterKey: 'synthetic-openrouter-key', anthropicKey: 'synthetic-anthropic-pasted',
      [STATE_KEY]: { version: 't.1', stage: 1, paused: false, sites: 'all', fetchedAt: Date.now(), words: WORDS } };
    let n = 0;
    const animals = ['cat', 'dog', 'bird', 'fish', 'cow', 'goat', 'fox', 'hen', 'owl', 'bat', 'ant', 'bee', 'elk', 'yak', 'pig', 'ram',
      'eel', 'emu', 'gnu', 'cod', 'ape', 'koi', 'boar', 'crab'];
    try {
      const dispatch = await startWorker(data, 'anthropic-direct');
      const ask = async () => {
        const text = `The ${animals[n++]} and the ${animals[n++]} sleep all day long.`;
        const { revision } = await dispatch({ type: 'config' }, page);
        return dispatch({ type: 'swaps', revision, items: [{ key: `${revision}:${hashKey(text)}`, text }] }, page);
      };
      expect(Object.values((await ask()).results)[0].map((s) => s.f)).toEqual(['et']);
      expect(calls).toEqual(['anthropic synthetic-anthropic-pasted']);
      let st = await dispatch({ type: 'status' }, popup);
      expect(st.config.level).toBe(2);
      expect(st.lastServed).toMatchObject({ model: DIRECT, provider: 'anthropic', keyName: 'anthropic' });
      expect(st.served.counts).toEqual({ [DIRECT]: 1 });
      expect(st.anthropic).toMatchObject({ usd: 0.0007, blocked: '' });
      expect(st.openRouter.usd).toBe(0);
      expect(st).toMatchObject({ anthropicKey: true, hostAnthropicKey: false });
      expect(JSON.stringify(st)).not.toContain('synthetic-anthropic');
      // Low credit: stopped until tomorrow or a new key; the next batches go to Gemini, not to OpenRouter's Haiku.
      direct = lowCredit;
      calls.length = 0;
      expect((await ask()).error).toBeUndefined(); // Gemini answered
      expect(calls).toEqual(['anthropic synthetic-anthropic-pasted', 'gemini-3.1-flash-lite']);
      expect((await dispatch({ type: 'status' }, popup)).anthropic.blocked).toBe('credits');
      calls.length = 0;
      await ask();
      expect(calls).toEqual(['gemini-3.1-flash-lite']);
      // A new pasted key clears the stop; a 401 sets the key stop.
      direct = () => status(401);
      await dispatch({ type: 'save', anthropicKey: 'synthetic-anthropic-new' }, popup);
      expect((await dispatch({ type: 'status' }, popup)).anthropic.blocked).toBe('');
      calls.length = 0;
      await ask();
      expect(calls).toEqual(['anthropic synthetic-anthropic-new', 'gemini-3.1-flash-lite']);
      expect((await dispatch({ type: 'status' }, popup)).anthropic.blocked).toBe('key');
      calls.length = 0;
      await ask();
      expect(calls).toEqual(['gemini-3.1-flash-lite']);
      // The cap ($0.01 here): a batch that costs $0.01 takes the day past it; after it, Gemini.
      direct = (init) => anthropicOk(init, { input_tokens: 50000, output_tokens: 10000 });
      await dispatch({ type: 'save', anthropicKey: 'synthetic-anthropic-ok', settings: { anthropicDailyUsd: 0.01 } }, popup);
      calls.length = 0;
      await ask();
      expect(calls).toEqual(['anthropic synthetic-anthropic-ok']);
      st = await dispatch({ type: 'status' }, popup);
      expect(st.anthropic).toMatchObject({ usd: 0.0107, blocked: 'cap' });
      calls.length = 0;
      await ask();
      expect(calls).toEqual(['gemini-3.1-flash-lite']);
      // Setup's key (native host), used once the pasted one is cleared; a pasted one wins again.
      await dispatch({ type: 'save', anthropicKey: '', settings: { anthropicDailyUsd: 5 } }, popup);
      globalThis.chrome.runtime.sendNativeMessage = async () => ({ ok: true, version: 't.2', stage: 1, words: WORDS,
        geminiKey: 'synthetic-main', anthropicKey: 'synthetic-anthropic-setup' });
      expect((await dispatch({ type: 'syncWords' }, popup)).ok).toBe(true);
      st = await dispatch({ type: 'status' }, popup);
      expect(st).toMatchObject({ anthropicKey: false, hostAnthropicKey: true });
      expect(JSON.stringify(st)).not.toContain('synthetic-anthropic');
      calls.length = 0;
      await ask();
      expect(calls).toEqual(['anthropic synthetic-anthropic-setup']);
      await dispatch({ type: 'save', anthropicKey: 'synthetic-anthropic-pasted' }, popup);
      calls.length = 0;
      await ask();
      expect(calls).toEqual(['anthropic synthetic-anthropic-pasted']);
      // Level 3: the Gemini chain, no Haiku from either provider.
      await dispatch({ type: 'save', settings: { levelOverride: 3 } }, popup);
      calls.length = 0;
      await ask();
      expect(calls).toEqual(['gemini-3.1-flash-lite']);
    } finally {
      Object.assign(globalThis, saved);
    }
  }, 30000);
});
