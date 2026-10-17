import { test, expect } from 'bun:test';
import { createUsage, cleanEvent, domainOf, errorText, outcomeOf, fallbacksOf, failureKind, batchFields, todayLine,
  BUFFER_KEY, TOGGLE_KEY, MAX_EVENTS, FLUSH_AT } from '../src/usage.js';
import * as pageUsage from '../src/usage-page.js';
import { memoryStorage } from '../src/cache.js';

// Key-shaped test values, built at run time so no literal key sits in the file (the commit leak scanner).
const FAKE_KEY = ['AIza', 'SyD', '-not-a-real-key-', 'x'.repeat(12)].join('');
const FAKE_ANTHROPIC = ['sk', '-ant-', 'api03-', 'y'.repeat(16)].join('');

// A storage area like chrome.storage.local (get takes a list), the native host as a function, timers held by hand.
function harness({ channel = 'dev', toggle, host = async () => ({ ok: true, appended: 0 }), saved } = {}) {
  const storage = memoryStorage({ hostChannel: channel, ...(toggle === undefined ? {} : { [TOGGLE_KEY]: toggle }),
    ...(saved ? { [BUFFER_KEY]: saved } : {}) });
  const sent = [];
  const timers = [];
  let t = 1_700_000_000_000;
  const usage = createUsage({ storage, version: '0.2.11', now: () => t,
    sendNative: async (msg) => { sent.push(structuredClone(msg)); return host(msg); },
    paidSpend: async () => null, paidCaps: async () => [],
    setTimer: (fn, ms) => { timers.push({ fn, ms }); return timers.length; }, clearTimer: () => {} });
  const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((r) => setTimeout(r, 0)); };
  return { storage, sent, timers, usage, settle, advance: (ms) => { t += ms; }, stored: async () => (await storage.get([BUFFER_KEY]))[BUFFER_KEY] };
}

test('usage: only the fields in the schema are kept; a URL keeps only its hostname', () => {
  const url = 'https://News.Example.com./2026/10/private-path/article?q=secret+query&token=abc#section';
  expect(domainOf(url)).toBe('news.example.com');
  expect(domainOf('chrome://extensions')).toBe('');
  expect(domainOf('not a url at all')).toBe('');
  const e = cleanEvent('page', { domain: url, on: true, level: 2, tier: 'gemini', text: 'The whole page text here', url, title: 'Secret title' }, 5, '0.2.11');
  expect(e).toEqual({ at: 5, k: 'page', v: '0.2.11', domain: 'news.example.com', on: true, level: 2, tier: 'gemini' });
  expect(cleanEvent('made_up', { a: 1 })).toBeNull();
  // A word from the list, never a sentence; a status or reason is a short word, never text.
  expect(cleanEvent('word', { word: 'Très', what: 'peek' }).word).toBe('très');
  expect(cleanEvent('word', { word: 'I typed my whole message into this box and it went somewhere', what: 'seen' }).word).toBeUndefined();
  expect(cleanEvent('queue', { what: 'retry', reason: 'rate limit; retrying shortly' }).reason).toBeUndefined();
  // A setting's value is a switch, a number or a short word; a key or any free text is dropped.
  expect(cleanEvent('setting', { name: 'modelChoice', from: 'auto', to: 'claude-haiku-5-5' })).toMatchObject({ from: 'auto', to: 'claude-haiku-5-5' });
  expect(cleanEvent('setting', { name: 'apiKey', to: FAKE_KEY }).to).toBeUndefined();
  // Error text: no URLs, nothing shaped like a key.
  const text = errorText(new Error(`HTTP 400 from https://api.example.com/v1/x?key=${FAKE_KEY} for ${FAKE_ANTHROPIC}`));
  expect(text).not.toContain('AIza');
  expect(text).not.toContain('sk-ant');
  expect(text).not.toContain('api.example.com');
});

test('usage: the dev gate: nothing kept or sent without the dev channel, with the log off, or without a host', async () => {
  for (const setup of [{ channel: '' }, { channel: 'public' }, { channel: 'dev', toggle: false }]) {
    const h = harness({ ...setup, saved: { events: [{ at: 1, k: 'popup' }] } });
    h.usage.record('popup', {});
    h.usage.record('page', { domain: 'https://example.com/a' });
    await h.settle();
    expect(await h.usage.flush({ today: true })).toEqual({ on: false });
    expect(h.sent).toEqual([]);
    expect(await h.stored()).toBeUndefined(); // a buffer left by an earlier dev worker is removed too
    expect(h.timers).toEqual([]);
  }
  // No native host: Chrome's error closes the gate and drops the buffer until a sync reaches a host again.
  const h = harness({ host: async () => { throw new Error('Specified native messaging host not found.'); } });
  h.usage.record('popup', {});
  await h.settle();
  expect((await h.usage.flush()).sent).toBe(0);
  expect(h.usage.isOn()).toBe(false);
  expect(await h.stored()).toBeUndefined();
  h.usage.record('popup', {});
  await h.settle();
  expect(await h.stored()).toBeUndefined();
  await h.usage.host('Specified native messaging host not found.');
  expect(h.usage.isOn()).toBe(false);
  await h.usage.host(null); // a sync reached the host
  expect(h.usage.isOn()).toBe(true);
});

test('usage: the buffer is bounded, persisted for the next worker, and flushed in batches', async () => {
  let fail = false;
  const h = harness({ host: async () => (fail ? { ok: false, error: 'disk full' } : { ok: true, appended: 1 }) });
  await h.settle();
  expect(h.sent).toEqual([]); // worker_start waits in the buffer
  expect((await h.stored()).events.map((e) => e.k)).toEqual(['worker_start']);
  expect(h.timers.map((t) => t.ms)).toEqual([60000]); // a flush is due within a minute
  // Below FLUSH_AT nothing is sent; at FLUSH_AT the buffer goes at once.
  fail = true;
  for (let i = 0; i < FLUSH_AT + MAX_EVENTS; i++) h.usage.record('word', { what: 'seen', word: 'et' });
  await h.settle();
  const saved = await h.stored();
  expect(saved.events.length).toBeLessThanOrEqual(MAX_EVENTS);
  expect(saved.overflow + saved.events.length).toBe(FLUSH_AT + MAX_EVENTS + 1);
  expect(saved.hostFails).toBeGreaterThan(0); // the failed sends are counted, and the events kept
  // The host back: everything left goes, with how many were lost to the bound and that the host had failed.
  fail = false;
  h.sent.length = 0;
  const r = await h.usage.flush();
  expect(r.sent).toBeGreaterThan(0);
  const kinds = h.sent.flatMap((m) => m.events.map((e) => e.k));
  expect(kinds).toContain('overflow');
  expect(kinds.filter((k) => k === 'word').length).toBeLessThanOrEqual(MAX_EVENTS);
  await h.settle();
  await h.usage.flush();
  expect(h.sent.at(-1).events.map((e) => e.k)).toEqual(['host_error']);
  expect((await h.stored()).events).toEqual([]);

  // The next worker picks up an unsent buffer and logs how long no worker ran.
  const next = harness({ saved: { events: [{ at: 1, k: 'popup', v: '0.2.11' }], aliveAt: 1_700_000_000_000 - 45000 } });
  await next.settle();
  const events = (await next.stored()).events;
  expect(events.map((e) => e.k)).toEqual(['popup', 'worker_start']);
  expect(events[1]).toMatchObject({ idleMs: 45000, prevAliveAt: 1_700_000_000_000 - 45000 });
  // The popup's line: flush and today's numbers from the host.
  next.sent.length = 0;
  const host = async (msg) => ({ ok: true, appended: msg.events.length, today: { batches: 12, passages: 50, cached: 20, p90Ms: 9840, usd: 0.0123 } });
  const withToday = harness({ host });
  expect(await withToday.usage.today()).toEqual({ ok: true, dev: true, on: true, line: 'Today: 12 batches, 40% cached, p90 9.8 s, $0.0123', error: '' });
  expect(withToday.sent[0].today).toBe(true);
  expect(withToday.sent[0].events.map((e) => e.k)).toEqual(['worker_start', 'popup']);
});

// Regression: a failing host once made save() flush at once, the failed flush saved again, and that save flushed
// again, forever (each send a copy of the full buffer: 23 GB in 8 minutes). A failed send must wait for the timer.
test('usage: a failing host is retried by the timer, never in a loop, and the buffer stays at its cap', async () => {
  // Past a few sends the host never answers, so the old loop stops and fails this test instead of eating the machine.
  let calls = 0;
  const h = harness({ host: () => (++calls > 5 ? new Promise(() => {}) : Promise.resolve({ ok: false, error: 'disk full' })) });
  await h.settle();
  for (let round = 0; round < 3; round++) {
    for (let i = 0; i < MAX_EVENTS * 2; i++) h.usage.record('word', { what: 'seen', word: 'et' });
    await h.settle();
    await h.settle();
  }
  expect(h.sent.length).toBe(1); // the one send at FLUSH_AT; after it failed, only the timer may try again
  expect((await h.stored()).events.length).toBe(MAX_EVENTS);
  expect((await h.stored()).hostFails).toBe(1);
  // Each timer firing is one more send, and a failure leaves exactly one timer behind it.
  const pending = h.timers.length;
  h.timers.at(-1).fn();
  await h.settle();
  expect(h.sent.length).toBe(2);
  expect(h.timers.length).toBe(pending + 1);
});

test('usage: the popup switch turns the log off and back on', async () => {
  const h = harness();
  h.usage.record('popup', {});
  await h.usage.toggle(false);
  expect(h.sent.at(-1).events.at(-1)).toMatchObject({ k: 'setting', name: 'usageLog', from: true, to: false });
  expect(await h.stored()).toBeUndefined();
  const before = h.sent.length;
  h.usage.record('popup', {});
  await h.settle();
  await h.usage.flush();
  expect(h.sent.length).toBe(before);
  await h.usage.toggle(true);
  await h.settle();
  expect((await h.stored()).events.map((e) => e.name)).toEqual(['usageLog']);
});

test('usage: batch events from the swaps reply, with outcome, model, tokens, cost and fallbacks', async () => {
  const h = harness();
  const sender = { tab: { id: 7, title: 'Some page' }, url: 'https://reading.example/2026/10/notes?ref=secret' };
  const msg = { type: 'swaps', items: [{ key: 'a', text: 'Passage one with words and more words' }, { key: 'b', text: 'Passage two' }, { key: 'c', text: 'x' }] };
  const fresh = { results: { a: [{ o: 'and', f: 'et', status: 'active' }], b: [] }, model: 'claude-haiku-5-5', provider: 'anthropic', keyName: 'anthropic',
    step: 1, thinking: 'low', requests: 1, ms: 5600, costUsd: 0.0017, usage: { promptTokens: 1200, answerTokens: 90, thinkingTokens: 40 },
    dropped: { notListed: 1 }, errors: ['gemini-3.1-flash-lite: timeout'], failures: [{ provider: 'gemini', keyName: 'main', timeout: true }] };
  const reply = await h.usage.batch(msg, sender, async () => {
    h.usage.note(msg, { fresh });
    h.advance(6000);
    return { results: { c: [{ o: 'but', f: 'mais', status: 'known' }], ...fresh.results } };
  });
  expect(reply.results.a).toHaveLength(1);
  await h.settle();
  const batch = (await h.stored()).events.find((e) => e.k === 'batch');
  expect(batch).toEqual({ at: batch.at, k: 'batch', v: '0.2.11', domain: 'reading.example', passages: 3, cached: 1, ms: 6000, swaps: 2,
    byStatus: { known: 1, active: 1 }, outcome: 'ok', provider: 'anthropic', model: 'claude-haiku-5-5', key: 'anthropic', step: 1,
    thinking: 'low', chunks: 1, modelMs: 5600, usd: 0.0017, dropped: { notListed: 1 }, tokensIn: 1200, tokensOut: 90, tokensThinking: 40,
    fallbacks: [{ provider: 'gemini', model: 'gemini-3.1-flash-lite', key: 'main', kind: 'timeout' }] });
  expect(JSON.stringify(await h.stored())).not.toMatch(/notes|secret|Passage|ref=/);

  // A failed batch: the engine's error, the cached passages it still returned, the retry time.
  const failed = { type: 'swaps', items: [{ key: 'a', text: 't' }] };
  const error = Object.assign(new Error('gemini-3.1-flash-lite: HTTP 429; gemini-3.5-flash-lite (backup key): HTTP 503'), { kind: 'busy', status: 503,
    retryAfterMs: 30000, failures: [{ provider: 'gemini', keyName: 'main', status: 429 }, { provider: 'gemini', keyName: 'backup', status: 503 }] });
  await h.usage.batch(failed, sender, async () => { h.usage.note(failed, { error }); return { results: {}, error: error.message, retryAfterMs: 30000 }; });
  // A tab closed while its batch was out; a stale reply.
  let finish;
  const out = h.usage.batch({ type: 'swaps', items: [{}, {}] }, sender, () => new Promise((done) => { finish = done; }));
  await h.settle();
  h.usage.batch({ type: 'swaps', items: [{}] }, sender, async () => ({ results: {}, stale: true }));
  await h.settle();
  // (the tab-closed listener is chrome's; here the token is marked by the recorder's own listener, wired below)
  finish({ results: {} });
  await out;
  await h.settle();
  const events = (await h.stored()).events.filter((e) => e.k === 'batch');
  expect(events[1]).toMatchObject({ outcome: '5xx', retryAfterMs: 30000, cached: 0, error: expect.any(String),
    fallbacks: [{ model: 'gemini-3.1-flash-lite', key: 'main', kind: '429' }, { model: 'gemini-3.5-flash-lite', key: 'backup', kind: '5xx' }] });
  expect(events.map((e) => e.outcome)).toEqual(['ok', '5xx', 'stale', 'cached']);
});

test('usage: a tab closed with its batch in flight', async () => {
  const removed = [];
  const storage = memoryStorage({ hostChannel: 'dev' });
  const usage = createUsage({ storage, sendNative: async () => ({ ok: true }), onTabRemoved: { addListener: (fn) => removed.push(fn) },
    paidSpend: async () => null, paidCaps: async () => [], setTimer: () => 0, clearTimer: () => {} });
  let finish;
  const sender = { tab: { id: 3 }, url: 'https://x.com/someone/status/123?s=20' };
  const out = usage.batch({ items: [{}, {}, {}] }, sender, () => new Promise((done) => { finish = done; }));
  await new Promise((r) => setTimeout(r, 5));
  removed[0](3);
  finish({ results: {} });
  await out;
  await new Promise((r) => setTimeout(r, 20));
  const events = (await storage.get([BUFFER_KEY]))[BUFFER_KEY].events;
  expect(events.find((e) => e.k === 'queue')).toMatchObject({ domain: 'x.com', what: 'tab_closed', n: 3 });
  expect(events.find((e) => e.k === 'batch')).toMatchObject({ tabClosed: true, domain: 'x.com' });
});

test('usage: page views, words, settings and page queue events never carry a path, text or key', async () => {
  const h = harness();
  const url = 'https://www.example.org/account/inbox/2026?q=my+private+search&id=42#private';
  const sender = { tab: { id: 1, title: 'Inbox - private' }, url };
  const ctx = { level: 2, tier: 'gemini', paused: false, origins: ['<all_urls>'], settings: { enabled: true, newSitesEnabled: true, siteOverrides: { 'www.example.org': false } } };
  const activeOn = () => false;
  expect(await h.usage.pageView({ type: 'config', load: true }, sender, Promise.resolve(ctx), activeOn)).toBe(ctx);
  await h.usage.pageView({ type: 'config' }, sender, Promise.resolve(ctx), activeOn); // not a page load: no event
  h.usage.word('peek', { fr: 'très', status: 'shaky' }, sender);
  h.usage.word('seen', { fr: 'This is page text, not a word from the list', status: 'active' }, sender);
  h.usage.settings({ enabled: true, levelOverride: 0, siteOverrides: {} }, { enabled: false, levelOverride: 2, siteOverrides: { 'www.example.org': false } },
    { apiKey: FAKE_KEY, anthropicKey: '' });
  h.usage.pageEvents({ events: [{ what: 'retry', n: 1, attempt: 2, reason: 'rate_limit' }, { what: 'typed', text: 'secret' },
    { what: 'gave_up', n: 1, reason: 'Daily limit reached for https://example.org/x' }] }, sender);
  await h.usage.host(`Error at https://www.example.org/account?token=${FAKE_KEY}`);
  await h.settle();
  const events = (await h.stored()).events;
  const all = JSON.stringify(events);
  for (const leak of ['account', 'inbox', 'private', 'q=', '42', 'AIza', 'page text', 'typed', 'secret', '/']) expect(all).not.toContain(leak);
  expect(events.find((e) => e.k === 'page')).toMatchObject({ domain: 'www.example.org', on: false, why: 'site_off', level: 2, tier: 'gemini' });
  expect(events.filter((e) => e.k === 'page')).toHaveLength(1);
  expect(events.filter((e) => e.k === 'word').map((e) => e.word)).toEqual(['très', undefined]);
  expect(events.filter((e) => e.k === 'setting').map((e) => [e.name, e.from, e.to])).toEqual([
    ['enabled', true, false], ['levelOverride', 0, 2], ['site', null, false], ['apiKey', undefined, 'set'], ['anthropicKey', undefined, 'cleared']]);
  expect(events.filter((e) => e.k === 'queue').map((e) => [e.what, e.reason])).toEqual([['retry', 'rate_limit'], ['gave_up', undefined]]);
  expect(events.find((e) => e.k === 'host_error').error).toContain('[url]');
});

test('usage: outcomes and fallback kinds', () => {
  expect(outcomeOf({ kind: 'local' })).toBe('cap_reached');
  expect(outcomeOf({ kind: 'wait' })).toBe('cooling_down');
  expect(outcomeOf({ kind: 'daily', status: 429 })).toBe('daily_quota');
  expect(outcomeOf({ kind: 'rate', status: 429, failures: [{ provider: 'gemini', status: 429 }] })).toBe('429');
  expect(outcomeOf({ kind: 'busy', failures: [{ provider: 'gemini', timeout: true }] })).toBe('timeout');
  expect(outcomeOf({ kind: 'key', message: 'No model key' })).toBe('no_key');
  expect(outcomeOf({ kind: 'other', message: 'anthropic: Anthropic stopped: max_tokens', failures: [{ provider: 'anthropic', status: 402, credits: true }] })).toBe('provider_stopped');
  expect(outcomeOf({ kind: 'other', message: 'gemini-3.1-flash-lite: Incomplete model response', failures: [{ provider: 'gemini' }] })).toBe('parse_error');
  expect(outcomeOf({ name: 'AbortError', message: 'The operation was aborted' })).toBe('aborted');
  expect(failureKind({ provider: 'gemini', status: 403 })).toBe('key_rejected');
  expect(failureKind({ provider: 'openrouter', status: 402 })).toBe('provider_stopped');
  expect(failureKind({ provider: 'anthropic' }, 'Anthropic stopped: refusal')).toBe('unusable_reply');
  expect(failureKind({ provider: 'gemini', status: 404 })).toBe('http_404');
  expect(fallbacksOf(['Anthropic claude-haiku-5-5: HTTP 529', 'gemini-3.5-flash-lite (backup key): Unexpected token'],
    [{ provider: 'anthropic', keyName: 'anthropic', status: 529 }, { provider: 'gemini', keyName: 'backup' }])).toEqual([
    { provider: 'anthropic', model: 'claude-haiku-5-5', key: 'anthropic', kind: '5xx' },
    { provider: 'gemini', model: 'gemini-3.5-flash-lite', key: 'backup', kind: 'parse_error' }]);
  expect(batchFields({ msg: { items: [{}, {}] }, sender: { url: 'https://a.example/x', tab: { title: 'Medication dosage guide' } }, reply: { results: { a: [], b: [] } }, ctx: { tier: 'gemini' } }).outcome).toBe('title_blocked');
  expect(todayLine({ batches: 0, passages: 0, cached: 0, p90Ms: null, usd: 0 })).toBe('Today: 0 batches, nothing cached, p90 -, $0.0000');
});

test('usage-page: retries, give-ups, unmounted and cancelled passages, only while the log is on', async () => {
  const sent = [];
  let config = { usage: false };
  pageUsage.init(() => config, async (msg) => { sent.push(msg); });
  pageUsage.retry(1, 3, { error: 'Model rate limit; retrying shortly' });
  pageUsage.sendNow();
  expect(sent).toEqual([]);
  config = { usage: true };
  pageUsage.retry(1, 3, { error: 'Model rate limit; retrying shortly', retryAfterMs: 5000 });
  pageUsage.retry(4, 3, { error: 'Gemini is busy (503)' });
  pageUsage.retry(5, 3, { error: 'Gemini is busy (503)' }); // already given up: not counted again
  const gone = { isConnected: false };
  const here = { isConnected: true };
  const pending = new Map([['k1', { text: 'private passage text', els: new Set([gone]) }], ['k2', { text: 'more text', els: new Set([gone, here]) }]]);
  pageUsage.unmounted(pending);
  pageUsage.unmounted(pending); // counted once
  pageUsage.cancelled(2, 5);
  pageUsage.cancelled(0, 0);
  pageUsage.sendNow();
  expect(sent).toEqual([{ type: 'usage', events: [
    { what: 'retry', n: 1, attempt: 1, reason: 'rate_limit' },
    { what: 'gave_up', n: 1, reason: 'busy' },
    { what: 'unmounted', n: 1 },
    { what: 'cancelled', n: 2, pending: 5, reason: 'page_changed' }] }]);
  expect(JSON.stringify(sent)).not.toContain('text');
});
