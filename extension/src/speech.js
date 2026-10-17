// Which of the browser's speech voices says the woven language, for the hover tip's speaker button. Pure: takes
// speechSynthesis.getVoices() and the language name from the word state ("French" unless setup chose another),
// so it tests without a browser. Names are matched through Intl, so any language setup accepts works without a table.

const dialect = new Intl.DisplayNames(['en'], { type: 'language' });
const standard = new Intl.DisplayNames(['en'], { type: 'language', languageDisplay: 'standard' });
const described = new Map(); // voice lang tag -> what it names, or null for a tag Intl can't read

function describe(lang) {
  const tag = String(lang || '').replace(/_/g, '-');
  if (described.has(tag)) return described.get(tag);
  let d = null;
  try {
    const locale = new Intl.Locale(tag);
    const base = locale.language;
    const lower = (names) => names.filter(Boolean).map((n) => n.toLowerCase());
    d = {
      regional: locale.region ? lower([dialect.of(tag), standard.of(tag)]) : [], // "canadian french", "french (canada)"
      names: lower([dialect.of(base), new Intl.DisplayNames([base], { type: 'language' }).of(base)]), // "indonesian", "indonesia"
      region: locale.region || '',
      home: new Intl.Locale(base).maximize().region || '', // FR for fr, ES for es, JP for ja
    };
  } catch { /* not a language tag */ }
  described.set(tag, d);
  return d;
}

// "French", "French (Canada)", "Mexican Spanish" or "Bahasa Indonesia" against what a voice's tag names.
const speaks = (d, want) => !!d && (d.regional.includes(want) || d.names.some((n) => want === n || want.endsWith(` ${n}`)));

// The voice to use, or null when none says the language (then the tip shows no speaker). Best first: a voice on
// this machine before an online one (Chrome's "Google" voices send the text to Google), always; the regional
// variant the setting names; the language's home region (fr-FR before fr-CA); the browser's default; list order.
export function voiceFor(voices, language = 'French') {
  const want = String(language || 'French').trim().toLowerCase();
  let best = null;
  let bestRank = null;
  for (const v of voices || []) {
    const d = describe(v?.lang);
    if (!speaks(d, want)) continue;
    const rank = [v.localService ? 0 : 1, d.regional.includes(want) ? 0 : 1, d.region && d.region === d.home ? 0 : 1, v.default ? 0 : 1];
    const i = bestRank ? rank.findIndex((r, k) => r !== bestRank[k]) : 0;
    if (!bestRank || (i >= 0 && rank[i] < bestRank[i])) { best = v; bestRank = rank; }
  }
  return best;
}
