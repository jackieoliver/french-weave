// Service worker: word state and the Gemini key from the Claude Code plugin (native host), site access,
// one model call at a time, results back to pages, seen/flip/peek events back to the plugin.
// Keys stay here; pages only get a config without them.
import { createCache, chromeStorage } from './cache.js';
import { requestSwaps } from './engine.js';
import { cleanSettings, newSitesDefault, siteEnabled, hasSiteAccess } from './settings.js';
import { resolveLevel, exactFr, isZeroFrench, wordCount } from './levels.js';
import { hashKey } from './hash.js';
import { HOST, refresh, readCached, queueEvents, flushEvents, shownToday } from './hostsource.js';

const store = chrome.storage.local;
const cache = createCache(chromeStorage);
const send = (message) => chrome.runtime.sendNativeMessage(HOST, message);
const ALARM = 'sync';
const SYNC_MINUTES = 30; // word statuses change at most a few times a day
const FLUSH_DELAY_MS = 10000;
const cooldown = new Map(); // model -> rate-limit cooldown end; worker memory is enough

const serial = () => {
  let chain = Promise.resolve();
  return (fn) => { const p = chain.then(fn); chain = p.catch(() => {}); return p; };
};
const modelCall = serial(); // one model call at a time
const locked = serial(); // storage read-modify-writes one at a time, or concurrent ones drop data

const ready = (async () => {
  // Content scripts run on every enabled site, so stored keys are kept out of their reach.
  if (store.setAccessLevel) await store.setAccessLevel({ accessLevel: 'TRUSTED_CONTEXTS' });
  const { settings } = await store.get('settings');
  if (settings?.apiKey) await store.set({ apiKey: settings.apiKey }); // 0.1 kept a pasted key in settings
  await store.set({ settings: cleanSettings(settings) });
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
  try {
    const fresh = await modelCall(async () => {
      if ((await context()).revision !== ctx.revision) return null;
      const { wordState, apiKey, hostKey } = await store.get(['wordState', 'apiKey', 'hostKey']);
      return requestSwaps({ apiKey: apiKey || hostKey, model: ctx.settings.model, level: ctx.level, words: wordState?.words,
        shownToday: await shownToday(chromeStorage), cooldown, batch: misses.map((i) => ({ id: i.key, text: i.text })) });
    });
    return await locked(async () => {
      if (!fresh || (await context()).revision !== ctx.revision) return { results: {}, stale: true };
      await cache.setMany(fresh.results);
      await store.set({ modelStatus: { at: Date.now(), error: '', model: fresh.model } });
      return { results: { ...results, ...fresh.results } };
    });
  } catch (e) {
    const error = e?.message || 'Model request failed';
    await store.set({ modelStatus: { at: Date.now(), error } });
    return { results, error, retryAfterMs: e?.retryAfterMs };
  }
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
    }
    await store.set(patch);
  });
  await broadcast();
  return { ok: true };
}

async function status() {
  const config = await context();
  const data = await store.get(['wordState', 'apiKey', 'hostKey', 'modelStatus']);
  return { config, words: data.wordState?.words?.length || 0, fetchedAt: data.wordState?.fetchedAt || 0,
    pastedKey: !!data.apiKey, hostKey: !!data.hostKey, modelStatus: data.modelStatus || null };
}

// Pages may only ask for config, swaps and events; everything else is popup-only.
chrome.runtime.onMessage.addListener((msg, sender, reply) => {
  if (!msg || sender.id !== chrome.runtime.id) return false;
  const popup = sender.url === chrome.runtime.getURL('src/popup.html');
  const page = sender.tab && /^https?:\/\//.test(sender.url || '');
  const handlers = {
    config: context,
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
}
chrome.runtime.onInstalled.addListener(arm);
chrome.runtime.onStartup.addListener(arm);
chrome.alarms.onAlarm.addListener((a) => { if (a.name === ALARM) void syncWords().catch(() => {}); });
void ready.then(registerSites).catch(() => {});
