// Local usage log for the dev build: what the extension does, when, and how long it takes, so Jackie and her agents
// can see how she uses it (`python3 scripts/fw.py usage`). It records only while the native host says this is the dev
// build (hostChannel "dev", from app/CHANNEL) and the popup's "Usage log" toggle is on (on by default there); the
// public build, or no native host, records nothing.
// Events wait in a small bounded buffer (chrome.storage.local, so a worker that MV3 stops loses nothing) and go to the
// native host in batches; the host appends them to ~/.french-weave/usage/YYYY-MM-DD.jsonl and keeps 60 days
// (scripts/fwusage.py). Nothing leaves the computer. Never recorded: page text, URLs (only the site's hostname),
// keys, anything typed. Words from the reader's own list are recorded.
// No chrome APIs here: the worker passes in storage, the native-message function and its listeners.
import { localDay } from './hostsource.js';
import { siteEnabled, hasSiteAccess, cleanSettings } from './settings.js';
import { anthropicToday, openRouterToday, paidBlocked } from './quota.js';
import { isZeroFrench } from './levels.js';

export const BUFFER_KEY = 'usageLog';
export const TOGGLE_KEY = 'usageOn'; // false: the popup's "Usage log" is off
export const MAX_EVENTS = 500; // in the buffer; the oldest go first, and how many is recorded (overflow)
export const FLUSH_AT = 100; // send at once from this many events
// Else this long after the first unsent one. Under 30 s, because Chrome stops an idle service worker after 30 s and
// its timers with it; a buffer a stopped worker left is sent by the worker's 5-minute alarm (background.js).
export const FLUSH_DELAY_MS = 20000;

// ---- what may be stored ----

const WORD = /^[A-Za-z0-9_.:+-]{1,40}$/;
const MODEL = /^[A-Za-z0-9_.:/+-]{1,60}$/;
const VERSION = /^[0-9][0-9A-Za-z.+-]{0,39}$/;
const HOSTNAME = /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]*[a-z0-9])?)*$/;
const LIST_WORD = /^[\p{L}\p{M}'’ -]{1,40}$/u; // a word from the reader's list (French, or another language's)
const KEYLIKE = /\bAIza[\w-]{8,}|\bsk-[\w-]{8,}|[A-Za-z0-9_-]{24,}/g;
const keyLike = (v) => /AIza|\bsk-|[A-Za-z0-9_-]{24,}/.test(v);

// The site of a page: its hostname, lowercased, without a trailing dot. Never the path, query or fragment.
export function domainOf(url) {
  try {
    const u = new URL(String(url));
    if (!/^https?:$/.test(u.protocol)) return '';
    const host = u.hostname.toLowerCase().replace(/\.$/, '');
    return HOSTNAME.test(host) ? host : '';
  } catch {
    const host = String(url || '').toLowerCase().replace(/\.$/, '');
    return HOSTNAME.test(host) ? host : '';
  }
}

// An error message, short and without URLs or anything shaped like a key.
export function errorText(e) {
  return String(e?.message || e || '').replace(/\bhttps?:\/\/\S+/g, '[url]').replace(KEYLIKE, '[key]').slice(0, 120);
}

const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? Math.round(v * 1e6) / 1e6 : undefined);
const TYPES = {
  num,
  int: (v) => (Number.isInteger(v) && v >= 0 && v <= 1e14 ? v : undefined),
  bool: (v) => (typeof v === 'boolean' ? v : undefined),
  word: (v) => (typeof v === 'string' && WORD.test(v) && !keyLike(v) ? v : undefined),
  model: (v) => (typeof v === 'string' && MODEL.test(v) ? v : undefined),
  ver: (v) => (typeof v === 'string' && VERSION.test(v) ? v : undefined),
  domain: (v) => domainOf(v) || undefined,
  listWord: (v) => (typeof v === 'string' && LIST_WORD.test(v.trim()) ? v.trim().toLowerCase() : undefined),
  error: (v) => errorText(v) || undefined,
  // A setting's value: a switch, a number or a short word (a model choice, a reasoning level); never free text.
  value: (v) => (typeof v === 'boolean' || v === null ? v : num(v) ?? (typeof v === 'string' && WORD.test(v) && !keyLike(v) ? v : undefined)),
  counts: (v) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
    const out = Object.fromEntries(Object.entries(v).filter(([k, n]) => WORD.test(k) && num(n) !== undefined).slice(0, 16)
      .map(([k, n]) => [k, num(n)]));
    return Object.keys(out).length ? out : undefined;
  },
  fallbacks: (v) => {
    if (!Array.isArray(v) || !v.length) return undefined;
    return v.slice(0, 8).map((f) => ({ provider: TYPES.word(f?.provider), model: TYPES.model(f?.model), key: TYPES.word(f?.key),
      kind: TYPES.word(f?.kind) || 'error' })).map((f) => Object.fromEntries(Object.entries(f).filter(([, x]) => x !== undefined)));
  },
};

// Every kind of event and its fields. Anything else is dropped, so a new field has to be added here first.
export const SCHEMA = {
  worker_start: { prevAliveAt: 'int', idleMs: 'int' },
  installed: { reason: 'word', from: 'ver', to: 'ver' },
  reload: { from: 'ver', to: 'ver' },
  page: { domain: 'domain', on: 'bool', why: 'word', level: 'int', tier: 'word' },
  batch: { domain: 'domain', level: 'int', tier: 'word', passages: 'int', cached: 'int', outcome: 'word', provider: 'word',
    model: 'model', key: 'word', step: 'int', reasoning: 'word', thinking: 'word', chunks: 'int', ms: 'int', modelMs: 'int',
    tokensIn: 'int', tokensOut: 'int', tokensThinking: 'int', usd: 'num', fallbacks: 'fallbacks', swaps: 'int',
    byStatus: 'counts', dropped: 'counts', retryAfterMs: 'int', tabClosed: 'bool', spent: 'counts', error: 'error' },
  queue: { domain: 'domain', what: 'word', n: 'int', pending: 'int', attempt: 'int', reason: 'word' },
  word: { domain: 'domain', what: 'word', word: 'listWord', status: 'word' },
  popup: {},
  setting: { name: 'word', domain: 'domain', from: 'value', to: 'value' },
  host_error: { where: 'word', error: 'error', n: 'int' },
  cap_hit: { provider: 'word', reason: 'word', usd: 'num', cap: 'num' },
  overflow: { n: 'int' },
};

// The stored form of an event ({ at, k, v, ...fields }), or null for an unknown kind.
export function cleanEvent(kind, fields = {}, at = Date.now(), version = '') {
  const schema = SCHEMA[kind];
  if (!schema) return null;
  const out = { at: Math.round(at), k: kind };
  if (VERSION.test(version)) out.v = version;
  for (const [name, type] of Object.entries(schema)) {
    if (!(name in fields)) continue;
    const value = TYPES[type](fields[name]);
    if (value !== undefined) out[name] = value;
  }
  return out;
}

// ---- outcomes ----

// What one failed request was, for the batch's fallbacks (engine.js failures, with its "label: message" text).
export function failureKind(f = {}, message = '') {
  if (f.timeout) return 'timeout';
  if (f.daily) return 'daily_quota';
  if (f.status === 429) return '429';
  if (f.status >= 500) return '5xx';
  if (f.credits || [401, 402, 403].includes(f.status) || (f.status === 400 && f.keyRejected)) {
    return f.provider === 'gemini' ? 'key_rejected' : 'provider_stopped';
  }
  if (f.network) return 'network';
  if (/abort/i.test(message)) return 'aborted';
  if (/stopped: /i.test(message)) return 'unusable_reply'; // Anthropic's refusal or max_tokens
  if (/json|parse|incomplete|unexpected|unterminated/i.test(message)) return 'parse_error';
  return f.status ? `http_${f.status}` : 'error';
}

// The requests that failed before the batch was served (or before it failed), in order: engine.js returns its
// errors ("label: message") and failures (provider, keyName, status, ...) side by side.
export function fallbacksOf(errors = [], failures = []) {
  return failures.map((f, i) => {
    const text = String(errors[i] || '');
    const cut = text.indexOf(': ');
    const label = cut > 0 ? text.slice(0, cut) : '';
    const model = label.replace(/ \(backup key\)$/, '').replace(/^(OpenRouter|Anthropic) /, '');
    return { provider: f?.provider, model, key: f?.keyName, kind: failureKind(f, cut > 0 ? text.slice(cut + 2) : text) };
  });
}

// What a failed batch ran into (the engine's chosen failure, or a wait or cap before any request).
export function outcomeOf(e) {
  if (e?.kind === 'local') return 'cap_reached';
  if (e?.kind === 'wait') return 'cooling_down';
  if (e?.kind === 'daily') return 'daily_quota';
  if (e?.name === 'AbortError') return 'aborted';
  const failures = Array.isArray(e?.failures) ? e.failures : [];
  if (failures.length && failures.every((f) => f.provider !== 'gemini' && failureKind(f) === 'provider_stopped')) return 'provider_stopped';
  switch (e?.kind) {
    case 'rate': return '429';
    case 'busy': return e.status >= 500 ? '5xx' : 'timeout';
    case 'key': return !e.status && !failures.length ? 'no_key' : e.keyName && !['main', 'backup'].includes(e.keyName) ? 'provider_stopped' : 'key_rejected';
    case 'network': return 'network';
    default: {
      const msg = String(e?.message || '');
      const last = msg.split('; ').at(-1);
      return failureKind({ ...(failures.at(-1) || {}), status: e?.status }, last);
    }
  }
}

// Why a page is off, or '' when it is on (background.js activeOn, the same checks in the same order).
export function whyOff(ctx, url) {
  if (!ctx) return 'unknown';
  if (!ctx.settings?.enabled) return 'extension_off';
  if (ctx.tier === 'none') return 'no_key';
  if (ctx.paused) return 'paused';
  if (!siteEnabled(ctx.settings, url)) return 'site_off';
  if (!hasSiteAccess(url, ctx.origins)) return 'no_access';
  return '';
}

const swapCounts = (results) => {
  let swaps = 0;
  const byStatus = {};
  for (const list of Object.values(results || {})) {
    if (!Array.isArray(list)) continue;
    for (const s of list) {
      swaps++;
      const status = typeof s?.status === 'string' ? s.status : 'builtin';
      byStatus[status] = (byStatus[status] || 0) + 1;
    }
  }
  return { swaps, byStatus };
};

// The batch event for one swaps request: what the page asked (msg.items), the worker's reply, and what swaps() noted
// on the way (fresh: requestSwaps' result; error: what it threw).
export function batchFields({ msg, sender, reply, thrown, note = {}, ctx, ms, tabClosed, spent }) {
  const passages = Array.isArray(msg?.items) ? msg.items.length : 0;
  const results = reply?.results || {};
  const fresh = note.fresh;
  const e = thrown || note.error;
  const out = { domain: sender?.url, level: ctx?.level, tier: ctx?.tier, reasoning: ctx?.settings?.reasoning, passages, ms,
    ...swapCounts(results), ...(tabClosed ? { tabClosed } : {}), ...(spent ? { spent } : {}) };
  if (fresh) {
    Object.assign(out, { provider: fresh.provider || undefined, model: fresh.model || undefined, key: fresh.keyName, step: fresh.step,
      thinking: fresh.thinking, chunks: fresh.requests, modelMs: fresh.ms, usd: fresh.costUsd, dropped: fresh.dropped,
      tokensIn: fresh.usage?.promptTokens, tokensOut: fresh.usage?.answerTokens, tokensThinking: fresh.usage?.thinkingTokens,
      fallbacks: fallbacksOf(fresh.errors, fresh.failures),
      cached: Math.max(0, passages - Object.keys(fresh.results || {}).length) });
  }
  if (thrown) out.outcome = 'error';
  else if (reply?.stale) out.outcome = 'stale';
  else if (e) {
    Object.assign(out, { outcome: outcomeOf(e), cached: Object.keys(results).length, retryAfterMs: e.retryAfterMs,
      fallbacks: fallbacksOf(String(e.message || '').split('; '), e.failures || []), error: e });
  } else if (fresh) out.outcome = fresh.skipped ? 'no_candidates' : 'ok';
  else if (ctx?.tier === 'local') Object.assign(out, { outcome: 'local', cached: 0 });
  else if (isZeroFrench(String(sender?.tab?.title || ''))) Object.assign(out, { outcome: 'title_blocked', cached: 0 });
  else Object.assign(out, { outcome: 'cached', cached: passages });
  if (out.outcome === 'stale' && !fresh) out.cached = Object.keys(results).length;
  return out;
}

// The popup's line: "Today: 12 batches, 40% cached, p90 9.8 s, $0.0123".
export function todayLine(t) {
  if (!t) return '';
  const cached = t.passages ? `${Math.round((t.cached / t.passages) * 100)}% cached` : 'nothing cached';
  const p90 = Number.isFinite(t.p90Ms) ? `p90 ${(t.p90Ms / 1000).toFixed(1)} s` : 'p90 -';
  return `Today: ${t.batches || 0} batches, ${cached}, ${p90}, $${Number(t.usd || 0).toFixed(4)}`;
}

// Chrome's error when no native host is installed for this extension.
const NO_HOST = /native messaging host not found|host not found|not installed/i;
const PAGE_QUEUE = { retry: 1, gave_up: 1, unmounted: 1, cancelled: 1 };
const KEY_FIELDS = ['apiKey', 'backupKey', 'openRouterKey', 'anthropicKey'];
const SETTING_NAMES = ['enabled', 'newSitesEnabled', 'modelChoice', 'reasoning', 'openRouterDailyUsd', 'anthropicDailyUsd', 'levelOverride'];

// ---- the recorder ----

// Today's paid spend per provider, as counted for the daily caps (quota.js): failed paid requests included.
export async function paidSpendOf(storage) {
  const [anthropic, openrouter] = await Promise.all([anthropicToday(storage), openRouterToday(storage)]);
  const out = Object.fromEntries(Object.entries({ anthropic: anthropic.usd, openrouter: openrouter.usd }).filter(([, usd]) => usd > 0));
  return Object.keys(out).length ? out : null;
}

// Paid providers stopped for today: past the popup's cap, out of credits, or the key refused.
export async function paidCapsOf(storage) {
  const { settings } = await storage.get(['settings']);
  const s = cleanSettings(settings);
  const out = [];
  for (const [provider, today, cap] of [['anthropic', await anthropicToday(storage), s.anthropicDailyUsd],
    ['openrouter', await openRouterToday(storage), s.openRouterDailyUsd]]) {
    const blocked = paidBlocked(today, cap);
    if (blocked && (today.usd > 0 || today.stopped)) out.push({ provider, blocked, usd: today.usd, cap });
  }
  return out;
}

// storage: { get, set, remove } (chrome.storage.local); sendNative(message) -> reply; version: the running version.
// context(): the worker's page config (for level and tier); paidSpend(): { anthropic, openrouter } USD today;
// paidCaps(): [{ provider, blocked, usd, cap }]; onInstalled / onTabRemoved: chrome event objects, or absent.
export function createUsage({ storage, sendNative, version = '', now = Date.now, context = async () => null,
  paidSpend = () => paidSpendOf(storage), paidCaps = () => paidCapsOf(storage), onInstalled, onTabRemoved,
  setTimer = setTimeout, clearTimer = clearTimeout } = {}) {
  const mem = [];
  const meta = { overflow: 0, hostFails: 0, aliveAt: 0, caps: { day: '', seen: [] } };
  let on = false; // the gate, as last read
  let known = false; // read at least once
  let hostDown = false; // the native host is missing: nothing is kept until a sync reaches it again
  let stored = true; // a buffer may be in storage (a previous worker's), to remove when the gate is closed
  let timer = null;
  let saving = null;
  let flushing = null;
  let dirty = false;
  const notes = new WeakMap(); // swaps message -> what swaps() noted
  const inflight = new Map(); // tab id -> Set of batch tokens

  async function gate() {
    const s = await storage.get(['hostChannel', TOGGLE_KEY]);
    on = s?.hostChannel === 'dev' && s?.[TOGGLE_KEY] !== false && !hostDown;
    known = true;
    return on;
  }

  function record(kind, fields) {
    if (known && !on) return;
    const event = cleanEvent(kind, fields, now(), version);
    if (!event) return;
    mem.push(event);
    if (mem.length > MAX_EVENTS) meta.overflow += mem.splice(0, mem.length - MAX_EVENTS).length;
    void persist();
  }

  async function save() {
    if (!(await gate())) { await drop(); return; }
    meta.aliveAt = now();
    await storage.set({ [BUFFER_KEY]: { events: mem.slice(), ...meta } });
    stored = true;
    // A full batch goes at once, unless a send is out or the last one failed: then the timer retries.
    if (mem.length >= FLUSH_AT && !flushing && !meta.hostFails) void flush();
    else if (mem.length && !timer) timer = setTimer(() => { timer = null; void flush(); }, FLUSH_DELAY_MS);
  }

  // Gate closed (public build, no host, log off): nothing in memory or storage.
  async function drop() {
    mem.length = 0;
    meta.overflow = 0;
    if (timer) { clearTimer(timer); timer = null; }
    if (stored) { stored = false; await storage.remove([BUFFER_KEY]); }
  }

  // Writes the buffer once per burst of records: one write at a time, and one more if anything came in meanwhile.
  function persist() {
    dirty = true;
    if (!saving) {
      saving = (async () => {
        await loaded;
        while (dirty) { dirty = false; await save(); }
      })().catch(() => {}).finally(() => { saving = null; });
    }
    return saving;
  }

  // Sends the buffer to the native host. today: also ask for today's numbers (the popup's line).
  // One send at a time; a flush asked for meanwhile runs after it.
  function flush(options) {
    const run = (flushing || Promise.resolve()).then(() => sendBuffer(options));
    const mine = run.catch(() => {});
    flushing = mine;
    void mine.then(() => { if (flushing === mine) flushing = null; });
    return run;
  }
  async function sendBuffer({ today = false } = {}) {
    await loaded;
    await saving;
    if (timer) { clearTimer(timer); timer = null; }
    if (!(await gate())) { await drop(); return { on: false }; }
    const batch = mem.slice(0, 1000);
    const lost = meta.overflow;
    const events = lost ? [...batch, cleanEvent('overflow', { n: lost }, now(), version)] : batch;
    if (!events.length && !today) return { on: true, sent: 0 };
    try {
      const reply = await sendNative({ type: 'usage', events, ...(today ? { today: true } : {}) });
      if (!reply?.ok) throw new Error(reply?.error || 'the native host refused usage events');
      mem.splice(0, batch.length);
      meta.overflow -= lost;
      if (meta.hostFails) { record('host_error', { where: 'usage', n: meta.hostFails }); meta.hostFails = 0; }
      await persist();
      return { on: true, sent: events.length, today: reply.today || null, off: !!reply.off };
    } catch (e) {
      meta.hostFails++;
      // No native host at all: keep nothing until a word sync reaches one again (host()).
      if (NO_HOST.test(String(e?.message || e))) {
        hostDown = true;
        on = false;
        await drop();
      } else await persist();
      return { on: true, sent: 0, error: errorText(e) };
    }
  }

  // The previous worker's buffer, and when it last recorded: the time between is how long no worker ran (MV3 stops an
  // idle one after about 30 seconds).
  const loaded = (async () => {
    const saved = (await storage.get([BUFFER_KEY]))?.[BUFFER_KEY];
    Object.assign(meta, { overflow: saved?.overflow || 0, hostFails: saved?.hostFails || 0, caps: saved?.caps || meta.caps });
    const prevAliveAt = saved?.aliveAt || 0;
    const start = cleanEvent('worker_start', prevAliveAt ? { prevAliveAt, idleMs: Math.max(0, now() - prevAliveAt) } : {}, now(), version);
    // The previous worker's events, then this start, then anything recorded while this was read.
    mem.unshift(...(Array.isArray(saved?.events) ? saved.events.slice(-MAX_EVENTS) : []), start);
    if (mem.length > MAX_EVENTS) meta.overflow += mem.splice(0, mem.length - MAX_EVENTS).length;
    stored = !!saved;
    if (!(await gate())) await drop();
    else void persist();
  })().catch(() => {});

  onInstalled?.addListener?.((d) => {
    void loaded.then(() => record('installed', { reason: d?.reason, from: d?.previousVersion, to: version }));
  });
  onTabRemoved?.addListener?.((tabId) => {
    const tokens = inflight.get(tabId);
    if (!tokens) return;
    for (const t of tokens) t.closed = true;
    record('queue', { domain: [...tokens][0]?.domain, what: 'tab_closed', n: [...tokens].reduce((sum, t) => sum + t.passages, 0) });
  });

  async function capCheck(outcome) {
    const day = localDay(new Date(now()));
    if (meta.caps.day !== day) meta.caps = { day, seen: [] };
    const hits = [];
    if (outcome === 'cap_reached') hits.push({ provider: 'gemini', reason: 'local' });
    for (const c of await paidCaps()) if (c?.blocked) hits.push({ provider: c.provider, reason: c.blocked, usd: c.usd, cap: c.cap });
    for (const hit of hits) {
      const tag = `${hit.provider}:${hit.reason}`;
      if (meta.caps.seen.includes(tag)) continue;
      meta.caps.seen.push(tag);
      record('cap_hit', hit);
    }
  }

  return {
    record,
    flush,
    isOn: () => on,
    // For the page config: content scripts send their queue events only while the log is on.
    async flag() { await loaded; return on ? { usage: true } : {}; },
    note(msg, info) { if (msg && typeof msg === 'object') notes.set(msg, { ...notes.get(msg), ...info }); },

    // One swaps request from a page: run it, then record what happened. The reply is never held back for this.
    async batch(msg, sender, run) {
      await loaded;
      if (!on) return run();
      const started = now();
      const tabId = sender?.tab?.id;
      const token = { passages: Array.isArray(msg?.items) ? msg.items.length : 0, domain: sender?.url, closed: false };
      if (tabId != null) { if (!inflight.has(tabId)) inflight.set(tabId, new Set()); inflight.get(tabId).add(token); }
      const ctx = context().catch(() => null);
      let reply;
      let thrown;
      try {
        reply = await run();
        return reply;
      } catch (e) {
        thrown = e;
        throw e;
      } finally {
        const ms = now() - started;
        inflight.get(tabId)?.delete(token);
        if (!inflight.get(tabId)?.size) inflight.delete(tabId);
        void (async () => {
          const fields = batchFields({ msg, sender, reply, thrown, note: notes.get(msg), ctx: await ctx, ms, tabClosed: token.closed,
            spent: await paidSpend().catch(() => null) });
          record('batch', fields);
          await capCheck(fields.outcome);
        })().catch(() => {});
      }
    },

    // A page's first config request (content.js sends load: true once per page view).
    async pageView(msg, sender, ctxPromise, activeOn) {
      const ctx = await ctxPromise;
      if (msg?.load && sender?.tab && /^https?:\/\//.test(sender.url || '')) {
        try {
          const active = activeOn(ctx, sender.url);
          record('page', { domain: sender.url, on: active, ...(active ? {} : { why: whyOff(ctx, sender.url) || 'other' }),
            level: ctx.level, tier: ctx.tier });
        } catch { /* never in the way of the reply */ }
      }
      return ctx;
    },

    // Queue counts from a content script (usage-page.js): counts and short reasons only.
    pageEvents(msg, sender) {
      if (!on || !Array.isArray(msg?.events)) return { ok: on };
      for (const e of msg.events.slice(0, 50)) {
        if (!PAGE_QUEUE[e?.what]) continue;
        record('queue', { domain: sender?.url, what: e.what, n: Math.min(Number(e.n) || 0, 1000), pending: e.pending, attempt: e.attempt, reason: e.reason });
      }
      return { ok: true };
    },

    // A seen, peek (gloss hover that stayed) or flip ("Show English") on a word from the reader's list.
    word(what, word, sender) {
      record('word', { domain: sender?.url, what, word: word?.fr, status: word?.status });
    },

    // The popup saved settings: which ones changed, old -> new. Keys only as set or cleared, never their value.
    settings(before = {}, after = {}, msg = {}) {
      for (const name of SETTING_NAMES) {
        if (before[name] !== after[name]) record('setting', { name, from: before[name] ?? null, to: after[name] ?? null });
      }
      const was = before.siteOverrides || {};
      const next = after.siteOverrides || {};
      for (const host of new Set([...Object.keys(was), ...Object.keys(next)])) {
        if (was[host] !== next[host]) record('setting', { name: 'site', domain: host, from: was[host] ?? null, to: next[host] ?? null });
      }
      for (const name of KEY_FIELDS) {
        if (typeof msg[name] === 'string') record('setting', { name, to: msg[name].trim() ? 'set' : 'cleared' });
      }
    },

    // After each word sync: a native-host error, or the host is back (and the gate may have opened or closed).
    async host(error) {
      if (error) {
        if (NO_HOST.test(String(error))) { hostDown = true; on = false; await drop(); return; }
        if (on) record('host_error', { where: 'state', error });
        return;
      }
      hostDown = false;
      await gate();
      if (on && (mem.length || meta.hostFails)) void persist();
    },

    // The worker is about to reload itself into a newer copy on disk: the buffer is saved first.
    async reloading(to) {
      record('reload', { from: version, to });
      await persist();
    },

    // The popup opened (dev build): flush, and today's numbers from the host.
    async today(open = true) {
      await loaded;
      if (open) record('popup', {});
      const r = await flush({ today: true });
      const s = await storage.get(['hostChannel', TOGGLE_KEY]);
      return { ok: true, dev: s?.hostChannel === 'dev', on: s?.[TOGGLE_KEY] !== false, line: todayLine(r.today), error: r.error || '' };
    },

    // The popup's "Usage log" switch. Turning it off records that, sends what is left, then keeps nothing.
    async toggle(next) {
      if (next === false) {
        record('setting', { name: 'usageLog', from: true, to: false });
        await flush();
        await storage.set({ [TOGGLE_KEY]: false });
        await gate();
        await drop();
      } else {
        await storage.set({ [TOGGLE_KEY]: true });
        await gate();
        record('setting', { name: 'usageLog', from: false, to: true });
      }
      return { ok: true, on: next !== false };
    },
  };
}
