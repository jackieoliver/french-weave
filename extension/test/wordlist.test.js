import { describe, expect, it, test } from 'bun:test';
import { Window } from 'happy-dom';
import { wordSummary, countsLine, renderWordList } from '../src/wordlist.js';
import { L1_WORDS, L2_WORDS } from '../src/levels.js';
import { parseState } from '../src/hostsource.js';

// Word state as the worker stores it after a sync (scripts/fw_host.py "state", through parseState).
const STATE = parseState({
  version: 'v1', stage: 2,
  words: [
    { fr: 'très', en: 'very', hint: 'treh', status: 'shaky' },
    { fr: 'alors', en: 'so / then', hint: 'ah-lor', status: 'active' },
    { fr: 'et', en: 'and', hint: 'ay', status: 'known' },
    { fr: 'mais', en: 'but', hint: 'meh', status: 'known' },
    { fr: 'déjà', en: 'already', hint: '', status: 'active' },
    { fr: 'presque', en: 'almost', hint: 'presk', status: 'shaky' },
  ],
});
const popupHtml = () => Bun.file(new URL('../src/popup.html', import.meta.url)).text();
async function popupDocument() {
  const win = new Window({ url: 'chrome-extension://fw-test/src/popup.html' });
  win.document.write((await popupHtml()).replace(/<script[^>]*><\/script>/, ''));
  return win.document;
}

describe('wordSummary', () => {
  it('counts known, learning and shaky words and lists the shaky ones first, then learning', () => {
    const s = wordSummary(STATE, {});
    expect(s.builtIn).toBe(false);
    expect(s.counts).toEqual({ known: 2, learning: 2, shaky: 2 });
    expect(s.words.map((w) => [w.fr, w.status])).toEqual([['très', 'shaky'], ['presque', 'shaky'], ['alors', 'learning'], ['déjà', 'learning']]);
    expect(countsLine(s)).toBe('2 known · 2 learning · 2 shaky');
  });
  it('counts any other status as learning, the same split the prompt uses', () => {
    const s = wordSummary({ words: [{ fr: 'si', en: 'if', hint: 'see', status: 'review' }, { fr: 'et', en: 'and', hint: 'ay', status: 'known' }] }, {});
    expect(s.counts).toEqual({ known: 1, learning: 1, shaky: 0 });
    expect(s.words).toEqual([{ fr: 'si', en: 'if', hint: 'see', status: 'learning' }]);
  });
  it('without a word state, falls back to the built-in list for the level the worker uses', () => {
    for (const state of [null, undefined, { words: [] }]) {
      const s = wordSummary(state, undefined);
      expect(s).toMatchObject({ builtIn: true, level: 1 });
      expect(s.words.map((w) => w.fr)).toEqual(L1_WORDS.map((w) => w.fr));
    }
    expect(wordSummary(null, { levelOverride: 2 }).words.length).toBe(L2_WORDS.length);
    expect(wordSummary(null, { levelOverride: 4 }).level).toBe(4); // L3/L4 are built; they use the L2 list for now
    expect(wordSummary(null, { levelOverride: 4 }).words.length).toBe(L2_WORDS.length);
    expect(countsLine(wordSummary(null, {}))).toBe('built-in level 1 list');
  });
});

describe('renderWordList in the popup', () => {
  test('the section is collapsed by default and scrolls inside when long', async () => {
    const html = await popupHtml();
    expect(html).toMatch(/<details id="wordList">/); // no "open" attribute
    expect(html).toMatch(/#wordList \[data-rows\] \{ max-height: \d+px; overflow: auto; \}/);
    const module = await Bun.file(new URL('../src/wordlist.js', import.meta.url)).text();
    for (const source of [html, module]) expect(source).not.toMatch(/fetch\(|XMLHttpRequest|https?:\/\//); // no network
  });
  test('synced words: counts in the summary line, shaky then learning rows with English and sound hint', async () => {
    const doc = await popupDocument();
    const details = doc.getElementById('wordList');
    renderWordList(details, wordSummary(STATE, {}));
    expect(details.querySelector('summary').textContent).toBe('Your words 2 known · 2 learning · 2 shaky');
    expect(details.open).toBe(false);
    expect([...details.querySelectorAll('.word-group')].map((e) => e.textContent)).toEqual(['Shaky', 'Learning']);
    expect([...details.querySelectorAll('.word')].map((e) => [e.dataset.status, e.querySelector('.word-fr').textContent, e.querySelector('.word-en').textContent]))
      .toEqual([['shaky', 'très', 'very · "treh"'], ['shaky', 'presque', 'almost · "presk"'], ['learning', 'alors', 'so / then · "ah-lor"'], ['learning', 'déjà', 'already']]);
    expect(details.textContent).not.toContain('mais'); // known words are counted, not listed
    expect(details.querySelector('.word-note')).toBeNull();
  });
  test('only known words: says there is nothing to learn right now', async () => {
    const doc = await popupDocument();
    const details = doc.getElementById('wordList');
    renderWordList(details, wordSummary({ words: [{ fr: 'et', en: 'and', hint: 'ay', status: 'known' }] }, {}));
    expect(details.querySelector('[data-counts]').textContent).toBe('1 known · 0 learning · 0 shaky');
    expect(details.querySelector('.word-note').textContent).toBe('No learning or shaky words right now.');
    expect(details.querySelectorAll('.word').length).toBe(0);
  });
  test('built-in list: says that is what it is, no status groups', async () => {
    const doc = await popupDocument();
    const details = doc.getElementById('wordList');
    renderWordList(details, wordSummary(null, {}));
    expect(details.querySelector('[data-counts]').textContent).toBe('built-in level 1 list');
    expect(details.querySelector('.word-note').textContent).toContain(`built-in level 1 list (${L1_WORDS.length} words)`);
    expect(details.querySelectorAll('.word-group').length).toBe(0);
    expect(details.querySelectorAll('.word').length).toBe(L1_WORDS.length);
    expect(details.querySelector('.word .word-en').textContent).toBe('and · "ay"');
  });
  test('word text from the host stays text, and a redraw replaces the rows', async () => {
    const doc = await popupDocument();
    const details = doc.getElementById('wordList');
    renderWordList(details, wordSummary({ words: [{ fr: '<img src=x onerror=alert(1)>', en: '<b>x</b>', hint: '', status: 'active' }] }, {}));
    expect(details.querySelector('img')).toBeNull();
    expect(details.querySelector('.word-fr').textContent).toBe('<img src=x onerror=alert(1)>');
    renderWordList(details, wordSummary(STATE, {}));
    expect(details.querySelectorAll('.word').length).toBe(4);
  });
});

// The real popup.js on popup.html with a fake chrome: the list draws from storage and follows syncs.
test('popup.js draws the word list from storage and redraws when the word state changes', async () => {
  const doc = await popupDocument();
  const originalGlobals = Object.fromEntries(['chrome', 'document', 'window'].map((k) => [k, globalThis[k]]));
  const data = { settings: { enabled: true } };
  const changed = [];
  const settings = { enabled: true, newSitesEnabled: true, siteOverrides: {}, levelOverride: 0, model: 'gemini-2.5-flash' };
  Object.assign(globalThis, {
    window: doc.defaultView, document: doc,
    chrome: {
      runtime: { id: 'fw-test', sendMessage: async () => ({ config: { settings, hasKey: true, paused: false, origins: [], stage: 0 }, words: 0, fetchedAt: 0 }) },
      tabs: { query: async () => [{ id: 1, url: 'https://example.com/' }], create: async () => {} },
      permissions: { contains: async () => true },
      storage: {
        local: { get: async (keys) => Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter((k) => k in data).map((k) => [k, structuredClone(data[k])])) },
        onChanged: { addListener: (fn) => changed.push(fn) },
      },
    },
  });
  const settle = () => new Promise((r) => setTimeout(r, 20));
  try {
    await import('../src/popup.js');
    await settle();
    const details = doc.getElementById('wordList');
    expect(details.querySelector('[data-counts]').textContent).toBe('built-in level 1 list');
    data.wordState = { ...STATE, fetchedAt: 1 };
    for (const fn of changed) fn({ wordState: { newValue: data.wordState } }, 'local');
    await settle();
    expect(details.querySelector('[data-counts]').textContent).toBe('2 known · 2 learning · 2 shaky');
    expect(details.querySelectorAll('.word').length).toBe(4);
    delete data.wordState;
    data.settings = { levelOverride: 2 };
    for (const fn of changed) fn({ apiKey: {} }, 'local'); // unrelated changes leave it alone
    await settle();
    expect(details.querySelectorAll('.word').length).toBe(4);
    for (const fn of changed) fn({ settings: {} }, 'local');
    await settle();
    expect(details.querySelector('[data-counts]').textContent).toBe('built-in level 2 list');
  } finally {
    Object.assign(globalThis, originalGlobals);
  }
});
