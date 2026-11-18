// Explicit, bounded learning backup. This module never reads permissions or writes storage.
import { bundledLanguage, GUARANI_STARTER } from './language-name.js';
import { GUARANI_PACK } from './guarani.js';
import { cleanPack, MAX_PACKS } from './languages.js';
import { MEASUREMENTS_SKIPPED_KEY } from './measurement-skips.js';
import { cleanPersonal, validForm, validLanguage, MAX_PERSONAL } from './personal.js';
import { validDay } from './learning.js';
import { wordsForLevel } from './levels.js';
import { REVIEW_KEY } from './review.js';
import { PENDING_KEY, SENT_KEY } from './events.js';
import { ENCOUNTERS_KEY } from './encounters.js';
import { entryId } from './catalog.js';
import { cleanFsrsState, storedFsrs, MIN_RETENTION, MAX_RETENTION } from './fsrs.js';
import { RETRIEVALS_KEY, EXPOSURES_KEY, MAX_RETRIEVALS, MAX_EXPOSURE_WORDS, cleanRetrievals,
  cleanExposures } from './learning-log.js';

export const BACKUP_FORMAT = 'lang-weave-learning-backup';
// The schema this build writes, and the schemas it reads. Schema 2 adds per-card FSRS state,
// the learning log (retrievals, exposures) and desiredRetention. A build must read a schema
// before any build writes it (docs/LEARNING-CORE-MISSION.md, "Release order").
export const BACKUP_SCHEMA = 2;
export const READ_SCHEMAS = Object.freeze([1, 2]);
export const MAX_BACKUP_BYTES = 1024 * 1024;
// One byte budget for the whole learning log in a schema 2 file, so the log can never crowd out
// cards, packs or personal entries under MAX_BACKUP_BYTES.
export const LOG_BUDGET_BYTES = 512 * 1024;
// Slack under MAX_BACKUP_BYTES for the separators fitLog's accounting may round away.
const LOG_MARGIN_BYTES = 1024;
export const IMPORT_JOURNAL_KEY = 'learningImportJournalV1';
export const IMPORT_RECEIPT_KEY = 'learningImportReceiptV1';
const LEARNING_SUFFIXES = [REVIEW_KEY, PENDING_KEY, SENT_KEY, ENCOUNTERS_KEY, RETRIEVALS_KEY, EXPOSURES_KEY];
// Storage suffix -> backup scope field. Every list of learning keys derives from this one.
const SCOPE_FIELDS = Object.freeze({ [REVIEW_KEY]: 'review', [PENDING_KEY]: 'events', [SENT_KEY]: 'shown',
  [ENCOUNTERS_KEY]: 'encounters', [RETRIEVALS_KEY]: 'retrievals', [EXPOSURES_KEY]: 'exposures' });
export const LEARNING_STORAGE_KEYS = Object.freeze(['languagePacks', 'personalVocabularyV1', ...LEARNING_SUFFIXES]);
const LOG_FIELDS = ['retrievals', 'exposures'];
// Validation context: `source` is local storage (export, target checks) rather than a file;
// `schema` is the file's schema (or, for storage, the schema being written); `omitted`
// counts unverified log entries dropped under the CTO's ruling B.
const mode = (source, schema) => ({ source, schema, omitted: { retrievals: 0, exposures: 0 } });
const DIRECT_KEYS = new Set(['settings', 'languagePacks', 'personalVocabularyV1', ...LEARNING_SUFFIXES]);
const NON_LEARNING_KEYS = new Set(['apiKey', 'epoch', 'keyEpoch', 'modelCalls', 'modelStatus', 'consentShown',
  'quotaState', 'reloadedFor', MEASUREMENTS_SKIPPED_KEY, IMPORT_JOURNAL_KEY, IMPORT_RECEIPT_KEY]);
const VERSION = /^[0-9a-f]{16}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PERSONAL_ID = /^personal:([^:]+):([0-9a-f-]{36})$/i;
const BAD_KEY = new Set(['__proto__', 'constructor', 'prototype']);
const MAX_SCOPES = 80;
const MAX_CARDS = 5000;
const SETTINGS_FIELDS = ['enabled', 'model', 'levelOverride', 'language', 'gradual',
  'newWordsPerDay', 'density', 'inlineRecall', 'newSitesEnabled', 'siteOverrides', 'apiKey', 'desiredRetention',
  'guessFirst'];

function fail(reason) { throw new Error(`Learning backup: ${reason}`); }
function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value) ||
      ![Object.prototype, null].includes(Object.getPrototypeOf(value))) fail(`${name} must be an object`);
  return value;
}
function keys(value, allowed, name, required = []) {
  object(value, name);
  for (const key of Object.keys(value)) if (BAD_KEY.has(key) || !allowed.includes(key)) fail(`unsupported ${name} field`);
  for (const key of required) if (!Object.hasOwn(value, key)) fail(`missing ${name} field`);
}
function map(value, name, max) {
  object(value, name);
  if (Object.keys(value).length > max) fail(`${name} is too large`);
  for (const key of Object.keys(value)) if (BAD_KEY.has(key)) fail(`unsafe ${name} key`);
  return value;
}
function integer(value, min, max, name) {
  if (!Number.isSafeInteger(value) || value < min || value > max) fail(`invalid ${name}`);
  return value;
}
function day(value, allowEmpty = false) {
  if (allowEmpty && value === '') return value;
  if (!validDay(value)) fail('invalid calendar day');
  return value;
}
function boundedString(value, max, name, joiners = false) {
  if (typeof value !== 'string' || !value || value.length > max ||
      /[\p{Cc}\p{Cf}\p{Cs}<>]/u.test(joiners ? value.replace(/[\u200c\u200d]/g, '') : value) ||
      /(?:https?:\/\/|www\.|\S+@\S+)/iu.test(value)) fail(`invalid ${name}`);
  return value;
}
function language(value) {
  if (value !== 'es' && validLanguage(value) !== value) fail('invalid language');
  return value;
}
function scopeKey(value) {
  if (value === 'es') return value;
  let match = /^lang:([^:]+):([0-9a-f]{16})$/.exec(value);
  if (match) { language(match[1]); if (match[1] === 'es') fail('Spanish has no pack scope'); return value; }
  match = /^personal:([^:]+)$/.exec(value);
  if (match) { language(match[1]); return value; }
  fail('unsupported history scope');
}
function storageScopeKey(key) {
  const match = /^lang:(.+):([^:]+)$/.exec(key);
  if (!match || !LEARNING_SUFFIXES.includes(match[2])) fail('unsupported scoped storage key');
  const raw = match[1];
  return raw.startsWith('personal:') ? scopeKey(raw) : scopeKey(`lang:${raw}`);
}
function storageKey(scope, suffix) {
  if (scope === 'es') return suffix;
  if (scope.startsWith('personal:')) return `lang:${scope}:${suffix}`;
  return `${scope}:${suffix}`;
}
function cardId(value, scope, known = false) {
  boundedString(value, 100, 'card ID', !scope.startsWith('personal:'));
  if (scope.startsWith('personal:')) {
    const match = PERSONAL_ID.exec(value);
    if (!match || match[1] !== scope.slice(9) || !UUID.test(match[2])) fail('invalid personal card ID');
  } else if (!known) fail('unverified historical card; old installation remains unchanged');
  return value;
}
function card(value, m) {
  keys(value, ['due', 'interval', 'reviews', 'familiar', 'easyStreak', 'introducedDay', 'introGateDay', 'introReceipt',
    ...(m.source || m.schema >= 2 ? ['fsrs', 'maintenance', 'retiredReturn', 'claimAt', 'claimDue', 'peekDue',
      'seenDay', 'seenCount', 'peekDay', 'peekCount'] : [])], 'card', ['due', 'interval', 'reviews']);
  const result = { due: integer(value.due, 0, Number.MAX_SAFE_INTEGER, 'due time'),
    interval: integer(value.interval, 0, 365, 'interval'), reviews: integer(value.reviews, 0, 10000, 'review count') };
  if (Object.hasOwn(value, 'familiar')) { if (value.familiar !== true) fail('invalid familiarity'); result.familiar = true; }
  if (Object.hasOwn(value, 'easyStreak')) result.easyStreak = integer(value.easyStreak, 0, 3, 'easy streak');
  if (Object.hasOwn(value, 'introducedDay')) result.introducedDay = day(value.introducedDay);
  if (Object.hasOwn(value, 'introGateDay')) result.introGateDay = day(value.introGateDay);
  if (m.schema >= 2) {
    if (Object.hasOwn(value, 'maintenance')) {
      if (value.maintenance !== true) fail('invalid maintenance');
      result.maintenance = true;
    }
    if (Object.hasOwn(value, 'retiredReturn')) {
      // A pending return survives a gradual-off write, which omits maintenance.
      if (typeof value.retiredReturn !== 'boolean' || value.retiredReturn === true && result.familiar !== true)
        fail('invalid retired return');
      result.retiredReturn = value.retiredReturn;
    }
    for (const kind of ['seen', 'peek']) {
      const dayKey = `${kind}Day`, countKey = `${kind}Count`;
      if (Object.hasOwn(value, dayKey) || Object.hasOwn(value, countKey)) {
        if (!Object.hasOwn(value, dayKey) || !Object.hasOwn(value, countKey)) fail('incomplete daily counter');
        result[dayKey] = day(value[dayKey]);
        result[countKey] = integer(value[countKey], 0, 3, 'daily count');
      }
    }
    if (Object.hasOwn(value, 'claimAt') || Object.hasOwn(value, 'claimDue')) {
      if (!Object.hasOwn(value, 'claimAt') || !Object.hasOwn(value, 'claimDue')) fail('incomplete known claim');
      result.claimAt = integer(value.claimAt, 0, Number.MAX_SAFE_INTEGER, 'claim time');
      result.claimDue = integer(value.claimDue, result.claimAt, Number.MAX_SAFE_INTEGER, 'claim due');
    }
    if (Object.hasOwn(value, 'peekDue')) result.peekDue = integer(value.peekDue, 0, result.due, 'peek due');
  }
  // The one-use receipt belongs to an installation/document and is deliberately omitted.
  // Schema 1 output never carries FSRS state, so storage state is simply not exported.
  if (Object.hasOwn(value, 'fsrs') && m.schema >= 2) {
    keys(value.fsrs, ['stability', 'difficulty', 'lastReview', 'lapses'], 'FSRS state',
      ['stability', 'difficulty', 'lastReview', 'lapses']);
    if (!cleanFsrsState(value.fsrs)) fail('invalid FSRS state');
    // State that no longer agrees with due/interval is stale and re-derived later; schema 1
    // never carries it.
    const fsrs = storedFsrs({ ...result, fsrs: value.fsrs });
    if (fsrs) result.fsrs = fsrs;
  }
  return result;
}
function review(value, scope, m, installed = {}) {
  keys(value, m.source ? ['version', 'cards', 'current', 'inline', 'learning'] : ['version', 'cards', 'learning'],
    'review', ['version', 'cards', 'learning']);
  if (value.version !== 1) fail('unsupported review version');
  const cards = Object.create(null);
  const known = scope === 'es' ? new Set(wordsForLevel(2).map((word) => word.fr)) :
    scope.startsWith('lang:') ? new Set(installed[scope.split(':')[1]]?.version === scope.split(':')[2]
      ? installed[scope.split(':')[1]].words.map((word) => word.fr) : []) : new Set();
  const sourceCards = map(value.cards, 'cards', MAX_CARDS);
  if (!scope.startsWith('personal:')) {
    const unverified = Object.keys(sourceCards).filter((id) => !known.has(id)).length;
    if (unverified) fail(`${unverified} unverified historical card ID(s); old installation remains unchanged`);
  }
  for (const [id, valueCard] of Object.entries(sourceCards))
    cards[cardId(id, scope, known.has(id))] = card(valueCard, m);
  keys(value.learning, m.source ? ['day', 'count', 'pending'] : ['day', 'count'], 'learning', ['day', 'count']);
  return { version: 1, cards, learning: { day: day(value.learning.day, true),
    count: integer(value.learning.count, 0, 20, 'introduction count') } };
}
function packs(value) {
  const result = Object.create(null);
  for (const [code, raw] of Object.entries(map(value, 'packs', MAX_PACKS))) {
    language(code);
    if (code === 'es') fail('Spanish is bundled');
    if (code === GUARANI_STARTER) fail('Paraguayan Guaraní starter is bundled');
    keys(raw, ['version', 'words'], 'pack', ['version', 'words']);
    if (!VERSION.test(raw.version)) fail('invalid pack version');
    if (!Array.isArray(raw.words)) fail('invalid pack words');
    for (const word of raw.words) {
      keys(word, ['fr', 'en', 'hint', 'level'], 'pack word', ['fr', 'en', 'hint', 'level']);
      boundedString(word.fr, 80, 'pack form', true);
      boundedString(word.en, 80, 'pack gloss');
      boundedString(word.hint, 80, 'pack hint');
    }
    const cleaned = cleanPack(raw, code);
    if (!cleaned || cleaned.version !== raw.version || cleaned.words.some((word, i) =>
      Object.keys(word).some((field) => word[field] !== raw.words[i][field]))) fail('unsupported pack data');
    result[code] = cleaned;
  }
  return result;
}
function preferences(value, installed, m) {
  keys(value, ['language', 'levelOverride', 'gradual', 'newWordsPerDay', 'density', 'inlineRecall',
    ...(m.schema >= 2 ? ['desiredRetention'] : [])],
  'preferences', ['language', 'levelOverride', 'gradual', 'newWordsPerDay', 'density', 'inlineRecall']);
  language(value.language);
  if (!bundledLanguage(value.language) && !Object.hasOwn(installed, value.language)) fail('selected language pack is missing');
  integer(value.levelOverride, 0, 4, 'level');
  integer(value.newWordsPerDay, 1, 10, 'daily budget');
  if (typeof value.gradual !== 'boolean' || typeof value.inlineRecall !== 'boolean' ||
      !['light', 'normal', 'heavy'].includes(value.density)) fail('invalid learning preference');
  if (Object.hasOwn(value, 'desiredRetention') && !(typeof value.desiredRetention === 'number' &&
      value.desiredRetention >= MIN_RETENTION && value.desiredRetention <= MAX_RETENTION)) fail('invalid desired retention');
  return { language: value.language, levelOverride: value.levelOverride, gradual: value.gradual,
    newWordsPerDay: value.newWordsPerDay, density: value.density, inlineRecall: value.inlineRecall,
    ...(Object.hasOwn(value, 'desiredRetention') ? { desiredRetention: value.desiredRetention } : {}) };
}
function personal(value, m) {
  keys(value, ['version', 'revision', 'entries', 'history'], 'personal', ['version', 'revision', 'entries', 'history']);
  if (value.version !== 1) fail('unsupported personal version');
  integer(value.revision, 0, Number.MAX_SAFE_INTEGER, 'personal revision');
  if (!Array.isArray(value.entries) || value.entries.length > MAX_PERSONAL) fail('invalid personal entries');
  const ids = new Set();
  const entries = value.entries.map((entry) => {
    keys(entry, ['uuid', 'id', 'language', 'source', 'target', 'sense', 'direction', 'archived',
      'provenance', 'createdAt', 'linkedLegacy'], 'personal entry',
    ['uuid', 'id', 'language', 'source', 'target', 'sense', 'direction', 'archived', 'provenance', 'createdAt']);
    language(entry.language);
    if (!UUID.test(entry.uuid) || entry.id !== `personal:${entry.language}:${entry.uuid}` || ids.has(entry.uuid) ||
        validForm(entry.source) !== entry.source || validForm(entry.target) !== entry.target ||
        validForm(entry.sense) !== entry.sense || !['en-to-target', 'target-to-en'].includes(entry.direction) ||
        typeof entry.archived !== 'boolean' || !['manual', 'bundled-suggestion'].includes(entry.provenance))
      fail('invalid personal entry');
    ids.add(entry.uuid);
    integer(entry.createdAt, 0, Number.MAX_SAFE_INTEGER, 'personal creation time');
    if (Object.hasOwn(entry, 'linkedLegacy')) boundedString(entry.linkedLegacy, 100, 'legacy link');
    return { ...entry };
  });
  const history = Object.create(null);
  for (const [code, state] of Object.entries(map(value.history, 'personal history', 80))) {
    language(code);
    history[code] = review(state, `personal:${code}`, m);
  }
  const result = { version: 1, revision: value.revision, entries, history };
  if (cleanPersonal(result).unsupported) fail('unsupported personal data');
  return result;
}
function knownIds(scope, installed, personalState, scopeState) {
  const forms = new Set();
  const aggregate = new Set();
  const catalogScope = scope.startsWith('lang:') ? scope.slice(5) : scope;
  const add = (word) => { forms.add(word.fr.toLowerCase()); aggregate.add(entryId(catalogScope, word)); };
  if (scope === 'es') {
    for (const word of wordsForLevel(2)) add(word);
  } else if (scope.startsWith('personal:')) {
    for (const id of Object.keys(personalState.history[scope.slice(9)]?.cards || {})) {
      forms.add(id.toLowerCase()); aggregate.add(id);
    }
    for (const entry of personalState.entries) if (entry.language === scope.slice(9)) {
      forms.add(entry.id.toLowerCase()); aggregate.add(entry.id);
    }
  } else {
    const [, code, version] = scope.split(':');
    if (installed[code]?.version === version) for (const word of installed[code].words) add(word);
  }
  return { forms, aggregate };
}
function feedbackId(id, allowed, scope, peek = false, encounter = false) {
  if (encounter) {
    // encodeURIComponent may use nine ASCII bytes per CJK code point. A
    // A catalog-valid 50-character generated form plus scope can exceed 400 encoded bytes.
    boundedString(id, 1024, 'encounter ID');
    if (!allowed.aggregate.has(id)) fail('encounter refers to unknown catalog ID');
    return id;
  }
  const bare = peek && id.startsWith('peek:') ? id.slice(5) : id;
  cardId(bare, scope, allowed.forms.has(bare.toLowerCase()));
  if (!allowed.forms.has(bare.toLowerCase())) fail('feedback refers to unknown word');
  return id;
}
// Exact card IDs a scope's learning log may name: bundled Spanish forms, the installed pack
// version's forms, or the personal entry IDs of that language (not orphan history cards).
function logCatalog(scope, installed, personalState) {
  if (scope === 'es') return new Set(wordsForLevel(2).map((word) => word.fr));
  if (scope.startsWith('personal:'))
    return new Set(personalState.entries.filter((entry) => entry.language === scope.slice(9)).map((entry) => entry.id));
  const [, code, version] = scope.split(':');
  return new Set(installed[code]?.version === version ? installed[code].words.map((word) => word.fr) : []);
}
// Malformed log data fails closed like every other field. Well-formed entries for words the
// catalog cannot verify are omitted and counted (CTO ruling B, learning-log-export-unverified-ruling).
function retrievalLog(value, catalog, m) {
  keys(value, ['version', 'retrievals'], 'retrieval log', ['version', 'retrievals']);
  if (value.version !== 1) fail('unsupported retrieval log version');
  if (!Array.isArray(value.retrievals) || value.retrievals.length > MAX_RETRIEVALS) fail('invalid retrieval log');
  const clean = cleanRetrievals(value).retrievals;
  if (clean.length !== value.retrievals.length) fail('invalid retrieval log entry');
  const kept = clean.filter(([word]) => catalog.has(word));
  m.omitted.retrievals += clean.length - kept.length;
  return { version: 1, retrievals: kept };
}
function exposureLog(value, catalog, m) {
  keys(value, ['version', 'words'], 'exposure log', ['version', 'words']);
  if (value.version !== 1) fail('unsupported exposure log version');
  const raw = map(value.words, 'exposure log', MAX_EXPOSURE_WORDS);
  const clean = cleanExposures(value).words;
  if (Object.keys(clean).length !== Object.keys(raw).length) fail('invalid exposure log entry');
  const words = Object.create(null);
  for (const [word, counts] of Object.entries(clean)) {
    if (catalog.has(word)) words[word] = counts;
    else m.omitted.exposures++;
  }
  return { version: 1, words };
}
function feedback(value, scope, installed, personalState, m) {
  keys(value, ['review', 'events', 'shown', 'encounters', ...(m.schema >= 2 ? LOG_FIELDS : [])], 'scope');
  const result = {};
  if (Object.hasOwn(value, 'review')) {
    if (scope.startsWith('personal:')) fail('personal review belongs in personal history');
    result.review = review(value.review, scope, m, installed);
  }
  if (m.schema >= 2) {
    const catalog = logCatalog(scope, installed, personalState);
    if (Object.hasOwn(value, 'retrievals')) result.retrievals = retrievalLog(value.retrievals, catalog, m);
    if (Object.hasOwn(value, 'exposures')) result.exposures = exposureLog(value.exposures, catalog, m);
  }
  const allowed = knownIds(scope, installed, personalState, result);
  const unverifiedForm = (id, peek = false) => typeof id === 'string' &&
    !allowed.forms.has((peek && id.startsWith('peek:') ? id.slice(5) : id).toLowerCase());
  const unverifiedEncounter = (id) => typeof id === 'string' && !allowed.aggregate.has(id);
  let unverifiedFeedback = 0;
  if (Array.isArray(value.events)) unverifiedFeedback += value.events.filter((event) =>
    event && unverifiedForm(event.word)).length;
  if (Array.isArray(value.shown?.words)) unverifiedFeedback += value.shown.words.filter((id) =>
    unverifiedForm(id, true)).length;
  if (value.encounters?.counts && typeof value.encounters.counts === 'object' &&
      !Array.isArray(value.encounters.counts))
    unverifiedFeedback += Object.keys(value.encounters.counts).filter(unverifiedEncounter).length;
  if (Array.isArray(value.encounters?.touched)) unverifiedFeedback += value.encounters.touched.filter(
    unverifiedEncounter).length;
  if (unverifiedFeedback) fail(`${unverifiedFeedback} unverified historical feedback ID(s); old installation remains unchanged`);
  if (Object.hasOwn(value, 'events')) {
    if (!Array.isArray(value.events) || value.events.length > 500) fail('invalid reading events');
    result.events = value.events.map((event) => {
      keys(event, ['word', 'kind', 'day'], 'event', ['word', 'kind', 'day']);
      if (!['seen', 'flip', 'peek'].includes(event.kind)) fail('invalid event kind');
      return { word: feedbackId(event.word, allowed, scope), kind: event.kind, day: day(event.day) };
    });
  }
  if (Object.hasOwn(value, 'shown')) {
    keys(value.shown, ['day', 'words'], 'shown', ['day', 'words']);
    if (!Array.isArray(value.shown.words) || value.shown.words.length > 500) fail('invalid shown words');
    result.shown = { day: day(value.shown.day), words: value.shown.words.map((id) => feedbackId(id, allowed, scope, true)) };
  }
  if (Object.hasOwn(value, 'encounters')) {
    keys(value.encounters, ['version', 'day', 'bucket', 'counts', 'touched'], 'encounters',
      ['version', 'day', 'bucket', 'counts', 'touched']);
    if (value.encounters.version !== 1) fail('unsupported encounter version');
    const counts = Object.create(null);
    for (const [id, count] of Object.entries(map(value.encounters.counts, 'encounter counts', 256)))
      counts[feedbackId(id, allowed, scope, false, true)] = integer(count, 1, 7, 'encounter count');
    if (!Array.isArray(value.encounters.touched) || value.encounters.touched.length > 256) fail('invalid touched IDs');
    result.encounters = { version: 1, day: day(value.encounters.day),
      bucket: integer(value.encounters.bucket, 0, 10000000, 'encounter bucket'), counts,
      touched: value.encounters.touched.map((id) => feedbackId(id, allowed, scope, false, true)) };
  }
  return result;
}
// Schema 2 files may say how much log data the exporter left out (budget or ruling B), so the
// import preview can report omissions the file itself no longer shows.
function logOmitted(value) {
  keys(value, ['retrievals', 'exposureWords'], 'log omissions', ['retrievals', 'exposureWords']);
  return { retrievals: integer(value.retrievals, 0, 10000000, 'omitted retrieval count'),
    exposureWords: integer(value.exposureWords, 0, 10000000, 'omitted exposure count') };
}
function state(value, m) {
  keys(value, ['preferences', 'packs', 'personal', 'scopes', ...(m.schema >= 2 && !m.source ? ['logOmitted'] : [])],
    'state', ['preferences', 'packs', 'personal', 'scopes']);
  const installed = packs(value.packs);
  const catalogs = { ...installed, [GUARANI_STARTER]: GUARANI_PACK };
  const own = personal(value.personal, m);
  const scopes = Object.create(null);
  for (const [id, raw] of Object.entries(map(value.scopes, 'scopes', MAX_SCOPES))) {
    scopeKey(id);
    scopes[id] = feedback(raw, id, catalogs, own, m);
  }
  return { preferences: preferences(value.preferences, installed, m), packs: installed, personal: own, scopes,
    ...(Object.hasOwn(value, 'logOmitted') ? { logOmitted: logOmitted(value.logOmitted) } : {}) };
}
export function parseBackup(json) {
  if (typeof json !== 'string' || new TextEncoder().encode(json).length > MAX_BACKUP_BYTES) fail('file is too large');
  let raw;
  try { raw = JSON.parse(json); } catch { fail('file is not valid JSON'); }
  keys(raw, ['format', 'schemaVersion', 'exportedByVersion', 'state'], 'file',
    ['format', 'schemaVersion', 'exportedByVersion', 'state']);
  if (raw.format !== BACKUP_FORMAT) fail('this is not a Lang Weave learning backup');
  if (!READ_SCHEMAS.includes(raw.schemaVersion)) fail(Number.isSafeInteger(raw.schemaVersion) && raw.schemaVersion > 0
    ? `this file uses schema ${raw.schemaVersion}, and this version of Lang Weave reads schemas ${READ_SCHEMAS.join(' and ')}. Update Lang Weave to import it`
    : 'unsupported schema version');
  boundedString(raw.exportedByVersion, 40, 'export tool version');
  if (!/^\d+\.\d+\.\d+(?:[-+][a-zA-Z0-9.-]+)?$/.test(raw.exportedByVersion)) fail('invalid export tool version');
  const m = mode(false, raw.schemaVersion);
  const parsed = state(raw.state, m);
  return { format: BACKUP_FORMAT, schemaVersion: raw.schemaVersion,
    exportedByVersion: raw.exportedByVersion, state: parsed, omitted: m.omitted };
}
function storageEntries(all) {
  object(all, 'storage');
  const scopes = Object.create(null);
  for (const [key, value] of Object.entries(all)) {
    if (DIRECT_KEYS.has(key) || NON_LEARNING_KEYS.has(key) || key.startsWith('c:')) continue;
    if (!key.startsWith('lang:')) fail('unknown storage format');
    const scope = storageScopeKey(key);
    const suffix = key.slice(storageKey(scope, '').length);
    if (!LEARNING_SUFFIXES.includes(suffix)) fail('unknown learning key');
    (scopes[scope] ||= {})[SCOPE_FIELDS[suffix]] = value;
  }
  const es = scopes.es ||= {};
  for (const [key, field] of Object.entries(SCOPE_FIELDS))
    if (Object.hasOwn(all, key)) es[field] = all[key];
  return scopes;
}
// Fit the log into LOG_BUDGET_BYTES of compact JSON: first every scope's exposure aggregates,
// which the catalogs bound to about 207 KiB, then retrievals newest first across all scopes,
// stopping at the first one that does not fit. Only current scopes (Spanish, installed packs,
// personal) can reach this point: a historical pack scope has no catalog to verify its words,
// so ruling B already left its log out. Everything left out, here or by ruling B during
// validation, is counted in state.logOmitted.
// Guess-first retrievals (source 'guess') are read, validated and imported, but schema 2 export
// leaves them out and counts them in logOmitted: every build up to 0.12.20 refuses a whole backup
// holding one. Turn this on once a release that reads them has shipped (the "Release order" rule
// in docs/LEARNING-CORE-MISSION.md; docs/INFERENCE-MISSION.md).
export const EXPORT_GUESSES = false;
// 0.12.21 rejects these IDs when importing a schema 2 log. Keep the old form
// predicate only at this export boundary until 0.12.22 readers have shipped.
const legacyExportForm = (id) => id.length > 0 && id.length <= 50 && id.trim() === id &&
  id.split(/\s+/).length <= 5 &&
  !/[\p{Cc}\p{Cf}\p{Cs}<>:\/@\\]/u.test(id.replace(/[\u200c\u200d]/g, '')) &&
  !/\.[\p{L}\p{N}]/u.test(id);
function fitLog(st, m, budget) {
  const encoder = new TextEncoder();
  const bytes = (value) => encoder.encode(JSON.stringify(value)).length;
  let used = 0, droppedRetrievals = 0, droppedWords = 0;
  const fit = (size) => used + size <= budget && ((used += size), true);
  // Charge the structure around the entries up front, so the budget bounds the serialized log:
  // each log field's key and empty wrapper, the key of a scope that holds only log data, and
  // the largest possible state.logOmitted.
  used += bytes({ retrievals: 10000000, exposureWords: 10000000 }) + bytes('logOmitted') + 2;
  for (const [id, fields] of Object.entries(st.scopes)) {
    const logFields = LOG_FIELDS.filter((field) => fields[field]);
    if (!logFields.length) continue;
    if (Object.keys(fields).every((field) => LOG_FIELDS.includes(field))) used += bytes(id) + 3;
    if (fields.retrievals) used += bytes('retrievals') + 2 + bytes({ version: 1, retrievals: [] });
    if (fields.exposures) used += bytes('exposures') + 2;
  }
  for (const [id, fields] of Object.entries(st.scopes)) {
    if (fields.exposures && !id.startsWith('personal:')) {
      for (const word of Object.keys(fields.exposures.words)) {
        if (legacyExportForm(word)) continue;
        delete fields.exposures.words[word];
        droppedWords++;
      }
    }
    if (fields.exposures && !fit(bytes(fields.exposures))) {
      droppedWords += Object.keys(fields.exposures.words).length;
      delete fields.exposures;
    }
  }
  const all = [];
  for (const [id, fields] of Object.entries(st.scopes))
    for (const tuple of fields.retrievals?.retrievals || []) {
      if ((tuple[2] === 'guess' && !EXPORT_GUESSES) ||
          (!id.startsWith('personal:') && !legacyExportForm(tuple[0]))) {
        droppedRetrievals++; continue;
      }
      all.push([id, tuple]);
    }
  all.sort(([, a], [, b]) => b[1] - a[1]);
  const kept = new Set();
  let full = false;
  for (const [, tuple] of all) {
    if (!full && fit(bytes(tuple) + 1)) kept.add(tuple);
    else { full = true; droppedRetrievals++; }
  }
  for (const fields of Object.values(st.scopes)) if (fields.retrievals)
    fields.retrievals = { version: 1, retrievals: fields.retrievals.retrievals.filter((tuple) => kept.has(tuple)) };
  for (const [id, fields] of Object.entries(st.scopes)) {
    if (fields.retrievals && !fields.retrievals.retrievals.length) delete fields.retrievals;
    if (fields.exposures && !Object.keys(fields.exposures.words).length) delete fields.exposures;
    if (id !== 'es' && !Object.keys(fields).length) delete st.scopes[id];
  }
  const retrievals = m.omitted.retrievals + droppedRetrievals, exposureWords = m.omitted.exposures + droppedWords;
  if (retrievals || exposureWords) st.logOmitted = { retrievals, exposureWords };
}

export function createBackup(all, exportedByVersion, schema = BACKUP_SCHEMA) {
  if (!READ_SCHEMAS.includes(schema)) fail('unsupported export schema');
  const scopes = storageEntries(all);
  // Schema 1 has no learning log; FSRS card state is stripped by card(). A scope that held only
  // log data is dropped rather than exported empty.
  if (schema < 2) for (const [id, fields] of Object.entries(scopes)) {
    const had = Object.keys(fields).length;
    for (const field of LOG_FIELDS) delete fields[field];
    if (id !== 'es' && had && !Object.keys(fields).length) delete scopes[id];
  }
  const settings = object(all.settings || {}, 'settings');
  validateStorageSettings(settings);
  const raw = { format: BACKUP_FORMAT, schemaVersion: schema, exportedByVersion,
    state: { preferences: {
      language: settings.language ?? 'es', levelOverride: settings.levelOverride ?? 0,
      gradual: settings.gradual ?? false, newWordsPerDay: settings.newWordsPerDay ?? 5,
      density: settings.density ?? 'normal', inlineRecall: settings.inlineRecall ?? false,
      ...(schema >= 2 && Object.hasOwn(settings, 'desiredRetention') ? { desiredRetention: settings.desiredRetention } : {}),
    }, packs: all.languagePacks || {},
    personal: all.personalVocabularyV1 || { version: 1, revision: 0, entries: [], history: {} },
    scopes } };
  const m = mode(true, schema);
  const clean = { ...raw, state: state(raw.state, m) };
  if (schema >= 2) {
    // The log is the only optional part of a backup, so it gets at most LOG_BUDGET_BYTES and never
    // more than the room the rest of the file leaves under MAX_BACKUP_BYTES.
    const scopesWithoutLog = Object.fromEntries(Object.entries(clean.state.scopes).map(([id, fields]) => {
      const { retrievals, exposures, ...rest } = fields;
      return [id, rest];
    }));
    const base = new TextEncoder().encode(JSON.stringify({ ...clean, state: { ...clean.state, scopes: scopesWithoutLog } })).length;
    // If the rest of the file alone sits within a few dozen bytes of the limit, even
    // state.logOmitted does not fit and the export fails closed below, rather than dropping the
    // log without saying so.
    fitLog(clean.state, m, Math.max(0, Math.min(LOG_BUDGET_BYTES, MAX_BACKUP_BYTES - base - LOG_MARGIN_BYTES)));
  }
  // Schema 2 is written compactly: indentation would roughly triple the learning log.
  const json = schema >= 2 ? JSON.stringify(clean) : JSON.stringify(clean, null, 2);
  if (new TextEncoder().encode(json).length > MAX_BACKUP_BYTES) fail('supported learning state exceeds file limit');
  return json;
}
export function learningPatch(backup, targetSettings) {
  const out = Object.create(null);
  out.settings = { ...targetSettings, ...backup.state.preferences };
  out.languagePacks = backup.state.packs;
  out.personalVocabularyV1 = backup.state.personal;
  for (const [scope, fields] of Object.entries(backup.state.scopes)) {
    for (const [suffix, field] of Object.entries(SCOPE_FIELDS))
      if (Object.hasOwn(fields, field)) out[storageKey(scope, suffix)] = fields[field];
  }
  return out;
}
// A log value of exactly the version 1 shape, and whether it holds nothing.
function knownLog(field, value) {
  const list = field === 'retrievals' ? 'retrievals' : 'words';
  return !!value && typeof value === 'object' && !Array.isArray(value) &&
    Object.keys(value).length === 2 && value.version === 1 && Object.hasOwn(value, list) &&
    (field === 'retrievals' ? Array.isArray(value.retrievals)
      : !!value.words && typeof value.words === 'object' && !Array.isArray(value.words));
}
function emptyLog(field, value) {
  return knownLog(field, value) && (field === 'retrievals' ? !value.retrievals.length : !Object.keys(value.words).length);
}
// An empty learning log under a storage key, which no import needs to write.
export function emptyLogEntry(key, value) {
  const suffix = key.startsWith('lang:') ? key.slice(key.lastIndexOf(':') + 1) : key;
  return Object.hasOwn(SCOPE_FIELDS, suffix) && LOG_FIELDS.includes(SCOPE_FIELDS[suffix]) && emptyLog(SCOPE_FIELDS[suffix], value);
}
export function targetFresh(all) {
  const scopes = storageEntries(all); // rejects unknown target keys, including unknown scoped formats
  validateStorageSettings(all.settings || {});
  if (all.apiKey || all.settings?.apiKey) fail('target has a key; import into a keyless fresh installation');
  if (Object.keys(packs(all.languagePacks || {})).length) fail('target has installed language packs');
  const own = personal(all.personalVocabularyV1 || { version: 1, revision: 0, entries: [], history: {} }, mode(true, 1));
  if (own.entries.length || Object.values(own.history).some((s) => Object.keys(s.cards).length || s.learning.day || s.learning.count))
    fail('target has personal learning');
  for (const [id, raw] of Object.entries(scopes)) {
    if (id !== 'es' && Object.keys(raw).length) fail('target has a learning scope');
    // Any logged retrieval or exposure is learning progress; an unknown log shape is a conflict.
    for (const field of LOG_FIELDS) if (Object.hasOwn(raw, field) && !emptyLog(field, raw[field])) {
      if (!knownLog(field, raw[field])) fail('unknown learning log format');
      fail('target has learning progress');
    }
    const rest = { ...raw };
    for (const field of LOG_FIELDS) delete rest[field];
    const clean = feedback(rest, id, {}, own, mode(true, 1));
    if (Object.keys(clean.review?.cards || {}).length || clean.review?.learning.day || clean.review?.learning.count ||
        clean.events?.length || clean.shown?.words.length || Object.keys(clean.encounters?.counts || {}).length ||
        clean.encounters?.touched.length) fail('target has learning progress');
  }
  return true;
}
export function validateStorageSettings(settings) {
  keys(settings, SETTINGS_FIELDS, 'settings');
  if (settings.siteOverrides !== undefined) map(settings.siteOverrides, 'site overrides', 10000);
  return true;
}
export function backupPreview(backup) {
  const { state: s } = backup;
  return { exportedByVersion: backup.exportedByVersion,
    languages: new Set(['es', s.preferences.language, ...Object.keys(s.packs), ...s.personal.entries.map((e) => e.language),
      ...Object.keys(s.personal.history), ...Object.keys(s.scopes).map((k) => k === 'es' ? 'es' :
        k.startsWith('personal:') ? k.slice(9) : k.split(':')[1])]).size,
    packs: Object.keys(s.packs).length,
    cards: Object.values(s.scopes).reduce((sum, scope) => sum + Object.keys(scope.review?.cards || {}).length, 0) +
      Object.values(s.personal.history).reduce((sum, scope) => sum + Object.keys(scope.cards).length, 0),
    personal: s.personal.entries.length, preferences: s.preferences, schemaVersion: backup.schemaVersion,
    retrievals: Object.values(s.scopes).reduce((sum, scope) => sum + (scope.retrievals?.retrievals.length || 0), 0),
    exposureWords: Object.values(s.scopes).reduce((sum, scope) => sum + Object.keys(scope.exposures?.words || {}).length, 0),
    omittedRetrievals: (backup.omitted?.retrievals || 0) + (s.logOmitted?.retrievals || 0),
    omittedExposureWords: (backup.omitted?.exposures || 0) + (s.logOmitted?.exposureWords || 0) };
}
