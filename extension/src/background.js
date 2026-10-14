// Service worker: word state from the Claude Code plugin (native host), cache lookup, one model call at a time,
// results back to the content script, seen/flip events back to the plugin.
import { createCache, chromeStorage } from './cache.js';
import { requestSwaps } from './engine.js';
import { withDefaults } from './settings.js';
import { HOST, refresh, readCached, queueEvents, flushEvents } from './hostsource.js';

const cache = createCache(chromeStorage);

const ALARM = 'sync';
const SYNC_MINUTES = 30; // word statuses change at most a few times a day
const FLUSH_DELAY_MS = 10000;

let chain = Promise.resolve();
function enqueue(fn) {
  const p = chain.then(fn);
  chain = p.catch(() => {});
  return p;
}

const send = (message) => chrome.runtime.sendNativeMessage(HOST, message);

// Event queue reads and writes go one at a time: concurrent read-modify-writes of storage would drop events.
let eventChain = Promise.resolve();
function serialEvents(fn) {
  const p = eventChain.then(fn);
  eventChain = p.catch(() => {});
  return p;
}
const flush = () => serialEvents(() => flushEvents({ storage: chromeStorage, send }));

async function getSettings() {
  const { settings } = await chrome.storage.local.get('settings');
  return withDefaults(settings);
}

// A new version clears the decision cache, because cached swaps were chosen against the old list.
async function syncWords() {
  const res = await refresh({ storage: chromeStorage, send });
  if (res.changed) await cache.clear();
  return res;
}

let flushTimer = null;
function scheduleFlush() {
  clearTimeout(flushTimer);
  flushTimer = setTimeout(flush, FLUSH_DELAY_MS);
}

async function handleSwaps({ level, items }) {
  const state = await readCached(chromeStorage);
  if (state?.paused) return { results: {}, paused: true };
  const keys = items.map((i) => i.key);
  const results = await cache.getMany(keys);
  const misses = items.filter((i) => !(i.key in results));
  if (misses.length) {
    const settings = await getSettings();
    const { hostKey } = await chrome.storage.local.get('hostKey');
    const apiKey = settings.apiKey || hostKey;
    if (!apiKey) return { results, error: 'no Gemini key: paste one in the French Weave popup' };
    const batch = misses.map((i) => ({ id: i.key, text: i.text }));
    try {
      const { results: fresh } = await enqueue(() =>
        requestSwaps({ apiKey, model: settings.model, level, batch, words: state?.words }),
      );
      const toStore = {};
      for (const i of misses) {
        if (i.key in fresh) {
          results[i.key] = fresh[i.key];
          toStore[i.key] = fresh[i.key];
        }
      }
      await cache.setMany(toStore);
    } catch (e) {
      // Cache hits still go back; the misses stay English and are retried when X re-renders them.
      return { results, error: String(e?.message || e) };
    }
  }
  return { results };
}

// create() replaces an alarm of the same name, so calling it on both events is safe. Startup matters
// because disabling and re-enabling the extension clears alarms without firing onInstalled.
function arm() {
  chrome.alarms.create(ALARM, { periodInMinutes: SYNC_MINUTES });
  syncWords();
}
chrome.runtime.onInstalled.addListener(arm);
chrome.runtime.onStartup.addListener(arm);
chrome.alarms.onAlarm.addListener(async (a) => {
  if (a.name !== ALARM) return;
  await flush();
  await syncWords();
});

const reply = (promise, sendResponse) => {
  promise.then(sendResponse, (e) => sendResponse({ error: String(e?.message || e) }));
  return true;
};

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  switch (msg?.type) {
    case 'swaps':
      return reply(handleSwaps(msg).catch((e) => ({ results: {}, error: String(e?.message || e) })), sendResponse);
    case 'events':
      return reply(
        serialEvents(() => queueEvents(chromeStorage, msg.events)).then((n) => { scheduleFlush(); return { ok: true, queued: n }; }),
        sendResponse,
      );
    case 'clearCache':
      return reply(cache.clear().then((n) => ({ ok: true, removed: n })), sendResponse);
    case 'syncWords':
      return reply(
        flush()
          .then(syncWords)
          .then((r) => ({ ok: !r.error, error: r.error, count: r.state?.words?.length || 0, stage: r.state?.stage || 0 })),
        sendResponse,
      );
    case 'wordState':
      return reply(
        Promise.all([readCached(chromeStorage), chrome.storage.local.get('hostKey')]).then(([s, { hostKey }]) => ({
          count: s?.words?.length || 0,
          stage: s?.stage || 0,
          paused: !!s?.paused,
          fetchedAt: s?.fetchedAt || 0,
          hostKey: !!hostKey,
        })),
        sendResponse,
      );
    default:
      return false;
  }
});
