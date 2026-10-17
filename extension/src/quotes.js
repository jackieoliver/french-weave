// Quoted text in a passage. A swap inside a quotation misquotes the source (a person's words, or UI text like
// 'Remote Control not started here'), so the candidates list and the validator keep every language's swaps out of it.
//
// Double quotes: straight "...", curly “...”, « ... », „...“ (or „...”), 「...」 and 『...』. A straight " right after
// a digit is an inch mark (a 12" screen), not a quote. A quote that never closes covers the whole passage when it
// opens the passage (a quotation running on over several paragraphs has an opening mark on each paragraph and one
// closing mark at the very end), and otherwise only the rest of its sentence (a lost closing mark).
// Single quotes count only when they clearly delimit a quotation: an opening ‘ or ' after a space, bracket or dash and
// before a letter, closed on the same line by a ’ or ' that follows a non-space and is not followed by a letter or
// digit. So the apostrophes in it's, Hartley's, don’t and students’ work open nothing, and an elision ('cause, ’90s)
// that never finds a closing mark quotes nothing.
const DOUBLE = { '"': '"', '“': '”', '„': '“”', '«': '»', '「': '」', '『': '』' };
const SINGLE = { "'": "'", '‘': '’' };
const BEFORE_SINGLE = /[\s([{“"«„—–\-/]/u;
const LETTER = /\p{L}/u;
const WORDISH = /[\p{L}\p{N}]/u;

function sentenceEnd(text, from) {
  const m = /[.!?…](?=[\s"”»’']|$)|\n/u.exec(text.slice(from));
  return m ? from + m.index + m[0].length : text.length;
}

// [start, end) character ranges, quote marks included, in passage order.
export function quotedRanges(text) {
  const s = String(text || '');
  const out = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (DOUBLE[ch] && !(ch === '"' && /\p{N}/u.test(s[i - 1] || ''))) {
      let k = i + 1;
      while (k < s.length && !(DOUBLE[ch].includes(s[k]) && !(ch === '"' && /\p{N}/u.test(s[k - 1])))) k++;
      const end = k < s.length ? k + 1 : (s.slice(0, i).trim() ? sentenceEnd(s, i + 1) : s.length);
      out.push([i, end]);
      i = end - 1;
      continue;
    }
    if (SINGLE[ch] && (i === 0 || BEFORE_SINGLE.test(s[i - 1])) && LETTER.test(s[i + 1] || '')) {
      let k = i + 1;
      while (k < s.length && s[k] !== '\n'
        && !(SINGLE[ch].includes(s[k]) && !/\s/u.test(s[k - 1]) && !WORDISH.test(s[k + 1] || ''))) k++;
      if (k < s.length && s[k] !== '\n') {
        out.push([i, k + 1]);
        i = k;
      }
    }
  }
  return out;
}

// Whether characters [from, to) of text touch quoted text.
export function inQuotes(text, from, to, ranges = quotedRanges(text)) {
  return ranges.some(([a, b]) => from < b && a < to);
}
