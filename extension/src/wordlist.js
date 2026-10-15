// The popup's "Your words" section. Pure apart from the element it fills: no chrome APIs, no network.
// With the Claude Code plugin's word state (synced by the worker), it counts known, learning and shaky words and
// lists the learning and shaky ones; without it, the bundled level list the extension falls back to.
import { resolveLevel, wordsForLevel } from './levels.js';
import { cleanSettings } from './settings.js';

// Same split as the prompt: anything not known or shaky is a learning word.
const group = (status) => status === 'known' ? 'known' : status === 'shaky' ? 'shaky' : 'learning';

export function wordSummary(state, settings) {
  if (state?.words?.length) {
    const counts = { known: 0, learning: 0, shaky: 0 };
    for (const w of state.words) counts[group(w.status)]++;
    const pick = (g) => state.words.filter((w) => group(w.status) === g).map((w) => ({ fr: w.fr, en: w.en, hint: w.hint || '', status: g }));
    return { builtIn: false, counts, words: [...pick('shaky'), ...pick('learning')] };
  }
  const level = resolveLevel(cleanSettings(settings), 0).effective; // the list the worker uses without a word state
  return { builtIn: true, level, words: wordsForLevel(level).map((w) => ({ fr: w.fr, en: w.en, hint: w.hint, status: 'built-in' })) };
}

export function countsLine(summary) {
  if (summary.builtIn) return `built-in level ${summary.level} list`;
  const { known, learning, shaky } = summary.counts;
  return `${known} known · ${learning} learning · ${shaky} shaky`;
}

// details: <details> holding a <summary> with a [data-counts] span and a [data-rows] container.
export function renderWordList(details, summary) {
  const doc = details.ownerDocument;
  details.querySelector('[data-counts]').textContent = countsLine(summary);
  const rows = details.querySelector('[data-rows]');
  rows.replaceChildren();
  const note = (text) => Object.assign(doc.createElement('p'), { className: 'small word-note', textContent: text });
  if (summary.builtIn) {
    rows.append(note(`No word list from Claude Code yet, so this is the built-in level ${summary.level} list (${summary.words.length} words). ` +
      'With the French Weave Claude Code plugin set up, your own known, learning and shaky words show here.'));
  } else if (!summary.words.length) {
    rows.append(note('No learning or shaky words right now.'));
  }
  let heading = '';
  for (const w of summary.words) {
    if (!summary.builtIn && w.status !== heading) {
      heading = w.status;
      rows.append(Object.assign(doc.createElement('div'), { className: 'word-group', textContent: heading === 'shaky' ? 'Shaky' : 'Learning' }));
    }
    const row = doc.createElement('div');
    row.className = 'word';
    row.dataset.status = w.status;
    const fr = Object.assign(doc.createElement('span'), { className: 'word-fr', textContent: w.fr });
    const en = Object.assign(doc.createElement('span'), { className: 'small word-en', textContent: w.hint ? `${w.en} · "${w.hint}"` : w.en });
    row.append(fr, en);
    rows.append(row);
  }
}
