// Quoted text stays English in every language, and the Portuguese and Italian sense rules (extension.contexts and
// extension.question_words in their profiles). Cases from an internal test set, 2026-10-17: swaps inside Hartley's quotation,
// é and è for the "is" of "is improving", and qual, chi, cosa for a relative.
import { describe, test, expect } from 'bun:test';
import { quotedRanges, inQuotes } from '../src/quotes.js';
import { findCandidates } from '../src/candidates.js';
import { validateSwaps } from '../src/levels.js';

const quoted = (text) => quotedRanges(text).map(([a, b]) => text.slice(a, b));
const W = (fr, en, hint = '', status = 'active') => ({ fr, en, hint, status });

describe('quotedRanges', () => {
  test('double quotes of every kind', () => {
    expect(quoted('He said "here and now" twice.')).toEqual(['"here and now"']);
    expect(quoted('He said “here and now” twice.')).toEqual(['“here and now”']);
    expect(quoted('Il a dit « ici et maintenant » deux fois.')).toEqual(['« ici et maintenant »']);
    expect(quoted('Er sagte „hier und jetzt“ zweimal, „dort”.')).toEqual(['„hier und jetzt“', '„dort”']);
    expect(quoted('彼は「ここ」と言った。')).toEqual(['「ここ」']);
  });
  test('an unclosed quote: the whole passage when it opens it, else the rest of its sentence', () => {
    const hartley = '“I’ve kept a number of these myself, and I’ve known other people who just found them. And the effects of reading the letters.';
    expect(quoted(hartley)).toEqual([hartley]);
    expect(quoted('We might describe the result as “going out with a whimper. The story ends there.'))
      .toEqual(['“going out with a whimper.']);
    expect(quoted('Very "strange feeling. I have long wondered about it.')).toEqual(['"strange feeling.']);
  });
  test('an inch mark is not a quote', () => {
    expect(quoted('A 12" screen and a 15" one are here.')).toEqual([]);
    expect(quoted('A 12" screen, "the best" one.')).toEqual(['"the best"']);
  });
  test('single quotes only when they clearly delimit a quotation', () => {
    expect(quoted("Claude Code prints a 'Remote Control not started here' notice.")).toEqual(["'Remote Control not started here'"]);
    expect(quoted('It prints ‘Remote Control not started here’ and stops.')).toEqual(['‘Remote Control not started here’']);
    expect(quoted("He called it 'fine', and it's fine.")).toEqual(["'fine'"]);
  });
  test('apostrophes open nothing', () => {
    for (const text of ["It's from Hartley's book, and it's here.", 'It’s from Hartley’s book, and it’s here.',
      "The students' work is done and the kids' too.", 'I don’t know, and they didn’t either.',
      "Back in the '90s, 'cause we could, we did it.", 'Back in the ’90s we did it, rock ’n’ roll aside.']) {
      expect(quoted(text).filter((q) => /[\p{L}]{3}/u.test(q))).toEqual([]);
    }
    expect(quoted("It's from Hartley's book")).toEqual([]);
  });
  test('inQuotes tells whether a span touches quoted text', () => {
    const text = 'Here "and there" and here.';
    expect(inQuotes(text, text.indexOf('and'), text.indexOf('and') + 3)).toBe(true);
    expect(inQuotes(text, text.lastIndexOf('and'), text.lastIndexOf('and') + 3)).toBe(false);
  });
});

describe('quoted text in the pipeline', () => {
  const PT = [W('e', 'and'), W('outro', 'other / another / else'), W('aqui', 'here'), W('é', "it's / is"), W('qual', 'which'), W('quem', 'who')];
  const pt = (text) => findCandidates(text, PT, 'Portuguese', 2).map((c) => `${c.o}->${c.f}`);
  test('findCandidates leaves quoted text alone, apostrophes and all', () => {
    expect(pt('“I’ve had a number of these myself, and I’ve known other people who have just acquired them.')).toEqual([]);
    expect(pt("It prints a 'Remote Control not started here' notice and stops here.")).toEqual(['and->e', 'here->aqui']);
    expect(pt("It's from Hartley's book, and here it is.")).toEqual(["It's->É", 'and->e', 'here->aqui', 'it is->é']);
    expect(findCandidates('He said « here and now » and left here.', [W('et', 'and'), W('ici', 'here')], 'French', 2)
      .map((c) => c.o)).toEqual(['and', 'here']);
  });
  test('validateSwaps drops a swap the page would place inside quotes, in every language', () => {
    const text = 'He said “we stay here and wait” and left.';
    const swaps = [{ o: 'here', f: 'aqui', ctx: 'we stay here and' }, { o: 'and', f: 'e', ctx: 'wait” and left' }];
    const stats = {};
    expect(validateSwaps(2, swaps, PT, 'Portuguese', { text, stats }).map((s) => s.o)).toEqual(['and']);
    expect(stats.quoted).toBe(1);
    const fr = validateSwaps(2, [{ o: 'here', f: 'ici', ctx: 'we stay here and' }], null, 'French', { text });
    expect(fr).toEqual([]);
    expect(validateSwaps(2, [{ o: 'here', f: 'aqui', ctx: 'we stay here and' }], PT, 'Portuguese').length).toBe(1); // no text: no check
  });
});

describe('Portuguese and Italian sense rules', () => {
  const PT = [W('é', "it's / is"), W('qual', 'which'), W('quem', 'who'), W('e', 'and')];
  const IT = [W('è', 'is / it\'s'), W('chi', 'who'), W('quale', 'which'), W('cosa', 'what'), W('e', 'and')];
  const pt = (text) => findCandidates(text, PT, 'Portuguese', 2).map((c) => `${c.o}->${c.f}`);
  const it = (text) => findCandidates(text, IT, 'Italian', 2).map((c) => `${c.o}->${c.f}`);
  test('the "is" of "is + -ing" is never é or è', () => {
    expect(pt('Microsoft is raising the price.')).toEqual([]);
    expect(pt('Deception which is continuously improving by trial.')).toEqual([]);
    expect(pt("It's raining and it is not working.")).toEqual(['and->e']);
    expect(pt('It is getting late and it is fine.')).toEqual(['and->e', 'it is->é']);
    expect(pt('The house is being built.')).toEqual([]);
    expect(it('The gesture is likely originating there.')).toEqual([]);
    expect(it('Microsoft is raising the price.')).toEqual([]);
  });
  test('the copula stays a candidate, -ing adjectives and nouns included', () => {
    expect(pt('The fix is fast.')).toEqual(['is->é']);
    expect(pt('This is amazing.')).toEqual(['This is->É']);
    expect(pt('The plan is something new.')).toEqual(['is->é']);
    expect(it('The fix is interesting.')).toEqual(['is->è']);
  });
  test('qual and quem only where the English asks', () => {
    expect(pt('Sophisticated deception which is fast.')).toEqual(['is->é']);
    expect(pt('The front facade, which was tilted.')).toEqual([]);
    expect(pt('Job creation – which are either.')).toEqual([]);
    expect(pt('The people who made it.')).toEqual([]);
    expect(pt('Human beings (who are called that).')).toEqual([]);
    expect(pt('Which one is better? Who decides that?')).toEqual(['Which->Qual', 'is->é', 'Who->Quem']);
    expect(pt('Find out which one is fast.')).toEqual(['which->qual', 'is->é']);
    expect(pt('I know which works and tell me who wins.')).toEqual(['which->qual', 'and->e', 'who->quem']);
    expect(pt('“Which is fast?” she asked.')).toEqual([]); // quoted
  });
  test('chi, quale and cosa only where the English asks', () => {
    expect(it('An analyst on the war who had worked there.')).toEqual([]);
    expect(it('Some of what they snarked on is cool.')).toEqual(['is->è']);
    expect(it('The tool which runs.')).toEqual([]);
    expect(it('Tell me what you think. Who knows?')).toEqual(['what->cosa', 'Who->Chi']);
    expect(it('What is it? Which one?')).toEqual(['What->Cosa', 'is->è', 'Which->Quale']);
  });
  test('validateSwaps applies the same rules to free-form swaps', () => {
    const text = 'Deception which is continuously improving. Which one wins?';
    const swaps = [{ o: 'which', f: 'qual', ctx: 'Deception which is' }, { o: 'is', f: 'é', ctx: 'which is continuously' },
      { o: 'Which', f: 'qual', ctx: 'Which one wins' }];
    const stats = {};
    expect(validateSwaps(2, swaps, PT, 'Portuguese', { text, stats }).map((s) => s.f)).toEqual(['Qual']);
    expect(stats.sense).toBe(2);
  });
  test('other languages keep their question words as before', () => {
    const fr = [W('qui', 'who'), W('et', 'and')];
    expect(findCandidates('The people who made it.', fr, 'French', 2).map((c) => c.f)).toEqual(['qui']);
  });
});
