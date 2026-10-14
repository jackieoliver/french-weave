import { expect, it } from 'bun:test';
import { DAILY_MODEL_CALLS, callsToday, countCall } from '../src/quota.js';
import { memoryStorage } from '../src/cache.js';

it('counts model calls per day and starts over the next day', async () => {
  const storage = memoryStorage();
  expect(await callsToday(storage, '2026-10-14')).toBe(0);
  for (let i = 0; i < DAILY_MODEL_CALLS; i++) await countCall(storage, '2026-10-14');
  expect(await callsToday(storage, '2026-10-14')).toBe(DAILY_MODEL_CALLS);
  expect(await callsToday(storage, '2026-10-15')).toBe(0);
  await countCall(storage, '2026-10-15');
  expect(await callsToday(storage, '2026-10-15')).toBe(1);
});
