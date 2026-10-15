import { describe, test, expect } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { GENERIC, PROFILES } from '../src/profile-data.js';
import { profileFor, articlePatterns, readingFor } from '../src/profile.js';
import { buildSystemPrompt } from '../src/prompt.js';
import { validateSwaps, glossMatches, SYNONYMS, normalizeFr, foldFor } from '../src/levels.js';

const DATA = new URL('../../data/', import.meta.url);
const json = (name) => JSON.parse(readFileSync(new URL(`profiles/${name}`, DATA), 'utf8'));

// A minimal fixture, not the real Spanish profile (that one comes with its word list).
const SPANISH = {
  language: 'Spanish',
  variety: 'Latin American Spanish',
  articles: { definite: ['el', 'la', 'los', 'las'], indefinite: ['un', 'una'], elided: [], hint_prefixes: ['el', 'lah'] },
  extension: {
    synonym_examples: [[['big', 'large', 'huge'], 'grande']],
    filler_example: ['and', 'y'],
    sense_note: '"so" as an intensifier is NOT entonces',
    adjective_example: ['a big win', 'a grande win'],
  },
};
const WORDS = [
  { fr: 'grande', en: 'big', hint: 'GRAHN-deh', status: 'active' },
  { fr: 'el problema', en: 'the problem', hint: 'el pro-BLEH-mah', status: 'active' },
  { fr: 'y', en: 'and', hint: 'ee', status: 'known' },
];
const FRENCH = /French(?! Weave)|\bdonc\b|\bgrand\b|-> et|\bseul\b|\bautre\b|même|\bici\b|\bbien\b/;

describe('profiles', () => {
  test('the extension copy matches data/profiles (run python3 scripts/make_profiles.py after editing a profile)', () => {
    const files = readdirSync(new URL('profiles/', DATA)).filter((f) => f.endsWith('.json'));
    expect(GENERIC).toEqual(json('_generic.json'));
    const others = Object.fromEntries(files.filter((f) => f !== '_generic.json').map((f) => [f.replace(/\.json$/, ''), json(f)]));
    expect(PROFILES).toEqual(others);
  });

  test('a language with no profile, or missing fields, gets the generic values', () => {
    expect(profileFor('Klingon')).toEqual({ ...GENERIC, language: 'Klingon' });
    const partial = profileFor('Spanish', { spanish: { language: 'Spanish', extension: { sense_note: 'x' } } });
    expect(partial.extension.sense_note).toBe('x');
    expect(partial.extension.synonym_examples).toEqual([]);
    expect(partial.script.marks).toBe('accents');
    expect(profileFor()).toEqual(profileFor('French'));
  });

  test('a non-French profile fills the prompt with its own examples, sense note and variety; no French left', () => {
    const prof = profileFor('Spanish', { spanish: SPANISH });
    const p = buildSystemPrompt(2, WORDS, [], 'Spanish', prof);
    expect(p).toContain('(including its English synonyms, e.g. "big"/"large"/"huge" -> grande)');
    expect(p).toContain('Do not let common filler like "and" -> y crowd out');
    expect(p).toContain('in context ("so" as an intensifier is NOT entonces).');
    expect(p).toContain('readable ("a big win" -> "a grande win" is fine).');
    expect(p).toContain('ordinary English reading. Use Latin American Spanish words and spellings.');
    expect(p).toContain('zero Spanish');
    expect(p).toContain('Zero Spanish in passages about health');
    expect(p).not.toMatch(FRENCH);
    // No profile: the generic prompt, no examples at all.
    const bare = buildSystemPrompt(2, WORDS, [], 'Klingon');
    expect(bare).toContain('sense fits. Use one');
    expect(bare).toContain('same sense in context. An adjective swap must keep English word order readable.');
    expect(bare).not.toMatch(FRENCH);
  });

  test('articles come from the profile', () => {
    const es = articlePatterns(profileFor('Spanish', { spanish: SPANISH }));
    expect('el problema'.replace(es.any, '')).toBe('problema');
    expect('una casa'.replace(es.any, '')).toBe('casa');
    expect('le problème'.replace(es.any, '')).toBe('le problème');
    expect(articlePatterns(profileFor('Klingon'))).toEqual({ any: null, definite: null, hint: null });
    // Words from a language with no profile: French articles are never stripped.
    const klingon = [{ fr: 'le problème', en: 'the problem', hint: 'luh prob-lem', status: 'active' }];
    expect(validateSwaps(1, [{ o: 'problem', f: 'problème' }], klingon, 'Klingon')).toEqual([]);
    expect(validateSwaps(1, [{ o: 'problem', f: 'problème' }], klingon, 'French')[0].f).toBe('problème');
  });

  // The synonym, filler and default-swap examples a profile puts in prompts must pass the swap filter (the gloss
  // check) against that language's word list, or the model is told to make swaps the extension then drops.
  test("every bundled profile's examples pass the gloss check against its word list", () => {
    const csv = (name) => readFileSync(new URL(name, DATA), 'utf8').replace(/^﻿/, '').trim().split('\n').slice(1)
      .map((line) => line.split(','));
    for (const [name, prof] of Object.entries(PROFILES)) {
      const rows = csv(name === 'french' ? 'lexicon.csv' : `lexicons/${name}.csv`);
      const gloss = new Map(rows.map(([w, en]) => [w, en]));
      const synonyms = { ...SYNONYMS, ...prof.extension.synonyms };
      const pairs = [...prof.extension.synonym_examples.flatMap(([ens, w]) => ens.map((en) => [en, w])),
        ...(prof.extension.filler_example ? [prof.extension.filler_example] : []), ...prof.examples.default_swaps];
      const failed = pairs.filter(([en, w]) => !gloss.has(w) || !glossMatches(en, gloss.get(w), synonyms));
      expect(failed.map(([en, w]) => `${name}: "${en}" -> ${w}`)).toEqual([]);
    }
  });

  test('German folds umlauts to ae, oe, ue and ss instead of stripping them', () => {
    const de = profileFor('German');
    expect(normalizeFr('schön')).toBe(normalizeFr('schon')); // the French fold would merge them
    expect(foldFor(de)('Schön')).toBe('schoen');
    expect(foldFor(de)('groß')).toBe('gross');
    expect(foldFor(profileFor('French'))).toBe(normalizeFr);
    const words = [
      { fr: 'schön', en: 'beautiful / nice', hint: 'shöhn', status: 'active' },
      { fr: 'schon', en: 'already', hint: 'shohn', status: 'active' },
      { fr: 'Fehler', en: 'mistake / error', hint: 'FAY-luh', status: 'active' },
    ];
    const swaps = validateSwaps(1, [{ o: 'nice', f: 'schoen' }, { o: 'already', f: 'schon' }, { o: 'nice', f: 'schon' },
      { o: 'bug', f: 'fehler' }], words, 'German');
    expect(swaps.map((s) => [s.o, s.f])).toEqual([['nice', 'schön'], ['already', 'schon'], ['bug', 'Fehler']]);
  });

  test('Portuguese fixed phrases keep their article', () => {
    const pt = articlePatterns(profileFor('Portuguese'));
    for (const phrase of ['o que', 'a não ser', 'a partir de', 'a maioria', 'o tempo todo']) {
      expect(phrase.replace(pt.any, '')).toBe(phrase);
      expect(phrase.replace(pt.definite, '')).toBe(phrase);
    }
    expect('o problema'.replace(pt.any, '')).toBe('problema');
    expect('o tempo'.replace(pt.any, '')).toBe('tempo');
    expect('uma ideia'.replace(pt.any, '')).toBe('ideia');
    const words = [
      { fr: 'o que', en: 'what', hint: 'oo KAY', status: 'active' },
      { fr: 'a partir de', en: 'starting from', hint: 'ah par-CHEER jee', status: 'active' },
      { fr: 'o problema', en: 'the problem', hint: 'oo proh-BLAY-mah', status: 'active' },
    ];
    const swaps = validateSwaps(1, [{ o: 'what', f: 'que' }, { o: 'starting from', f: 'partir de' },
      { o: 'what', f: 'o que' }, { o: 'problem', f: 'problema' }], words, 'Portuguese');
    expect(swaps.map((s) => [s.o, s.f, s.h])).toEqual([['what', 'o que', 'oo KAY'], ['problem', 'problema', 'proh-BLAY-mah']]);
  });

  test('reading above a word follows the profile (none by default)', () => {
    const neko = { fr: '猫', en: 'cat', hint: 'neko', reading: 'ねこ', status: 'active' };
    const demo = { fr: 'でも', en: 'but', hint: 'demo', reading: 'でも', status: 'active' };
    expect(readingFor(neko, profileFor('French'))).toBe('');
    const ja = profileFor('Japanese', { japanese: { language: 'Japanese', script: { reading: {
      early: 'romaji', late: 'kana', late_from_stage: 3, late_only_with: 'kanji', known_drop: true } } } });
    expect([readingFor(neko, ja, 1), readingFor(demo, ja, 2)]).toEqual(['neko', 'demo']);
    expect([readingFor(neko, ja, 3), readingFor(demo, ja, 3)]).toEqual(['ねこ', '']);
    expect(readingFor({ ...neko, status: 'known' }, ja, 1)).toBe('');
    // The bundled Japanese profile: romaji above every word early on, kana above kanji words later, none when known.
    const bundled = profileFor('Japanese');
    expect([readingFor(neko, bundled, 1), readingFor(neko, bundled, 3), readingFor(demo, bundled, 3)]).toEqual(['neko', 'ねこ', '']);
    expect(readingFor({ ...neko, status: 'known' }, bundled, 1)).toBe('');
  });
});
