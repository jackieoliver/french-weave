// Daily cap on Gemini calls, so pages that keep changing their text can't use up the key's quota.
import { localDay } from './hostsource.js';

export const DAILY_MODEL_CALLS = 1000;
const KEY = 'modelCalls';

export async function callsToday(storage, day = localDay()) {
  const { [KEY]: used } = await storage.get([KEY]);
  return used?.day === day ? used.count : 0;
}

export async function countCall(storage, day = localDay()) {
  await storage.set({ [KEY]: { day, count: (await callsToday(storage, day)) + 1 } });
}
