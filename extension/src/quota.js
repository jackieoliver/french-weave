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
