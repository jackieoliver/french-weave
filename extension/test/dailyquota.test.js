import { describe, test, expect } from 'bun:test';
import { callGemini, quotaFailure, dailyReset } from '../src/gemini.js';
import { requestSwaps, clockTime } from '../src/engine.js';
import { DAILY_MODEL_CALLS, spentToday, saveSpent } from '../src/quota.js';
import { memoryStorage } from '../src/cache.js';
import { hashKey } from '../src/hash.js';
import { STATE_KEY } from '../src/hostsource.js';

// A free-tier 429 as Gemini sends it: QuotaFailure names the quota, RetryInfo says when it frees up.
const quota429 = (quotaId, retryDelay, quotaValue = '500') => ({
  ok: false,
  status: 429,
  text: async () => JSON.stringify({ error: { code: 429, status: 'RESOURCE_EXHAUSTED', details: [
    { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaMetric: 'generativelanguage.googleapis.com/generate_content_free_tier_requests', quotaId, quotaValue }] },
    { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay },
  ] } }),
});
const DAY = 'GenerateRequestsPerDayPerProjectPerModel-FreeTier';
const MINUTE = 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier';
const ok = (passages) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ passages }) }] } }] }) });

describe('daily quota', () => {
  test('the 429 body says which quota ran out', async () => {
    expect(quotaFailure('nope')).toEqual({});
    expect(quotaFailure('{"error":{"details":[{"retryDelay":"36s"}]}}')).toEqual({});
    const t = Date.UTC(2026, 9, 15, 20, 12); // 13:12 PDT
    const now = () => t;
    const day = await callGemini({ fetchImpl: async () => quota429(DAY, '13634s'), apiKey: 'K', model: 'gemini-3.5-flash-lite', body: {}, now }).catch((e) => e);
    expect(day).toMatchObject({ status: 429, daily: true, dailyLimit: 500, quotaId: DAY, retryAfterMs: 13634000 });
    const minute = await callGemini({ fetchImpl: async () => quota429(MINUTE, '36s', '15'), apiKey: 'K', model: 'gemini-3.5-flash-lite', body: {}, now }).catch((e) => e);
    expect(minute.daily).toBeUndefined();
    expect(minute.retryAfterMs).toBe(36000);
    const noDelay = await callGemini({ fetchImpl: async () => quota429(DAY, ''), apiKey: 'K', model: 'gemini-3.5-flash-lite', body: {}, now }).catch((e) => e);
    expect(noDelay.retryAfterMs).toBe(dailyReset(t) - t); // no time given: just after midnight Pacific
  });

  test('a per-day 429 stops calls until the retry time and says when French resumes; a per-minute one keeps the short backoff', async () => {
    let clock = Date.UTC(2026, 9, 15, 20, 12);
    const now = () => clock;
    let calls = 0;
    let reply = () => quota429(DAY, '13634s');
    const fetchImpl = async () => { calls++; return reply(); };
    const cooldown = new Map();
    const daily = new Map();
    const args = { apiKey: 'K', model: 'gemini-3.5-flash-lite', level: 1, batch: [{ id: 'a', text: 'x' }], fetchImpl, cooldown, daily, now };
    const resume = clock + 13634000;
    const first = await requestSwaps(args).catch((e) => e);
    expect(first.message).toBe(`Daily Gemini limit reached; resumes about ${clockTime(resume)}`);
    expect(first.message).toMatch(/resumes about \d{1,2}:\d{2}/);
    expect(first).toMatchObject({ daily: true, resumeAt: resume, retryAfterMs: 13634000 });
    expect(daily.get('gemini-3.5-flash-lite')).toBe(resume);
    clock += 3600000; // an hour later: no request, the same message
    const again = await requestSwaps(args).catch((e) => e);
    expect(again.message).toBe(first.message);
    expect(calls).toBe(1);
    // With a fallback, only both models spent for the day reads as the daily limit.
    clock = resume + 1;
    reply = () => quota429(MINUTE, '36s', '15');
    const minute = await requestSwaps(args).catch((e) => e);
    expect(minute.message).toContain('HTTP 429');
    expect(minute.daily).toBeUndefined();
    expect(minute.retryAfterMs).toBe(36000);
    const fast = await requestSwaps(args).catch((e) => e);
    expect(fast.message).toBe('Model rate limit; retrying shortly');
    clock += 36001;
    const models = [];
    const both = { ...args, model: 'gemini-3.8-flash', fetchImpl: async (url) => {
      const m = url.split('/').pop().split(':')[0];
      models.push(m);
      return m === 'gemini-3.8-flash' ? quota429(DAY, '7200s', '20') : ok([{ id: 'a', swaps: [] }]);
    } };
    expect((await requestSwaps(both)).model).toBe('gemini-3.5-flash-lite'); // Flash spent for the day, Lite answers
    expect(daily.has('gemini-3.8-flash')).toBe(true);
  });

  // Google's retryDelay for a per-day quota counts down to midnight UTC (17:00 PDT), but the quota resets at midnight
  // Pacific: at 17:08 PDT on 2026-10-15 it still said 429 with "retry in 23h51m". Trusting it blocked French ~17 hours.
  test('a per-day limit resumes just after the next Pacific midnight, or at Google\'s time if sooner', async () => {
    const at = (iso) => Date.parse(iso);
    // Before and after 17:00 PDT: both resume at 00:01 PDT (07:01 UTC) the next calendar day in Pacific time.
    expect(dailyReset(at('2026-10-15T23:04:00Z'))).toBe(at('2026-10-16T07:01:00Z')); // 16:04 PDT
    expect(dailyReset(at('2026-10-16T00:08:00Z'))).toBe(at('2026-10-16T07:01:00Z')); // 17:08 PDT
    expect(dailyReset(at('2026-10-16T06:59:00Z'))).toBe(at('2026-10-16T07:01:00Z')); // 23:59 PDT
    expect(dailyReset(at('2026-10-16T07:00:30Z'))).toBe(at('2026-10-17T07:01:00Z')); // 00:00:30 PDT: the next one
    // DST ends 2026-11-01 (PDT -> PST): midnight that day is still PDT, the next is PST.
    expect(dailyReset(at('2026-11-01T03:00:00Z'))).toBe(at('2026-11-01T07:01:00Z')); // Oct 31 20:00 PDT
    expect(dailyReset(at('2026-11-01T20:00:00Z'))).toBe(at('2026-11-02T08:01:00Z')); // Nov 1 12:00 PST
    // DST starts 2027-03-14 (PST -> PDT).
    expect(dailyReset(at('2027-03-14T04:00:00Z'))).toBe(at('2027-03-14T08:01:00Z')); // Mar 13 20:00 PST
    expect(dailyReset(at('2027-03-14T19:00:00Z'))).toBe(at('2027-03-15T07:01:00Z')); // Mar 14 12:00 PDT

    const call = (t, delay) => callGemini({ fetchImpl: async () => quota429(DAY, delay), apiKey: 'K', model: 'gemini-3.5-flash-lite', body: {}, now: () => t }).catch((e) => e);
    // 17:08 PDT, Google says 23h51m: wait only until 00:01 PDT.
    const late = at('2026-10-16T00:08:00Z');
    expect((await call(late, '85860s')).retryAfterMs).toBe(at('2026-10-16T07:01:00Z') - late);
    // 16:04 PDT, Google says 55m40s: sooner than midnight, so Google's time; the probe then gets 23h58m -> 00:01 PDT.
    const early = at('2026-10-15T23:04:00Z');
    expect((await call(early, '3340s')).retryAfterMs).toBe(3340000);
    const probe = at('2026-10-16T00:01:00Z');
    expect((await call(probe, '86280s')).retryAfterMs).toBe(at('2026-10-16T07:01:00Z') - probe);

    // Through the engine with a fake clock: the popup line names the Pacific reset in the reader's own time.
    const daily = new Map();
    const err = await requestSwaps({ apiKey: 'K', model: 'gemini-3.5-flash-lite', level: 1, batch: [{ id: 'a', text: 'x' }], daily,
      fetchImpl: async () => quota429(DAY, '85860s'), now: () => late }).catch((e) => e);
    expect(err).toMatchObject({ daily: true, resumeAt: at('2026-10-16T07:01:00Z') });
    expect(err.message).toBe(`Daily Gemini limit reached; resumes about ${clockTime(at('2026-10-16T07:01:00Z'))}`);
  });

  test('the local cap matches the free tier, and spent days are kept in storage', async () => {
    expect(DAILY_MODEL_CALLS).toBe(500);
    const storage = memoryStorage();
    await saveSpent(storage, new Map([['gemini-3.5-flash-lite', 5000], ['gemini-3.8-flash', 500]]), 1000);
    expect([...(await spentToday(storage, 1000))]).toEqual([['gemini-3.5-flash-lite', 5000]]);
    expect([...(await spentToday(storage, 6000))]).toEqual([]);
  });

  // The real worker: the popup shows the daily message, and a new worker (Chrome stops idle ones) still waits.
  test('worker: the daily limit reaches the popup and survives a worker restart', async () => {
    const saved = Object.fromEntries(['chrome', 'fetch', 'setTimeout'].map((k) => [k, globalThis[k]]));
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => (ms >= 10000 ? 0 : realTimeout(fn, ms, ...rest));
    const data = {
      settings: { enabled: true, newSitesEnabled: true },
      apiKey: 'synthetic-key',
      [STATE_KEY]: { version: 't.1', stage: 1, paused: false, sites: 'all', fetchedAt: Date.now(),
        words: [{ fr: 'et', en: 'and', hint: 'ay', status: 'active' }] },
    };
    let geminiCalls = 0;
    const on = (arr = []) => ({ addListener: (fn) => arr.push(fn) });
    const worker = async (tag) => {
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
        runtime: {
          id: 'fw-test', getURL: (path) => `chrome-extension://fw-test/${path}`, getManifest: () => ({ version: '0.2.1' }),
          onMessage: on(listeners), onInstalled: on(), onStartup: on(),
          sendNativeMessage: async () => ({ ok: false }),
        },
        action: { setBadgeText: async () => {} },
        tabs: { query: async () => [], sendMessage: async () => {} },
        alarms: { create: async () => {}, onAlarm: on() },
        permissions: { getAll: async () => ({ origins: ['<all_urls>'] }), onAdded: on(), onRemoved: on() },
        scripting: { getRegisteredContentScripts: async () => [], updateContentScripts: async () => {},
          unregisterContentScripts: async () => {}, registerContentScripts: async () => {} },
      };
      globalThis.fetch = async (url) => {
        if (String(url).startsWith('chrome-extension://')) return { ok: true, json: async () => ({ version: '0.2.1' }) };
        geminiCalls++;
        return quota429(DAY, '13634s');
      };
      await import(`../src/background.js?daily-${tag}`);
      return (msg, sender) => new Promise((done) => { if (!listeners.some((fn) => fn(msg, sender, done))) done(undefined); });
    };
    const popup = { id: 'fw-test', url: 'chrome-extension://fw-test/src/popup.html' };
    const page = { id: 'fw-test', tab: { id: 1 }, url: 'https://example.com/article' };
    const ask = async (dispatch, text) => {
      const { revision } = await dispatch({ type: 'config' }, page);
      return dispatch({ type: 'swaps', revision, items: [{ key: `${revision}:${hashKey(text)}`, text }] }, page);
    };
    try {
      let dispatch = await worker('a');
      const res = await ask(dispatch, 'The garden was quiet and the book was good.');
      expect(res.error).toMatch(/^Daily Gemini limit reached; resumes about \d{1,2}:\d{2}/);
      expect(res.retryAfterMs).toBeGreaterThan(0);
      expect(res.retryAfterMs).toBeLessThanOrEqual(13634000); // Google's time, or the Pacific midnight if sooner
      expect(geminiCalls).toBe(1);
      expect((await dispatch({ type: 'status' }, popup)).modelStatus.error).toBe(res.error);
      expect(data.dailyQuota['gemini-3.5-flash-lite']).toBeGreaterThan(Date.now());
      dispatch = await worker('b'); // a fresh worker has no cooldown in memory, only storage
      const later = await ask(dispatch, 'Another quiet passage with and in it here.');
      expect(later.error).toBe(res.error);
      expect(geminiCalls).toBe(1);
    } finally {
      Object.assign(globalThis, saved);
    }
  }, 30000);
});
