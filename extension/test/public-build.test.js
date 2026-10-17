import { test, expect } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { createUsage } from '../src/usage.js';
import * as page from '../src/usage-page.js';

// The public release leaves out the dev build's usage log (RELEASING.md on the dev side). A merge from dev that
// brings back the real usage.js, usage-page.js, fwusage.py or the popup's usage switch fails here.
const root = new URL('../../', import.meta.url).pathname;

test('public build: the usage log is a stub that records, stores and sends nothing', async () => {
  const sent = [];
  const stored = [];
  const storage = { get: async () => ({}), set: async (x) => { stored.push(x); }, remove: async () => {} };
  const usage = createUsage({ storage, sendNative: async (m) => { sent.push(m); return { ok: true }; } });
  usage.record('popup', {});
  usage.word('seen', { fr: 'et', status: 'active' }, { url: 'https://example.com/' });
  expect(await usage.flag()).toEqual({});
  expect(await usage.batch({ items: [{}] }, {}, async () => 'reply')).toBe('reply');
  expect(await usage.pageView({ load: true }, { tab: { id: 1 }, url: 'https://example.com/' }, Promise.resolve('ctx'), () => true)).toBe('ctx');
  expect((await usage.today()).dev).toBe(false);
  await usage.flush();
  page.init(() => ({ usage: true }), (m) => sent.push(m));
  page.retry(1, 3, { error: 'x' });
  page.sendNow();
  expect(sent).toEqual([]);
  expect(stored).toEqual([]);
});

test('public build: no usage files, command or popup switch', () => {
  expect(existsSync(`${root}scripts/fwusage.py`)).toBe(false);
  expect(existsSync(`${root}RELEASING.md`)).toBe(false); // dev-side release notes
  expect(readFileSync(`${root}scripts/fw.py`, 'utf8')).not.toContain('fwusage');
  expect(readFileSync(`${root}scripts/fw_host.py`, 'utf8')).not.toContain('fwusage');
  expect(readFileSync(`${root}extension/src/popup.html`, 'utf8')).not.toContain('usageOn');
  expect(readFileSync(`${root}README.md`, 'utf8')).not.toContain('Usage log');
});
