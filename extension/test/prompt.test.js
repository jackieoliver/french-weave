import { describe, test, expect } from 'bun:test';
import { buildSystemPrompt, buildUserContent, RESPONSE_SCHEMA } from '../src/prompt.js';
import { L1_WORDS, L2_WORDS } from '../src/levels.js';

describe('prompt', () => {
  test('L1 lists all 28 accented words and the sense rules', () => {
    const p = buildSystemPrompt(1);
    expect(p).toContain('Level 1');
    for (const w of L1_WORDS) expect(p).toContain(w.fr);
    expect(p).toContain('très');
    expect(p).not.toContain('"very"->tres');
    expect(p).toContain('set "topic" to "avoid" and return no swaps');
    expect(p).toContain('about one French word every sentence or two');
  });
  test('L2 lists the fixed phrases; L3/L4 fall back to L2 for now', () => {
    const p = buildSystemPrompt(2);
    expect(p).toContain('Level 2');
    for (const w of L2_WORDS) expect(p).toContain(w.fr);
    expect(p).toContain("c'est");
    expect(buildSystemPrompt(4)).toBe(p);
  });
  test('user content and schema shape', () => {
    expect(buildUserContent([{ id: 'a', text: 'hi', extra: 1 }])).toBe('Passages:\n[{"id":"a","page":"unknown","want":1,"text":"hi"}]');
    expect(buildUserContent([{ id: 'a', text: "I like it. You like it. We like it. They like it." }], 2, 'Title (site.com)'))
      .toBe('Passages:\n[{"id":"a","page":"Title (site.com)","want":6,"text":"I like it. You like it. We like it. They like it."}]');
    expect(RESPONSE_SCHEMA.properties.passages.items.required).toEqual(['id', 'topic', 'swaps']);
    expect(RESPONSE_SCHEMA.properties.passages.items.properties.swaps.items.required).toEqual(['o', 'f', 'g', 'h', 'ctx']);
  });
  test('shared state: learning words are the target, unshown ones first; known words are filler; no fixed examples', () => {
    const words = [
      { fr: 'grand', en: 'big', hint: 'grahn', status: 'active' },
      { fr: 'petit', en: 'small', hint: 'puh-tee', status: 'active' },
      { fr: 'vrai', en: 'true', hint: 'vray', status: 'shaky' },
      { fr: 'et', en: 'and', hint: 'ay', status: 'known' },
    ];
    const p = buildSystemPrompt(2, words, ['grand']);
    expect(p).toContain('LEARNING words');
    expect(p).toContain('petit = small; vrai = true; grand = big');
    expect(p).toContain('KNOWN words (filler only):\net');
    expect(p).not.toContain('"but"->mais');
    expect(p).toContain('one or two French words in every sentence');
    expect(buildSystemPrompt(1, words)).toContain('about one French word every sentence or two');
  });
  test('another language from the plugin: its name, no French examples; French stays as it was', () => {
    const words = [{ fr: '猫', en: 'cat', hint: 'neko', status: 'active' }, { fr: 'でも', en: 'but', hint: 'demo', status: 'known' }];
    const p = buildSystemPrompt(1, words, [], 'Japanese');
    expect(p).toContain('French Weave engine');
    expect(p).toContain('learning Japanese from zero');
    expect(p).not.toMatch(/French(?! Weave)|donc|grand|-> et/);
    expect(buildSystemPrompt(1, words, [], 'French')).toBe(buildSystemPrompt(1, words));
    expect(buildSystemPrompt(1, undefined, [], 'Japanese')).toBe(buildSystemPrompt(1)); // bundled lists are French
  });
});
