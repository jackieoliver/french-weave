import { describe, test, expect } from 'bun:test';
import { validateSwaps, breaksEnglish, compileEnglish } from '../src/levels.js';
import { GENERIC } from '../src/profile-data.js';
import { requestSwaps } from '../src/engine.js';

// Idiom swaps from the 0.2.1 live test that the gloss check can't catch: the English word is the gloss, but the
// phrase around it means something else. The rules are English-side data shared by every language (_generic.json).
const kept = (text, o, f, words, language) => validateSwaps(2, [{ o, f, ctx: '' }], words, language, { text }).map((s) => s.f);

describe('English never-split rules', () => {
  test('fixed phrases: a swap may cover one whole or stay out, never cut into it', () => {
    expect(kept('I need the report right now, please.', 'now', 'maintenant')).toEqual([]);
    expect(kept('We still meet now and then for coffee.', 'now', 'maintenant')).toEqual([]);
    expect(kept('You might as well ship it today.', 'as well', 'aussi')).toEqual([]);
    expect(kept('It was cheap and fast as well.', 'well', 'bien')).toEqual([]);
    expect(kept('It was cheap and fast as well.', 'as well', 'aussi')).toEqual(['aussi']); // the whole phrase
    expect(kept('Speed as well as cost matters here.', 'as well', 'aussi')).toEqual([]);
    expect(kept('It did not help at all, sadly.', 'all', 'tout')).toEqual([]);
    expect(kept('The build is fast now and the tests pass.', 'now', 'maintenant')).toEqual(['maintenant']);
  });

  test('no dangling English "of" after a swap', () => {
    expect(kept('There are a lot of people here today.', 'a lot', 'beaucoup')).toEqual([]);
    expect(kept('We stayed home because of the rain.', 'because', 'parce que')).toEqual([]);
    expect(kept('We stayed home because it rained.', 'because', 'parce que')).toEqual(['parce que']);
    expect(kept('It was a lot more fun than expected.', 'a lot', 'beaucoup')).toEqual(['beaucoup']);
  });

  test('before, after and since only before a noun, never a clause', () => {
    expect(kept('Call me before you leave the office.', 'before', 'avant')).toEqual([]);
    expect(kept('We ate after reading the news.', 'after', 'après')).toEqual([]);
    expect(kept('It has rained since we arrived here.', 'since', 'depuis')).toEqual([]);
    expect(kept('We always eat before the movie starts.', 'before', 'avant')).toEqual(['avant']);
    expect(kept('Call me after lunch if you can.', 'after', 'après')).toEqual(['après']);
  });

  test('"it\'s" meaning "it has" is not c\'est', () => {
    expect(kept("It's been a long week for everyone.", "It's", "c'est")).toEqual([]);
    expect(kept("Well, it's finally happened to us.", "it's", "c'est")).toEqual([]);
    expect(kept('That’s already been fixed upstream.', 'That’s', "c'est")).toEqual([]);
    expect(kept("It's a long week for everyone.", "It's", "c'est")).toEqual(["C'est"]);
  });

  test('filler "like" is not comme', () => {
    expect(kept('And I was like, no way that works.', 'like', 'comme')).toEqual([]);
    expect(kept('It took like 20 minutes to load.', 'like', 'comme')).toEqual([]);
    expect(kept('It was like really slow all day.', 'like', 'comme')).toEqual([]);
    expect(kept('It runs like a dream on my laptop.', 'like', 'comme')).toEqual(['comme']);
  });

  test('"there is a" never becomes "il y a a"', () => {
    expect(kept('Judging by my feed there is a growing gap in understanding.', 'there is', 'il y a')).toEqual([]);
    expect(kept('There is something odd about it.', 'There is', 'il y a')).toEqual(['Il y a']);
  });

  test('shared across languages: Spanish "porque of", "mucho of", "antes of" are caught the same way', () => {
    const es = [['porque', 'because'], ['mucho', 'a lot'], ['antes', 'before (earlier)'], ['ahora', 'now'], ['hay', 'there is / there are']]
      .map(([fr, en]) => ({ fr, en, hint: '', status: 'active' }));
    expect(kept('We stayed home because of the rain.', 'because', 'porque', es, 'Spanish')).toEqual([]);
    expect(kept('There are a lot of people here today.', 'a lot', 'mucho', es, 'Spanish')).toEqual([]);
    expect(kept('Call me before you leave the office.', 'before', 'antes', es, 'Spanish')).toEqual([]);
    expect(kept('I need the report right now, please.', 'now', 'ahora', es, 'Spanish')).toEqual([]);
    expect(kept('We stayed home because it rained.', 'because', 'porque', es, 'Spanish')).toEqual(['porque']);
    expect(kept('Judging by my feed there is a growing gap in understanding.', 'there is', 'hay', es, 'Spanish')).toEqual(['hay']);
  });

  test('ctx picks the occurrence; without the passage, ctx stands in', () => {
    const text = 'Do it right now, and now the tests pass.';
    expect(validateSwaps(2, [{ o: 'now', f: 'maintenant', ctx: 'and now the' }], undefined, 'French', { text })).toHaveLength(1);
    expect(validateSwaps(2, [{ o: 'now', f: 'maintenant', ctx: 'it right now' }], undefined, 'French', { text })).toHaveLength(0);
    expect(validateSwaps(2, [{ o: 'now', f: 'maintenant', ctx: 'right now,' }])).toHaveLength(0);
    expect(breaksEnglish('now', 'maintenant', '', 'Do it right now.')).toBe('phrase "right now"');
    expect(breaksEnglish('now', 'maintenant', '', 'Do it now.')).toBe('');
  });

  test('the rules are data: one english block in _generic.json, compiled once', () => {
    expect(GENERIC.english.phrases).toContain('right now');
    expect(GENERIC.english.contexts).toContain('[*] of');
    const rules = compileEnglish({ phrases: ['by the way'], contexts: ['[so] much?'] });
    expect(breaksEnglish('way', 'chemin', '', 'Oh, by the way, it works.', rules)).toBe('phrase "by the way"');
    expect(breaksEnglish('so', 'donc', '', 'It was so much fun.', rules)).toBe('context');
    expect(breaksEnglish('so', 'donc', '', 'It broke, so we fixed it.', rules)).toBe('context'); // optional token
    expect(breaksEnglish('so', 'donc', '', 'It broke, so we fixed it.', compileEnglish({ contexts: ['[so] much'] }))).toBe('');
  });

  test('the engine checks each swap against its own passage and counts the drops', async () => {
    const swaps = [{ o: 'now', f: 'maintenant', g: 'now', h: '', ctx: 'right now' }, { o: 'and', f: 'et', g: 'and', h: 'ay', ctx: 'tea and cake' }];
    const fetchImpl = async () => ({ ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ passages: [{ id: 'a', swaps }] }) }] } }] }) });
    const r = await requestSwaps({ apiKey: 'K', model: 'gemini-3.5-flash-lite', level: 2, batch: [{ id: 'a', text: 'I want tea and cake right now. Then a long nap.' }], fetchImpl });
    expect(r.results.a.map((s) => s.f)).toEqual(['et']);
    expect(r.dropped).toEqual({ idiom: 1 });
  });
});
