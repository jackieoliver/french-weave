import { describe, test, expect } from 'bun:test';
import { modelErrorText, replaceLegacyStatus, clockTime } from '../src/modelerror.js';
import { STATE_KEY, localDay } from '../src/hostsource.js';
import { DAILY_MODEL_CALLS } from '../src/quota.js';

// 2026-10-15: 0.2.1 stored { at, error: "Model rate limit; retrying shortly" } (no kind) at 17:18 for what was the
// per-day quota. After the update to 0.2.2 at 17:22 the badge kept showing that wrong text, and nothing cleared it
// until a request worked, which the spent quota ruled out until midnight Pacific.
const LEGACY = { at: Date.UTC(2026, 9, 16, 0, 18), error: 'Model rate limit; retrying shortly' };
const LITE = 'gemini-3.5-flash-lite';
const FLASH = 'gemini-3.8-flash';

describe('model status stored before 0.2.2', () => {
  test('is ignored by the popup and badge text, and replaced: daily notice while the quota is spent, else nothing', () => {
    const now = Date.UTC(2026, 9, 16, 0, 25);
    const midnight = Date.UTC(2026, 9, 16, 7, 0, 30);
    expect(modelErrorText(LEGACY, now)).toBe('');
    // No per-day cooldown stored (or it has passed): the stale error goes.
    expect(replaceLegacyStatus(LEGACY, undefined, [LITE], now)).toEqual({ at: now, error: '' });
    expect(replaceLegacyStatus(LEGACY, { [LITE]: now - 1 }, [LITE], now)).toEqual({ at: now, error: '' });
    // Only one of two models spent: the next request tries the other, so it is not the daily limit.
    expect(replaceLegacyStatus(LEGACY, { [LITE]: midnight }, [FLASH, LITE], now)).toEqual({ at: now, error: '' });
    // Every model the next request would try is spent for the day: the daily notice, with when it resumes.
    const daily = replaceLegacyStatus(LEGACY, { [LITE]: midnight, other: 1 }, [LITE], now);
    expect(daily).toMatchObject({ kind: 'daily', retryAt: midnight, httpStatus: 429 });
    expect(modelErrorText(daily, now)).toMatch(/^Daily Gemini limit reached \(429\); resumes (tomorrow )?about /); // tomorrow in Pacific time
    expect(modelErrorText(daily, now)).toEndWith(`about ${clockTime(midnight)}`);
    // Today's local cap used up: its own notice, ahead of the daily one.
    expect(replaceLegacyStatus(LEGACY, { [LITE]: midnight }, [LITE], now, 'Daily limit of 500 model calls reached'))
      .toEqual({ at: now, error: 'Daily limit of 500 model calls reached', kind: 'local' });
    // Statuses with a kind, and successes, are left alone.
    expect(replaceLegacyStatus({ at: 1, error: 'x', kind: 'rate' }, {}, [LITE], now)).toBeNull();
    expect(replaceLegacyStatus({ at: 1, error: '' }, {}, [LITE], now)).toBeNull();
    expect(replaceLegacyStatus(null, {}, [LITE], now)).toBeNull();
  });

  // The real worker with a fake chrome: starting it (as after the update) replaces the stored legacy status.
  async function startWorker(name, extra) {
    const saved = Object.fromEntries(['chrome', 'fetch', 'setTimeout'].map((k) => [k, globalThis[k]]));
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => (ms >= 10000 ? 0 : realTimeout(fn, ms, ...rest));
    const data = {
      settings: { enabled: true, newSitesEnabled: true },
      apiKey: 'synthetic-key',
      modelStatus: { ...LEGACY },
      [STATE_KEY]: { version: 't.1', stage: 1, paused: false, sites: 'all', fetchedAt: 1,
        words: [{ fr: 'et', en: 'and', hint: 'ay', status: 'active' }] },
      ...extra,
    };
    const badge = { text: '', color: '', textColor: '', title: '' };
    const on = () => ({ addListener() {} });
    globalThis.chrome = {
      storage: { local: {
        async setAccessLevel() {},
        async get(keys) {
          const pick = keys == null ? Object.keys(data) : typeof keys === 'string' ? [keys] : keys;
          return structuredClone(Object.fromEntries(pick.filter((k) => k in data).map((k) => [k, data[k]])));
        },
        async set(values) { for (const [k, v] of Object.entries(values)) data[k] = structuredClone(v); },
        async remove(keys) { for (const k of keys) delete data[k]; },
      }, onChanged: on() },
      runtime: { id: 'fw-test', getURL: (path) => `chrome-extension://fw-test/${path}`, getManifest: () => ({ version: '0.2.3' }),
        onMessage: on(), onInstalled: on(), onStartup: on(), sendNativeMessage: async () => ({ ok: false }) },
      action: {
        setBadgeText: async ({ text }) => { badge.text = text; },
        setBadgeBackgroundColor: async ({ color }) => { badge.color = color; },
        setBadgeTextColor: async ({ color }) => { badge.textColor = color; },
        setTitle: async ({ title }) => { badge.title = title; },
      },
      tabs: { query: async () => [], sendMessage: async () => {} },
      alarms: { create: async () => {}, onAlarm: on() },
      permissions: { getAll: async () => ({ origins: [] }), onAdded: on(), onRemoved: on() },
      scripting: { getRegisteredContentScripts: async () => [], updateContentScripts: async () => {},
        unregisterContentScripts: async () => {}, registerContentScripts: async () => {} },
    };
    globalThis.fetch = async () => ({ ok: true, json: async () => ({ version: '0.2.3' }) });
    try {
      const worker = await import(`../src/background.js?legacy-${name}`);
      for (let i = 0; i < 50; i++) await new Promise((done) => realTimeout(done, 2));
      return { data, badge, worker };
    } finally {
      Object.assign(globalThis, saved);
    }
  }

  test('worker start drops it when no daily quota is stored: no badge', async () => {
    const { data, badge } = await startWorker('cleared');
    expect(data.modelStatus.error).toBe('');
    expect(data.modelStatus.kind).toBeUndefined();
    expect(badge.title).toBe(''); // the stale text never reaches the badge (nothing is drawn with no error and no update check yet)
  });

  test('worker start keeps the local cap notice while today\'s calls are used up', async () => {
    const { data } = await startWorker('local', { modelCalls: { day: localDay(), count: DAILY_MODEL_CALLS } });
    expect(data.modelStatus).toEqual({ at: expect.any(Number), kind: 'local',
      error: `Daily limit of ${DAILY_MODEL_CALLS} model calls reached; French resumes tomorrow` });
  });

  test('worker start shows the daily notice when the per-day quota is still spent', async () => {
    const until = Date.now() + 3 * 3600000;
    const { data, badge, worker } = await startWorker('daily', { dailyQuota: { 'gemini-3.5-flash-lite': until } });
    expect(data.modelStatus).toMatchObject({ kind: 'daily', retryAt: until, httpStatus: 429 });
    expect(badge).toMatchObject({ text: worker.BADGE_ERROR.text, color: worker.PLACEHOLDER_GRAY, textColor: worker.ERROR_DOT_COLOR });
    expect(badge.title).toMatch(/^French Weave: Daily Gemini limit reached \(429\); resumes (tomorrow )?about /);
  });
});
