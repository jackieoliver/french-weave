import { describe, test, expect } from 'bun:test';
import {
  resolveLevel, L1_WORDS, L2_WORDS, validateSwaps, glossMatches, wordCount, isZeroFrench, normalizeFr, matchCase,
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
  test('keeps the synonym swaps the prompt itself asks for, with the bundled list and the plugin lexicon glosses', () => {
    // prompt.js examples and synonym rule; the lexicon (data/lexicon.csv) glosses grand as "big", il y a as "there is".
    const lexicon = [['grand', 'big'], ['seul', 'alone / only'], ['autre', 'other'], ['même', 'same / even'],
      ['je pense que', 'I think that'], ["c'est", "it's"], ['il y a', 'there is'], ['merci', 'thank you'],
      ["d'accord", 'okay / agreed'], ['un peu', 'a little'], ['beaucoup', 'a lot'], ['peut-être', 'maybe']]
      .map(([fr, en]) => ({ fr, en, hint: '', status: 'active' }));
    const pairs = [['large', 'grand'], ['huge', 'grand'], ['single', 'seul'], ['another', 'autre'], ['else', 'autre'],
      ['even', 'même'], ['I think', 'je pense que'], ['it is', "c'est"], ["that's", "c'est"], ['there are', 'il y a'],
      ['Thanks', 'merci'], ['OK', "d'accord"], ['a bit', 'un peu'], ['so much', 'beaucoup'], ['perhaps', 'peut-être']];
    const kept = validateSwaps(2, pairs.map(([o, f]) => ({ o, f, ctx: '' })), lexicon).map((s) => s.o);
    expect(kept).toEqual(pairs.map(([o]) => o));
    // The bundled level 2 examples in the prompt ("I think"->je pense que, "it's"->c'est, ...) all survive too.
    const bundled = [['I think', 'je pense que'], ["it's", "c'est"], ['there is', 'il y a'], ['the world', 'le monde'], ['today', "aujourd'hui"]];
    expect(validateSwaps(2, bundled.map(([o, f]) => ({ o, f, ctx: '' }))).map((s) => s.o)).toEqual(bundled.map(([o]) => o));
    // Issue #1 still drops.
    expect(validateSwaps(1, [{ o: 'to start', f: 'donc', ctx: '' }])).toEqual([]);
  });

  test('drops a swap whose English is not the word\'s gloss (issue #1: "to start" -> donc)', () => {
    expect(validateSwaps(1, [{ o: 'to start', f: 'donc' }])).toEqual([]);
    expect(validateSwaps(1, [{ o: 'So', f: 'donc' }])[0].f).toBe('Donc');
    expect(validateSwaps(1, [{ o: 'really', f: 'très' }])).toEqual([]);
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

describe('glossMatches', () => {
  test('matches any slash alternative, with or without a leading article', () => {
    expect(glossMatches('still', 'again / still')).toBe(true);
    expect(glossMatches('home', 'the house / home')).toBe(true);
    expect(glossMatches('the house', 'the house / home')).toBe(true);
    expect(glossMatches('house', 'the house / home')).toBe(true);
    expect(glossMatches('free', 'free (no cost)')).toBe(true);
  });
  test('accepts plain inflections and ignores case and punctuation', () => {
    expect(glossMatches('Problems', 'the problem')).toBe(true);
    expect(glossMatches('starting', 'to start')).toBe(true);
    expect(glossMatches('started', 'to start')).toBe(true);
    expect(glossMatches('making', 'to make')).toBe(true);
    expect(glossMatches('cities', 'the city')).toBe(true);
    expect(glossMatches('so,', 'so')).toBe(true);
    expect(glossMatches('it’s', "it's")).toBe(true);
  });
  test('rejects English that is not a gloss', () => {
    expect(glossMatches('to start', 'so')).toBe(false);
    expect(glossMatches('soon', 'so')).toBe(false);
    expect(glossMatches('', 'so')).toBe(false);
  });
});
