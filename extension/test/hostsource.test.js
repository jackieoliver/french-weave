import { describe, expect, it } from 'bun:test';
import { parseState, readCached, refresh, queueEvents, flushEvents, STATE_KEY, PENDING_KEY } from '../src/hostsource.js';
import { memoryStorage } from '../src/cache.js';
import { validateSwaps } from '../src/levels.js';
import { buildSystemPrompt } from '../src/prompt.js';

// Shape the native host sends (scripts/fw_host.py "state").
const REPLY = {
  ok: true,
  version: 'abc123',
  stage: 1,
  paused: false,
  words: [
    { fr: 'alors', en: 'so / then', hint: 'ah-lor', status: 'active' },
    { fr: 'très', en: 'very', hint: 'treh', status: 'shaky' },
    { fr: 'et', en: 'and', hint: 'ay', status: 'known' },
  ],
  geminiKey: 'KEY',
};
const host = (reply) => async () => reply;

describe('parseState', () => {
  it('reads the host reply shape', () => {
    const s = parseState(REPLY);
    expect(s).toEqual({ version: 'abc123', stage: 1, paused: false, words: REPLY.words });
  });
  it('drops unusable rows and duplicates; bad stage falls back to 1', () => {
    const s = parseState({ stage: 9, words: [{ fr: 'et', en: 'and' }, { fr: 'et', en: 'x' }, { fr: ' ', en: 'y' }, null, { fr: 'mais' }] });
    expect(s.words).toEqual([{ fr: 'et', en: 'and', hint: '', status: 'active' }]);
    expect(s.stage).toBe(1);
  });
  it('throws when nothing usable is left', () => {
    expect(() => parseState({ words: [] })).toThrow();
  });
});

describe('refresh', () => {
  it('stores the state and the setup key; a new version reports changed', async () => {
    const storage = memoryStorage();
    const r = await refresh({ storage, send: host(REPLY), now: () => 5 });
    expect(r.error).toBeNull();
    expect(r.changed).toBe(true);
    expect((await readCached(storage)).fetchedAt).toBe(5);
    expect((await storage.get(['hostKey'])).hostKey).toBe('KEY');
    const again = await refresh({ storage, send: host(REPLY) });
    expect(again.changed).toBe(false);
  });
  it('keeps the last good list when the host is missing or answers badly', async () => {
    const storage = memoryStorage();
    await refresh({ storage, send: host(REPLY) });
    const missing = await refresh({ storage, send: async () => { throw new Error('Specified native messaging host not found.'); } });
    expect(missing.error).toContain('not found');
    expect(missing.state.version).toBe('abc123');
    const bad = await refresh({ storage, send: host({ ok: true, words: [] }) });
    expect(bad.error).toBeTruthy();
    expect((await readCached(storage)).words).toHaveLength(3);
  });
  it('a synced list drives validation and the prompt', () => {
    const s = parseState(REPLY);
    expect(validateSwaps(1, [{ o: 'so', f: 'alors', ctx: 'so then' }], s.words)[0].f).toBe('alors');
    expect(validateSwaps(1, [{ o: 'but', f: 'mais', ctx: 'x' }], s.words)).toEqual([]);
    expect(buildSystemPrompt(1, s.words)).toContain('alors, très, et');
  });
});

describe('events', () => {
  it('counts a word as seen or peeked once per day, keeps every flip', async () => {
    const storage = memoryStorage();
    await queueEvents(storage, [{ word: 'Très', kind: 'seen' }, { word: 'très', kind: 'seen' }, { word: 'et', kind: 'flip' },
      { word: 'très', kind: 'peek' }, { word: 'très', kind: 'peek' }], '2026-10-01');
    await queueEvents(storage, [{ word: 'très', kind: 'seen' }, { word: 'et', kind: 'flip' }, { word: 'x', kind: 'bogus' }], '2026-10-01');
    await queueEvents(storage, [{ word: 'très', kind: 'seen' }], '2026-10-02');
    const { [PENDING_KEY]: pending } = await storage.get([PENDING_KEY]);
    expect(pending).toEqual([
      { word: 'très', kind: 'seen', day: '2026-10-01' },
      { word: 'et', kind: 'flip', day: '2026-10-01' },
      { word: 'très', kind: 'peek', day: '2026-10-01' },
      { word: 'et', kind: 'flip', day: '2026-10-01' },
      { word: 'très', kind: 'seen', day: '2026-10-02' },
    ]);
  });
  it('flush sends and clears; a failed flush keeps the queue', async () => {
    const storage = memoryStorage();
    await queueEvents(storage, [{ word: 'et', kind: 'flip' }], '2026-10-01');
    const failed = await flushEvents({ storage, send: async () => { throw new Error('no host'); } });
    expect(failed.error).toBe('no host');
    expect((await storage.get([PENDING_KEY]))[PENDING_KEY]).toHaveLength(1);
    const sent = [];
    const ok = await flushEvents({ storage, send: async (m) => { sent.push(m); return { ok: true, applied: 1 }; } });
    expect(ok).toEqual({ sent: 1, applied: 1 });
    expect(sent[0].type).toBe('events');
    expect((await storage.get([PENDING_KEY]))[PENDING_KEY]).toEqual([]);
  });
  it('readCached ignores empty state', async () => {
    expect(await readCached(memoryStorage({ [STATE_KEY]: { words: [] } }))).toBeNull();
  });
});
