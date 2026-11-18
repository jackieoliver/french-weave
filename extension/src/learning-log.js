// Local learning measurements: a bounded retrieval log and per-word exposure aggregates.
//
// Privacy contract: entries hold catalog word IDs, times, enums and numbers only. No URL,
// host, title, passage or page text is ever accepted: every write requires the caller's
// scope catalog (`allowed`) and copies only the fixed fields below. Nothing leaves the
// browser. Callers scope storage with scopedStorage(storage, scope), exactly like events.js,
// so each language/pack (and each personal language) has its own log, and callers
// serialize read-modify-write.
//
// Storage (version 1). Entries are fixed-position arrays to keep a full log well under the
// learning backup's size budget (see docs/LEARNING-CORE-MISSION.md):
//   learningRetrievals: { version: 1, retrievals: [[word, at, source, direction, outcome,
//     prior, latencyMs, elapsedDays, intervalDays, predicted], ...] }  (oldest first)
//   learningExposures: { version: 1, words: { [word]: [count, peeks, distinctDays,
//     firstDay, lastDay] } }
// A guess-first answer (guess.js) is a retrieval with source 'guess', direction 'receptive' and
// outcome 'correct' or 'incorrect'; those values occur only together. They were added in 0.12.21
// without a version change: builds up to 0.12.20 drop such entries from storage and refuse a
// backup holding one, so schema 2 export leaves them out (portability.js, INFERENCE-MISSION.md).
// Guesses are not reviews: every recall measure below excludes them (reviewEntries).
import { localDay } from './events.js';
import { validDay } from './learning.js';
import { validPackForm } from './word-form.js';
import { GUARANI_STARTER } from './language-name.js';

export const RETRIEVALS_KEY = 'learningRetrievals';
export const EXPOSURES_KEY = 'learningExposures';
export const MAX_RETRIEVALS = 5000;
export const MAX_EXPOSURE_WORDS = 5000;
export const MAX_LATENCY_MS = 10 * 60 * 1000;
export const MAX_COUNT = 1000000;
export const SOURCES = Object.freeze(['inline', 'standalone', 'guess']);
// productive: meaning -> target form (today's review and inline cue); receptive: the reverse.
export const DIRECTIONS = Object.freeze(['productive', 'receptive']);
// 'known' is the inline "Already know" claim: logged, never counted as a recall. 'correct' and
// 'incorrect' belong to guesses only.
export const OUTCOMES = Object.freeze(['again', 'hard', 'medium', 'easy', 'known', 'correct', 'incorrect']);
const GUESS_OUTCOMES = new Set(['correct', 'incorrect']);
export const isGuess = (entry) => entry.source === 'guess';
// The retrievals that are reviews (ratings and claims), in log order.
export const reviewEntries = (entries) => entries.filter((entry) => !isGuess(entry));
const PASS = new Set(['hard', 'medium', 'easy']);
const MAX_ELAPSED_DAYS = 36500;
const MAX_INTERVAL_DAYS = 365;
const MAX_PRIOR = 10000;

const has = (allowed, id) => {
  if (allowed instanceof Set) return allowed.has(id);
  if (Array.isArray(allowed)) return allowed.includes(id);
  throw new TypeError('learning log: a scope catalog (Set or Array of word IDs) is required');
};

// An ID is either an exact personal UUID or a generated-pack form. The latter's
// shape is deliberately the same one cleanPack accepts; catalog membership is
// the privacy guarantee, including for punctuation and fixed phrases.
const PERSONAL_ID = new RegExp(
  `^personal:(?:[a-z]{2,3}(?:-[a-z0-9]{2,8})*|${GUARANI_STARTER}):[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`, 'i');
export function validWordId(id) {
  if (typeof id !== 'string') return false;
  if (PERSONAL_ID.test(id)) return id.length <= 100;
  return validPackForm(id);
}

const nullableInt = (v, max) => v === null || (Number.isSafeInteger(v) && v >= 0 && v <= max);
const nullableProbability = (v) => v === null || (Number.isFinite(v) && v >= 0 && v <= 1);

function validTuple(t) {
  return Array.isArray(t) && t.length === 10 && validWordId(t[0]) &&
    Number.isSafeInteger(t[1]) && t[1] >= 0 && SOURCES.includes(t[2]) && DIRECTIONS.includes(t[3]) &&
    OUTCOMES.includes(t[4]) && Number.isSafeInteger(t[5]) && t[5] >= 0 && t[5] <= MAX_PRIOR &&
    nullableInt(t[6], MAX_LATENCY_MS) && nullableInt(t[7], MAX_ELAPSED_DAYS) &&
    nullableInt(t[8], MAX_INTERVAL_DAYS) && nullableProbability(t[9]) &&
    (t[2] === 'guess') === GUESS_OUTCOMES.has(t[4]) && (t[2] !== 'guess' || t[3] === 'receptive');
}

const plainObject = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const newerVersion = (raw) => plainObject(raw) && Number.isSafeInteger(raw.version) && raw.version > 1;

export function cleanRetrievals(raw) {
  // Keep structurally valid entries even if their word left the catalog: a temporary catalog
  // change must not erase measurements (the same rule cleanReview applies to cards).
  const source = plainObject(raw) && raw.version === 1 && Array.isArray(raw.retrievals) ? raw.retrievals : [];
  return { version: 1, retrievals: source.filter(validTuple).slice(-MAX_RETRIEVALS)
    .map((t) => [...t]) };
}

// `entry`: { word, at, source, direction, outcome, prior, latencyMs?, elapsedDays?,
// intervalDays?, predicted? }. `prior` is the card's review count before this retrieval.
// `elapsedDays` is what the scheduler used: whole 24-hour periods since the last review
// (fsrs.js elapsedDays). For a first retrieval (prior 0) the card only knows its local
// introduction day, so it is local calendar days since `introducedDay`. Unknown fields are
// ignored, never stored. Returns false if rejected.
export function appendRetrieval(state, entry, allowed) {
  if (!plainObject(entry) || !validWordId(entry.word) || !has(allowed, entry.word)) return false;
  const latency = Number.isSafeInteger(entry.latencyMs) && entry.latencyMs >= 0
    ? Math.min(MAX_LATENCY_MS, entry.latencyMs) : null;
  const predicted = Number.isFinite(entry.predicted) && entry.predicted >= 0 && entry.predicted <= 1
    ? Math.round(entry.predicted * 10000) / 10000 : null;
  const tuple = [entry.word, entry.at, entry.source, entry.direction, entry.outcome, entry.prior, latency,
    entry.elapsedDays ?? null, entry.intervalDays ?? null, predicted];
  if (!validTuple(tuple)) return false;
  state.retrievals.push(tuple);
  if (state.retrievals.length > MAX_RETRIEVALS) state.retrievals.splice(0, state.retrievals.length - MAX_RETRIEVALS);
  return true;
}

export function retrievalEntries(state) {
  return state.retrievals.map(([word, at, source, direction, outcome, prior, latencyMs, elapsedDays,
    intervalDays, predicted]) => ({ word, at, source, direction, outcome, prior, latencyMs, elapsedDays,
    intervalDays, predicted }));
}

const dayNumber = (day) => Date.parse(`${day}T00:00:00Z`) / 86400000;
// Counters must be consistent: a seen word has 1..count distinct days, which cannot exceed
// the days from first to last; a peek-only record has no exposures and no days.
function validExposure(id, v) {
  return validWordId(id) && Array.isArray(v) && v.length === 5 &&
    Number.isSafeInteger(v[0]) && v[0] >= 0 && v[0] <= MAX_COUNT &&
    Number.isSafeInteger(v[1]) && v[1] >= 0 && v[1] <= MAX_COUNT &&
    Number.isSafeInteger(v[2]) && validDay(v[3]) && validDay(v[4]) && v[3] <= v[4] &&
    (v[0] === 0 ? v[2] === 0 : v[2] >= 1 && v[2] <= v[0] && v[2] <= dayNumber(v[4]) - dayNumber(v[3]) + 1);
}

export function cleanExposures(raw) {
  const words = Object.create(null);
  const source = plainObject(raw) && raw.version === 1 && plainObject(raw.words) ? raw.words : {};
  const valid = Object.entries(source).filter(([id, v]) => validExposure(id, v))
    .sort(([a, av], [b, bv]) => (bv[4] < av[4] ? -1 : bv[4] > av[4] ? 1 : bv[0] - av[0] || (a < b ? -1 : 1)));
  for (const [id, v] of valid.slice(0, MAX_EXPOSURE_WORDS)) words[id] = [...v];
  return { version: 1, words };
}

function evictOne(words) {
  let victim = null;
  for (const [id, v] of Object.entries(words)) {
    const w = victim && words[victim];
    // Same order as cleanExposures keeps: oldest last day, then fewest exposures, then the later ID.
    if (!w || v[4] < w[4] || (v[4] === w[4] && (v[0] < w[0] || (v[0] === w[0] && id > victim)))) victim = id;
  }
  delete words[victim];
}

// Count one in-context placement ('seen') or one hover-to-meaning ('peek') for each distinct
// listed word, on local `day`: one call is one delivery, so a word placed twice in it counts
// once. A peek never adds an exposure. A clock rollback still counts but cannot
// mint another distinct day or move the last day backwards. When full, the word with the
// oldest last day is dropped. Returns how many words were counted.
export function countExposures(state, ids, allowed, day, kind = 'seen') {
  if (!validDay(day) || !['seen', 'peek'].includes(kind) || !Array.isArray(ids)) return 0;
  let counted = 0;
  for (const id of new Set(ids)) {
    if (!validWordId(id) || !has(allowed, id)) continue;
    let v = state.words[id];
    if (!v) {
      if (Object.keys(state.words).length >= MAX_EXPOSURE_WORDS) evictOne(state.words);
      v = state.words[id] = [0, 0, 0, day, day];
    }
    if (kind === 'peek') v[1] = Math.min(MAX_COUNT, v[1] + 1);
    else {
      if (v[0] === 0 || day > v[4]) { v[2] = Math.min(MAX_COUNT, v[2] + 1); if (day > v[4]) v[4] = day; }
      v[0] = Math.min(MAX_COUNT, v[0] + 1);
    }
    counted++;
  }
  return counted;
}

// Storage wrappers. A stored log of a newer version is never overwritten: the write is
// refused so a downgrade cannot erase it. Malformed version-1 entries are dropped.
export async function recordRetrieval(storage, entry, allowed) {
  const { [RETRIEVALS_KEY]: raw } = await storage.get([RETRIEVALS_KEY]);
  if (newerVersion(raw)) return false;
  const state = cleanRetrievals(raw);
  if (!appendRetrieval(state, entry, allowed)) return false;
  await storage.set({ [RETRIEVALS_KEY]: state });
  return true;
}

export async function recordExposures(storage, ids, allowed, day = localDay(), kind = 'seen') {
  const { [EXPOSURES_KEY]: raw } = await storage.get([EXPOSURES_KEY]);
  if (newerVersion(raw)) return 0;
  const state = cleanExposures(raw);
  const counted = countExposures(state, ids, allowed, day, kind);
  if (counted) await storage.set({ [EXPOSURES_KEY]: state });
  return counted;
}

// ---- Measurements (docs/research/learning-science.md section 9) ----
// Recall measures use retrievals with a graded outcome; Again is a failure, Hard/Medium/Easy
// a pass (as in FSRS), and 'known' claims are excluded.

const graded = (entries) => reviewEntries(entries).filter((e) => e.outcome !== 'known');
const rate = (list) => ({ n: list.length, passed: list.filter((e) => PASS.has(e.outcome)).length,
  rate: list.length ? list.filter((e) => PASS.has(e.outcome)).length / list.length : null });
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const mean = (values) => values.length ? values.reduce((a, b) => a + b, 0) / values.length : null;

// 1. First retrievals made the local day after introduction.
export function nextDayRecall(entries) {
  return rate(graded(entries).filter((e) => e.prior === 0 && e.elapsedDays === 1));
}

// 2. Retention at long gaps. `predicted` compares the scheduler on the same population: the
// long-gap retrievals that carry a prediction (a first retrieval has none).
export function longRetention(entries, minDays = 21) {
  const list = graded(entries).filter((e) => e.elapsedDays !== null && e.elapsedDays >= minDays);
  const withPrediction = list.filter((e) => e.predicted !== null);
  return { ...rate(list), predicted: { n: withPrediction.length,
    meanPredicted: mean(withPrediction.map((e) => e.predicted)), observed: rate(withPrediction).rate } };
}

// 3. Predicted vs observed recall in equal-width buckets, with the Brier score of the
// scheduler and of a constant predictor (the observed overall rate). The fsrs-scheduler
// issue is falsified if, after a few hundred reviews, the scheduler does not beat the constant.
// Same-day retries (elapsed < 1 day) are excluded: their prediction is always 1 and FSRS does
// not model short-term recall, so they would skew the test against the scheduler.
export function calibration(entries, buckets = 10) {
  const list = graded(entries).filter((e) => e.predicted !== null && e.elapsedDays !== null && e.elapsedDays >= 1);
  const bins = Array.from({ length: buckets }, (_, i) => ({ from: i / buckets, to: (i + 1) / buckets, items: [] }));
  for (const e of list) bins[Math.min(buckets - 1, Math.floor(e.predicted * buckets))].items.push(e);
  const outcome = (e) => (PASS.has(e.outcome) ? 1 : 0);
  const base = list.length ? list.reduce((s, e) => s + outcome(e), 0) / list.length : null;
  const brier = list.length ? list.reduce((s, e) => s + (e.predicted - outcome(e)) ** 2, 0) / list.length : null;
  const baselineBrier = list.length ? list.reduce((s, e) => s + (base - outcome(e)) ** 2, 0) / list.length : null;
  return { n: list.length, brier, baselineBrier, beatsConstant: list.length ? brier < baselineBrier : null,
    buckets: bins.map(({ from, to, items }) => ({ from, to, n: items.length,
      meanPredicted: mean(items.map((e) => e.predicted)), observed: rate(items).rate })) };
}

// 4. Words whose latest long-gap evidence is a pass: a pass at >= minDays verifies a word, and
// any later Again un-verifies it until another long-gap pass. Log order is retrieval order.
export function verifiedKnown(entries, minDays = 21) {
  const verified = new Set();
  for (const e of graded(entries)) {
    if (e.outcome === 'again') verified.delete(e.word);
    else if (e.elapsedDays !== null && e.elapsedDays >= minDays) verified.add(e.word);
  }
  return { count: verified.size, words: [...verified].sort() };
}

// 5. Peeks per exposure, overall and per word. Aggregates carry no time series, so a trend
// needs successive snapshots.
export function peekRate(exposures) {
  let count = 0, peeks = 0;
  const words = Object.create(null);
  for (const [id, [n, p]] of Object.entries(exposures.words)) {
    count += n; peeks += p;
    words[id] = n ? p / n : null;
  }
  return { exposures: count, peeks, rate: count ? peeks / count : null, words };
}

// 6. Exposures and distinct days for the learning words (unfamiliar cards), against the
// research target of 8+ encounters on distinct days.
export function exposureCoverage(exposures, learningWords, targetDays = 8) {
  const rows = [...new Set(learningWords)].map((id) => {
    const v = exposures.words[id];
    return { word: id, exposures: v ? v[0] : 0, days: v ? v[2] : 0 };
  });
  return { words: rows.length, medianExposures: median(rows.map((r) => r.exposures)),
    medianDays: median(rows.map((r) => r.days)), atTarget: rows.filter((r) => r.days >= targetDays).length, rows };
}

// 7a. Workload over the last `windowDays` local days ending at `now`, inclusive.
export function workload(entries, now, windowDays = 30) {
  if (!Number.isSafeInteger(now) || !Number.isSafeInteger(windowDays) || windowDays < 1) throw new RangeError('learning log: invalid window');
  const today = new Date(now);
  const start = localDay(new Date(today.getFullYear(), today.getMonth(), today.getDate() - (windowDays - 1)));
  const end = localDay(today);
  const inWindow = reviewEntries(entries).filter((e) => e.at <= now && localDay(new Date(e.at)) >= start && localDay(new Date(e.at)) <= end);
  const latencies = inWindow.filter((e) => e.latencyMs !== null).map((e) => e.latencyMs / 1000);
  return { reviews: inWindow.length, days: windowDays, reviewsPerDay: inWindow.length / windowDays,
    activeDays: new Set(inWindow.map((e) => localDay(new Date(e.at)))).size,
    medianSecondsPerReview: median(latencies) };
}

// 7b. Leeches: words with `minLapses` or more lapses. A lapse is an Again on a previously rated
// card at least one day after its last review, the rule fsrs.js reviewCard uses. Only lapses
// still inside the bounded log are visible.
export function leeches(entries, minLapses = 4) {
  const lapses = new Map();
  for (const e of reviewEntries(entries)) {
    if (e.outcome === 'again' && e.prior > 0 && e.elapsedDays !== null && e.elapsedDays >= 1)
      lapses.set(e.word, (lapses.get(e.word) || 0) + 1);
  }
  const words = [...lapses].filter(([, n]) => n >= minLapses).map(([word, n]) => ({ word, lapses: n }))
    .sort((a, b) => b.lapses - a.lapses || (a.word < b.word ? -1 : 1));
  return { count: words.length, words };
}

// Everything above for one scope. `now` (ms) is required: this module never reads the clock.
export function summarize(retrievalState, exposureState, { now, learningWords = [], retention = 0.9,
  windowDays = 30 } = {}) {
  if (!Number.isSafeInteger(now)) throw new RangeError('learning log: summarize needs the current time');
  const entries = reviewEntries(retrievalEntries(retrievalState));
  const long = longRetention(entries);
  return { retrievals: entries.length, claims: entries.filter((e) => e.outcome === 'known').length,
    nextDayRecall: nextDayRecall(entries), longRetention: { ...long, target: retention },
    calibration: calibration(entries), verifiedKnown: verifiedKnown(entries), peekRate: peekRate(exposureState),
    exposureCoverage: exposureCoverage(exposureState, learningWords), workload: workload(entries, now, windowDays),
    leeches: leeches(entries) };
}
