import { describe, test, expect } from 'bun:test';
import {
  resolveLevel, L1_WORDS, L2_WORDS, validateSwaps, wordCount, isZeroFrench, normalizeFr, matchCase,
} from '../src/levels.js';

describe('level', () => {
  test('follows the synced stage, else 1; override wins; capped at the built level', () => {
    expect(resolveLevel({})).toEqual({ stage: 0, chosen: 1, effective: 1 });
    expect(resolveLevel({}, 2)).toEqual({ stage: 2, chosen: 2, effective: 2 });
    expect(resolveLevel({ levelOverride: 1 }, 2)).toEqual({ stage: 2, chosen: 1, effective: 1 });
    expect(resolveLevel({ levelOverride: 4 }, 1)).toEqual({ stage: 1, chosen: 4, effective: 2 });
    expect(resolveLevel({ levelOverride: 9 }, 7)).toEqual({ stage: 0, chosen: 1, effective: 1 });
  });
});

describe('word lists', () => {
  test('L1 is the bundled starter list', () => {
    const spec = ['et', 'mais', 'ou', 'donc', 'parce que', 'avec', 'sans', 'pour', 'très', 'aussi', 'bien', 'beaucoup', 'un peu',
      'maintenant', 'toujours', 'peut-être', 'ici', 'voilà', 'oui', 'non', 'merci', 'le problème', 'la question', "l'idée",
      'la réponse', 'important', 'possible', 'difficile'];
    expect(L1_WORDS.map((w) => w.fr)).toEqual(spec);
  });
  test('L2 is about 150 words, includes L1 and the fixed phrases, every entry glossed with a hint', () => {
    expect(L2_WORDS.length).toBeGreaterThanOrEqual(140);
    expect(L2_WORDS.length).toBeLessThanOrEqual(160);
    const frs = L2_WORDS.map((w) => w.fr);
    for (const w of L1_WORDS) expect(frs).toContain(w.fr);
    for (const p of ["c'est", 'il y a', 'je pense que', 'il faut']) expect(frs).toContain(p);
    expect(new Set(frs).size).toBe(frs.length);
    for (const w of L2_WORDS) {
      expect(w.en.length).toBeGreaterThan(0);
      expect(w.hint.length).toBeGreaterThan(0);
    }
  });
});

describe('validateSwaps', () => {
  test('keeps list words, canonicalizes accents, fills gloss and hint from the list', () => {
    const out = validateSwaps(1, [{ o: 'very', f: 'tres', g: 'x', h: 'y', ctx: 'is very good' }]);
    expect(out).toEqual([{ o: 'very', f: 'très', g: 'very', h: 'treh', ctx: 'is very good' }]);
  });
  test('drops words off the level list and malformed entries', () => {
    expect(validateSwaps(1, [{ o: 'in', f: 'dans' }])).toEqual([]);
    expect(validateSwaps(2, [{ o: 'in', f: 'dans' }])[0].f).toBe('dans');
    expect(validateSwaps(1, [{ o: 'and' }, null, { f: 'et' }, { o: '  ', f: 'et' }])).toEqual([]);
    expect(validateSwaps(1, 'nope')).toEqual([]);
  });
  test('accepts the bare noun and keeps accents', () => {
    const [s] = validateSwaps(1, [{ o: 'problem', f: 'probleme' }]);
    expect(s.f).toBe('problème');
    expect(s.g).toBe('problem');
    const [t] = validateSwaps(1, [{ o: 'the problem', f: 'le problème' }]);
    expect(t.f).toBe('le problème');
  });
  test('matches capitalization of the original', () => {
    expect(validateSwaps(1, [{ o: 'And', f: 'et' }])[0].f).toBe('Et');
    expect(validateSwaps(1, [{ o: 'AND', f: 'et' }])[0].f).toBe('et');
    expect(validateSwaps(1, [{ o: 'Because', f: 'parce que' }])[0].f).toBe('Parce que');
    expect(matchCase("l'idée", 'The idea')).toBe("L'idée");
  });
  test('keeps accented homographs distinct and rejects blank replacements', () => {
    expect(validateSwaps(2, [{ o: 'or', f: 'ou' }])[0].f).toBe('ou');
    expect(validateSwaps(2, [{ o: 'where', f: 'où' }])[0].f).toBe('où');
    expect(validateSwaps(2, [{ o: 'and', f: '' }, { o: 'and', f: '  ' }])).toEqual([]);
  });
  test('plugin words replace the bundled list and keep the event spelling and status', () => {
    const words = [{ fr: 'la lumière', en: 'the light', hint: 'loo-myair', status: 'active' }];
    expect(validateSwaps(1, [{ o: 'light', f: 'lumiere' }, { o: 'and', f: 'et' }], words))
      .toEqual([{ o: 'light', f: 'lumière', g: 'light', h: 'loo-myair', ctx: '', word: 'la lumière', status: 'active' }]);
  });
  test('normalizeFr', () => {
    expect(normalizeFr(' Peut-Être ')).toBe('peut-etre');
    expect(normalizeFr('l’idée')).toBe("l'idee");
  });
});

describe('guards', () => {
  test('wordCount', () => {
    expect(wordCount('')).toBe(0);
    expect(wordCount('  one two\n\nthree ')).toBe(3);
  });
  test('zero-French topics', () => {
    expect(isZeroFrench('if you take ibuprofen talk to your doctor first')).toBe(true);
    expect(isZeroFrench('my lawyer says the lawsuit is fine')).toBe(true);
    expect(isZeroFrench('call 911 in an emergency')).toBe(true);
    expect(isZeroFrench('shipped the new onboarding flow today')).toBe(false);
    expect(isZeroFrench('the taxi was late again')).toBe(false);
  });
});
