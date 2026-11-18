import { exactTarget } from './levels.js';
import { englishAnchors } from './catalog.js';
import { cleanReview } from './review.js';
import { bundledLanguage, languageCode } from './language-name.js';

export const PERSONAL_KEY = 'personalVocabularyV1';
export const MAX_PERSONAL = 300;
export const MAX_FIELD_POINTS = 80;
const MAX_SELECTION_WORDS = 5;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const BAD = /[\p{Cc}\p{Cf}\p{Cs}\u2028\u2029<>]/u;
const URLISH = /(?:https?:\/\/|www\.|\S+@\S+|\.[a-z]{2,}(?:\/|$))/iu;
const SPANISH_ARTICLE = /^(?:el|la|los|las|un|una|unos|unas)\s+/i;
const AUTOMATIC_FORM = /^[\p{L}\p{N}][\p{L}\p{M}\p{N}]*(?:['’\-][\p{L}\p{N}][\p{L}\p{M}\p{N}]*)*$/u;
const automaticTarget = (form, language) => AUTOMATIC_FORM.test(form) ||
  language === 'es' && SPANISH_ARTICLE.test(form) && AUTOMATIC_FORM.test(form.replace(SPANISH_ARTICLE, ''));

export function validForm(value, { selection = false } = {}) {
  if (typeof value !== 'string' || BAD.test(value)) return null;
  const form = value.normalize('NFC').replace(/\s+/gu, ' ').trim();
  if (!form || [...form].length > MAX_FIELD_POINTS || URLISH.test(form) ||
      selection && form.split(' ').length > MAX_SELECTION_WORDS ||
      !/[\p{L}\p{N}]/u.test(form)) return null;
  return form;
}

export function validLanguage(code) {
  return bundledLanguage(code) ? code : languageCode(code);
}

const normal = (s, language) => s.normalize('NFC').toLocaleLowerCase(language).replace(/\s+/gu, ' ').trim();
export function exactPersonal(a, b) {
  return a.language === b.language && normal(a.source, 'en') === normal(b.source, 'en') &&
    normal(a.target, a.language) === normal(b.target, b.language) &&
    normal(a.sense, 'en') === normal(b.sense, 'en');
}

export function targetAliases(form, language) {
  const full = exactTarget(form, language);
  if (language !== 'es') return [full];
  const bare = full.replace(SPANISH_ARTICLE, '');
  return bare === full ? [full] : [full, bare];
}

export function cleanPersonal(raw, gradual = false) {
  if (raw && (typeof raw !== 'object' || raw.version !== 1 || !Array.isArray(raw.entries) ||
      raw.entries.length > MAX_PERSONAL || raw.history && (typeof raw.history !== 'object' || Array.isArray(raw.history))))
    return { version: 1, revision: 0, entries: [], history: {}, unsupported: true };
  const entries = [];
  const ids = new Set();
  for (const item of raw?.entries || []) {
    const language = validLanguage(item?.language);
    const source = validForm(item?.source), target = validForm(item?.target), sense = validForm(item?.sense);
    if (!language || language !== item.language || !UUID.test(item?.uuid || '') || ids.has(item.uuid) || !source || !target || !sense ||
        !['en-to-target', 'target-to-en'].includes(item.direction) ||
        item.id && item.id !== `personal:${language}:${item.uuid}`)
      return { version: 1, revision: 0, entries: [], history: {}, unsupported: true };
    ids.add(item.uuid);
    entries.push({ uuid: item.uuid, id: `personal:${language}:${item.uuid}`, language, source, target, sense,
      direction: item.direction, archived: item.archived === true,
      ...(typeof item.linkedLegacy === 'string' && item.linkedLegacy.length <= 100 ? { linkedLegacy: item.linkedLegacy } : {}),
      provenance: item.provenance === 'bundled-suggestion' ? 'bundled-suggestion' : 'manual',
      createdAt: Number.isSafeInteger(item.createdAt) && item.createdAt > 0 ? item.createdAt : 0 });
  }
  const byLanguage = {};
  for (const entry of entries) (byLanguage[entry.language] ||= []).push(entry);
  const history = {};
  const languages = new Set([...Object.keys(byLanguage), ...Object.keys(raw?.history || {})]);
  for (const language of languages) {
    if (validLanguage(language) !== language)
      return { version: 1, revision: 0, entries: [], history: {}, unsupported: true };
    const words = byLanguage[language] || [];
    const rawHistory = raw?.history?.[language];
    history[language] = cleanReview(rawHistory, words.map((entry) => ({ fr: entry.id, en: entry.source, hint: '' })), Date.now(), gradual);
  }
  return { version: 1, revision: Number.isSafeInteger(raw?.revision) && raw.revision >= 0 ? raw.revision : 0,
    entries, history };
}

export function personalWords(personal, language, bundledAll) {
  const active = personal.entries.filter((e) => e.language === language && !e.archived);
  const targetCount = new Map();
  const anchorCount = new Map();
  for (const word of [...bundledAll, ...active.filter((e) => !e.linkedLegacy)
    .map((e) => ({ fr: e.target, en: e.source }))]) {
    for (const target of targetAliases(word.fr, language))
      targetCount.set(target, (targetCount.get(target) || 0) + 1);
    for (const anchor of englishAnchors(word)) anchorCount.set(anchor, (anchorCount.get(anchor) || 0) + 1);
  }
  return active.map((entry) => {
    const anchors = englishAnchors({ en: entry.source });
    const reviewOnly = !!entry.linkedLegacy || !AUTOMATIC_FORM.test(entry.source) ||
      !automaticTarget(entry.target, language) ||
      targetAliases(entry.target, language).some((target) => targetCount.get(target) !== 1) ||
      anchors.some((anchor) => anchorCount.get(anchor) !== 1);
    return { entry, reviewOnly, word: { fr: entry.target, en: entry.source, hint: '',
      entryId: entry.id, personalId: entry.id } };
  });
}

export function suggestedMatches(selection, direction, language, bundled, personal) {
  const selected = validForm(selection, { selection: true });
  if (!selected) return [];
  const needle = normal(selected, direction === 'target-to-en' ? language : 'en');
  const candidates = [
    ...bundled.map((word) => ({ source: word.en, target: word.fr, sense: word.en,
      provenance: 'bundled-suggestion' })),
    ...personal.entries.filter((e) => e.language === language && !e.archived)
      .map((e) => ({ source: e.source, target: e.target, sense: e.sense, provenance: e.provenance, id: e.id })),
  ];
  return candidates.filter((item) => direction === 'target-to-en'
    ? normal(item.target, language) === needle
    : englishAnchors({ en: item.source }).includes(needle)).slice(0, 12);
}

export function addPersonal(personal, fields, language, now = Date.now(), uuid = crypto.randomUUID()) {
  if (personal.unsupported) throw new Error('This personal vocabulary uses a newer format. Update Lang Weave before saving.');
  const source = validForm(fields?.source), target = validForm(fields?.target);
  const sense = validForm(fields?.sense) || (fields?.sense === '' ? source : null);
  const direction = fields?.direction;
  if (!source || !target || !sense || !['en-to-target', 'target-to-en'].includes(direction) || validLanguage(language) !== language)
    throw new Error('Enter a short English form, target form and meaning.');
  const proposal = { language, source, target, sense };
  const same = personal.entries.find((entry) => exactPersonal(entry, proposal));
  if (same) return { entry: same, duplicate: true };
  if (personal.entries.length >= MAX_PERSONAL) throw new Error(`Personal vocabulary is full (${MAX_PERSONAL} entries). Archive or export existing entries.`);
  const collision = personal.entries.some((entry) => entry.language === language && !entry.archived &&
    (normal(entry.source, 'en') === normal(source, 'en') || normal(entry.target, language) === normal(target, language)));
  if (collision && fields.distinct !== true) throw new Error('This spelling already has another meaning. Confirm “distinct meaning” to save it separately.');
  const entry = { uuid, id: `personal:${language}:${uuid}`, language, source, target, sense, direction,
    archived: false, provenance: fields.provenance === 'bundled-suggestion' ? 'bundled-suggestion' : 'manual', createdAt: now };
  if (typeof fields.linkedLegacy === 'string' && fields.linkedLegacy.length <= 100) entry.linkedLegacy = fields.linkedLegacy;
  personal.entries.push(entry);
  personal.revision++;
  return { entry, duplicate: false };
}

export function exportPersonal(personal) {
  const history = Object.fromEntries(Object.entries(personal.history).map(([language, state]) =>
    [language, { version: 1, cards: Object.fromEntries(Object.entries(state.cards).map(([id, card]) => {
      const { introReceipt, fsrs, ...progress } = card; // personal export format v1 is unchanged
      return [id, progress];
    })), learning: { day: state.learning.day, count: state.learning.count } }]));
  return { format: 'lang-weave-personal-vocabulary', version: 1,
    entries: personal.entries.map(({ id, uuid, language, source, target, sense, direction, archived, provenance, createdAt, linkedLegacy }) =>
      ({ id, uuid, language, source, target, sense, direction, archived, provenance, createdAt,
        ...(linkedLegacy ? { linkedLegacy } : {}) })),
    history };
}
