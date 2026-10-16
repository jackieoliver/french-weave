// Service worker: word state and the Gemini key from the Claude Code plugin (native host), site access,
// one model call at a time, results back to pages, seen/flip/peek events back to the plugin.
// Keys stay here; pages only get a config without them.
import { createCache, chromeStorage } from './cache.js';
import { requestSwaps } from './engine.js';
import { cleanSettings, newSitesDefault, siteEnabled, hasSiteAccess } from './settings.js';
import { resolveLevel, exactFr, isZeroFrench, wordCount } from './levels.js';
import { hashKey } from './hash.js';
import { HOST, refresh, readCached, queueEvents, flushEvents, shownToday } from './hostsource.js';
import { DAILY_MODEL_CALLS, callsToday, countCall, spentToday, saveSpent } from './quota.js';
import { modelErrorText, replaceLegacyStatus } from './modelerror.js';
import { FALLBACK_MODEL } from './gemini.js';

const store = chrome.storage.local;
const cache = createCache(chromeStorage);
const send = (message) => chrome.runtime.sendNativeMessage(HOST, message);
const ALARM = 'sync';
const SYNC_MINUTES = 30; // word statuses change at most a few times a day
const FLUSH_DELAY_MS = 10000;
// A pause from Claude Code (fw.py pause) has to stop page text going to Gemini within minutes, not at the next
// 30-minute sync: before a model call, the word state is re-read from the native host when the last read is older.
export const HOST_CHECK_MS = 2 * 60000;
let hostChecked = 0;
let hostCheck = null;
function recheckHost() {
  if (!hostCheck && Date.now() - hostChecked >= HOST_CHECK_MS) {
    hostCheck = syncWords().catch(() => {}).finally(() => { hostCheck = null; });
  }
  return hostCheck;
}
const cooldown = new Map(); // model -> rate-limit cooldown end; worker memory is enough

const serial = () => {
  let chain = Promise.resolve();
  return (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
};
const modelCall = serial(); // one model call at a time
const locked = serial(); // storage read-modify-writes one at a time, or concurrent ones drop data

const LOCAL_CAP_ERROR = `Daily limit of ${DAILY_MODEL_CALLS} model calls reached; French resumes tomorrow`;
const localCapped = async () => await callsToday(chromeStorage) >= DAILY_MODEL_CALLS;

const ready = (async () => {
  // Content scripts run on every enabled site, so stored keys are kept out of their reach.
  if (store.setAccessLevel) await store.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const { settings } = await store.get('settings');
  if (settings?.apiKey) await store.set({ apiKey: settings.apiKey }); // 0.1 kept a pasted key in settings
  const clean = cleanSettings(settings);
  await store.set({ settings: clean });
  // A status stored before 0.2.2 has no kind, and its text can be wrong (0.2.1 called the per-day quota a rate
  // limit); nothing would clear it until a request worked. Replace it on every worker start, updates included.
  await locked(async () => {
    const { modelStatus, dailyQuota } = await store.get(['modelStatus', 'dailyQuota']);
    const models = [clean.model, FALLBACK_MODEL[clean.model]].filter(Boolean);
    const replaced = replaceLegacyStatus(modelStatus, dailyQuota, models, Date.now(), (await localCapped()) ? LOCAL_CAP_ERROR : '');
    if (replaced) await store.set({ modelStatus: replaced });
  });
})();

// What pages get. The revision changes whenever anything that affects swaps does, so stale replies are dropped.
async function context() {
  await ready;
  const data = await store.get(['settings', 'wordState', 'apiKey', 'hostKey', 'epoch']);
  const state = data.wordState?.words?.length ? data.wordState : null;
  const saved = cleanSettings(data.settings);
  const settings = { ...saved, newSitesEnabled: newSitesDefault(saved, state?.sites) };
  const level = resolveLevel(saved, state?.stage).effective;
  const hasKey = !!(data.apiKey || data.hostKey);
  const paused = !!state?.paused;
  const { origins = [] } = await chrome.permissions.getAll();
  const revision = hashKey(JSON.stringify([data.epoch || '', settings, level, state?.version || '', paused, hasKey, origins]));
  return { settings, level, revision, hasKey, paused, origins, stage: state?.stage || 0 };
}

const activeOn = (ctx, url) => ctx.hasKey && !ctx.paused && siteEnabled(ctx.settings, url) && hasSiteAccess(url, ctx.origins);

async function broadcast(type = 'config') {
  const config = await context();
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map((t) => chrome.tabs.sendMessage(t.id, { type, config })));
}

async function swaps(msg, sender) {
  const ctx = await context();
  if (msg.revision !== ctx.revision || !activeOn(ctx, sender.url)) return { results: {}, stale: true };
  if (!Array.isArray(msg.items) || msg.items.length > 8) throw new Error('Invalid text batch');
  const items = msg.items.filter((i) => i && typeof i.text === 'string' && i.text.length <= 2000 &&
    wordCount(i.text) >= 6 && !isZeroFrench(i.text) && i.key === `${ctx.revision}:${hashKey(i.text)}`);
  const results = await cache.getMany(items.map((i) => i.key));
  const misses = items.filter((i) => !(i.key in results));
  if (!misses.length) return { results };
  if (recheckHost()) {
    await hostCheck;
    if ((await context()).revision !== ctx.revision) return { results, stale: true };
  }
  let usedKey = '';
  try {
    const fresh = await modelCall(async () => {
      if ((await context()).revision !== ctx.revision) return null;
      if (await localCapped()) throw Object.assign(new Error(LOCAL_CAP_ERROR), { kind: 'local' });
      const { wordState, apiKey, hostKey } = await store.get(['wordState', 'apiKey', 'hostKey']);
      usedKey = apiKey || hostKey || '';
      const fetchImpl = async (...args) => { await countCall(chromeStorage); return fetch(...args); };
      const daily = await spentToday(chromeStorage); // a spent daily quota outlives the worker, so it is kept in storage
      try {
        return await requestSwaps({ apiKey: apiKey || hostKey, model: ctx.settings.model, level: ctx.level, words: wordState?.words, language: wordState?.language, fetchImpl,
          shownToday: await shownToday(chromeStorage), cooldown, daily, batch: misses.map((i) => ({ id: i.key, text: i.text })) });
      } finally {
        await saveSpent(chromeStorage, daily);
      }
    });
    return await locked(async () => {
      if (!fresh || (await context()).revision !== ctx.revision) return { results: {}, stale: true };
      await cache.setMany(fresh.results);
      await store.set({ modelStatus: { at: Date.now(), error: '', model: fresh.model } });
      return { results: { ...results, ...fresh.results } };
    }).finally(() => void showBadge());
  } catch (e) {
    const error = await failed(e, usedKey);
    return { results, error, retryAfterMs: e?.retryAfterMs };
  }
}

// Every candidate model failed (after the engine's own fallback). Stores what the popup and badge need; a wait
// with no request of its own (every model cooling down) keeps the code and case of the request that started it.
async function failed(e, usedKey) {
  const { apiKey, hostKey } = await store.get(['apiKey', 'hostKey']);
  const keys = [apiKey, hostKey, usedKey].filter((k) => typeof k === 'string' && k.length >= 8);
  const error = keys.reduce((text, k) => text.split(k).join('[key]'), String(e?.message || 'Model request failed')).slice(0, 500);
  // A key pasted while this request was out: its refusal says nothing about the new key.
  if (e?.kind === 'key' && usedKey && usedKey !== (apiKey || hostKey)) return error;
  const now = Date.now();
  await locked(async () => {
    const { modelStatus: prev } = await store.get('modelStatus');
    const wait = e?.kind === 'wait';
    const kind = wait ? (prev?.error && prev.kind !== 'local' && prev.kind) || 'rate' : e?.kind || 'other';
    const same = prev?.error && prev.kind === kind ? prev : {}; // a daily limit read from storage has no body of its own
    const retryAt = e?.resumeAt || (e?.retryAfterMs ? now + e.retryAfterMs : 0);
    await store.set({ modelStatus: { at: now, error, kind, retryAt,
      httpStatus: (wait ? same.httpStatus : e?.status) || 0,
      googleStatus: (wait ? same.googleStatus : e?.googleStatus) || (kind === 'daily' && same.googleStatus) || '' } });
  });
  await showBadge();
  return error;
}

// Toolbar badge: a small muted dot while the last model request failed, cleared by the next success; otherwise "NEW"
// while an update waits for a reload. No system notifications: free keys run out often, and a pop-up each time would
// nag. Chrome draws every badge as an opaque rounded square (a transparent background gets Chrome's default orange;
// any other alpha is drawn opaque), so the error badge is a square in the gray of Chrome's placeholder icon, which
// merges into the icon and leaves only the dot showing. ERROR_DOT_COLOR is the one to change.
export const ERROR_DOT_COLOR = '#c7837d'; // muted rose; tried: amber #c4a35a, light slate #b9bec6
export const PLACEHOLDER_GRAY = '#6b6b6b'; // Chrome's gray "F" tile, measured in light and dark themes
export const BADGE_ERROR = { text: '●', color: PLACEHOLDER_GRAY, textColor: ERROR_DOT_COLOR };
export const BADGE_NEW = { text: 'NEW', color: '#1a73e8', textColor: '#ffffff' };
let updateWaiting = null; // set by checkUpdate; null until it has run in this worker
async function showBadge(checkFirst = true) {
  try {
    const { modelStatus } = await store.get('modelStatus');
    const problem = modelErrorText(modelStatus);
    if (!problem && updateWaiting === null) { if (checkFirst) await checkUpdate(); return; }
    const badge = problem ? BADGE_ERROR : updateWaiting ? BADGE_NEW : null;
    await chrome.action.setBadgeText({ text: badge?.text || '' });
    if (badge) {
      await chrome.action.setBadgeBackgroundColor?.({ color: badge.color });
      await chrome.action.setBadgeTextColor?.({ color: badge.textColor });
    }
    await chrome.action.setTitle?.({ title: problem ? `French Weave: ${problem}` : 'French Weave' });
  } catch { /* the badge is a hint; never let it break a reply */ }
}

const flush = () => locked(() => flushEvents({ storage: chromeStorage, send }));
let flushTimer = null;
function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

// Events only for words in the plugin's word state; queueEvents keeps seen and peek to once per word per day.
async function record(msg, sender) {
  const ctx = await context();
  if (!activeOn(ctx, sender.url) || !['seen', 'flip', 'peek'].includes(msg.event) || typeof msg.word !== 'string') return { ok: false };
  const word = (await readCached(chromeStorage))?.words.find((w) => exactFr(w.fr) === exactFr(msg.word));
  if (!word) return { ok: false };
  await locked(() => queueEvents(chromeStorage, [{ word: word.fr, kind: msg.event }]));
  scheduleFlush();
  return { ok: true };
}

// A new word-state version clears the decision cache, because cached swaps were chosen against the old list.
async function syncWords() {
  hostChecked = Date.now();
  await flush();
  const res = await refresh({ storage: chromeStorage, send });
  if (res.changed) await locked(() => cache.clear());
  await broadcast();
  return { ok: !res.error, error: res.error, count: res.state?.words?.length || 0, stage: res.state?.stage || 0 };
}

async function clearCache() {
  const removed = await locked(async () => {
    await store.set({ epoch: crypto.randomUUID() });
    return cache.clear();
  });
  await broadcast('retry');
  return { ok: true, removed };
}

// msg.settings: a partial patch; msg.siteOverride: { host, enabled: true | false | null (reset) }; msg.apiKey.
async function save(msg) {
  await locked(async () => {
    const saved = await store.get('settings');
    const merged = { ...saved.settings, ...msg.settings };
    if (msg.siteOverride && typeof msg.siteOverride.host === 'string') {
      merged.siteOverrides = { ...saved.settings?.siteOverrides };
      if (msg.siteOverride.enabled === null) delete merged.siteOverrides[msg.siteOverride.host];
      else merged.siteOverrides[msg.siteOverride.host] = msg.siteOverride.enabled;
    }
    const patch = { settings: cleanSettings(merged) };
    if (typeof msg.apiKey === 'string') {
      if (msg.apiKey.length > 500) throw new Error('Key is too long');
      patch.apiKey = msg.apiKey.trim();
      // A new key answers "Gemini rejected the key" and has its own limits; the next request says whether it works.
      const { modelStatus } = await store.get('modelStatus');
      if (['key', 'daily', 'rate'].includes(modelStatus?.kind)) patch.modelStatus = { at: Date.now(), error: '' };
      patch.dailyQuota = {};
      cooldown.clear();
    }
    await store.set(patch);
  });
  await showBadge();
  await broadcast();
  return { ok: true };
}

async function status() {
  const config = await context();
  const data = await store.get(['wordState', 'apiKey', 'hostKey', 'modelStatus']);
  return { config, words: data.wordState?.words?.length || 0, fetchedAt: data.wordState?.fetchedAt || 0,
    pastedKey: !!data.apiKey, hostKey: !!data.hostKey, modelStatus: data.modelStatus || null,
    update: await checkUpdate() };
}

// An update replaces this folder on disk (setup, or the Claude Code hook after a plugin update), but Chrome keeps
// running the loaded copy. Compare the manifest on disk with the running one and reload from disk by ourselves,
// once per disk version, after any model call in flight and pending storage writes. If the running copy still
// differs after that (or reload fails), mark the toolbar icon so the user can reload by hand.
export const RELOADED_KEY = 'reloadedFor';
async function checkUpdate() {
  try {
    const disk = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json();
    const waiting = disk.version && disk.version !== chrome.runtime.getManifest().version ? String(disk.version) : '';
    if (waiting && (await store.get(RELOADED_KEY))[RELOADED_KEY] !== waiting) {
      await store.set({ [RELOADED_KEY]: waiting });
      try {
        await locked(() => modelCall(() => chrome.runtime.reload()));
        return waiting; // normally not reached: the worker is gone
      } catch { /* fall back to the badge */ }
    }
    updateWaiting = waiting;
    await showBadge();
    return waiting;
  } catch {
    return '';
  }
}

// Pages may only ask for config, swaps and events; everything else is popup-only.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || sender.id !== chrome.runtime.id) return false;
  const popup = sender.url === chrome.runtime.getURL('src/popup.html');
  const page = sender.tab && /^https?:\/\//.test(sender.url || '');
  const handlers = {
    config: () => { if (page) void recheckHost(); return context(); }, // a page load also notices a pause or resume
    swaps: () => swaps(msg, sender),
    event: () => record(msg, sender),
    status, syncWords, clearCache,
    save: () => save(msg),
  };
  if (!handlers[msg.type] || (!popup && !(page && ['config', 'swaps', 'event'].includes(msg.type)))) return false;
  ready.then(handlers[msg.type]).then(reply, (e) => reply({ error: String(e?.message || e) }));
  return true;
});

// Granted origins (all sites, or one at a time from the popup) decide where the content script is injected.
// X is in the manifest, so it works without a grant.
let registrations = Promise.resolve();
function registerSites() {
  const p = registrations.then(async () => {
    const { origins = [] } = await chrome.permissions.getAll();
    const matches = [...new Set(origins.flatMap((o) => o === '<all_urls>' ? ['http://*/*', 'https://*/*'] : [o]))]
      .filter((o) => /^(https?|\*):\/\//.test(o) && !o.includes('googleapis.com'));
    const existing = await chrome.scripting.getRegisteredContentScripts({ ids: ['weave-sites'] });
    if (!matches.length) {
      if (existing.length) await chrome.scripting.unregisterContentScripts({ ids: ['weave-sites'] });
      return;
    }
    const script = { id: 'weave-sites', matches, js: ['src/content-loader.js'], css: ['src/content.css'], runAt: 'document_idle',
      excludeMatches: ['https://x.com/*', 'https://twitter.com/*'] };
    if (existing.length) await chrome.scripting.updateContentScripts([script]);
    else await chrome.scripting.registerContentScripts([script]);
  });
  registrations = p.catch(() => {});
  return p;
}
const permissionsChanged = () => { void registerSites().then(() => broadcast('retry')).catch(() => {}); };
chrome.permissions.onAdded.addListener(permissionsChanged);
chrome.permissions.onRemoved.addListener(permissionsChanged);

// create() replaces an alarm of the same name, so calling it on both events is safe. Startup matters
// because disabling and re-enabling the extension clears alarms without firing onInstalled.
function arm() {
  chrome.alarms.create(ALARM, { periodInMinutes: SYNC_MINUTES });
  void syncWords().catch(() => {});
  void checkUpdate();
}
chrome.runtime.onInstalled.addListener(arm);
chrome.runtime.onStartup.addListener(arm);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name !== ALARM) return;
  void syncWords().catch(() => {});
  void checkUpdate();
});
void ready.then(registerSites).catch(() => {});
void ready.then(() => showBadge(false)); // a stored failure shows from the start, without an update check
