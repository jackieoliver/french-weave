// No-key mode: swaps from a fixed list, with no model, for when there is no Gemini key. Only invariable words whose
// French doesn't depend on context (connectors, adverbs, a few prepositions and pronouns, two set phrases), each with
// the neighbouring English words that would make it wrong ("because of" is à cause de, not parce que). Words with a
// second sense (so, for, in, like, well, here, still, now, only, since, when) are left out. Pure: no DOM, no chrome APIs.
import { wordsForLevel, capSwaps, exactFr, isZeroFrench, matchCase } from './levels.js';
import { locate } from './text.js';

// forms: the English it replaces (lowercase). skipBefore / skipAfter: the word right before or after it (only spaces
// between) that changes its sense.
const L = (fr, forms, skip = {}) => ({ fr, forms, skipBefore: skip.before || [], skipAfter: skip.after || [] });
export const LOCAL_WORDS = [
  L('et', ['and']),
  L('mais', ['but'], { before: ['all', 'nothing', 'anything', 'none', 'everyone', 'everybody', 'everything', 'anyone',
    'anybody', 'nobody', 'help'], after: ['for'] }), // "all but one", "can't help but", "but for": except
  L('ou', ['or'], { after: ['so'] }), // "ten or so"
  L('parce que', ['because'], { after: ['of'] }), // "because of" is à cause de
  L('avec', ['with'], { before: ['deal', 'deals', 'dealt', 'dealing', 'cope', 'copes', 'coping', 'filled', 'covered',
    'packed', 'provided', 'fed', 'pace', 'happy', 'pleased', 'satisfied', 'content', 'synonymous', 'case', 'start', 'starts',
    'started', 'starting', 'begin', 'begins', 'began', 'beginning'], after: ['respect', 'regard', 'regards', 'no'] }),
    // French says de, par or sans there ("filled with", "starts with", "with no")
  L('sans', ['without']),
  L('très', ['very'], { before: ['the', 'this', 'that', 'these', 'those', 'a', 'my', 'your', 'his', 'her', 'its', 'our',
    'their'], after: ['much', 'many', 'least', 'most', 'own', 'same', 'first', 'last'] }), // "the very end", "very much"
  L('aussi', ['also']),
  L('toujours', ['always']),
  L('peut-être', ['maybe']),
  L('oui', ['yes']),
  L('jamais', ['never'], { after: ['mind'] }),
  L('déjà', ['already']),
  L('souvent', ['often']),
  L('parfois', ['sometimes']),
  L('vraiment', ['really']),
  L('presque', ['almost']),
  L('surtout', ['especially']),
  L('ensemble', ['together']),
  L("aujourd'hui", ['today']),
  L('demain', ['tomorrow']),
  L('hier', ['yesterday']),
  L('ce soir', ['tonight']),
  L('pourquoi', ['why']),
  L('bientôt', ['soon'], { before: ['as', 'how', 'so', 'too', 'very'], after: ['as', 'after', 'enough'] }), // "too soon" is trop tôt
  L('qui', ['who']),
  L('rien', ['nothing']),
  L('quelque chose', ['something']),
  L("quelqu'un", ['someone', 'somebody']),
  L('tout le monde', ['everyone', 'everybody']),
  L('pendant', ['during']),
  L('entre', ['between']),
  L('contre', ['against']), // not in the built-in lists: only with the plugin's words
  L('par exemple', ['for example']),
  L('bien sûr', ['of course'], { before: ['change', 'matter', 'part'] }), // "a change of course"
];

// Without a model nothing judges the topic, so this guard is wider than isZeroFrench: crime, death, accidents, money
// and insurance too. A passage it catches just stays English, and so does every passage on a page whose title it
// catches ("It's crazy how dangerous driving is"), since one passage alone may not name its topic.
const LOCAL_ZERO_FRENCH = [
  /\b(health|medical|medicine|disease|illness|mortality|deaths?|died|dying|suicid\w*|patients?|clinic\w*|nurses?|drugs?|alcohol|anxiety|depress\w*|injur\w*|pain|covid|virus|pandemic)\b/i,
  /\b(crimes?|criminal|murders?|homicide|violen\w*|theft|robbery|assault|police|cops?|fbi|arrest\w*|prison|jail|guns?|killed|kill|weapons?|terror\w*|abuse\w*)\b/i,
  /\b(court|judge|legal|illegal|law|laws|sue|suing|crash\w*|accidents?|dangerous|unsafe|drove|reckless)\b/i,
  /\b(money|insurance|insur\w*|invest\w*|retire\w*|pension|savings|debt|equity|loans?|dollars?|bank\w*|financ\w*|price[sd]?|paid|pay|pays|cost|costs|tax\w*)\b/i,
  /[$€£¥]\s?\d/,
];
export const localOff = (text) => isZeroFrench(text) || LOCAL_ZERO_FRENCH.some((re) => re.test(text));

const WORD_CHAR = /[\p{L}\p{N}_]/u;
const SMALL = new Set(['the', 'a', 'an', 'of']);
const wordBefore = (text, i) => /([\p{L}\p{N}_'’-]+) +$/u.exec(text.slice(Math.max(0, i - 40), i))?.[1] || '';
const wordAfter = (text, i) => /^ +([\p{L}\p{N}_'’-]+)/u.exec(text.slice(i, i + 40))?.[1] || '';
const capitalized = (w) => /^\p{Lu}/u.test(w) && w !== 'I';
// Start of a sentence (or after a colon), past any opening quote or bracket.
const sentenceStart = (text, i) => /(?:^|[.!?…:]) *["“‘'(\[]*$/u.test(text.slice(Math.max(0, i - 6), i));

// Whole-word matches, with the same rule as text.js: a contraction or hyphenated compound is one word ("today's").
function occurrences(text, form) {
  const out = [];
  const lower = text.toLowerCase();
  for (let i = lower.indexOf(form); i !== -1; i = lower.indexOf(form, i + 1)) {
    const end = i + form.length;
    const before = text[i - 1] ?? '';
    const after = text[end] ?? '';
    if (WORD_CHAR.test(before) || WORD_CHAR.test(after)) continue;
    if (/['’-]/.test(after) && WORD_CHAR.test(text[end + 1] ?? '')) continue;
    if (/['’-]/.test(before) && WORD_CHAR.test(text[i - 2] ?? '')) continue;
    if (before === '/' || after === '/') continue; // "and/or", "yes/no"
    out.push({ start: i, end });
  }
  return out;
}

// Inside quotation marks: a title ("going out with a whimper") can't be told from quoted speech, so neither is touched.
// A ’ between two letters is an apostrophe, not a closing quote.
function quoted(text, i) {
  const before = text.slice(0, i);
  if ((before.match(/"/g) || []).length % 2) return true;
  if (before.lastIndexOf('“') > before.lastIndexOf('”')) return true;
  const open = before.lastIndexOf('‘');
  return open !== -1 && !/’(?![\p{L}])|(?<![\p{L}])’/u.test(before.slice(open + 1));
}

// Names and titles keep their English: "Simon and Garfunkel", "Gone with the Wind", "Always Sunny".
function nameOrTitle(text, m, o) {
  if (/^\p{Lu}{2}/u.test(o)) return true; // capitals: a heading, an acronym
  if (capitalized(o) && !sentenceStart(text, m.start)) return true;
  const [next1, next2] = text.slice(m.end).trimStart().split(' ', 2);
  if (capitalized(o) && capitalized(next1 || '') && capitalized(next2 || '')) return true; // "Nothing Is Better Than This"
  const prev = wordBefore(text, m.start);
  let next = wordAfter(text, m.end);
  for (let at = m.end; next && SMALL.has(next.toLowerCase());) {
    at = text.indexOf(next, at) + next.length;
    next = wordAfter(text, at);
  }
  return capitalized(prev) && capitalized(next);
}

// The shortest run of whole words around the match that locate() in text.js finds again at the same place.
function contextFor(text, m, o) {
  const words = [...text.matchAll(/\S+/g)].map((w) => ({ start: w.index, end: w.index + w[0].length }));
  const first = words.findIndex((w) => w.end > m.start);
  let last = first;
  while (last + 1 < words.length && words[last].end < m.end) last++;
  for (let k = 1; k <= 8; k++) {
    const a = words[Math.max(0, first - k)].start;
    const b = words[Math.min(words.length - 1, last + k)].end;
    const ctx = text.slice(a, b);
    if (locate({ text }, o, ctx)?.start === m.start) return ctx;
  }
  return null;
}

function sentences(text) {
  const out = [];
  let start = 0;
  for (const m of text.matchAll(/[.!?…]+(?= |$)/g)) {
    out.push({ start, end: m.index + m[0].length });
    start = m.index + m[0].length;
  }
  if (start < text.length) out.push({ start, end: text.length });
  return out;
}

// The words this tier may use: with the plugin's French word state, the ones in it (its glosses, hints and statuses);
// otherwise the ones on the level's built-in list. Another language has no fixed list: nothing.
export function localVocabulary(level, sharedWords, language = 'French') {
  if (sharedWords?.length && language !== 'French') return [];
  const source = new Map((sharedWords?.length ? sharedWords : wordsForLevel(level)).map((w) => [exactFr(w.fr), w]));
  return LOCAL_WORDS.filter((w) => source.has(exactFr(w.fr))).map((w) => ({ ...w, ...source.get(exactFr(w.fr)), fr: w.fr }));
}

// Swaps for one passage in the shape validateSwaps returns, capped like the model's: per level, at most one per
// sentence at level 1 and two at level 2, each French word once, learning words before known ones.
export function localSwaps(level, text, sharedWords, language = 'French') {
  if (typeof text !== 'string' || localOff(text)) return [];
  const shared = !!sharedWords?.length;
  const vocabulary = localVocabulary(level, sharedWords, language);
  const candidates = [];
  for (const w of vocabulary) {
    for (const form of w.forms) {
      for (const m of occurrences(text, form)) {
        const o = text.slice(m.start, m.end);
        if (w.skipBefore.includes(wordBefore(text, m.start).toLowerCase())) continue;
        if (w.skipAfter.includes(wordAfter(text, m.end).toLowerCase())) continue;
        if (nameOrTitle(text, m, o) || quoted(text, m.start)) continue;
        // "more and more", "over and over": de plus en plus, encore et encore
        if (['et', 'ou'].includes(w.fr) && wordBefore(text, m.start).toLowerCase() === wordAfter(text, m.end).toLowerCase() &&
          wordBefore(text, m.start)) continue;
        // Learning words first; "and" and "or" are everywhere, so they only fill what's left.
        const rank = (shared && w.status !== 'known' ? 0 : 2) + (['et', 'ou'].includes(w.fr) ? 1 : 0);
        candidates.push({ w, m, o, rank });
      }
    }
  }
  const perSentence = level <= 1 ? 1 : 2;
  const used = new Set();
  const swaps = [];
  for (const s of sentences(text)) {
    const here = candidates.filter((c) => c.m.start >= s.start && c.m.end <= s.end)
      .sort((a, b) => a.rank - b.rank || a.m.start - b.m.start);
    let placed = [];
    for (const c of here) {
      if (placed.length >= perSentence || used.has(c.w.fr) || placed.some((p) => c.m.start < p.m.end && p.m.start < c.m.end)) continue;
      const ctx = contextFor(text, c.m, c.o);
      if (ctx === null) continue;
      used.add(c.w.fr);
      placed.push({ ...c, ctx });
    }
    placed = placed.sort((a, b) => a.m.start - b.m.start);
    for (const c of placed) {
      swaps.push({ o: c.o, f: matchCase(c.w.fr, c.o), g: c.w.en, h: c.w.hint || '', ctx: c.ctx,
        ...(shared ? { word: c.w.fr, ...(c.w.status ? { status: c.w.status } : {}) } : {}) });
    }
  }
  return capSwaps(level, swaps, text, sharedWords);
}
