import { describe, test, expect } from 'bun:test';
import { readFileSync } from 'fs';
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
  test('an English article left outside the swap gets the bare noun, never a double article', () => {
    const f = (o, fr) => validateSwaps(1, [{ o, f: fr, ctx: '' }])[0]?.f;
    expect(f('problem', 'le problème')).toBe('problème'); // "my problem", "a solved problem"
    expect(f('answer', 'la réponse')).toBe('réponse'); // "The answer is"
    expect(f('idea', "l'idée")).toBe('idée');
    expect(f('the problem', 'le problème')).toBe('le problème');
    expect(f('The answer', 'la réponse')).toBe('La réponse');
  });
  test("a bare noun drops its article's sound from the hint, hyphenated elided hints included", () => {
    const h = (o, fr, words, lang) => validateSwaps(2, [{ o, f: fr, ctx: '' }], words, lang)[0]?.h;
    expect(h('idea', "l'idée")).toBe('ee-day'); // was "lee-day", the article's sound
    expect(h('year', "l'année")).toBe('ah-nay');
    expect(h('school', "l'école")).toBe('ay-kol');
    expect(h('story', "l'histoire")).toBe('ees-twar');
    expect(h('problem', 'le problème')).toBe('prob-lem');
    expect(h('the idea', "l'idée")).toBe('lee-day'); // with its article, the article's sound stays
    const it = [{ fr: "l'ora", en: 'the hour', hint: 'LOH-rah', status: 'active' }, { fr: 'la casa', en: 'the house', hint: 'lah KAH-sah', status: 'active' }];
    expect(h('hour', "l'ora", it, 'Italian')).toBe('OH-rah');
    expect(h('house', 'la casa', it, 'Italian')).toBe('KAH-sah');
    // A language whose profile has no elided sound leaves the hint alone.
    const es = [{ fr: 'el agua', en: 'the water', hint: 'el AH-gwah', status: 'active' }];
    expect(h('water', 'el agua', es, 'Spanish')).toBe('AH-gwah');
  });
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
  test('QA 2026-10-15: right synonyms the gloss check used to drop', () => {
    for (const [o, en] of [['too', 'also'], ['as well', 'also'], ['hard', 'difficult'], ['in fact', 'actually'], ['However', 'but'], ['possibly', 'maybe'], ['too', 'too much']]) {
      expect(glossMatches(o, en)).toBe(true);
    }
    expect(glossMatches('sure', 'of course')).toBe(false); // "I'm not sure" is not bien sûr
  });
  test('rejects English that is not a gloss', () => {
    expect(glossMatches('to start', 'so')).toBe(false);
    expect(glossMatches('soon', 'so')).toBe(false);
    expect(glossMatches('', 'so')).toBe(false);
  });
});

describe('gloss check across every word list', () => {
  // CSV rows of the plugin lexicon and the starter lists (word or fr, en, ...); quoted fields allowed.
  const csv = (name) => readFileSync(new URL(`../../data/${name}`, import.meta.url), 'utf8').replace(/^﻿/, '').trim()
    .split('\n').slice(1).map((line) => line.match(/("[^"]*"|[^,]*)(?:,|$)/g).map((c) => c.replace(/,$/, '').replace(/^"|"$/g, '')))
    .map(([fr, en]) => ({ fr, en, hint: '', status: 'active' }));
  const lists = { bundled: L2_WORDS, lexicon: csv('lexicon.csv'), spanish: csv('lexicons/spanish.csv'),
    japanese: csv('lexicons/japanese.csv'), indonesian: csv('lexicons/indonesian.csv'), german: csv('lexicons/german.csv'),
    italian: csv('lexicons/italian.csv'), portuguese: csv('lexicons/portuguese.csv') };
  const alternatives = (en) => en.split(/\s*[/;,]\s*/).filter((a) => a.trim());
  // 0.2.1 regression (gloss check with synonyms): a too-strict check dropped right swaps. Each word's own gloss passes.
  test('every gloss alternative of every word is accepted for that word', () => {
    for (const [name, words] of Object.entries(lists)) {
      expect(words.length).toBeGreaterThan(20);
      const dropped = words.flatMap((w) => alternatives(w.en).filter((alt) => !glossMatches(alt, w.en)).map((alt) => `${name}: ${w.fr} <- ${alt}`));
      expect(dropped).toEqual([]);
    }
  });
  // Issue #1 generalized: a model pairing a word with another word's English (wrong sense) is dropped.
  test("another word's gloss is rejected unless the two glosses share an alternative", () => {
    for (const [name, words] of Object.entries(lists)) {
      const wrong = [];
      for (let i = 0; i < words.length; i++) {
        const w = words[i], other = words[(i + 7) % words.length];
        const shared = alternatives(other.en).some((alt) => glossMatches(alt, w.en) && glossMatches(alternatives(w.en)[0], other.en));
        const english = alternatives(other.en)[0];
        if (!shared && glossMatches(english, w.en)) wrong.push(`${name}: ${w.fr} (${w.en}) <- ${english}`);
      }
      expect(wrong).toEqual([]);
    }
  });
});
