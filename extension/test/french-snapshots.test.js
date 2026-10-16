// French output must not change when the rules are refactored: the system prompt is compared byte for byte with
// files captured before the language-profile refactor (test/snapshots/). Rewrite them only for a deliberate wording
// change: UPDATE_SNAPSHOTS=1 bun test test/french-snapshots.test.js
import { describe, test, expect } from 'bun:test';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { buildSystemPrompt } from '../src/prompt.js';

const DIR = new URL('./snapshots/', import.meta.url);

const WORDS = [
  { fr: 'grand', en: 'big', hint: 'grahn', status: 'active' },
  { fr: 'le problème', en: 'the problem', hint: 'luh prob-lem', status: 'active' },
  { fr: 'vrai', en: 'true', hint: 'vray', status: 'shaky' },
  { fr: 'et', en: 'and', hint: 'ay', status: 'known' },
  { fr: 'mais', en: 'but', hint: 'meh', status: 'known' },
  { fr: 'très', en: 'very', hint: 'treh', status: 'known' },
];

export const CASES = {
  'prompt-level1-bundled': () => buildSystemPrompt(1),
  'prompt-level2-bundled': () => buildSystemPrompt(2),
  'prompt-level1-shared': () => buildSystemPrompt(1, WORDS, ['grand']),
  'prompt-level2-shared': () => buildSystemPrompt(2, WORDS, ['grand']),
  'prompt-level2-shared-french': () => buildSystemPrompt(2, WORDS, [], 'French'),
};

describe('French snapshots', () => {
  for (const [name, make] of Object.entries(CASES)) {
    test(name, () => {
      const file = new URL(`${name}.txt`, DIR);
      if (process.env.UPDATE_SNAPSHOTS === '1') {
        mkdirSync(DIR, { recursive: true });
        writeFileSync(file, make());
      }
      expect(make()).toBe(readFileSync(file, 'utf8'));
    });
  }
});
