// Daily cap on Gemini calls, so pages that keep changing their text can't use up the key's quota. 500 is the free
// tier's daily limit for gemini-3.5-flash-lite (GenerateRequestsPerDayPerProjectPerModel-FreeTier, checked
// 2026-10-15); when Google's own daily limit comes first, its 429 stops calls until the time it gives (engine.js).
import { localDay } from './hostsource.js';

export const DAILY_MODEL_CALLS = 500;
const KEY = 'modelCalls';
const DAILY_KEY = 'dailyQuota'; // { model: until ms } for models whose daily quota is spent

// Models whose daily quota is spent, as the Map requestSwaps takes; past entries are left out.
export async function spentToday(storage, now = Date.now()) {
  const { [DAILY_KEY]: saved } = await storage.get([DAILY_KEY]);
  return new Map(Object.entries(saved || {}).filter(([, until]) => Number(until) > now).map(([m, until]) => [m, Number(until)]));
}

// Today's count of swaps the validator dropped, by reason ({ day, malformed, notListed, ... }), for the popup's
// status and debugging: a broken accent from the model is dropped, but no longer silently.
const STATS_KEY = 'swapStats';
export async function countDropped(storage, dropped, day = localDay()) {
  if (!dropped || !Object.keys(dropped).length) return;
  const { [STATS_KEY]: saved } = await storage.get([STATS_KEY]);
  const stats = saved?.day === day ? { ...saved } : { day };
  for (const [reason, n] of Object.entries(dropped)) stats[reason] = (stats[reason] || 0) + n;
  await storage.set({ [STATS_KEY]: stats });
}

export async function droppedToday(storage, day = localDay()) {
  const { [STATS_KEY]: saved } = await storage.get([STATS_KEY]);
  return saved?.day === day ? saved : { day };
}

export async function saveSpent(storage, daily, now = Date.now()) {
  await storage.set({ [DAILY_KEY]: Object.fromEntries([...daily].filter(([, until]) => until > now)) });
}

export async function callsToday(storage, day = localDay()) {
  const { [KEY]: used } = await storage.get([KEY]);
  return used?.day === day ? used.count : 0;
}

export async function countCall(storage, day = localDay()) {
  await storage.set({ [KEY]: { day, count: (await callsToday(storage, day)) + 1 } });
}

// OpenRouter spend today in USD, as OpenRouter reports it per request ({ day, usd, stopped }). stopped: 'credits'
// after a 402 (the account's credits are used up), so no more OpenRouter calls until tomorrow.
const OPENROUTER_KEY = 'openRouterDay';
export async function openRouterToday(storage, day = localDay()) {
  const { [OPENROUTER_KEY]: saved } = await storage.get([OPENROUTER_KEY]);
  return saved?.day === day ? { usd: 0, stopped: '', ...saved } : { day, usd: 0, stopped: '' };
}

export async function countOpenRouter(storage, { costUsd = 0, status = 200 } = {}, day = localDay()) {
  const today = await openRouterToday(storage, day);
  today.usd = Math.round((today.usd + (Number(costUsd) > 0 ? Number(costUsd) : 0)) * 1e6) / 1e6;
  if (status === 402) today.stopped = 'credits';
  await storage.set({ [OPENROUTER_KEY]: today });
  return today;
}

// Why OpenRouter is off for the rest of today, or '' while it may be called.
export function openRouterBlocked(today, capUsd) {
  if (today?.stopped === 'credits') return 'credits';
  return today?.usd >= capUsd ? 'cap' : '';
}

// Batches each model served today ({ day, counts: { model: n } }), for the popup: how often the chain falls through.
const SERVED_KEY = 'servedToday';
export async function servedToday(storage, day = localDay()) {
  const { [SERVED_KEY]: saved } = await storage.get([SERVED_KEY]);
  return saved?.day === day ? saved : { day, counts: {} };
}

export async function countServed(storage, model, day = localDay()) {
  if (!model) return;
  const today = await servedToday(storage, day);
  await storage.set({ [SERVED_KEY]: { day, counts: { ...today.counts, [model]: (today.counts[model] || 0) + 1 } } });
}
