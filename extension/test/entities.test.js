import { describe, test, expect } from 'bun:test';
import { validateSwaps, decodeEntities, malformed } from '../src/levels.js';
import { requestSwaps } from '../src/engine.js';
import { countDropped, droppedToday } from '../src/quota.js';
import { memoryStorage } from '../src/cache.js';

// 14 of 703 proposals in the 0.2.1 live test came back with HTML entities or raw bytes for accents and were dropped
// without a sign.
describe('accents from the model', () => {
  test('HTML entities are decoded before validation', () => {
    expect(decodeEntities('tr&#232;s')).toBe('très');
    expect(decodeEntities('tr&#xE8;s')).toBe('très');
    expect(decodeEntities('le probl&egrave;me')).toBe('le problème');
    expect(decodeEntities('d&eacute;j&agrave;')).toBe('déjà');
    expect(decodeEntities('&Ccedil;a')).toBe('Ça');
    expect(decodeEntities('gro&szlig; &amp; sch&ouml;n, a&ntilde;o')).toBe('groß & schön, año');
    expect(decodeEntities('l&rsquo;id&eacute;e')).toBe('l’idée');
    expect(decodeEntities('&bogus; &#0;')).toBe('&bogus; &#0;');
    const f = (o, fr) => validateSwaps(2, [{ o, f: fr, ctx: '' }])[0]?.f;
    expect(f('very', 'tr&#232;s')).toBe('très');
    expect(f('problem', 'le probl&egrave;me')).toBe('problème');
    expect(f('the idea', 'l&#8217;id&eacute;e')).toBe("l'idée");
    expect(f('already', 'd&eacute;j&agrave;')).toBe('déjà');
    expect(validateSwaps(2, [{ o: 'very', f: 'tr&egrave;s', ctx: 'is very &quot;good&quot;' }])[0].ctx).toBe('is very "good"');
  });

  test('anything still malformed is dropped and counted', () => {
    for (const bad of ['tr\u0080s', 'tr�s', 'tr\\x80s', 'tr\\u00e8s', 'trÃ¨s', 'tr&eagrave;s', 'tr&#xD800;s']) expect(malformed(decodeEntities(bad))).toBe(true);
    for (const good of ['très', 'déjà', 'l\'idée', 'São Paulo', 'ÇA', '問題']) expect(malformed(good)).toBe(false);
    const stats = {};
    const out = validateSwaps(2, [
      { o: 'very', f: 'tr\u0080s' }, { o: 'very', f: 'trÃ¨s' }, { o: 'very', f: 'tr\\x80s' }, { o: 'very', f: 'tr&#232;s' },
      { o: 'and', f: 'lumière' }, { o: 'really', f: 'très' }, { o: 'AND', f: 'et' }, { o: 'problems', f: 'le problème' },
    ], undefined, 'French', { stats });
    expect(out.map((s) => s.f)).toEqual(['très']);
    expect(stats).toEqual({ malformed: 3, notListed: 1, gloss: 1, allCaps: 1, plural: 1 });
  });

  test('the engine reports drops with each batch, and the worker keeps a daily count', async () => {
    const swaps = [{ o: 'very', f: 'tr\u0080s', g: 'very', h: 'treh', ctx: 'very' }, { o: 'and', f: 'lumi&egrave;re', g: 'and', h: 'ay', ctx: 'and' }];
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ passages: [{ id: 'a', swaps }] }) }] } }] }) });
    const r = await requestSwaps({ apiKey: 'K', model: 'gemini-3.5-flash-lite', level: 1, batch: [{ id: 'a', text: 'this is very nice and calm' }], fetchImpl });
    expect(r.results.a).toEqual([]);
    expect(r.dropped).toEqual({ malformed: 1, notListed: 1 });
    const storage = memoryStorage();
    await countDropped(storage, r.dropped, '2026-10-15');
    await countDropped(storage, { malformed: 2 }, '2026-10-15');
    expect(await droppedToday(storage, '2026-10-15')).toEqual({ day: '2026-10-15', malformed: 3, notListed: 1 });
    expect(await droppedToday(storage, '2026-10-16')).toEqual({ day: '2026-10-16' });
  });
});
