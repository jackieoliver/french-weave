// Language profiles: what differs between languages (examples, sense notes, articles, script), as data. The single
// source is data/profiles/<language>.json in the plugin; profile-data.js is its generated copy (scripts/make_profiles.py).
// A language with no profile, or a profile missing fields, gets the generic values: no examples or sense notes, so
// nothing French leaks into another language.
import { GENERIC, PROFILES } from './profile-data.js';

const isObject = (v) => v && typeof v === 'object' && !Array.isArray(v);

function merged(base, own) {
  const out = { ...base };
  for (const [k, v] of Object.entries(own || {})) out[k] = isObject(base[k]) && isObject(v) ? merged(base[k], v) : v;
  return out;
}

// profiles: tests pass their own fixtures.
export function profileFor(language = 'French', profiles = PROFILES) {
  const name = String(language || 'French').trim();
  const p = merged(GENERIC, profiles[name.toLowerCase()] || {});
  return { ...p, language: p.language || name };
}

const esc = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

// Regexes for a listed noun's article: any article (le problème, une idée -> problème, idée), definite only (for
// "the problem" vs "my problem"), and the article's sound in a hint ("luh prob-lem" -> "prob-lem"). null: none.
export function articlePatterns(profile) {
  const a = profile.articles;
  const lead = (spaced) => {
    const parts = [...(spaced.length ? [`(?:${spaced.map(esc).join('|')})\\s+`] : []), ...a.elided.map(esc)];
    return parts.length ? new RegExp(`^(?:${parts.join('|')})`, 'i') : null;
  };
  return {
    any: lead([...a.definite, ...a.indefinite]),
    definite: lead(a.definite),
    hint: a.hint_prefixes.length ? new RegExp(`^(?:${a.hint_prefixes.map(esc).join('|')}) `) : null,
  };
}

// Kanji (CJK ideographs), for script.reading.late_only_with = "kanji".
const KANJI = /[㐀-䶿一-鿿]/;

// What to show above a word on a web page (HTML ruby), per the profile's script.reading, or '' for nothing.
// mode "romaji" shows the word's hint, "kana" its reading (the lexicon's reading column). From late_from_stage on,
// "late" replaces "early", and late_only_with = "kanji" limits it to words containing kanji. known_drop: known words
// show nothing. Chat never shows readings above words (terminals can't); the footer gloss carries the hint there.
// Not rendered yet: the extension's ruby display comes with the first profile that turns this on.
export function readingFor(word, profile, stage = 1) {
  const r = profile.script.reading || {};
  if (!word || (r.known_drop && word.status === 'known')) return '';
  const late = r.late_from_stage > 0 && stage >= r.late_from_stage;
  const mode = late ? r.late : r.early;
  if (late && r.late_only_with === 'kanji' && !KANJI.test(word.fr)) return '';
  if (mode === 'romaji') return word.hint || '';
  if (mode === 'kana') return word.reading || '';
  return '';
}
