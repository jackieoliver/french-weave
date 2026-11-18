import { expect, test } from 'bun:test';
import { GUARANI_STARTER } from '../src/language-name.js';
import { GUARANI_PACK } from '../src/guarani.js';
import { cleanPack } from '../src/languages.js';
import { validateSwaps } from '../src/levels.js';
import { createBackup, learningPatch, parseBackup } from '../src/portability.js';

const ID = 'fw-guarani';
const BASE = `chrome-extension://${ID}/`;
const sender = (page) => ({ id: ID, url: `${BASE}src/${page}.html` });
const starterScope = `${GUARANI_STARTER}:${GUARANI_PACK.version}`;
const storageKey = (scope, suffix) => `lang:${scope}:${suffix}`;

test('the starter is selectable without a key and its reviews round trip alongside earlier Guaraní packs', async () => {
  const original = { chrome: globalThis.chrome, fetch: globalThis.fetch };
  // Both spellings of the generated locale can coexist with the starter, even
  // when a generated target form is also present in the bundled catalog.
  const generatedWords = Array.from({ length: 20 }, (_, i) => ({
    fr: i === 0 ? 'y' : `sample${i}`, en: i === 0 ? 'water' : `gloss ${i}`,
    hint: 'sample', level: i < 10 ? 1 : 2,
  }));
  const gn = cleanPack({ words: generatedWords }, 'gn');
  const gnPY = cleanPack({ words: generatedWords }, 'gn-PY');
  const generatedHistory = { version: 1, cards: { y: { due: 1000, interval: 1, reviews: 2 } },
    learning: { day: '', count: 0 } };
  const data = {
    settings: { language: 'gn', levelOverride: 1 },
    languagePacks: { gn, 'gn-PY': gnPY },
    [storageKey(`gn:${gn.version}`, 'recallReview')]: structuredClone(generatedHistory),
    [storageKey(`gn-PY:${gnPY.version}`, 'recallReview')]: structuredClone(generatedHistory),
  };
  const listeners = [];
  const event = (list = []) => ({ addListener: (fn) => list.push(fn) });
  globalThis.chrome = {
    storage: { local: {
      async setAccessLevel() {},
      async get(keys) {
        const selected = keys == null ? Object.keys(data) : [keys].flat();
        return structuredClone(Object.fromEntries(selected.filter((key) => key in data).map((key) => [key, data[key]])));
      },
      async set(patch) { Object.assign(data, structuredClone(patch)); },
      async remove(keys) { for (const key of [keys].flat()) delete data[key]; },
    } },
    runtime: { id: ID, getURL: (path) => BASE + path, getManifest: () => ({ version: '0.12.26' }),
      onMessage: event(listeners), onInstalled: event(), onStartup: event(), onConnect: event() },
    tabs: { query: async () => [] },
    alarms: { create: async () => {}, onAlarm: event() },
    permissions: { getAll: async () => ({ origins: [] }), onAdded: event(), onRemoved: event() },
    scripting: { getRegisteredContentScripts: async () => [], registerContentScripts: async () => {},
      updateContentScripts: async () => {}, unregisterContentScripts: async () => {} },
  };
  const network = [];
  globalThis.fetch = async (url) => {
    if (String(url).startsWith(BASE)) return Response.json({ version: '0.12.26' });
    network.push(String(url));
    throw new Error('Unexpected network call');
  };
  const dispatch = (page, message) => new Promise((resolve) => {
    if (!listeners.some((fn) => fn(message, sender(page), resolve))) resolve(undefined);
  });

  try {
    await import('../src/background.js?guarani');
    const status = await dispatch('options', { type: 'status' });
    expect(status.config.language).toBe('gn');
    expect(status.config.scope).toBe(`gn:${gn.version}`);
    expect(status.languages).toEqual([
      { code: 'es', name: 'Spanish', experimental: false },
      { code: GUARANI_STARTER, name: 'Paraguayan Guaraní', experimental: false },
      { code: 'gn', name: expect.any(String), experimental: true },
      { code: 'gn-PY', name: expect.any(String), experimental: true },
    ]);
    const select = (language, levelOverride = 1) =>
      dispatch('options', { type: 'save', settings: { language, levelOverride } });
    expect((await select('gn-PY')).ok).toBe(true);
    expect((await dispatch('options', { type: 'status' })).config.scope).toBe(`gn-PY:${gnPY.version}`);
    expect((await select(GUARANI_STARTER, 2)).ok).toBe(true);
    expect((await dispatch('options', { type: 'removeLanguage', code: GUARANI_STARTER })).error).toBeTruthy();
    const expanded = await dispatch('words', { type: 'wordsList' });
    expect(expanded.scope).toBe(starterScope);
    expect(expanded.rows).toHaveLength(14);
    expect(expanded.rows.find(({ target }) => target === 'ytororõ')).toMatchObject({ gloss: 'waterfall', practise: true });
    expect(await dispatch('words', { type: 'wordPractice', id: 'ytororõ', scope: starterScope }))
      .toMatchObject({ ok: true });

    const { card } = await dispatch('review', { type: 'reviewNext' });
    expect(card.en).toBe('waterfall');
    expect((await dispatch('review', { type: 'reviewReveal', ticket: card.ticket })).answer.fr).toBe('ytororõ');
    expect((await dispatch('review', { type: 'reviewRate', ticket: card.ticket, rating: 'medium' })).ok).toBe(true);
    expect((await select(GUARANI_STARTER)).ok).toBe(true);
    expect(await dispatch('review', { type: 'reviewStatus' }))
      .toMatchObject({ language: 'Paraguayan Guaraní', new: 9 });
    expect((await dispatch('words', { type: 'wordsList' })).rows.find(({ target }) => target === 'ytororõ'))
      .toMatchObject({ reviews: 1, practise: false });

    const backup = parseBackup(createBackup(data, '0.12.26'));
    expect(backup.state.preferences.language).toBe(GUARANI_STARTER);
    expect(backup.state.packs).toEqual({ gn, 'gn-PY': gnPY });
    expect(backup.state.scopes[`lang:${starterScope}`].retrievals.retrievals[0][0]).toBe('ytororõ');
    const restored = learningPatch(backup, {});
    expect(restored[storageKey(starterScope, 'recallReview')].cards.ytororõ.reviews).toBe(1);
    expect(restored[storageKey(`gn:${gn.version}`, 'recallReview')]).toEqual(generatedHistory);
    expect(restored[storageKey(`gn-PY:${gnPY.version}`, 'recallReview')]).toEqual(generatedHistory);
    expect((await select('es')).ok).toBe(true);
    expect(await dispatch('review', { type: 'reviewStatus' })).toMatchObject({ language: 'Spanish', new: 30 });
    expect(network).toEqual([]);
  } finally {
    Object.assign(globalThis, original);
  }
});

test('reading validation keeps the listed Guaraní diacritics and rejects unlisted forms and glosses', () => {
  const validate = (o, f) => validateSwaps(2, [{ o, f, g: 'invented gloss', h: 'invented pronunciation' }],
    GUARANI_PACK.words, GUARANI_STARTER);
  expect(validate('waterfall', 'ytororõ'.normalize('NFD'))).toMatchObject([
    { o: 'waterfall', f: 'ytororõ', g: 'waterfall', h: '' },
  ]);
  expect(validate('waterfall', 'ytororo')).toEqual([]);
  expect(validate('fountain', 'ytororõ')).toEqual([]);
});
