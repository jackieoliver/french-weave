// Level schedule, word lists, and guards. Pure: no DOM, no chrome APIs.
import { profileFor, articlePatterns } from './profile.js';
import { GENERIC } from './profile-data.js';

// Levels 3-4 need the plugin's word state; with the bundled lists the prompt stays at Level 2 rules.
export const MAX_BUILT_LEVEL = 4;

// stage: from the Claude Code plugin's word state (0 when there is none); chosen: after the popup override;
// effective: what the prompt uses.
export function resolveLevel(settings = {}, stage = 0) {
  const override = Number(settings.levelOverride) || 0;
  const synced = Number(stage) >= 1 && Number(stage) <= 4 ? Number(stage) : 0;
  const chosen = override >= 1 && override <= 4 ? override : synced || 1;
  return { stage: synced, chosen, effective: Math.min(chosen, MAX_BUILT_LEVEL) };
}

const W = (fr, en, hint) => ({ fr, en, hint });

// Level 1: the bundled starter list, used when the Claude Code plugin's word state isn't available.
export const L1_WORDS = [
  W('et', 'and', 'ay'),
  W('mais', 'but', 'meh'),
  W('ou', 'or', 'oo'),
  W('donc', 'so', 'donk'),
  W('parce que', 'because', 'pars kuh'),
  W('avec', 'with', 'ah-vek'),
  W('sans', 'without', 'sahn'),
  W('pour', 'for', 'poor'),
  W('très', 'very', 'treh'),
  W('aussi', 'also', 'oh-see'),
  W('bien', 'well / good', 'byan'),
  W('beaucoup', 'a lot', 'boh-koo'),
  W('un peu', 'a little', 'uhn puh'),
  W('maintenant', 'now', 'man-tuh-nahn'),
  W('toujours', 'always', 'too-zhoor'),
  W('peut-être', 'maybe', 'puh-tet-ruh'),
  W('ici', 'here', 'ee-see'),
  W('voilà', 'there it is', 'vwah-lah'),
  W('oui', 'yes', 'wee'),
  W('non', 'no', 'noh'),
  W('merci', 'thank you', 'mair-see'),
  W('le problème', 'the problem', 'luh prob-lem'),
  W('la question', 'the question', 'lah kess-tyon'),
  W("l'idée", 'the idea', 'lee-day'),
  W('la réponse', 'the answer', 'lah ray-ponss'),
  W('important', 'important', 'an-por-tahn'),
  W('possible', 'possible', 'po-see-bluh'),
  W('difficile', 'difficult', 'dee-fee-seel'),
];

// Level 2: L1 plus frequent words, cognates, and fixed phrases (~150 total).
export const L2_EXTRA = [
  // question words and connectors
  W('si', 'if', 'see'),
  W('comme', 'like / as', 'kom'),
  W('quand', 'when', 'kahn'),
  W('où', 'where', 'oo'),
  W('pourquoi', 'why', 'poor-kwah'),
  W('comment', 'how', 'ko-mahn'),
  W('qui', 'who', 'kee'),
  W('quoi', 'what', 'kwah'),
  W('alors', 'so / then', 'ah-lor'),
  W('en fait', 'actually', 'ahn fet'),
  W('par exemple', 'for example', 'par eg-zahm-pl'),
  // adverbs
  W('jamais', 'never', 'zha-meh'),
  W('encore', 'again / still', 'ahn-kor'),
  W('déjà', 'already', 'day-zha'),
  W('souvent', 'often', 'soo-vahn'),
  W('parfois', 'sometimes', 'par-fwah'),
  W('vraiment', 'really', 'vray-mahn'),
  W('seulement', 'only', 'suhl-mahn'),
  W('trop', 'too much', 'troh'),
  W('assez', 'enough', 'ah-say'),
  W('presque', 'almost', 'presk'),
  W('surtout', 'especially', 'sur-too'),
  W('ensemble', 'together', 'ahn-sahm-bl'),
  W('bientôt', 'soon', 'byan-toh'),
  W("aujourd'hui", 'today', 'oh-zhoor-dwee'),
  W('demain', 'tomorrow', 'duh-man'),
  W('hier', 'yesterday', 'yair'),
  W('ce soir', 'tonight', 'suh swar'),
  W('là', 'there', 'lah'),
  W('plus', 'more', 'plüs'),
  W('moins', 'less', 'mwan'),
  W('mieux', 'better', 'myuh'),
  W('pire', 'worse', 'peer'),
  W('bien sûr', 'of course', 'byan sür'),
  W("d'accord", 'okay / agreed', 'da-kor'),
  W('pas du tout', 'not at all', 'pah dü too'),
  // pronouns and quantifiers
  W('tout', 'everything / all', 'too'),
  W('rien', 'nothing', 'ryan'),
  W('quelque chose', 'something', 'kel-kuh shohz'),
  W("quelqu'un", 'someone', 'kel-kuhn'),
  W('tout le monde', 'everyone', 'too luh mond'),
  W('même', 'same / even', 'mem'),
  W('autre', 'other', 'oh-tr'),
  W('ça', 'that / this', 'sa'),
  // prepositions
  W('dans', 'in', 'dahn'),
  W('sur', 'on', 'sür'),
  W('entre', 'between', 'ahn-tr'),
  W('après', 'after', 'ah-preh'),
  W('avant', 'before', 'ah-vahn'),
  W('pendant', 'during', 'pahn-dahn'),
  W('depuis', 'since', 'duh-pwee'),
  // nouns
  W('le temps', 'time / the weather', 'luh tahn'),
  W('la vie', 'life', 'lah vee'),
  W('le monde', 'the world', 'luh mond'),
  W('la maison', 'the house / home', 'lah may-zon'),
  W('le travail', 'work', 'luh tra-vye'),
  W('la chose', 'the thing', 'lah shohz'),
  W('le jour', 'the day', 'luh zhoor'),
  W('la semaine', 'the week', 'lah suh-men'),
  W("l'année", 'the year', 'lah-nay'),
  W("l'ami", 'the friend', 'lah-mee'),
  W('la famille', 'the family', 'lah fa-mee'),
  W('la ville', 'the city', 'lah veel'),
  W('la fin', 'the end', 'lah fan'),
  W('la raison', 'the reason', 'lah ray-zon'),
  W('le moment', 'the moment', 'luh mo-mahn'),
  W('la chance', 'luck', 'lah shahns'),
  W("l'histoire", 'the story / history', 'lees-twar'),
  W('la musique', 'music', 'lah mü-zeek'),
  W('le chat', 'the cat', 'luh sha'),
  W('le chien', 'the dog', 'luh shyan'),
  W("l'école", 'school', 'lay-kol'),
  // adjectives
  W('bon', 'good', 'bon'),
  W('mauvais', 'bad', 'mo-veh'),
  W('grand', 'big / tall', 'grahn'),
  W('petit', 'small', 'puh-tee'),
  W('nouveau', 'new', 'noo-voh'),
  W('vieux', 'old', 'vyuh'),
  W('jeune', 'young', 'zhuhn'),
  W('beau', 'beautiful', 'boh'),
  W('vrai', 'true', 'vray'),
  W('faux', 'false / fake', 'foh'),
  W('facile', 'easy', 'fa-seel'),
  W('fort', 'strong', 'for'),
  W('long', 'long', 'lon'),
  W('chaud', 'hot', 'shoh'),
  W('froid', 'cold', 'frwah'),
  W('heureux', 'happy', 'uh-ruh'),
  W('triste', 'sad', 'treest'),
  W('libre', 'free', 'lee-br'),
  W('sûr', 'sure', 'sür'),
  W('simple', 'simple', 'san-pl'),
  W('intéressant', 'interesting', 'an-tay-reh-sahn'),
  W('incroyable', 'incredible', 'an-krwa-ya-bl'),
  W('parfait', 'perfect', 'par-feh'),
  W('terrible', 'terrible', 'teh-ree-bl'),
  W('excellent', 'excellent', 'ek-seh-lahn'),
  W('différent', 'different', 'dee-fay-rahn'),
  W('normal', 'normal', 'nor-mal'),
  W('rapide', 'fast', 'ra-peed'),
  W('dernier', 'last', 'dair-nyay'),
  W('premier', 'first', 'pruh-myay'),
  W('prochain', 'next', 'pro-shan'),
  W('seul', 'alone / only', 'suhl'),
  W('gratuit', 'free (no cost)', 'gra-twee'),
  W('sérieux', 'serious', 'say-ryuh'),
  W('drôle', 'funny', 'drohl'),
  W('fou', 'crazy', 'foo'),
  W('génial', 'great / brilliant', 'zhay-nyal'),
  W('impossible', 'impossible', 'an-po-see-bl'),
  // fixed phrases and greetings
  W("c'est", "it's / this is", 'seh'),
  W('il y a', 'there is / there are', 'eel ee ah'),
  W('je pense que', 'I think that', 'zhuh pahns kuh'),
  W('il faut', 'you have to / we need', 'eel foh'),
  W("j'aime", 'I love / I like', 'zhem'),
  W('je sais', 'I know', 'zhuh seh'),
  W('je ne sais pas', "I don't know", 'zhuh nuh seh pah'),
  W("s'il vous plaît", 'please', 'seel voo pleh'),
  W('bonjour', 'hello', 'bon-zhoor'),
  W('désolé', 'sorry', 'day-zo-lay'),
  W('ça va', "it's fine / how's it going", 'sa va'),
];

export const L2_WORDS = [...L1_WORDS, ...L2_EXTRA];

export function wordsForLevel(level) {
  return level <= 1 ? L1_WORDS : L2_WORDS;
}

// "très", "tres", "Très " and "l’idée" all map to the same entry.
export function normalizeFr(s) {
  return String(s)
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[’‘`]/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
}

// The fold for a language's folded index: its profile's script.fold spellings (German: "schön" and "schoen" -> "schoen",
// while "schon" stays apart) in place of accent stripping, else normalizeFr.
export function foldFor(profile) {
  const pairs = Object.entries(profile?.script?.fold || {});
  if (!pairs.length) return normalizeFr;
  return (s) => pairs.reduce((text, [letter, plain]) => text.split(letter).join(plain), exactFr(s));
}

// Article patterns from the language profile (French: le, la, les, un, une, des, l'); the bundled lists are French.
const FRENCH_PROFILE = profileFor('French');
const FRENCH = articlePatterns(FRENCH_PROFILE);
const articlesFor = (language) => (!language || language === 'French' ? FRENCH : articlePatterns(profileFor(language)));
export const exactFr = (s) => String(s).normalize('NFC').toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim();

const indexCache = new Map();
function indexFor(level, sharedWords, articles = FRENCH, fold = normalizeFr) {
  const lvl = level <= 1 ? 1 : 2;
  if (!sharedWords && indexCache.has(lvl)) return indexCache.get(lvl);
  const idx = new Map();
  for (const w of sharedWords || wordsForLevel(lvl)) {
    const full = exactFr(w.fr);
    idx.set(full, { canon: w.fr, en: w.en, hint: w.hint, word: w.fr, status: w.status });
    const stripped = articles.any ? full.replace(articles.any, '') : full;
    if (stripped !== full && !idx.has(stripped)) {
      // Accept the bare noun ("problème" for "problem") and keep the accents from the list.
      const canon = w.fr.replace(articles.any, '');
      const hint = articles.elided?.test(full) ? (articles.elidedHint ? w.hint.replace(articles.elidedHint, '') : w.hint)
        : articles.hint ? w.hint.replace(articles.hint, '') : w.hint;
      idx.set(stripped, { canon, en: w.en.replace(/^the /, ''), hint, word: w.fr, status: w.status });
    }
  }
  const folded = new Map();
  for (const [key, value] of idx) {
    const k = fold(key);
    folded.set(k, folded.has(k) ? null : value);
  }
  const result = { exact: idx, folded };
  if (!sharedWords) indexCache.set(lvl, result);
  return result;
}

// "I" is written with a capital anywhere in a sentence, so it says nothing about the swap's case: "I think" stays
// je pense que here, and applySwaps (text.js) capitalizes it where the swap starts a sentence.
const PRONOUN_I = /^I(?!\p{L})/u;

export function matchCase(fr, original) {
  if (/^\p{Lu}/u.test(original) && !/^\p{Lu}{2}/u.test(original) && !PRONOUN_I.test(original)) {
    return fr.charAt(0).toUpperCase() + fr.slice(1);
  }
  return fr;
}

// The English a swap replaces must be one of the word's glosses, or a plain inflection of one, so a model
// slip like "to start" -> donc is dropped instead of shown.
const EN_LEAD_RE = /^(?:the|a|an|to)\s+/;
const cleanEn = (s) => String(s).toLowerCase().replace(/[’‘`]/g, "'").replace(/\(.*?\)/g, ' ')
  .replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();

// Everyday English variants of a gloss, including the synonyms the prompt itself asks the model to use
// (the profile's synonym examples: "big"/"large"/"huge" -> grand, "other"/"another"/"else" -> autre, "I think" -> je
// pense que, ...). English only, so shared by every language; a profile can add more (extension.synonyms).
export const SYNONYMS = {
  big: ['large', 'huge'],
  only: ['single'],
  other: ['another', 'else'],
  'i think that': ['i think'],
  okay: ['ok'],
  'thank you': ['thanks'],
  'a little': ['a bit', 'a little bit'],
  'a lot': ['lots', 'a lot of', 'lots of', 'much', 'so much'],
  maybe: ['perhaps', 'possibly'],
  also: ['too', 'as well'],
  'too much': ['too', 'too many'],
  difficult: ['hard'],
  actually: ['in fact'],
  but: ['however'],
  'there is': ["there's", 'there are'],
  'there are': ["there's", 'there is'],
  "it's": ['it is', 'this is', "that's", 'that is'],
  'this is': ["it's", 'it is', "that's", 'that is'],
  hello: ['hi'],
};

function mergeSynonyms(base, extra) {
  const out = { ...base };
  for (const [k, v] of Object.entries(extra)) out[k.toLowerCase()] = [...(out[k.toLowerCase()] || []), ...v];
  return out;
}

const SUFFIXES = [['ies', 'y'], ['es', ''], ['s', ''], ['ed', ''], ['ed', 'e'], ['ing', ''], ['ing', 'e']];

// How the English matches a gloss: 'exact' (a gloss or a synonym), 'plural' (a gloss that is not a verb, plus -s, -es
// or -ies: "problems" for "the problem"), 'inflected' (a verb gloss with an ending: "starts", "started", "starting"
// for "to start"), or '' for no match.
export function glossMatch(original, en, synonyms = SYNONYMS) {
  const { forms, verbs } = glossForms(en, synonyms);
  const t = cleanEn(original);
  if (!t) return '';
  let found = '';
  for (const c of new Set([t, t.replace(EN_LEAD_RE, '')])) {
    if (forms.has(c)) return 'exact';
    for (const [suffix, stem] of SUFFIXES) {
      const base = c.slice(0, -suffix.length) + stem;
      if (!c.endsWith(suffix) || !forms.has(base)) continue;
      if (suffix.endsWith('s') && !verbs.has(base)) found ||= 'plural';
      else found = 'inflected';
    }
  }
  return found;
}

// The English forms a gloss matches exactly (glosses, without a leading article or "to", and their synonyms); verbs:
// those from a "to ..." gloss, which take endings instead of a plural.
export function glossForms(en, synonyms = SYNONYMS) {
  const forms = new Set();
  const verbs = new Set();
  for (const alt of String(en).split(/\s*[/;,]\s*/)) {
    const g = cleanEn(alt);
    if (!g) continue;
    const verb = /^to\s/.test(g);
    for (const f of [g, g.replace(EN_LEAD_RE, '')]) {
      for (const form of [f, ...(synonyms[f] || [])]) {
        forms.add(form);
        if (verb) verbs.add(form);
      }
    }
  }
  return { forms, verbs };
}

// The forms glossMatch tries for some English: itself and without a leading article, each also with an ending
// taken off. A gloss can match only if one of these is among its glossForms.
export function matchKeys(original) {
  const t = cleanEn(original);
  const keys = new Set();
  for (const c of [t, t.replace(EN_LEAD_RE, '')]) {
    if (!c) continue;
    keys.add(c);
    for (const [suffix, stem] of SUFFIXES) if (c.endsWith(suffix)) keys.add(c.slice(0, -suffix.length) + stem);
  }
  return keys;
}

export function glossMatches(original, en, synonyms = SYNONYMS) {
  return !!glossMatch(original, en, synonyms);
}

// A plural English noun ("problems") must not show the singular list word (problème). The swap stays only when the
// list has the plural too: an entry glossed with exactly that English whose word starts like the singular one
// (les problèmes for le problème, problemi for problema).
function pluralEntry(idx, hit, o, synonyms, articles, fold) {
  const bare = (w) => fold(articles.any ? exactFr(w).replace(articles.any, '') : exactFr(w));
  const stem = bare(hit.canon).slice(0, -1);
  if (stem.length < 3) return null;
  for (const entry of idx.exact.values()) {
    if (entry !== hit && bare(entry.canon).startsWith(stem) && glossMatch(o, entry.en, synonyms) === 'exact') return entry;
  }
  return null;
}

// ALL-CAPS English is emphasis or an acronym ("ALL" meaning all of you, US, IT): a lower-case swap would drop the
// emphasis and often the sense, so it stays English. OK is written in capitals anyway.
export const allCaps = (o) => /\p{Lu}.*\p{Lu}/su.test(o) && !/\p{Ll}/u.test(o) && !/^O\.?K\.?$/.test(o);

// Model output sometimes spells accents as HTML entities (tr&#232;s, le probl&egrave;me). Decode them before the
// list lookup; named accents are built from the letter and a combining mark, so any Latin-script language works.
const MARKS = { acute: '\u0301', grave: '\u0300', circ: '\u0302', uml: '\u0308', tilde: '\u0303', cedil: '\u0327', ring: '\u030A', caron: '\u030C' };
const NAMED = { amp: '&', quot: '"', apos: "'", lt: '<', gt: '>', nbsp: ' ', rsquo: '’', lsquo: '‘', ldquo: '“', rdquo: '”',
  szlig: 'ß', oelig: 'œ', OElig: 'Œ', aelig: 'æ', AElig: 'Æ', oslash: 'ø', Oslash: 'Ø', laquo: '«', raquo: '»',
  iexcl: '¡', iquest: '¿', ordf: 'ª', ordm: 'º', hellip: '…', ndash: '–', mdash: '—' };
export function decodeEntities(s) {
  return String(s).replace(/&(?:#(\d{1,7})|#x([\da-f]{1,6})|([a-z]+));/gi, (m, dec, hex, name) => {
    if (dec || hex) {
      const cp = parseInt(dec || hex, dec ? 10 : 16);
      return cp > 0 && cp <= 0x10ffff && (cp < 0xd800 || cp > 0xdfff) ? String.fromCodePoint(cp) : m;
    }
    if (Object.hasOwn(NAMED, name)) return NAMED[name];
    const accent = /^([a-z])(acute|grave|circ|uml|tilde|cedil|ring|caron)$/i.exec(name);
    return accent ? accent[1] + MARKS[accent[2]] : m;
  }).normalize('NFC');
}

// Still broken after decoding, so the swap is dropped and counted: an unknown entity, a control character or
// replacement mark (raw bytes, tr\x80), an escape written out, or UTF-8 read as Latin-1 (trÃ¨s).
const MALFORMED = /&#?[a-z\d]+;|[\u0000-\u001f\u007f-\u009f\ufffd]|\\(?:x[\da-f]{2}|u[\da-f]{4})|[ÃÂ][\u0080-\u00bf]/i;
export const malformed = (s) => MALFORMED.test(s);

// English never-split rules (data/profiles/_generic.json "english", documented in data/profiles/README.md): English is
// the source in every language, so one small list keeps swaps out of fixed phrases whose meaning differs ("right now",
// "might as well"), off a dangling "of" ("beaucoup of", "porque of"), off "before"/"after" + clause, "it's" meaning
// "it has", and filler "like".
const tokenize = (s) => [...String(s).replace(/[’‘`]/g, "'").toLowerCase()
  .matchAll(/[\p{L}\p{N}]+(?:'[\p{L}\p{N}]+)*|[^\s\p{L}\p{N}]/gu)].map((m) => m[0]);

function tokenTest(src) {
  const optional = src.length > 1 && src.endsWith('?');
  const alts = (optional ? src.slice(0, -1) : src).split('|');
  const test = (tok) => tok !== undefined && alts.some((a) => (a === '#' ? /^\p{N}/u.test(tok)
    : a.length > 1 && a.startsWith('*') ? /^\p{L}/u.test(tok) && tok.length > a.length + 1 && tok.endsWith(a.slice(1))
      : a === tok));
  return { optional, test };
}

export function compileEnglish(english = {}) {
  const phrases = (english.phrases || []).map(tokenize);
  const contexts = (english.contexts || []).map((pattern) => {
    const parts = pattern.trim().split(/\s+/);
    const at = parts.findIndex((p) => /^\[.+\]$/.test(p));
    const target = parts[at].slice(1, -1);
    return {
      target: target === '*' ? null : target.split('|').map((t) => tokenize(t).join(' ')),
      before: parts.slice(0, at).reverse().map(tokenTest),
      after: parts.slice(at + 1).map(tokenTest),
    };
  });
  return { phrases, contexts };
}
const ENGLISH = compileEnglish(GENERIC.english);

function seq(tests, toks, pos, dir) {
  if (!tests.length) return true;
  const [t, ...rest] = tests;
  if (t.test(toks[pos]) && seq(rest, toks, pos + dir, dir)) return true;
  return t.optional && seq(rest, toks, pos, dir);
}

const find = (toks, part, from = 0, to = toks.length) => {
  const out = [];
  for (let i = from; part.length && i + part.length <= to; i++) if (part.every((t, k) => toks[i + k] === t)) out.push(i);
  return out;
};

// Why a swap of English o (into f) at tokens [s, e) breaks the English around it, or ''.
function splitAt(toks, s, e, f, rules) {
  const o = toks.slice(s, e).join(' ');
  for (const phrase of rules.phrases) {
    for (const p of find(toks, phrase)) {
      const end = p + phrase.length;
      if (s < end && p < e && !(s <= p && e >= end)) return `phrase "${phrase.join(' ')}"`;
    }
  }
  for (const c of rules.contexts) {
    if ((!c.target || c.target.includes(o)) && seq(c.before, toks, s - 1, -1) && seq(c.after, toks, e, 1)) return 'context';
  }
  // "there is a growing gap" -> "il y a a growing gap": the replacement ends with the next English word.
  const ft = tokenize(f);
  if (ft.length && (ft.at(-1) === toks[e] || ft[0] === toks[s - 1])) return 'repeat';
  return '';
}

// The swap's place in the passage (text; ctx narrows it, as text.js locate does), checked against the rules. With no
// text, ctx stands in. A swap that can't be found is left to the page, which won't place it.
export function breaksEnglish(o, f, ctx = '', text = '', rules = ENGLISH) {
  const toks = tokenize(text || ctx);
  const ot = tokenize(o);
  let starts = find(toks, ot);
  const ct = text && ctx ? tokenize(ctx) : [];
  const around = ct.length >= ot.length ? find(toks, ct) : [];
  if (around.length === 1) {
    const inside = find(toks, ot, around[0], around[0] + ct.length);
    if (inside.length) starts = inside;
  }
  for (const s of starts) {
    const why = splitAt(toks, s, s + ot.length, f, rules);
    if (why) return why;
  }
  return '';
}

// The same check for the English at characters [from, to) of text, for code that knows the exact place (candidates.js).
export function breaksEnglishAt(text, from, to, f, rules = ENGLISH) {
  const s = tokenize(String(text).slice(0, from)).length;
  return splitAt(tokenize(text), s, s + tokenize(String(text).slice(from, to)).length, f, rules);
}

// The index of a word state's list, built once per list and language: candidates.js validates each candidate on its
// own, and a 1,000-word list took about 1 ms to index each time. Word states come fresh from storage per batch.
const sharedIndexes = new WeakMap();
function sharedIndex(words, lang, build) {
  const byLang = sharedIndexes.get(words) || new Map();
  sharedIndexes.set(words, byLang);
  if (!byLang.has(lang)) byLang.set(lang, build());
  return byLang.get(lang);
}

// Fail closed: keep only swaps whose French is on the list (the plugin's word state, else the level's bundled list)
// and whose English matches that word's gloss.
// Canonicalizes accents, fills gloss and hint from the list, matches capitalization of the original.
// language: the word state's language (its profile gives the articles and extra synonyms); bundled lists are French.
// stats: an optional object that counts dropped swaps by reason (malformed, allCaps, notListed, gloss, plural, idiom).
// text: the passage, for the English never-split rules (ctx stands in without it).
export function validateSwaps(level, swaps, sharedWords, language = 'French', { stats = null, text = '' } = {}) {
  if (!Array.isArray(swaps)) return [];
  const lang = sharedWords ? language || 'French' : 'French';
  const articles = articlesFor(lang);
  const prof = lang === 'French' ? null : profileFor(lang);
  const extra = prof ? prof.extension.synonyms : null;
  const fold = prof ? foldFor(prof) : normalizeFr;
  const synonyms = extra && Object.keys(extra).length ? mergeSynonyms(SYNONYMS, extra) : SYNONYMS;
  const idx = sharedWords ? sharedIndex(sharedWords, lang, () => indexFor(level, sharedWords, articles, fold)) : indexFor(level, sharedWords, articles, fold);
  const out = [];
  const drop = (reason) => { if (stats) stats[reason] = (stats[reason] || 0) + 1; };
  for (const s of swaps) {
    if (!s || typeof s.o !== 'string' || typeof s.f !== 'string') { drop('malformed'); continue; }
    const o = decodeEntities(s.o).trim();
    const f = decodeEntities(s.f).trim();
    if (!o || !f) { drop('malformed'); continue; }
    if (malformed(o) || malformed(f)) { drop('malformed'); continue; }
    if (allCaps(o)) { drop('allCaps'); continue; }
    let hit = idx.exact.get(exactFr(f)) || idx.folded.get(fold(f));
    if (!hit) { drop('notListed'); continue; }
    const match = glossMatch(o, hit.en, synonyms);
    if (!match) { drop('gloss'); continue; }
    if (match === 'plural' && (prof || FRENCH_PROFILE).plural_nouns) {
      hit = pluralEntry(idx, hit, o, synonyms, articles, fold);
      if (!hit) { drop('plural'); continue; }
    }
    // "my problem" -> "my le problème", "the answer" -> "the la réponse": when the English article (or a
    // possessive) stays outside the swap, use the bare noun.
    const bare = articles.definite ? exactFr(hit.canon).replace(articles.definite, '') : exactFr(hit.canon);
    if (bare !== exactFr(hit.canon) && !/^the\s/i.test(o) && idx.exact.has(bare)) hit = idx.exact.get(bare);
    const ctx = typeof s.ctx === 'string' ? decodeEntities(s.ctx).trim() : '';
    if (breaksEnglish(o, hit.canon, ctx, text)) { drop('idiom'); continue; }
    out.push({
      o,
      f: matchCase(hit.canon, o),
      g: hit.en,
      h: hit.hint,
      ctx,
      ...(sharedWords ? { word: hit.word, ...(hit.status ? { status: hit.status } : {}) } : {}),
    });
  }
  return out;
}

export function sentenceCount(text) {
  return Math.max(1, String(text).split(/[.!?…]+(?:\s|$)|\n+/).filter((s) => wordCount(s) >= 3).length);
}

// Density ceiling per passage (swaps per sentence by level), one use per French word, learning words
// (active/shaky) kept before known ones.
export const CAP_PER_SENTENCE = { 1: 1, 2: 2, 3: 3, 4: 4 };
export function capSwaps(level, swaps, text, sharedWords) {
  const max = CAP_PER_SENTENCE[Math.min(Math.max(Math.round(Number(level) || 1), 1), MAX_BUILT_LEVEL)] * sentenceCount(text);
  const status = new Map((sharedWords || []).map((w) => [w.fr, w.status]));
  const rank = (s) => (status.get(s.word) && status.get(s.word) !== 'known' ? 0 : 1);
  const used = new Set();
  const unique = swaps.filter((s) => { const k = exactFr(s.word || s.f); if (used.has(k)) return false; used.add(k); return true; });
  const keep = new Set([...unique].sort((a, b) => rank(a) - rank(b)).slice(0, max));
  return unique.filter((s) => keep.has(s));
}

export function wordCount(text) {
  const t = String(text).trim();
  return t ? t.split(/\s+/).length : 0;
}

// Small, conservative client-side guard for the zero-French topics. The model rule does the real work;
// this just guarantees the obvious cases never leave the page.
const ZERO_FRENCH = [
  /\b(doctor|hospital|diagnos\w*|symptoms?|medication|meds|ibuprofen|tylenol|prescription|overdose|vaccine|cancer|surgery|pregnan\w*|therapist|antidepressants?|ssri|adderall|stimulants?|chemo)\b/i,
  /\b(lawsuit|attorney|lawyer|sued|indict\w*|court order|legal advice|subpoena)\b/i,
  /\b(invest\w*|stock market|crypto|bitcoin|mortgage|loan|taxes|salary|bank account|financial advice)\b/i,
  // Funds and accounts people put money in (2026-10-16: "The best index funds to buy this year" leaked). Bare "funds"
  // and "retirement" stay out ("funds for open source", "the API's retirement"); IRA and ETF only in capitals (Ira).
  /\b((index|mutual|hedge|pension|retirement) funds?|funds to (buy|own)|retirement (savings|account|plan|income|age)|stocks|dividends?|401\(?k\)?|roth)\b/i,
  /\b(IRAs?|ETFs?)\b/,
  /\b(911|emergency|evacuat\w*|shooting|wildfire|earthquake|hurricane|tornado|active shooter)\b/i,
  /\b(driving|drunk driv\w*|car crash|dui|speed limit|seat ?belt)\b/i,
  // Road accidents ("Teen driver injured in crash on Route 9"). Bare "crash" and "driver" stay out ("the crash of a
  // program", "a driver update"): only injuries, collisions, a crash on a road or of a vehicle, and kinds of driver.
  /\b(injur(ed|ies|y)|collisions?|(car|bus|truck|plane|train|motorcycle|bike|highway|fatal|deadly|head-on|traffic) crash(es)?|crash(es|ed)? (on|near) (route|highway|interstate|i-\d+|us-\d+|hwy)|(teen|teenage|student|drunk|truck|bus|taxi|delivery|uber|lyft) drivers?|hit-and-run)\b/i,
];

export function isZeroFrench(text) {
  return ZERO_FRENCH.some((re) => re.test(text));
}
