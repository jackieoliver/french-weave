// Service worker: word state and the Gemini key from the Claude Code plugin (native host), site access,
// one model call at a time, results back to pages, seen/flip/peek events back to the plugin.
// Keys stay here; pages only get a config without them. Without a key, swaps come from local.js, with no model.
import { createCache, chromeStorage } from './cache.js';
import { requestSwaps, attemptsFor } from './engine.js';
import { cleanSettings, newSitesDefault, siteEnabled, hasSiteAccess } from './settings.js';
import { resolveLevel, exactFr, isZeroFrench, wordCount } from './levels.js';
import { hashKey } from './hash.js';
import { HOST, refresh, readCached, queueEvents, flushEvents, shownToday } from './hostsource.js';
import { DAILY_MODEL_CALLS, callsToday, countCall, spentToday, saveSpent, countDropped, droppedToday, openRouterToday,
  countOpenRouter, anthropicToday, countAnthropic, paidBlocked, clearPaidStop, servedToday, countServed } from './quota.js';
import { modelErrorText, replaceLegacyStatus } from './modelerror.js';
import { API_BASE } from './gemini.js';
import { configFor, reasoningLevels } from './model-config.js';
import { localSwaps, localOff } from './local.js';

const store = chrome.storage.local;
const cache = createCache(chromeStorage);
const send = (message) => chrome.runtime.sendNativeMessage(HOST, message);
const ALARM = 'sync';
const SYNC_MINUTES = 30; // word statuses change at most a few times a day
// An update on disk is picked up within this many minutes while Chrome runs: checkUpdate only fetches the local
// manifest, so it has its own, shorter alarm instead of waiting for the word sync.
export const UPDATE_ALARM = 'update';
export const UPDATE_MINUTES = 5;
// The running version the native host last confirmed it recorded (scripts/fw_host.py, extension-seen.json).
export const REPORTED_KEY = 'versionReported';
const runningVersion = () => String(chrome.runtime.getManifest?.()?.version || '');
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

// The local cap is per Gemini key, each with its own count: a backup key brings its own quota, and a spent main key
// is left out of the chain while the backup still has calls.
const keyCapped = async (which) => await callsToday(chromeStorage, undefined, which) >= DAILY_MODEL_CALLS;
const localCapError = (perKey) => `Daily limit of ${DAILY_MODEL_CALLS} model calls${perKey ? ' per key' : ''} reached; French resumes tomorrow`;
// The Gemini keys in use: main and backup, each pasted, else from setup; the backup only when it differs from the main
// key (the same key pasted twice is one key with one cap).
async function geminiKeys() {
  const { apiKey, hostKey, backupKey, hostBackupKey } = await store.get(['apiKey', 'hostKey', 'backupKey', 'hostBackupKey']);
  const main = apiKey || hostKey || '';
  const backup = backupKey || hostBackupKey || '';
  return { main, backup: backup && backup !== main ? backup : '' };
}
// Capped when every key in use has made its calls today (no key at all is the popup's "add a key", not a cap).
const localCapped = async () => {
  const { main, backup } = await geminiKeys();
  return (!!main || !!backup) && (!main || await keyCapped('main')) && (!backup || await keyCapped('backup'));
};
// Every key the worker holds, for scrubbing error text: none may reach a page, the popup or storage.
const KEY_NAMES = ['apiKey', 'hostKey', 'backupKey', 'hostBackupKey', 'openRouterKey', 'hostOpenRouterKey', 'anthropicKey', 'hostAnthropicKey'];
// Keys the native host hands over from setup; a change to any of them starts it with a clean slate.
const HOST_KEYS = ['hostKey', 'hostBackupKey', 'hostOpenRouterKey', 'hostAnthropicKey'];
// The paid keys in use, each pasted in the popup, else from setup.
async function paidKeys() {
  const k = await store.get(['openRouterKey', 'hostOpenRouterKey', 'anthropicKey', 'hostAnthropicKey']);
  return { openrouter: k.openRouterKey || k.hostOpenRouterKey || '', anthropic: k.anthropicKey || k.hostAnthropicKey || '' };
}

const languageOf = (wordState) => (wordState?.words?.length ? wordState.language || 'French' : 'French');

// The chain the next batch goes through, and the key each provider may use: '' for a key that is missing, spent for
// the day (Gemini's local cap) or stopped (a paid provider past its cap or after a refusal), so engine.js leaves its
// steps out. main and backup are the Gemini keys as set, capped or not. Used by swaps() and the popup's "Next" line.
// The Haiku step's provider follows which keys are set (model-config.js levelFirst): a capped or stopped Anthropic key
// means no Haiku step, not OpenRouter's.
async function planFor(ctx, wordState, choice = ctx.settings.modelChoice) {
  const reasoning = choice === ctx.settings.modelChoice ? ctx.settings.reasoning : 'auto';
  const { main, backup } = await geminiKeys();
  const paid = await paidKeys();
  const mainOut = !main || await keyCapped('main');
  const backupOut = !backup || await keyCapped('backup');
  const openRouterOn = !!paid.openrouter && !paidBlocked(await openRouterToday(chromeStorage), ctx.settings.openRouterDailyUsd);
  const anthropicOn = !!paid.anthropic && !paidBlocked(await anthropicToday(chromeStorage), ctx.settings.anthropicDailyUsd);
  const { design, chain } = configFor(languageOf(wordState), choice, undefined, ctx.level,
    { anthropic: !!paid.anthropic, openrouter: !!paid.openrouter }, reasoning);
  return { design, chain, main, backup, keys: { main: mainOut ? '' : main, backup: backupOut ? '' : backup,
    openrouter: openRouterOn ? paid.openrouter : '', anthropic: anthropicOn ? paid.anthropic : '' } };
}

// The first step of a choice as configured (keys set, caps and cooldowns aside), for the popup's menus and Mode line:
// first, with the reader's reasoning; firstDefault, with Recommended reasoning (the Reasoning menu's first entry);
// recommended, what the Recommended model resolves to.
async function modeInfo(settings, level) {
  const { wordState } = await store.get('wordState');
  const paid = await paidKeys();
  const has = { anthropic: !!paid.anthropic, openrouter: !!paid.openrouter };
  const first = (choice, reasoning) => {
    const s = configFor(languageOf(wordState), choice, undefined, level, has, reasoning).chain[0];
    return s ? { model: s.model, provider: s.provider, thinking: s.thinking } : null;
  };
  return { first: first(settings.modelChoice, settings.reasoning), firstDefault: first(settings.modelChoice),
    recommended: first('auto') };
}

// What the popup's "Next" line names: the first request the next batch would make at the current level, skipping
// steps that are cooling down or out of today's quota (the first one anyway when every step is). null without a
// Gemini key (no model runs) or when no step has a key it may use. choice: the popup's model, or another to ask what
// that one would run (the Auto entry's label).
async function nextModel(ctx, choice) {
  if (ctx.tier !== 'gemini') return null;
  const { wordState } = await store.get('wordState');
  const { chain, keys } = await planFor(ctx, wordState, choice);
  const open = attemptsFor(chain, keys);
  const now = Date.now();
  const daily = await spentToday(chromeStorage, now);
  const a = open.find((x) => !((cooldown.get(x.slot) || 0) > now) && !((daily.get(x.slot) || 0) > now)) || open[0];
  return a ? { model: a.step.model, provider: a.step.provider, keyName: a.keyName, level: ctx.level } : null;
}

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
    const { modelStatus, dailyQuota, wordState } = await store.get(['modelStatus', 'dailyQuota', 'wordState']);
    const models = configFor(wordState?.language || 'French', clean.modelChoice).chain.filter((s) => s.provider === 'gemini').map((s) => s.model);
    const backup = !!(await geminiKeys()).backup;
    const replaced = replaceLegacyStatus(modelStatus, dailyQuota, models, Date.now(), (await localCapped()) ? localCapError(backup) : '');
    if (replaced) await store.set({ modelStatus: replaced });
  });
})();

// What pages get. The revision changes whenever anything that affects swaps does, so stale replies are dropped.
async function context() {
  await ready;
  const data = await store.get(['settings', 'wordState', 'apiKey', 'hostKey', 'backupKey', 'hostBackupKey', 'epoch']);
  const state = data.wordState?.words?.length ? data.wordState : null;
  const saved = cleanSettings(data.settings);
  const settings = { ...saved, newSitesEnabled: newSitesDefault(saved, state?.sites) };
  const level = resolveLevel(saved, state?.stage).effective;
  const hasKey = !!(data.apiKey || data.hostKey || data.backupKey || data.hostBackupKey);
  const paused = !!state?.paused;
  const origins = await grantedOrigins();
  const { openRouterDailyUsd, anthropicDailyUsd, ...affecting } = settings; // spend caps change no swap, so cached ones stay
  const revision = hashKey(JSON.stringify([data.epoch || '', affecting, level, state?.version || '', paused, hasKey, origins]));
  return { settings, level, revision, hasKey, tier: tierFor(hasKey, state), paused, origins, stage: state?.stage || 0 };
}

// The model APIs' own host permissions (manifest) are not sites the reader granted: openrouter.ai is also a website,
// which needs its own grant like any other. api.anthropic.com has no host permission: its fetches are CORS requests
// the API allows (anthropic.js).
const API_ORIGINS = ['https://generativelanguage.googleapis.com/*', 'https://openrouter.ai/*'];
const grantedOrigins = async () => ((await chrome.permissions.getAll()).origins || []).filter((o) => !API_ORIGINS.includes(o));

// Which engine makes the swaps: 'gemini' with a key; else 'local' (a fixed list, no model), which has French words
// only, so another language set up in the plugin gets 'none'. On-device Gemini Nano was tested for this and rejected
// (an internal test run, 2026-10-16: 14-25% of its swaps were wrong, and it swapped words in sensitive passages).
export const tierFor = (hasKey, state) => hasKey ? 'gemini' : state?.language ? 'none' : 'local';

const activeOn = (ctx, url) => ctx.tier !== 'none' && !ctx.paused && siteEnabled(ctx.settings, url) && hasSiteAccess(url, ctx.origins);

async function broadcast(type = 'config') {
  const config = await context();
  const tabs = await chrome.tabs.query({});
  await Promise.allSettled(tabs.map((t) => chrome.tabs.sendMessage(t.id, { type, config })));
}

// "Field Notes (example.org)": the tab's title and site, for the model's page-level topic check.
function pageLabel(sender) {
  let host = '';
  try { host = new URL(sender.url).hostname; } catch { /* no site */ }
  return [String(sender.tab?.title || '').slice(0, 200), host && `(${host})`].filter(Boolean).join(' ');
}

async function swaps(msg, sender) {
  const ctx = await context();
  if (msg.revision !== ctx.revision || !activeOn(ctx, sender.url)) return { results: {}, stale: true };
  if (!Array.isArray(msg.items) || msg.items.length > 8) throw new Error('Invalid text batch');
  const items = msg.items.filter((i) => i && typeof i.text === 'string' && i.text.length <= 2000 &&
    wordCount(i.text) >= 6 && !isZeroFrench(i.text) && i.key === `${ctx.revision}:${hashKey(i.text)}`);
  // Title guard: a page whose title is about money, health, legal matters, crime, driving or emergencies gets no swaps
  // at all, not even cached ones from the same text elsewhere, and nothing goes to a model.
  if (isZeroFrench(String(sender.tab?.title || ''))) return { results: Object.fromEntries(items.map((i) => [i.key, []])) };
  if (ctx.tier === 'local') {
    // Nothing leaves the machine and nothing is cached: the list lookup is cheaper than a storage read. A page whose
    // title names a sensitive topic stays English throughout.
    const offPage = localOff(String(msg.title || '').slice(0, 300));
    const { wordState } = await store.get('wordState');
    const words = wordState?.words?.length ? wordState.words : undefined;
    return { results: Object.fromEntries(items.map((i) => [i.key, offPage ? [] : localSwaps(ctx.level, i.text, words)])) };
  }
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
      const { wordState } = await store.get('wordState');
      const { design, chain, keys, main, backup: backupKey } = await planFor(ctx, wordState);
      if (await localCapped()) throw Object.assign(new Error(localCapError(!!backupKey)), { kind: 'local' });
      usedKey = main;
      // Only Gemini calls count toward the local cap, each toward its key's; OpenRouter has its own spend cap.
      const fetchImpl = async (url, init, ...rest) => {
        if (String(url).startsWith(API_BASE)) {
          const which = backupKey && init?.headers?.['x-goog-api-key'] === backupKey ? 'backup' : 'main';
          await countCall(chromeStorage, undefined, which);
        }
        return fetch(url, init, ...rest);
      };
      const daily = await spentToday(chromeStorage); // a spent daily quota outlives the worker, so it is kept in storage
      // Claude Haiku 5.5 first at Levels 1-2 on Auto, or at every level when picked in the popup (planFor).
      try {
        return await requestSwaps({ keys, chain, design, level: ctx.level, words: wordState?.words, language: wordState?.language, fetchImpl,
          onOpenRouter: (r) => locked(() => countOpenRouter(chromeStorage, r)),
          onAnthropic: (r) => locked(() => countAnthropic(chromeStorage, r)),
          shownToday: await shownToday(chromeStorage), cooldown, daily, page: pageLabel(sender), batch: misses.map((i) => ({ id: i.key, text: i.text })) });
      } finally {
        await saveSpent(chromeStorage, daily);
      }
    });
    return await locked(async () => {
      if (!fresh || (await context()).revision !== ctx.revision) return { results: {}, stale: true };
      await cache.setMany(fresh.results);
      await countDropped(chromeStorage, fresh.dropped);
      if (!fresh.skipped) { // a batch without candidates made no request: the last model's status stands
        const served = { at: Date.now(), model: fresh.model, provider: fresh.provider, keyName: fresh.keyName, ms: fresh.ms || 0 };
        await store.set({ modelStatus: { ...served, error: '' }, lastServed: served }); // lastServed outlives a later failure
        await countServed(chromeStorage, fresh.model);
      }
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
  const stored = await store.get(KEY_NAMES);
  const { apiKey, hostKey } = stored;
  const keys = [...KEY_NAMES.map((k) => stored[k]), usedKey].filter((k) => typeof k === 'string' && k.length >= 8);
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
    await store.set({ modelStatus: { at: now, error, kind, retryAt, ...(kind === 'key' && e?.keyName ? { keyName: e.keyName } : {}),
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
    const { modelStatus, apiKey, hostKey } = await store.get(['modelStatus', 'apiKey', 'hostKey']);
    const problem = apiKey || hostKey ? modelErrorText(modelStatus) : ''; // no key: no Gemini calls to fail
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
  const before = await store.get(HOST_KEYS);
  // The running version goes along, so `fw.py check` can say which copy Chrome runs (a host before 0.2.9 ignores it).
  const version = runningVersion();
  const res = await refresh({ storage: chromeStorage, send, version });
  if (!res.error && version) await store.set({ [REPORTED_KEY]: { version, at: Date.now() } });
  if (res.changed) await locked(() => cache.clear());
  const after = await store.get(HOST_KEYS);
  const changed = (k) => (before[k] || '') !== (after[k] || '');
  if (HOST_KEYS.some(changed)) await keyChanged(); // setup stored, replaced or removed a key
  if (changed('hostOpenRouterKey')) await clearPaidStop(chromeStorage, 'openrouter');
  if (changed('hostAnthropicKey')) await clearPaidStop(chromeStorage, 'anthropic');
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

// A new key answers "Gemini rejected the key" and has its own limits; the next request says whether it works.
async function freshKeyPatch() {
  const { modelStatus } = await store.get('modelStatus');
  cooldown.clear();
  return { dailyQuota: {}, ...(['key', 'daily', 'rate'].includes(modelStatus?.kind) ? { modelStatus: { at: Date.now(), error: '' } } : {}) };
}
async function keyChanged() {
  await locked(async () => store.set(await freshKeyPatch()));
  await showBadge();
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
    // A new model that doesn't take the chosen reasoning level goes back to Recommended reasoning.
    const next = patch.settings;
    if (next.reasoning !== 'auto' && next.modelChoice !== cleanSettings(saved.settings).modelChoice) {
      const { first } = await modeInfo(next, (await context()).level);
      if (!reasoningLevels(first).includes(next.reasoning)) next.reasoning = 'auto';
    }
    if (typeof msg.apiKey === 'string') {
      if (msg.apiKey.length > 500) throw new Error('Key is too long');
      patch.apiKey = msg.apiKey.trim();
      Object.assign(patch, await freshKeyPatch());
    }
    // The backup Gemini key and the paid keys: same rules as the main key; a new one starts with a clean slate.
    const prefixes = { backupKey: 'backup:', openRouterKey: 'openrouter:', anthropicKey: 'anthropic:' };
    for (const name of Object.keys(prefixes)) {
      if (typeof msg[name] !== 'string') continue;
      if (msg[name].length > 500) throw new Error('Key is too long');
      patch[name] = msg[name].trim();
      const prefix = prefixes[name];
      const { dailyQuota } = await store.get('dailyQuota');
      patch.dailyQuota = Object.fromEntries(Object.entries(patch.dailyQuota || dailyQuota || {}).filter(([slot]) => !slot.startsWith(prefix)));
      for (const slot of [...cooldown.keys()]) if (slot.startsWith(prefix)) cooldown.delete(slot);
      // A new backup key answers its own "rejected the backup key".
      const { modelStatus } = await store.get('modelStatus');
      if (name === 'backupKey' && modelStatus?.kind === 'key' && modelStatus.keyName === 'backup') patch.modelStatus = { at: Date.now(), error: '' };
      if (name === 'openRouterKey') await clearPaidStop(chromeStorage, 'openrouter');
      if (name === 'anthropicKey') await clearPaidStop(chromeStorage, 'anthropic');
    }
    await store.set(patch);
  });
  await showBadge();
  await broadcast();
  return { ok: true };
}

// "Updated to X", once: the first popup open after the running version changed. Before 0.2.9 nothing recorded the
// version a popup showed; an update this worker reloaded into (RELOADED_KEY) counts then.
const POPUP_VERSION_KEY = 'popupVersion';
async function updatedOnce() {
  const running = runningVersion();
  const { [POPUP_VERSION_KEY]: shown, [RELOADED_KEY]: reloadedFor } = await store.get([POPUP_VERSION_KEY, RELOADED_KEY]);
  if (!running || shown === running) return '';
  await store.set({ [POPUP_VERSION_KEY]: running });
  return (shown ? shown !== running : reloadedFor === running) ? running : '';
}

async function status() {
  const config = await context();
  const data = await store.get(['wordState', 'apiKey', 'hostKey', 'backupKey', 'hostBackupKey', 'openRouterKey', 'hostOpenRouterKey',
    'anthropicKey', 'hostAnthropicKey', 'modelStatus', 'lastServed', 'hostChannel']);
  const openRouter = await openRouterToday(chromeStorage);
  const anthropic = await anthropicToday(chromeStorage);
  return { config, words: data.wordState?.words?.length || 0, fetchedAt: data.wordState?.fetchedAt || 0,
    pastedKey: !!data.apiKey, hostKey: !!data.hostKey, backupKey: !!data.backupKey, hostBackupKey: !!data.hostBackupKey,
    openRouterKey: !!data.openRouterKey, hostOpenRouterKey: !!data.hostOpenRouterKey,
    anthropicKey: !!data.anthropicKey, hostAnthropicKey: !!data.hostAnthropicKey,
    modelStatus: data.modelStatus || null, lastServed: data.lastServed || null, served: await servedToday(chromeStorage),
    openRouter: { ...openRouter, blocked: paidBlocked(openRouter, config.settings.openRouterDailyUsd) },
    anthropic: { ...anthropic, blocked: paidBlocked(anthropic, config.settings.anthropicDailyUsd) },
    dropped: await droppedToday(chromeStorage),
    next: await nextModel(config), ...await modeInfo(config.settings, config.level),
    version: runningVersion(), channel: data.hostChannel || '', updated: await updatedOnce(),
    // updating: a newer copy on disk the popup announces before it asks for the reload (applyUpdate); update: one
    // that a reload already failed to load, for the popup's "reload by hand" line.
    ...await popupUpdate() };
}

async function popupUpdate() {
  const { waiting, reloading } = await checkUpdate({ reload: false });
  return { update: reloading ? '' : waiting, updating: reloading ? waiting : '' };
}

// An update replaces this folder on disk (setup, or the Claude Code hook after a plugin update), but Chrome keeps
// running the loaded copy. Compare the manifest on disk with the running one and reload from disk by ourselves,
// once per disk version, after any model call in flight and pending storage writes. If the running copy still
// differs after that (or reload fails), mark the toolbar icon so the user can reload by hand.
// reload false (the popup): only say whether a reload is due ({ waiting, reloading: true }), so the popup can show
// "Updating to X…" before it asks for one; the reload closes it.
export const RELOADED_KEY = 'reloadedFor';
async function checkUpdate({ reload = true } = {}) {
  try {
    const disk = await (await fetch(chrome.runtime.getURL('manifest.json'), { cache: 'no-store' })).json();
    const waiting = disk.version && disk.version !== chrome.runtime.getManifest().version ? String(disk.version) : '';
    if (waiting && (await store.get(RELOADED_KEY))[RELOADED_KEY] !== waiting) {
      if (!reload) return { waiting, reloading: true };
      await store.set({ [RELOADED_KEY]: waiting });
      try {
        await locked(() => modelCall(() => chrome.runtime.reload()));
        return { waiting, reloading: true }; // normally not reached: the worker is gone
      } catch { /* fall back to the badge */ }
    }
    updateWaiting = waiting;
    await showBadge();
    return { waiting, reloading: false };
  } catch {
    return { waiting: '', reloading: false };
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
    applyUpdate: async () => ({ ok: true, ...(await checkUpdate()) }),
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
    const origins = await grantedOrigins();
    const matches = [...new Set(origins.flatMap((o) => o === '<all_urls>' ? ['http://*/*', 'https://*/*'] : [o]))]
      .filter((o) => /^(https?|\*):\/\//.test(o));
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
  chrome.alarms.create(UPDATE_ALARM, { periodInMinutes: UPDATE_MINUTES });
  void syncWords().catch(() => {});
  void checkUpdate();
}
chrome.runtime.onInstalled.addListener(arm);
chrome.runtime.onStartup.addListener(arm);
chrome.alarms.onAlarm.addListener((a) => {
  if (a.name === ALARM) void syncWords().catch(() => {});
  if (a.name === ALARM || a.name === UPDATE_ALARM) void checkUpdate();
});
// Right after a reload into a new version, tell the native host at once, even if Chrome skipped onInstalled. Only
// when an earlier version was reported: a first install syncs from onInstalled. recheckHost skips this when arm()'s
// sync already ran.
void ready.then(async () => {
  const { [REPORTED_KEY]: reported } = await store.get(REPORTED_KEY);
  if (reported?.version && reported.version !== runningVersion()) await recheckHost();
}).catch(() => {});
void ready.then(registerSites).catch(() => {});
void ready.then(() => showBadge(false)); // a stored failure shows from the start, without an update check
