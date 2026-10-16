import { describe, test, expect } from 'bun:test';
import { findCandidates, buildUserContent, buildSystemPrompt, toSwaps, parseKeepResponse, RESPONSE_SCHEMA } from '../src/candidates.js';
import { isZeroFrench } from '../src/levels.js';

const W = (fr, en, hint, status = 'active') => ({ fr, en, hint, status });
const WORDS = [
  W('depuis', 'since', 'duh-pwee'), W('jamais', 'never', 'zha-meh'), W('pour', 'for', 'poor'), W('trouver', 'to find', 'troo-vay'),
  W('comme', 'like / as', 'kom'), W('nouveau', 'new', 'noo-voh'), W('le problème', 'the problem', 'luh pro-blem'),
  W('les problèmes', 'the problems', 'lay pro-blem'), W('et', 'and', 'ay', 'known'), W('application', 'app', 'a-plee-ka-syon'),
  W('la réponse', 'the answer', 'lah ray-ponss'), W('beaucoup', 'a lot', 'boh-koo'), W('grand', 'big', 'grahn'),
];
const found = (text, words = WORDS, level = 2) => findCandidates(text, words, 'French', level).map((c) => `${c.o}->${c.f}`);

describe('findCandidates', () => {
  test('numbers every listed gloss in passage order, as the swap the validator keeps', () => {
    const c = findCandidates('The cat and the dog are big.', WORDS, 'French', 2);
    expect(c.map((x) => [x.n, x.o, x.f, x.g, x.h])).toEqual([[1, 'and', 'et', 'and', 'ay'], [2, 'big', 'grand', 'big', 'grahn']]);
    expect(c[0].ctx).toBe('The cat and the dog');
    expect(c[0].status).toBe('known');
  });
  test('articles: "the new" is not nouveau; "the problem" takes the article along; "my answer" the bare noun', () => {
    expect(found('The new phone is here.')).toEqual(['new->nouveau']);
    expect(found('We saw the problem today.')).toEqual(['the problem->le problème']);
    expect(found('That was my answer to it.')).toEqual(['answer->réponse']);
    // Review 2026-10-16: "a problem" became "problème" and "to work" (the verb) the noun.
    expect(found('We have a problem now.')).toEqual(['problem->problème']);
    const work = [W('le travail', 'work', 'luh tra-vy'), W('trouver', 'to find', 'troo-vay')];
    expect(found('A good way to work is here.', work)).toEqual(['work->travail']); // the span never takes the "to"
    expect(found('I want to find it.', work)).toEqual(['to find->trouver']);
    // Second review: a listed word with its definite article still takes "the" along, in list order.
    const nouns = [W('le temps', 'time', 'luh tahn'), W('la fois', 'the time (occasion)', 'lah fwah'), W('la musique', 'music', 'lah mew-zeek'), W('les gens', 'people', 'lay zhahn')];
    expect(found('We love the time we spend. I like the music here. The people came early.', nouns))
      .toEqual(['the time->le temps', 'the music->la musique', 'The people->Les gens']);
  });
  test('plurals: offered only when the list has the plural', () => {
    expect(found('Our problems keep growing fast.')).toEqual(['problems->problèmes']);
    expect(found('The answers keep growing fast.')).toEqual([]); // la réponse has no plural on the list
  });
  test('longer spans win: "a lot of" is one place', () => {
    expect(found('We have a lot of work to do.')).toEqual(['a lot of->beaucoup']);
  });
  test('quotes, URLs, handles, hashtags, numbers and ALL CAPS stay English', () => {
    expect(found('He said "the problem is new" and left.')).toEqual(['and->et']);
    expect(found('See https://example.com/new and @new and #new now.')).toEqual(['and->et', 'and->et']);
    expect(found('It is BIG and big.')).toEqual(['and->et', 'big->grand']);
  });
  test('names: capitals mid-sentence, and the word after one ("the new Home app")', () => {
    expect(found('Open the new Home app and the app store.')).toEqual(['new->nouveau', 'and->et', 'app->application']);
    expect(found('We went to the Big Apple for a week.')).toEqual(['for->pour']);
    expect(found('Paris and London are big.')).toEqual(['and->et', 'big->grand']); // a function word after a name stays
  });
  test('"since" only before a time, never causal', () => {
    expect(found('Since it rained, we stayed in.')).toEqual([]);
    expect(found('We have lived here since 2019 and since then it changed.')).toEqual(['since->depuis', 'and->et', 'since->depuis']);
    expect(found('Nothing changed since last week or since the start of the year.')).toEqual(['since->depuis', 'since->depuis']);
    expect(found('It works since you asked.')).toEqual([]);
    expect(found('Since the idea of a free lunch is a myth, we pay.')).toEqual([]);
    expect(found('It grew since the start of the year.')).toEqual(['since->depuis']);
  });
  test('"like" only as "as / such as", never the verb', () => {
    expect(found('I like cats like Tom. Tools like grep help. I would like to go. They really like it.'))
      .toEqual(['like->comme', 'like->comme']);
    expect(found("We don't like rain.")).toEqual([]);
    expect(found('These are the things I like. Kids like games.')).toEqual(['like->comme']); // a plural noun: the model decides
  });
  test('never-split phrases: "Never mind", "look for", "find out"', () => {
    expect(found('Never mind the noise; I never go there.')).toEqual(['never->jamais']);
    expect(found('I look for answers and wait for news.')).toEqual(['and->et', 'for->pour']);
    expect(found('Find out more, then find the cat.')).toEqual(['find->trouver']);
    // Final harness run: "mind" out of "in mind", and "in" with no object (Mark Twain "walked in with two friends").
    const more = [W('dans', 'in', 'dahn'), W('esprit', 'mind', 'es-pree'), W('avec', 'with', 'ah-vek')];
    expect(found('Keep the new deadline in mind, please.', more)).toEqual([]);
    expect(found('Then he walked in with two old friends in the evening.', more)).toEqual(['with->avec', 'in->dans']);
  });
  test('bundled lists without a word state', () => {
    expect(findCandidates('The cat and the dog.', null, 'French', 1).map((c) => c.f)).toEqual(['et']);
  });
});

describe('candidates request and reply', () => {
  test('user content lists each passage with its numbered candidates; the schema asks only for keep', () => {
    const batch = [{ id: 'a', text: 'The cat and the dog are big.' }];
    const map = new Map([['a', findCandidates(batch[0].text, WORDS, 'French', 2)]]);
    const user = JSON.parse(buildUserContent(batch, 2, 'Pets (example.com)', map).replace(/^Passages:\n/, ''));
    expect(user[0]).toMatchObject({ id: 'a', page: 'Pets (example.com)', want: 2 });
    expect(user[0].candidates).toEqual([
      { n: 1, o: 'and', f: 'et', en: 'and', status: 'known', ctx: 'The cat and the dog' },
      { n: 2, o: 'big', f: 'grand', en: 'big', status: 'learning', ctx: 'dog are big' },
    ]);
    expect(RESPONSE_SCHEMA.properties.passages.items.required).toEqual(['id', 'topic', 'keep']);
    expect(buildSystemPrompt(2, WORDS, [], 'Spanish')).toContain('learning Spanish, at Level 2 of 4');
  });
  test('kept numbers become swaps; avoid keeps nothing; unknown numbers are ignored', () => {
    const c = findCandidates('The cat and the dog are big.', WORDS, 'French', 2);
    expect(toSwaps(c, [2, 7])).toEqual([{ o: 'big', f: 'grand', g: 'big', h: 'grahn', ctx: 'dog are big' }]);
    const reply = parseKeepResponse(JSON.stringify({ passages: [{ id: 'a', topic: 'ok', keep: [1] }, { id: 'b', topic: 'avoid', keep: [1] }, { id: 'c', topic: 'ok' }] }));
    expect([...reply]).toEqual([['a', [1]], ['b', []], ['c', []]]);
  });
});

describe('title guard', () => {
  test('pages about money, health, legal matters, crime, driving or emergencies by their title', () => {
    for (const t of ['The best index funds to buy this year', 'Teen driver injured in crash on Route 9', 'Best ETFs for 2026',
      'The Roth IRA explained', 'Stocks fall as rates rise', 'Fatal highway crash closes lanes', 'Two hurt in collision downtown']) {
      expect(isZeroFrench(t)).toBe(true);
    }
  });
  test('ordinary pages that share a word stay on', () => {
    for (const t of ['Why my program crashed: the crash of a program', 'A driver update for Linux', 'NVIDIA driver 560 released',
      'Ira Glass on radio', 'Funds for open source', 'Retirement of the v1 API', 'App crash on startup fixed', 'Graphics driver crash on Windows']) {
      expect(isZeroFrench(t)).toBe(false);
    }
  });
});
