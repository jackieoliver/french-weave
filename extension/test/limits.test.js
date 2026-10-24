import { describe, test, expect } from 'bun:test';
import { createLimiter, createSpendGate } from '../src/limits.js';
import { requestSwaps, paidBound } from '../src/engine.js';
import { MODEL_CONFIG } from '../src/model-config.js';
import { ANTHROPIC_URL, maxCostOf } from '../src/anthropic.js';
import { MAX_REQUEST_USD } from '../src/openrouter.js';
import { buildRequest } from '../src/gemini.js';
import { paidToday, countPaid, spentToday, saveSpent } from '../src/quota.js';
import { createCache, memoryStorage, CACHE_MAX_AGE_MS } from '../src/cache.js';

const tick = (ms = 0) => new Promise((done) => setTimeout(done, ms));
const serial = () => {
  let chain = Promise.resolve();
  return (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
};
// chrome.storage-like: a tick between a read and its write, so unserialized read-modify-writes would lose data.
const slowStorage = () => {
  const data = {};
  return {
    data,
    async get(keys) { await tick(); return structuredClone(Object.fromEntries(keys.filter((k) => k in data).map((k) => [k, data[k]]))); },
    async set(values) { await tick(); Object.assign(data, structuredClone(values)); },
  };
};
const DAY = '2026-10-17';

describe('limiter', () => {
  test('runs at most max at once, in arrival order', async () => {
    const limit = createLimiter(4);
    let running = 0;
    let most = 0;
    const started = [];
    const job = (n) => limit.run(async () => {
      started.push(n);
      most = Math.max(most, ++running);
      await tick(5);
      running--;
      return n;
    });
    const results = await Promise.all(Array.from({ length: 10 }, (_, n) => job(n)));
    expect(results).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(most).toBe(4);
    expect(started).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(limit.active).toBe(0);
  });

  test('a limit of 1 is one at a time; a failed call frees its slot', async () => {
    const limit = createLimiter(1);
    let running = 0;
    let most = 0;
    const job = (fail) => limit.run(async () => { most = Math.max(most, ++running); await tick(2); running--; if (fail) throw new Error('x'); });
    const out = await Promise.allSettled([job(false), job(true), job(false)]);
    expect(out.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
    expect(most).toBe(1);
  });

  test('exclusive waits for every call out and holds the ones after it', async () => {
    const limit = createLimiter(3);
    const log = [];
    const job = (name, ms) => limit.run(async () => { log.push(`${name} start`); await tick(ms); log.push(`${name} end`); });
    const a = job('a', 10);
    const b = job('b', 20);
    const x = limit.exclusive(async () => { log.push('reload'); });
    const c = job('c', 1);
    await Promise.all([a, b, x, c]);
    expect(log.indexOf('reload')).toBeGreaterThan(log.indexOf('b end'));
    expect(log.indexOf('c start')).toBeGreaterThan(log.indexOf('reload'));
  });

  test('take holds a slot until released, once', async () => {
    const limit = createLimiter(1);
    const release = await limit.take();
    let second = false;
    const next = limit.take().then((r) => { second = true; return r; });
    await tick(5);
    expect(second).toBe(false);
    release(); release(); // twice frees one slot
    (await next)();
    expect(limit.active).toBe(0);
  });
});

describe('spend gate', () => {
  const gateFor = (storage) => {
    const locked = serial();
    const gate = createSpendGate({ locked, today: (provider) => paidToday(storage, provider, DAY) });
    // A paid call as the worker makes it: through the gate, the request, its cost counted under the lock, then release.
    const call = async (provider, cap, bound, cost, log) => {
      const turn = await gate.acquire(provider, cap, bound);
      if (!turn.release) return turn.blocked;
      log.out = (log.out || 0) + 1;
      log.most = Math.max(log.most || 0, log.out);
      await tick(5);
      await locked(() => countPaid(storage, provider, { costUsd: cost }, DAY));
      log.out--;
      turn.release();
      return 'ran';
    };
    return { gate, call };
  };

  test('far under the cap, calls run in parallel', async () => {
    const storage = slowStorage();
    const { call } = gateFor(storage);
    const log = {};
    const out = await Promise.all(Array.from({ length: 4 }, () => call('anthropic', 5, 0.01, 0.002, log)));
    expect(out).toEqual(['ran', 'ran', 'ran', 'ran']);
    expect(log.most).toBe(4);
    expect((await paidToday(storage, 'anthropic', DAY)).usd).toBe(0.008); // every count kept
  });

  test('near the cap, no two calls both pass a check only one should', async () => {
    const storage = slowStorage();
    storage.data.anthropicDay = { day: DAY, usd: 4.995, stopped: '' };
    const { call } = gateFor(storage);
    const log = {};
    // One at a time: the first passes (4.995 < 5), costs 0.01, and the cap stops the rest.
    const out = await Promise.all(Array.from({ length: 4 }, () => call('anthropic', 5, 0.006, 0.01, log)));
    expect(out).toEqual(['ran', 'cap', 'cap', 'cap']);
    expect(log.most).toBe(1);
    expect((await paidToday(storage, 'anthropic', DAY)).usd).toBe(5.005);
  });

  test('near the cap, cheap calls still run, one after another, exactly as many as one at a time would', async () => {
    const storage = slowStorage();
    storage.data.anthropicDay = { day: DAY, usd: 4.99, stopped: '' };
    const { call } = gateFor(storage);
    const log = {};
    const out = await Promise.all(Array.from({ length: 6 }, () => call('anthropic', 5, 0.006, 0.004, log)));
    // 4.99 -> 4.994 -> 4.998 -> 5.002: three pass, as one at a time; never two out while a second could cross the cap.
    expect(out.filter((x) => x === 'ran')).toHaveLength(3);
    expect(out.filter((x) => x === 'cap')).toHaveLength(3);
    expect(log.most).toBe(1);
  });

  test('random costs under the bound: the spend ends past the cap by at most one call, as one at a time', async () => {
    for (let round = 0; round < 20; round++) {
      const costs = Array.from({ length: 12 }, () => Math.round(Math.random() * 0.01 * 1e6) / 1e6);
      const start = Math.round((0.95 + Math.random() * 0.05) * 1e6) / 1e6;
      const storage = slowStorage();
      storage.data.openRouterDay = { day: DAY, usd: start, stopped: '' };
      const { call } = gateFor(storage);
      const log = {};
      // Calls arrive in order, each a little after the last, as batches do.
      const out = await Promise.all(costs.map(async (c, i) => { await tick(i); return call('openrouter', 1, 0.01, c, log); }));
      // As one at a time: every call that ran started under the cap even counting the others out, so the spend ends
      // past the cap by at most one call's cost (12 unchecked parallel calls could pass it by up to 0.12).
      const ran = costs.filter((_, i) => out[i] === 'ran');
      const final = (await paidToday(storage, 'openrouter', DAY)).usd;
      expect(final).toBeCloseTo(start + ran.reduce((a, b) => a + b, 0), 5);
      expect(final - 1).toBeLessThan(0.01);
      expect(out.every((x) => x === 'ran' || x === 'cap')).toBe(true);
    }
  });

  test('a provider stopped (refused key, no credit) refuses at once; providers are separate', async () => {
    const storage = slowStorage();
    storage.data.openRouterDay = { day: DAY, usd: 0, stopped: 'credits' };
    const { gate } = gateFor(storage);
    expect(await gate.acquire('openrouter', 1, 0.01)).toEqual({ blocked: 'credits' });
    const a = await gate.acquire('anthropic', 1, 0.6);
    const b = gate.acquire('anthropic', 1, 0.6); // 0 + 0.6 + 0.6 >= 1: waits for a
    let bDone = false;
    b.then(() => { bDone = true; });
    await tick(10);
    expect(bDone).toBe(false);
    expect(gate.inFlight('anthropic')).toBe(1);
    a.release(); // a cost nothing: b may go
    expect((await b).release).toBeFunction();
  });

  test('a cost ceiling: Anthropic from the request size and max_tokens, OpenRouter a fixed ceiling per request', () => {
    const step = MODEL_CONFIG.default.levelFirst.via.anthropic;
    const body = buildRequest({ system: 'S'.repeat(1000), user: 'U'.repeat(3000), schema: { type: 'object' }, thinkingLevel: 'low', model: step.model });
    const usd = maxCostOf(step.model, body);
    expect(usd).toBeGreaterThan(8000 * 0.5 / 1e6); // max_tokens at the output price, plus the input
    expect(usd).toBeLessThan(0.006);
    expect(maxCostOf('unknown-model', body)).toBe(Infinity);
    const plan = { send: [1, 2, 3, 4, 5].map((n) => ({ id: `p${n}`, text: 'x' })), system: 'S', user: 'U', userFor: () => 'U', schema: { type: 'object' } };
    expect(paidBound({ keyName: 'anthropic', step }, plan)).toBeCloseTo(2 * maxCostOf(step.model, buildRequest({ system: 'S', user: 'U', schema: { type: 'object' }, thinkingLevel: 'low', model: step.model })), 10);
    expect(paidBound({ keyName: 'openrouter', step: { model: 'openai/gpt-6-luna' } }, plan)).toBe(MAX_REQUEST_USD);
  });
});

describe('engine admit', () => {
  const WORDS = [{ fr: 'et', en: 'and', hint: 'ay', status: 'active' }];
  const BATCH = [{ id: 'a', text: 'The cat and the dog sleep all day long.' }];
  const keepAll = (text) => JSON.stringify({ passages: JSON.parse(text.replace(/^Passages:\n/, '')).map(({ id, candidates }) => ({ id, topic: 'ok', keep: candidates.map((c) => c.n) })) });
  const geminiOk = (init) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: keepAll(JSON.parse(init.body).contents[0].parts[0].text) }] } }] }) });
  const anthropicOk = (init) => ({ ok: true, status: 200, text: async () => JSON.stringify({ stop_reason: 'end_turn', usage: { input_tokens: 10, output_tokens: 10 },
    content: [{ type: 'text', text: keepAll(JSON.parse(init.body).messages.at(-1).content) }] }) });
  const CHAIN = [MODEL_CONFIG.default.levelFirst.via.anthropic, ...MODEL_CONFIG.default.chain];
  const run = (extra) => requestSwaps({ chain: CHAIN, design: 'candidates', level: 2, batch: BATCH, words: WORDS, language: 'French', ...extra });

  test('each request waits for admit and releases after; a refused provider is left out', async () => {
    const log = [];
    const fetchImpl = async (url, init) => { log.push(url === ANTHROPIC_URL ? 'anthropic' : 'gemini'); return url === ANTHROPIC_URL ? anthropicOk(init) : geminiOk(init); };
    const admit = async (a, bound) => {
      log.push(`admit ${a.keyName} ${bound > 0 ? 'bound' : 'free'}`);
      if (a.keyName === 'anthropic') return { error: new Error('Anthropic daily cap reached') };
      return { release: () => log.push(`release ${a.keyName}`) };
    };
    const r = await run({ keys: { main: 'k', anthropic: 'a' }, fetchImpl, admit });
    expect(r.provider).toBe('gemini');
    expect(r.results.a.map((s) => s.f)).toEqual(['et']);
    expect(log).toEqual(['admit anthropic bound', 'admit main free', 'gemini', 'release main']);
  });

  test('nothing sent: the local cap error from admit, or a wait when another batch cooled every step meanwhile', async () => {
    const fetchImpl = async () => { throw new Error('no request expected'); };
    const local = Object.assign(new Error('Daily limit of 500 model calls reached; French resumes tomorrow'), { kind: 'local' });
    const capped = await run({ keys: { main: 'k' }, fetchImpl, admit: async () => ({ error: local }) }).catch((e) => e);
    expect(capped).toBe(local);
    const cooldown = new Map();
    const admit = async (a) => { for (const s of ['gemini-3.1-flash-lite', 'gemini-3.5-flash-lite']) cooldown.set(s, Date.now() + 60000); return { release: () => {} }; };
    const waited = await run({ keys: { main: 'k' }, fetchImpl, admit, cooldown }).catch((e) => e);
    expect(waited.kind).toBe('wait');
    expect(waited.retryAfterMs).toBeGreaterThan(50000);
  });
});

describe('storage under concurrency', () => {
  test('saveSpent with what a batch loaded keeps entries other batches wrote meanwhile', async () => {
    const storage = memoryStorage();
    const now = 1000;
    const a = await spentToday(storage, now);
    const b = await spentToday(storage, now);
    const loadedA = new Map(a);
    const loadedB = new Map(b);
    a.set('gemini-3.1-flash-lite', 9000);
    b.set('gemini-3.5-flash-lite', 8000);
    await saveSpent(storage, a, now, loadedA);
    await saveSpent(storage, b, now, loadedB);
    expect(Object.fromEntries(await spentToday(storage, now))).toEqual({ 'gemini-3.1-flash-lite': 9000, 'gemini-3.5-flash-lite': 8000 });
    // A key change reset the map while a batch was out: the batch writes back only what it added.
    const c = await spentToday(storage, now);
    const loadedC = new Map(c);
    await storage.set({ dailyQuota: {} });
    c.set('backup:gemini-3.1-flash-lite', 7000);
    await saveSpent(storage, c, now, loadedC);
    expect(Object.fromEntries(await spentToday(storage, now))).toEqual({ 'backup:gemini-3.1-flash-lite': 7000 });
  });
});

describe('decision cache age', () => {
  test('entries are reused for 3 days, then count as misses and get replaced', async () => {
    let clock = Date.UTC(2026, 9, 17);
    const storage = memoryStorage();
    const cache = createCache(storage, { now: () => clock });
    expect(CACHE_MAX_AGE_MS).toBe(3 * 24 * 3600 * 1000);
    await cache.setMany({ k1: [{ o: 'and', f: 'et' }] });
    clock += CACHE_MAX_AGE_MS - 60000;
    expect(await cache.getMany(['k1'])).toEqual({ k1: [{ o: 'and', f: 'et' }] });
    clock += 120000; // just over 3 days
    expect(await cache.getMany(['k1'])).toEqual({});
    await cache.setMany({ k1: [{ o: 'with', f: 'avec' }] });
    expect(await cache.getMany(['k1'])).toEqual({ k1: [{ o: 'with', f: 'avec' }] });
    expect((await storage.getAll())['c:k1'].t).toBe(clock);
  });
});
