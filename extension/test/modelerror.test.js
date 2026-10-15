import { describe, test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { callGemini } from '../src/gemini.js';
import { requestSwaps } from '../src/engine.js';
import { modelErrorText, errorKind, clockTime } from '../src/modelerror.js';
import { DAILY_MODEL_CALLS } from '../src/quota.js';
import { hashKey } from '../src/hash.js';
import { STATE_KEY } from '../src/hostsource.js';

// 2026-10-15: both free keys hit the 500/day quota for about an hour and nothing showed it. The popup said "Off on
// this site" (the site check won over the model error), and even where it showed, it was a bare "HTTP 429".
const KEY = 'synthetic-gemini-key-0123456789';
const googleBody = (code, status, message, details = []) => JSON.stringify({ error: { code, status, message, details } });
const fail = (code, status, message = 'failed', details = []) => ({ ok: false, status: code, text: async () => googleBody(code, status, message, details) });
// Google's reply to a bad key: a 400, not a 401, and the reason says so.
const badKey = () => fail(400, 'INVALID_ARGUMENT', `API key not valid. Please pass a valid API key. (${KEY})`,
  [{ '@type': 'type.googleapis.com/google.rpc.ErrorInfo', reason: 'API_KEY_INVALID', domain: 'googleapis.com' }]);
const perMinute = () => fail(429, 'RESOURCE_EXHAUSTED', 'quota', [
  { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerMinutePerProjectPerModel-FreeTier', quotaValue: '15' }] },
  { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '36s' }]);
const perDay = () => fail(429, 'RESOURCE_EXHAUSTED', 'quota', [
  { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [{ quotaId: 'GenerateRequestsPerDayPerProjectPerModel-FreeTier', quotaValue: '500' }] },
  { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '3600s' }]);
const ok = (ids) => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ passages: ids.map((id) => ({ id, swaps: [] })) }) }] } }] }) });
const modelOf = (url) => String(url).split('/').pop().split(':')[0];

// What the popup shows for a failure the engine threw, the way the worker stores it.
async function shown(model, reply) {
  const err = await requestSwaps({ apiKey: KEY, model, level: 1, batch: [{ id: 'a', text: 'x' }], fetchImpl: async (url) => reply(modelOf(url)) }).catch((e) => e);
  expect(err).toBeInstanceOf(Error);
  return { err, text: modelErrorText({ error: err.message, kind: err.kind, httpStatus: err.status, googleStatus: err.googleStatus, retryAt: err.resumeAt }) };
}

describe('model error notice', () => {
  test('each failure gets plain words, the HTTP code and when it retries', async () => {
    const lite = 'gemini-3.5-flash-lite';
    expect((await shown(lite, () => fail(403, 'PERMISSION_DENIED'))).text).toBe('Gemini rejected the key (403). Paste a new one below.');
    expect((await shown(lite, () => fail(401, 'UNAUTHENTICATED'))).text).toBe('Gemini rejected the key (401). Paste a new one below.');
    const key400 = await shown(lite, badKey);
    expect(key400.text).toBe('Gemini rejected the key (400). Paste a new one below.');
    expect(key400.err.googleStatus).toBe('INVALID_ARGUMENT');
    // A 400 that is not about the key is not blamed on it.
    expect((await shown(lite, () => fail(400, 'INVALID_ARGUMENT', 'Invalid JSON payload'))).text).toBe('Gemini request failed (400 INVALID_ARGUMENT).');
    expect((await shown(lite, () => fail(503, 'UNAVAILABLE'))).text).toBe('Gemini is busy (503). Retrying.');
    expect((await shown(lite, () => fail(500, 'INTERNAL'))).text).toBe('Gemini is busy (500). Retrying.');
    expect((await shown(lite, () => { throw new DOMException('signal timed out', 'TimeoutError'); })).text).toBe('Gemini is busy (timed out). Retrying.');
    expect((await shown(lite, () => { throw new TypeError('Failed to fetch'); })).text).toBe("Can't reach Gemini.");
    // A TypeError after Google answered is not a connection problem.
    const broken = await shown(lite, () => ({ ok: true, status: 200, json: async () => { throw new TypeError('body stream already read'); } }));
    expect(broken.text).toBe('Gemini request failed: gemini-3.5-flash-lite: body stream already read');
    const minute = await shown(lite, perMinute);
    expect(minute.text).toBe('Gemini rate limit (429). Retrying shortly.');
    expect(minute.err.googleStatus).toBe('RESOURCE_EXHAUSTED');
    const day = await shown(lite, perDay);
    expect(day.err).toMatchObject({ kind: 'daily', status: 429, googleStatus: 'RESOURCE_EXHAUSTED' });
    expect(day.text).toBe(`Daily Gemini limit reached (429); resumes about ${clockTime(day.err.resumeAt)}`);
    expect(day.text).toMatch(/^Daily Gemini limit reached \(429\); resumes about \d{1,2}:\d{2}/);
    // Once the resume time has passed, an old time would read as tomorrow's.
    expect(modelErrorText({ error: day.err.message, kind: 'daily', httpStatus: 429, retryAt: day.err.resumeAt }, day.err.resumeAt + 1))
      .toBe('Daily Gemini limit reached (429); should work again with the next page');
    // A refused key is refused for every model, so it wins over the other model's failure.
    expect((await shown('gemini-3.8-flash', (m) => (m === 'gemini-3.8-flash' ? badKey() : fail(503, 'UNAVAILABLE')))).text).toMatch(/^Gemini rejected the key \(400\)/);
    expect((await shown('gemini-3.8-flash', (m) => (m === 'gemini-3.8-flash' ? fail(503, 'UNAVAILABLE') : perMinute()))).text).toBe('Gemini rate limit (429). Retrying shortly.');
    // The local cap's message stays as it is; a success shows nothing.
    const local = `Daily limit of ${DAILY_MODEL_CALLS} model calls reached; French resumes tomorrow`;
    expect(modelErrorText({ error: local, kind: 'local' })).toBe(local);
    expect(modelErrorText({ error: '', model: 'gemini-3.5-flash-lite' })).toBe('');
    expect(modelErrorText(null)).toBe('');
    expect(errorKind({ status: 404 })).toBe('other');
  });

  test('one model failing over to another that answers is not an error', async () => {
    const res = await requestSwaps({ apiKey: KEY, model: 'gemini-3.8-flash', level: 1, batch: [{ id: 'a', text: 'x' }],
      fetchImpl: async (url) => (modelOf(url) === 'gemini-3.8-flash' ? fail(503, 'UNAVAILABLE') : ok(['a'])) });
    expect(res.model).toBe('gemini-3.5-flash-lite');
  });

  test('the key never reaches the error, even when Google echoes it', async () => {
    const err = await callGemini({ fetchImpl: async () => badKey(), apiKey: KEY, model: 'gemini-3.5-flash-lite', body: {} }).catch((e) => e);
    expect(err).toMatchObject({ status: 400, googleStatus: 'INVALID_ARGUMENT', keyRejected: true });
    expect(JSON.stringify({ ...err, message: err.message })).not.toContain(KEY);
  });

  // The real worker and the real popup with a fake chrome: badge "!" over "NEW", cleared by the next success; the
  // popup's error line shows on a site that is off, apart from the site status; no system notifications.
  test('worker and popup: badge precedence, error on an off site, cleared on success', async () => {
    const names = ['chrome', 'fetch', 'setTimeout', 'document', 'window'];
    const saved = Object.fromEntries(names.map((k) => [k, globalThis[k]]));
    const realNow = Date.now;
    const realTimeout = globalThis.setTimeout;
    globalThis.setTimeout = (fn, ms, ...rest) => (ms >= 10000 ? 0 : realTimeout(fn, ms, ...rest));
    const tick = () => new Promise((done) => realTimeout(done, 5));
    const data = {
      settings: { enabled: true, newSitesEnabled: true, siteOverrides: { 'off.example': false } },
      apiKey: KEY,
      reloadedFor: '0.2.2', // already reloaded once for 0.2.2 and still old: the NEW badge is the fallback
      [STATE_KEY]: { version: 't.1', stage: 1, paused: false, sites: 'all', fetchedAt: Date.now(),
        words: [{ fr: 'et', en: 'and', hint: 'ay', status: 'active' }] },
    };
    const listeners = [];
    const badge = { text: '', color: '', title: '' };
    let diskVersion = '0.2.2';
    let gemini = () => badKey();
    let geminiCalls = 0;
    const on = (arr = []) => ({ addListener: (fn) => arr.push(fn) });
    const dispatch = (msg, sender) => new Promise((done) => { if (!listeners.some((fn) => fn(msg, sender, done))) done(undefined); });
    const popupSender = { id: 'fw-test', url: 'chrome-extension://fw-test/src/popup.html' };
    const page = { id: 'fw-test', tab: { id: 1 }, url: 'https://example.com/article' };
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
        sendMessage: (msg) => dispatch(msg, popupSender),
        reload: () => { throw new Error('not expected'); },
      },
      action: {
        setBadgeText: async ({ text }) => { badge.text = text; },
        setBadgeBackgroundColor: async ({ color }) => { badge.color = color; },
        setBadgeTextColor: async () => {},
        setTitle: async ({ title }) => { badge.title = title; },
      },
      tabs: { query: async () => [{ id: 2, url: 'https://off.example/post' }], sendMessage: async () => {} },
      alarms: { create: async () => {}, onAlarm: on() },
      permissions: { getAll: async () => ({ origins: ['<all_urls>'] }), contains: async () => true, onAdded: on(), onRemoved: on() },
      scripting: { getRegisteredContentScripts: async () => [], updateContentScripts: async () => {},
        unregisterContentScripts: async () => {}, registerContentScripts: async () => {} },
      // no chrome.notifications: the extension has no such permission, and calling it would throw here
    };
    globalThis.fetch = async (url) => {
      if (String(url).startsWith('chrome-extension://')) return { ok: true, json: async () => ({ version: diskVersion }) };
      geminiCalls++;
      return gemini(modelOf(url));
    };
    const ask = async (text) => {
      const { revision } = await dispatch({ type: 'config' }, page);
      const key = `${revision}:${hashKey(text)}`;
      const res = await dispatch({ type: 'swaps', revision, items: [{ key, text }] }, page);
      for (let i = 0; i < 20; i++) await tick(); // the badge after a success is set without holding up the reply
      return res;
    };
    const html = await Bun.file(new URL('../src/popup.html', import.meta.url)).text();
    let popups = 0;
    const openPopup = async () => {
      const win = new Window({ url: 'chrome-extension://fw-test/src/popup.html' });
      win.document.write(html.replace(/<script[^>]*><\/script>/, ''));
      Object.assign(globalThis, { window: win, document: win.document });
      await import(`../src/popup.js?modelerror-${++popups}`);
      for (let i = 0; i < 100 && !win.document.getElementById('operation').textContent; i++) await tick();
      const el = (id) => win.document.getElementById(id);
      return { operation: el('operation').textContent, modelError: el('modelError').textContent, site: el('siteName').textContent };
    };
    try {
      await import('../src/background.js?modelerror');
      await dispatch({ type: 'status' }, popupSender);
      expect(badge.text).toBe('NEW');

      // Every model refused the key: the error wins over NEW, and nothing stored or shown carries the key.
      const res = await ask('The garden was quiet and the book was good.');
      expect(res.error).toBeTruthy();
      expect(badge).toMatchObject({ text: '!', color: '#c5221f' });
      expect(badge.title).toBe('French Weave: Gemini rejected the key (400). Paste a new one below.');
      expect(data.modelStatus).toMatchObject({ kind: 'key', httpStatus: 400, googleStatus: 'INVALID_ARGUMENT' });
      expect(JSON.stringify([data.modelStatus, res, badge])).not.toContain(KEY);
      await dispatch({ type: 'status' }, popupSender); // the popup's status check keeps the error badge
      expect(badge.text).toBe('!');

      // The popup on a site that is off: the site line says so, and the model error has its own line.
      const off = await openPopup();
      expect(off).toEqual({ site: 'off.example', operation: 'Off on this site', modelError: 'Gemini rejected the key (400). Paste a new one below.' });

      // Pasting a new key clears the key error; the next request says whether it works.
      await dispatch({ type: 'save', apiKey: KEY }, popupSender);
      expect(data.modelStatus.error).toBe('');
      expect(badge.text).toBe('NEW');

      // A refusal of the old key that lands after a new key was pasted doesn't bring the error back.
      gemini = async () => { await dispatch({ type: 'save', apiKey: 'synthetic-new-key-987654321' }, popupSender); return badKey(); };
      await ask('A quiet passage and a garden with a book.');
      expect(data.modelStatus.error).toBe('');
      expect(badge.text).toBe('NEW');
      await dispatch({ type: 'save', apiKey: KEY }, popupSender);

      // Whatever an error message says, the key in it is never stored or shown.
      gemini = () => { throw new Error(`proxy refused ${KEY}`); };
      const leaky = await ask('One more quiet passage and a book to read.');
      expect(data.modelStatus.error).toBe('gemini-3.5-flash-lite: proxy refused [key]');
      expect(JSON.stringify([data.modelStatus, leaky, badge])).not.toContain(KEY);
      expect(badge.text).toBe('!');

      // A wait with no request of its own keeps the code of the request that started it.
      gemini = () => perMinute();
      await ask('Another quiet passage with and in it here.');
      expect(modelErrorText(data.modelStatus)).toBe('Gemini rate limit (429). Retrying shortly.');
      const before = geminiCalls;
      await ask('A third quiet passage with and in it here today.');
      expect(geminiCalls).toBe(before); // cooling down
      expect(data.modelStatus).toMatchObject({ kind: 'rate', httpStatus: 429, googleStatus: 'RESOURCE_EXHAUSTED' });
      expect(data.modelStatus.retryAt).toBeGreaterThan(Date.now());

      // A minute later the next success clears the error, and NEW shows again.
      Date.now = () => realNow() + 61000;
      await dispatch({ type: 'save', settings: { model: 'gemini-3.8-flash' } }, popupSender);
      const { revision } = await dispatch({ type: 'config' }, page);
      const text = 'Maybe the best part was walking home and reading.';
      const key = `${revision}:${hashKey(text)}`;
      gemini = (m) => (m === 'gemini-3.8-flash' ? fail(503, 'UNAVAILABLE') : ok([key])); // Flash busy, Lite answers
      await dispatch({ type: 'swaps', revision, items: [{ key, text }] }, page);
      for (let i = 0; i < 20; i++) await tick();
      expect(data.modelStatus).toMatchObject({ error: '', model: 'gemini-3.5-flash-lite' });
      expect(badge.text).toBe('NEW');
      expect(badge.title).toBe('French Weave');
      expect((await openPopup()).modelError).toBe('');

      diskVersion = '0.2.1'; // reloaded by hand
      await dispatch({ type: 'status' }, popupSender);
      expect(badge.text).toBe('');
    } finally {
      Object.assign(globalThis, saved);
      Date.now = realNow;
    }
  }, 30000);
});
