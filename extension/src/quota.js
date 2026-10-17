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

// which: 'main' or 'backup'; each Gemini key has its own count and cap.
const callsKey = (which) => (which === 'backup' ? 'modelCallsBackup' : KEY);
export async function callsToday(storage, day = localDay(), which = 'main') {
  const { [callsKey(which)]: used } = await storage.get([callsKey(which)]);
  return used?.day === day ? used.count : 0;
}

export async function countCall(storage, day = localDay(), which = 'main') {
  await storage.set({ [callsKey(which)]: { day, count: (await callsToday(storage, day, which)) + 1 } });
}

// Paid spend today in USD, per provider, as each reports it per request ({ day, usd, stopped }): OpenRouter's own
// figure, and Anthropic's computed from usage at the published price (anthropic.js). stopped: 'credits' after the
// account can't pay (OpenRouter's 402; Anthropic's 402 or "credit balance is too low"), 'key' after a 401 or 403 (key
// refused): no more calls to that provider until tomorrow or a new key.
const PAID_KEYS = { openrouter: 'openRouterDay', anthropic: 'anthropicDay' };
export async function paidToday(storage, provider, day = localDay()) {
  const key = PAID_KEYS[provider];
  const { [key]: saved } = await storage.get([key]);
  return saved?.day === day ? { usd: 0, stopped: '', ...saved } : { day, usd: 0, stopped: '' };
}

export async function countPaid(storage, provider, { costUsd = 0, status = 200, credits = false } = {}, day = localDay()) {
  const today = await paidToday(storage, provider, day);
  today.usd = Math.round((today.usd + (Number(costUsd) > 0 ? Number(costUsd) : 0)) * 1e6) / 1e6;
  if (status === 402 || credits) today.stopped = 'credits';
  if (status === 401 || status === 403) today.stopped = 'key';
  await storage.set({ [PAID_KEYS[provider]]: today });
  return today;
}

// A new key for the provider: a stop from the old key no longer applies (today's spend stays).
export async function clearPaidStop(storage, provider) {
  const today = await paidToday(storage, provider);
  if (today.stopped) await storage.set({ [PAID_KEYS[provider]]: { ...today, stopped: '' } });
}

export const openRouterToday = (storage, day) => paidToday(storage, 'openrouter', day);
export const countOpenRouter = (storage, r, day) => countPaid(storage, 'openrouter', r, day);
export const anthropicToday = (storage, day) => paidToday(storage, 'anthropic', day);
export const countAnthropic = (storage, r, day) => countPaid(storage, 'anthropic', r, day);

// Why a paid provider is off for the rest of today, or '' while it may be called.
export function paidBlocked(today, capUsd) {
  if (today?.stopped) return today.stopped;
  return today?.usd >= capUsd ? 'cap' : '';
}
export const openRouterBlocked = paidBlocked;

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
