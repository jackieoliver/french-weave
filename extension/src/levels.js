// Level schedule, word lists, and guards. Pure: no DOM, no chrome APIs.

// L3/L4 prompts are not built yet; anything above this uses L2 rules.
export const MAX_BUILT_LEVEL = 2;

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

const ARTICLE_RE = /^(?:(?:les|le|la|une|un|des)\s+|l')/i;
const DEFINITE_RE = /^(?:(?:les|le|la)\s+|l')/i;
export const exactFr = (s) => String(s).normalize('NFC').toLowerCase().replace(/[’‘`]/g, "'").replace(/\s+/g, ' ').trim();

const indexCache = new Map();
function indexFor(level, sharedWords) {
  const lvl = level <= 1 ? 1 : 2;
  if (!sharedWords && indexCache.has(lvl)) return indexCache.get(lvl);
  const idx = new Map();
  for (const w of sharedWords || wordsForLevel(lvl)) {
    const full = exactFr(w.fr);
    idx.set(full, { canon: w.fr, en: w.en, hint: w.hint, word: w.fr, status: w.status });
    const stripped = full.replace(ARTICLE_RE, '');
    if (stripped !== full && !idx.has(stripped)) {
      // Accept the bare noun ("problème" for "problem") and keep the accents from the list.
      const canon = w.fr.replace(ARTICLE_RE, '');
      idx.set(stripped, { canon, en: w.en.replace(/^the /, ''), hint: w.hint.replace(/^(luh|lah|lay|lee|uhn|ün) /, ''), word: w.fr, status: w.status });
    }
  }
  const folded = new Map();
  for (const [key, value] of idx) {
    const fold = normalizeFr(key);
    folded.set(fold, folded.has(fold) ? null : value);
  }
  const result = { exact: idx, folded };
  if (!sharedWords) indexCache.set(lvl, result);
  return result;
}

export function matchCase(fr, original) {
  if (/^\p{Lu}/u.test(original) && !/^\p{Lu}{2}/u.test(original)) {
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
// (prompt.js: "big"/"large"/"huge" -> grand, "other"/"another"/"else" -> autre, "I think" -> je pense que, ...).
const SYNONYMS = {
  big: ['large', 'huge'],
  only: ['single'],
  other: ['another', 'else'],
  'i think that': ['i think'],
  okay: ['ok'],
  'thank you': ['thanks'],
  'a little': ['a bit', 'a little bit'],
  'a lot': ['lots', 'a lot of', 'lots of', 'much', 'so much'],
  maybe: ['perhaps'],
  'there is': ["there's", 'there are'],
  'there are': ["there's", 'there is'],
  "it's": ['it is', 'this is', "that's", 'that is'],
  'this is': ["it's", 'it is', "that's", 'that is'],
  hello: ['hi'],
};

export function glossMatches(original, en) {
  const forms = new Set();
  for (const alt of String(en).split(/\s*[/;,]\s*/)) {
    const g = cleanEn(alt);
    if (!g) continue;
    for (const f of [g, g.replace(EN_LEAD_RE, '')]) {
      forms.add(f);
      for (const syn of SYNONYMS[f] || []) forms.add(syn);
    }
  }
  const t = cleanEn(original);
  if (!t) return false;
  for (const c of new Set([t, t.replace(EN_LEAD_RE, '')])) {
    if (forms.has(c)) return true;
    for (const [suffix, stem] of [['ies', 'y'], ['es', ''], ['s', ''], ['ed', ''], ['ed', 'e'], ['ing', ''], ['ing', 'e']]) {
      if (c.endsWith(suffix) && forms.has(c.slice(0, -suffix.length) + stem)) return true;
    }
  }
  return false;
}

// Fail closed: keep only swaps whose French is on the list (the plugin's word state, else the level's bundled list)
// and whose English matches that word's gloss.
// Canonicalizes accents, fills gloss and hint from the list, matches capitalization of the original.
export function validateSwaps(level, swaps, sharedWords) {
  if (!Array.isArray(swaps)) return [];
  const idx = indexFor(level, sharedWords);
  const out = [];
  for (const s of swaps) {
    if (!s || typeof s.o !== 'string' || typeof s.f !== 'string') continue;
    const o = s.o.trim();
    if (!o || !s.f.trim()) continue;
    let hit = idx.exact.get(exactFr(s.f)) || idx.folded.get(normalizeFr(s.f));
    if (!hit || !glossMatches(o, hit.en)) continue;
    // "my problem" -> "my le problème", "the answer" -> "the la réponse": when the English article (or a
    // possessive) stays outside the swap, use the bare noun.
    const bare = exactFr(hit.canon).replace(DEFINITE_RE, '');
    if (bare !== exactFr(hit.canon) && !/^the\s/i.test(o) && idx.exact.has(bare)) hit = idx.exact.get(bare);
    out.push({
      o,
      f: matchCase(hit.canon, o),
      g: hit.en,
      h: hit.hint,
      ctx: typeof s.ctx === 'string' ? s.ctx.trim() : '',
      ...(sharedWords ? { word: hit.word, ...(hit.status ? { status: hit.status } : {}) } : {}),
    });
  }
  return out;
}

export function sentenceCount(text) {
  return Math.max(1, String(text).split(/[.!?…]+(?:\s|$)|\n+/).filter((s) => wordCount(s) >= 3).length);
}

// Density ceiling per passage, one use per French word, learning words (active/shaky) kept before known ones.
export function capSwaps(level, swaps, text, sharedWords) {
  const max = (level <= 1 ? 1 : 2) * sentenceCount(text);
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
  /\b(911|emergency|evacuat\w*|shooting|wildfire|earthquake|hurricane|tornado|active shooter)\b/i,
  /\b(driving|drunk driv\w*|car crash|dui|speed limit|seat ?belt)\b/i,
];

export function isZeroFrench(text) {
  return ZERO_FRENCH.some((re) => re.test(text));
}
