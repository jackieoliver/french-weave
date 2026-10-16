import { describe, test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { LOCAL_WORDS, localSwaps, localOff, localVocabulary } from '../src/local.js';
import { L1_WORDS, L2_WORDS, validateSwaps } from '../src/levels.js';
import { applySwaps, locate } from '../src/text.js';
import { hashKey } from '../src/hash.js';
import { STATE_KEY } from '../src/hostsource.js';
import { TIER_TEXT } from '../src/tier.js';

const fr = (swaps) => swaps.map((s) => s.f);
const L2 = (text, words) => localSwaps(2, text, words);

describe('local swaps (no key, no model)', () => {
  test('the list holds only fixed-sense words, each from the lexicon, and none with a second sense', async () => {
    const lexicon = new Set((await Bun.file(new URL('../../data/lexicon.csv', import.meta.url)).text()).split('\n').slice(1).map((l) => l.split(',')[0]));
    const builtIn = new Set(L2_WORDS.map((w) => w.fr));
    for (const w of LOCAL_WORDS) {
      expect(lexicon.has(w.fr)).toBe(true);
      if (w.fr !== 'contre') expect(builtIn.has(w.fr)).toBe(true); // contre comes only with the plugin's words
    }
    const english = LOCAL_WORDS.flatMap((w) => w.forms);
    for (const twoSenses of ['so', 'for', 'in', 'like', 'well', 'here', 'still', 'now', 'only', 'since', 'when', 'on', 'that', 'this', 'no', 'more', 'all', 'even', 'same', 'it\'s', 'okay']) {
      expect(english).not.toContain(twoSenses);
    }
  });

  test('swaps fixed words with the case of the original, gloss and sound hint from the list', () => {
    expect(L2('Cats and dogs sleep a lot. Because it rains, we stay home.')).toEqual([
      { o: 'and', f: 'et', g: 'and', h: 'ay', ctx: 'Cats and dogs' },
      { o: 'Because', f: 'Parce que', g: 'because', h: 'pars kuh', ctx: 'lot. Because it' },
    ]);
    // The same shape the model path produces, so validation passes them unchanged.
    const swaps = L2('Maybe we walk home together after the long week.');
    expect(fr(swaps)).toEqual(['Peut-être', 'ensemble']);
    expect(fr(localSwaps(1, 'Maybe we walk home together after the long week.'))).toEqual(['Peut-être']); // level 1: no ensemble
    expect(validateSwaps(2, swaps)).toEqual(swaps);
  });

  test('leaves alone the senses a fixed swap would get wrong', () => {
    const none = [
      'We stayed inside because of the storm that hit the coast.',
      'They came to the party, all but one of my old friends.',
      'I can not help but laugh at this joke every single time.',
      'We read the very end of the book together last night quietly.'.replace(' together', ''),
      'He said he was very much looking forward to the trip.',
      'Ten or so people showed up to the meeting this morning.',
      'We had to deal with a broken laptop for the whole week.',
      'The training starts with a forward pass through the network.',
      'Sampling the model with no input returns odd reports sometimes.'.replace(' sometimes', ''),
      'More and more people are writing less code than they used to.',
      'You can pick tea and/or coffee from the menu at the counter.',
      'We listened to Simon and Garfunkel on the long ride up north.',
      'My favourite film is Gone with the Wind, which I watch yearly.',
      'The scenario is called “going out with a whimper” in the essay.',
      'She wrote a ‘how to argue with the people who tell you’ piece last year.',
      'THE OLD SIGN SAID BREAKFAST AND LUNCH ARE SERVED ALL DAY.',
      'I keep saying never mind to my sister when she asks about it.',
      'The tree grew as soon as spring arrived in the small garden.',
      'He made a change of course halfway through the long project.',
      'Nothing Is Better Than This, the oral history, came out last fall.',
      'She fell in love with him the summer they both lived in Lyon.',
      'Compared with last year, the garden looks much greener this spring.',
      'He replaced the old tiles with new ones from the shop down the road.',
      'What should I do with all these old boxes in the hall closet?',
      'That is the reason why I left the party early last night.',
      'How often do you go to the market on the weekend, roughly?',
      'The person who I met at the station gave me a paper map.',
      "'I'll come with you,' she said as the train pulled into the station.",
      'He replaced the old wooden kitchen table with a new one from the shop.',
      'Here are five reasons why I left the city last spring for the coast.',
      'They replaced Mr. Smith with a robot at the front desk last month.',
    ];
    for (const text of none) expect([text, L2(text)]).toEqual([text, []]);
  });

  test('sensitive passages stay English: the model rule has no model here, so the guard is wider', () => {
    for (const text of [
      'The crime rate in the city is one of the highest and it is always rising.',
      'Life insurance pays out less on average than you put into it, and that is the point.',
      'I always think it is kinda nuts how dangerous it is, and nobody talks about it.',
      'My doctor changed the dose and the side effects are still there.',
      'It cost me $200 and I would buy it again without a second thought.',
      'He was shot twice and the suspect fled before anyone could stop him.',
      'My dad had a heart attack yesterday and is in the ICU right now.',
      'Two soldiers were dead and dozens wounded after the bomb exploded today.',
      'She was raped at a party and never told anyone about it for years.',
      'Her abortion appointment is tomorrow and she is really scared about it.',
      'The killing shocked the town and everyone stayed home that night.',
      "I can't afford rent or groceries this month and my credit card is maxed out.",
      'Scammers took her whole paycheck and the bank did nothing to help.',
      'He was convicted of fraud and sentenced to five years last week.',
      "'We were left with nothing,' says mother of two after the flood.",
      'Shells were exploding all night and we hid together in the cellar.',
      'Her brother was murdered and the family still wants answers today.',
      'Mass shootings happen almost every week and nothing ever changes.',
      'The basement flooded and we lost almost everything we owned there.',
    ]) {
      expect(localOff(text)).toBe(true);
      expect(L2(text)).toEqual([]);
    }
    expect(localOff('Does Coffee Cause Cancer? - Example Blog')).toBe(true); // a page title
    expect(localOff('What I learned from a slow week')).toBe(false);
    // Ordinary English and accented words stay on: \b alone would read "Gymnopédies" as ending in "dies".
    for (const text of ['Satie wrote the Gymnopédies and the Gnossiennes in Paris.', 'We used trial and error with the new parser.',
      'Stable Diffusion is fast and also very good at faces.', 'Fire up the terminal and run the tests again.',
      'She took a great shot of the sunset over the bay last night.',
      'Starlink saw explosive growth this year and also new rivals.', 'The comédies musicales were always fun to watch.']) {
      expect([text, localOff(text)]).toEqual([text, false]);
    }
  });

  test("an elision's apostrophe opens no quote; a real quote in straight marks ends where it closes", () => {
    expect(fr(L2("I stayed home 'cause it rained. We played cards and drank tea together. Maybe tomorrow we go out.")))
      .toEqual(['et', 'ensemble', 'Peut-être', 'demain']);
    expect(fr(L2("She said 'go with them' and we always did that together."))).toEqual(['toujours', 'ensemble']);
    expect(fr(L2("It's rock 'n' roll and we always loved it."))).toEqual(['et', 'toujours']);
  });

  test('respects the level caps: one per sentence at level 1, two at level 2, each French word once', () => {
    const text = 'I always read and also write with friends. We often sit together and talk. Then we walk home and sleep.';
    expect(fr(localSwaps(1, text))).toEqual(['toujours', 'et']); // the third sentence's "and" is et again
    const two = L2(text);
    expect(fr(two)).toEqual(['toujours', 'aussi', 'souvent', 'ensemble', 'et']);
    expect(two.length).toBeLessThanOrEqual(2 * 3);
    // "and" and "or" are everywhere, so the rarer word of the sentence goes first.
    expect(fr(localSwaps(1, 'Cats and dogs are always hungry in the morning.'))).toEqual(['toujours']);
  });

  test('each swap carries a context that finds the same spot again, and links and code stay English', () => {
    const text = 'Run the tests and the linter, and read the docs and notes with care before you merge.';
    for (const s of L2(text)) {
      const at = locate({ text }, s.o, s.ctx);
      expect(text.slice(at.start, at.end)).toBe(s.o);
    }
    const win = new Window();
    const p = win.document.createElement('p');
    p.innerHTML = 'Run <code>git commit and push</code> and then read <a href="/x">the docs with notes</a> with care. We always do.';
    win.document.body.append(p);
    const swaps = L2(p.textContent);
    // The list sees plain text, so its first "and" and "with" are the ones in the code and the link: the page never
    // paints those, and the passage gets fewer swaps.
    expect(fr(swaps)).toEqual(['et', 'avec', 'toujours']);
    expect(applySwaps(p, swaps)).toBe(1);
    expect(p.querySelector('code').textContent).toBe('git commit and push');
    expect(p.querySelector('a').textContent).toBe('the docs with notes');
    expect(p.textContent).toBe('Run git commit and push and then read the docs with notes with care. We toujours do.');
  });

  test("with the plugin's words: only words in the word state, learning before known, statuses kept; another language: none", () => {
    const words = [
      { fr: 'et', en: 'and', hint: 'ay', status: 'known' },
      { fr: 'avec', en: 'with', hint: 'ah-vek', status: 'active' },
      { fr: 'contre', en: 'against', hint: 'kohn-truh', status: 'shaky' },
      { fr: 'donc', en: 'so', hint: 'donk', status: 'active' },
    ];
    expect(localVocabulary(1, words).map((w) => w.fr)).toEqual(['et', 'avec', 'contre']);
    const swaps = localSwaps(1, 'We play and argue with friends. We vote against it. So we leave and rest.', words);
    expect(swaps.map((s) => [s.f, s.word, s.status])).toEqual([['avec', 'avec', 'active'], ['contre', 'contre', 'shaky'], ['et', 'et', 'known']]);
    expect(localSwaps(2, 'We play and argue with friends every single day.', [{ fr: 'y', en: 'and', hint: 'ee', status: 'active' }], 'Spanish')).toEqual([]);
  });
});

// The real worker with a fake chrome, as a page and the popup talk to it.
async function startWorker(name, data, native = async () => ({ ok: false })) {
  const saved = Object.fromEntries(['chrome', 'fetch', 'setTimeout'].map((k) => [k, globalThis[k]]));
  const realTimeout = globalThis.setTimeout;
  globalThis.setTimeout = (fn, ms, ...rest) => (ms >= 10000 ? 0 : realTimeout(fn, ms, ...rest));
  const listeners = [];
  const gemini = [];
  const badge = { text: '', title: '' };
  const on = (arr = []) => ({ addListener: (fn) => arr.push(fn) });
  globalThis.chrome = {
    storage: { local: {
      async setAccessLevel() {},
      async get(keys) {
        const pick = keys == null ? Object.keys(data) : typeof keys === 'string' ? [keys] : keys;
        return structuredClone(Object.fromEntries(pick.filter((k) => k in data).map((k) => [k, data[k]])));
      },
      async set(values) { for (const [k, v] of Object.entries(values)) data[k] = structuredClone(v); },
      async remove(keys) { for (const k of keys) delete data[k]; },
    }, onChanged: on() },
    runtime: { id: 'fw-test', getURL: (path) => `chrome-extension://fw-test/${path}`, getManifest: () => ({ version: '0.2.3' }),
      onMessage: on(listeners), onInstalled: on(), onStartup: on(), sendNativeMessage: (_host, msg) => native(msg) },
    action: { setBadgeText: async ({ text }) => { badge.text = text; }, setBadgeBackgroundColor: async () => {},
      setBadgeTextColor: async () => {}, setTitle: async ({ title }) => { badge.title = title; } },
    tabs: { query: async () => [], sendMessage: async () => {} },
    alarms: { create: async () => {}, onAlarm: on() },
    permissions: { getAll: async () => ({ origins: ['https://*/*'] }), onAdded: on(), onRemoved: on() },
    scripting: { getRegisteredContentScripts: async () => [], updateContentScripts: async () => {},
      unregisterContentScripts: async () => {}, registerContentScripts: async () => {} },
  };
  globalThis.fetch = async (url, init) => {
    if (!String(url).startsWith('https://generativelanguage.googleapis.com/')) return { ok: true, json: async () => ({ version: '0.2.3' }) };
    gemini.push(init);
    const items = JSON.parse(JSON.parse(init.body).contents[0].parts[0].text.replace(/^Passages:\n/, ''));
    const passages = items.map(({ id }) => ({ id, swaps: [{ o: 'walk', f: 'et', ctx: '' }, { o: 'and', f: 'et', ctx: '' }] }));
    return { ok: true, status: 200, json: async () => ({ candidates: [{ content: { parts: [{ text: JSON.stringify({ passages }) }] } }] }) };
  };
  const send = (msg, sender) => new Promise((done) => {
    if (!listeners.some((fn) => fn(msg, sender, done))) done(undefined);
  });
  const page = { id: 'fw-test', tab: { id: 1 }, url: 'https://example.com/post' };
  const popup = { id: 'fw-test', url: 'chrome-extension://fw-test/src/popup.html' };
  const restore = () => Object.assign(globalThis, saved);
  try {
    await import(`../src/background.js?tier-${name}`);
    for (let i = 0; i < 50; i++) await new Promise((done) => realTimeout(done, 2));
  } catch (e) { restore(); throw e; }
  const ask = async (text, title = 'Notes') => {
    const config = await send({ type: 'config' }, page);
    const key = `${config.revision}:${hashKey(text)}`;
    const res = await send({ type: 'swaps', revision: config.revision, items: [{ key, text }], title }, page);
    return { config, swaps: res.results?.[key], res };
  };
  return { data, gemini, badge, ask, page: (msg) => send(msg, page), popup: (msg) => send(msg, popup), restore };
}

const TEXT = 'We walk home and talk about the long week together.';
const WORDS = { version: 't.1', stage: 1, paused: false, sites: 'all', fetchedAt: 1, words: [
  { fr: 'et', en: 'and', hint: 'ay', status: 'active' }, { fr: 'ensemble', en: 'together', hint: 'ahn-sahm-bl', status: 'known' }] };

describe('engine tiers in the worker', () => {
  test('no key: local swaps with no request anywhere, sensitive page titles stay English, no Gemini error shown', async () => {
    const w = await startWorker('local', { settings: { enabled: true, newSitesEnabled: true, levelOverride: 2 },
      modelStatus: { at: 1, error: 'HTTP 400', kind: 'key', httpStatus: 400 } }); // left from a key since removed
    try {
      const { config, swaps } = await w.ask(TEXT);
      expect(config.tier).toBe('local');
      expect(config.hasKey).toBe(false);
      expect(swaps.map((s) => s.f)).toEqual(['et', 'ensemble']);
      expect(w.gemini).toHaveLength(0);
      expect(w.data.modelCalls).toBeUndefined(); // nothing counts toward the daily Gemini cap
      expect(Object.keys(w.data).filter((k) => k.startsWith('c:'))).toHaveLength(0); // nothing cached
      expect((await w.ask(TEXT, "It's crazy how dangerous driving is")).swaps).toEqual([]);
      expect((await w.ask('The crime rate here is always rising and nobody seems to care.')).swaps).toEqual([]);
      expect(w.badge.text).toBe(''); // no key, no Gemini calls to fail
    } finally { w.restore(); }
  });

  test("no key with the plugin's words: its words and statuses, for seen and flip events", async () => {
    const w = await startWorker('local-plugin', { settings: { enabled: true, newSitesEnabled: true }, [STATE_KEY]: WORDS });
    try {
      const { config, swaps } = await w.ask(TEXT);
      expect(config.tier).toBe('local');
      expect(swaps.map((s) => [s.f, s.word, s.status])).toEqual([['et', 'et', 'active']]); // level 1: one per sentence, learning first
      expect(await w.page({ type: 'event', word: 'et', event: 'seen' })).toEqual({ ok: true });
    } finally { w.restore(); }
  });

  test('a key wins over the local list; removing it falls back to local swaps', async () => {
    const w = await startWorker('gemini', { settings: { enabled: true, newSitesEnabled: true }, apiKey: 'synthetic-gemini' });
    try {
      let { config, swaps } = await w.ask(TEXT);
      expect(config.tier).toBe('gemini');
      expect(w.gemini).toHaveLength(1);
      expect(swaps.map((s) => s.o)).toEqual(['and']); // the model's answer, validated as before ("walk" is no gloss of et)
      expect(await w.popup({ type: 'save', apiKey: '' })).toEqual({ ok: true });
      ({ config, swaps } = await w.ask(TEXT));
      expect(config.tier).toBe('local');
      expect(swaps.map((s) => s.f)).toEqual(['et']);
      expect(w.gemini).toHaveLength(1);
    } finally { w.restore(); }
  });

  test("a Gemini error dot goes when the setup's key does, on the next sync", async () => {
    let geminiKey = 'synthetic-host';
    const w = await startWorker('host-key', { settings: { enabled: true, newSitesEnabled: true }, hostKey: 'synthetic-host',
      modelStatus: { at: 1, error: 'HTTP 503', kind: 'busy', httpStatus: 503 } },
    async (msg) => (msg.type === 'state' ? { ok: true, ...WORDS, geminiKey } : { ok: true, applied: 0 }));
    try {
      expect(w.badge.text).not.toBe('');
      expect(w.badge.title).toContain('Gemini is busy');
      geminiKey = '';
      await w.popup({ type: 'syncWords' });
      expect(w.badge.text).toBe('');
      expect(w.badge.title).toBe('French Weave');
      expect((await w.ask(TEXT)).config.tier).toBe('local');
      // A rejection of an old key says nothing about the one setup stores next.
      w.data.modelStatus = { at: 2, error: 'HTTP 400', kind: 'key', httpStatus: 400 };
      geminiKey = 'synthetic-other';
      await w.popup({ type: 'syncWords' });
      expect(w.data.modelStatus.error).toBe('');
      expect(w.badge.text).toBe('');
    } finally { w.restore(); }
  });

  test('no key and another language from the plugin: off, since the fixed list is French only', async () => {
    const w = await startWorker('none', { settings: { enabled: true, newSitesEnabled: true },
      [STATE_KEY]: { ...WORDS, language: 'Spanish', words: [{ fr: 'y', en: 'and', hint: 'ee', status: 'active' }] } });
    try {
      const { config, res } = await w.ask(TEXT);
      expect(config.tier).toBe('none');
      expect(res).toEqual({ results: {}, stale: true });
      expect(w.gemini).toHaveLength(0);
    } finally { w.restore(); }
  });
});

test('popup says which engine is on, in plain words, with the matching privacy note', async () => {
  const html = (await Bun.file(new URL('../src/popup.html', import.meta.url)).text()).replace(/<script[^>]*><\/script>/, '');
  const settings = { enabled: true, newSitesEnabled: true, siteOverrides: {}, levelOverride: 0, model: 'gemini-3.5-flash-lite' };
  const originalGlobals = Object.fromEntries(['chrome', 'document', 'window'].map((k) => [k, globalThis[k]]));
  try {
    for (const [tier, hasKey, operation] of [['local', false, 'On'], ['gemini', true, 'On'], ['none', false, 'Add a Gemini key to start']]) {
      const win = new Window({ url: 'chrome-extension://fw-test/src/popup.html' });
      win.document.write(html);
      const doc = win.document;
      Object.assign(globalThis, {
        window: win, document: doc,
        chrome: {
          runtime: { id: 'fw-test', sendMessage: async () => ({ config: { settings, hasKey, tier, paused: false, origins: ['<all_urls>'], stage: 0 },
            words: 0, fetchedAt: 0, modelStatus: { at: 1, error: 'HTTP 503', kind: 'busy', httpStatus: 503 } }) },
          tabs: { query: async () => [{ id: 1, url: 'https://example.com/' }], create: async () => {} },
          permissions: { contains: async () => true },
          storage: { local: { get: async () => ({}) }, onChanged: { addListener() {} } },
        },
      });
      await import(`../src/popup.js?tier-${tier}`);
      await new Promise((r) => setTimeout(r, 20));
      const text = (id) => doc.getElementById(id).textContent;
      expect([tier, text('tierInfo'), text('tierNote'), text('privacyNote'), text('operation')])
        .toEqual([tier, TIER_TEXT[tier].label, TIER_TEXT[tier].note, TIER_TEXT[tier].privacy, operation]);
      expect(text('modelError')).toBe(tier === 'gemini' ? 'Gemini is busy (503). Retrying.' : ''); // a Gemini error only while Gemini is in use
    }
    expect(TIER_TEXT.local.label).toBe('Built-in list, no key');
    expect(TIER_TEXT.local.privacy).toContain('no page text leaves your computer');
  } finally {
    Object.assign(globalThis, originalGlobals);
  }
});
