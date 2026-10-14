// System prompt and response schema per level. Wording follows eval/live/prompt-live.md, which gave
// the best judgment on real tweets; accented forms in the examples so the model outputs accents.
import { wordsForLevel } from './levels.js';

export const RESPONSE_SCHEMA = {
  type: 'object',
  properties: {
    tweets: {
      type: 'array',
      items: {
        type: 'object',
        properties: {
          id: { type: 'string' },
          swaps: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                o: { type: 'string' },
                f: { type: 'string' },
                g: { type: 'string' },
                h: { type: 'string' },
                ctx: { type: 'string' },
              },
              required: ['o', 'f', 'g', 'h', 'ctx'],
            },
          },
        },
        required: ['id', 'swaps'],
      },
    },
  },
  required: ['tweets'],
};

// `words` overrides the bundled list (see hostsource.js); without it the level picks L1 or L2.
export function buildSystemPrompt(level, words = wordsForLevel(level)) {
  const lvl = level <= 1 ? 1 : 2;
  const wordList = words.map((w) => w.fr).join(', ');
  const density = lvl === 1
    ? 'About one French word every sentence or two. Only these words:'
    : 'One or two French words per sentence. Only these words and fixed phrases:';
  const target = lvl === 1
    ? 'find the one list word that fits most naturally'
    : 'find the one or two list words per sentence that fit most naturally';
  const examples = lvl === 1
    ? '"and"->et, "but"->mais, "because"->parce que, "with"->avec, "very"->très, "also"->aussi, "maybe"->peut-être, "now"->maintenant, "always"->toujours, "here"->ici, "without"->sans'
    : '"and"->et, "but"->mais, "because"->parce que, "with"->avec, "very"->très, "now"->maintenant, "it\'s"->c\'est, "there is"->il y a, "I think"->je pense que, "today"->aujourd\'hui, "never"->jamais, "the world"->le monde, "in"->dans';

  return `You are the French Weave engine for a browser extension. The reader is a native English speaker with zero French, currently at Level ${lvl}.

Level ${lvl} rules:
- ${density} ${wordList}
- Swap an English word or short phrase for its French equivalent ONLY when the French word carries the same sense in context ("so" meaning therefore -> donc; "so" as an intensifier is NOT donc; "well" as a filler is NOT bien).
- Never touch names, handles, hashtags, URLs, numbers, code, or quoted titles.
- Zero French in tweets about health, medication, legal, money, safety, emergencies, or driving.
- Comprehension beats the level: skip a tweet entirely if a swap would make it hard to follow.

Output: JSON only. For every tweet return {"id": "<same id>", "swaps": [...]}. Each swap: {"o": exact word(s) from the tweet as written, "f": French replacement with its accents, "g": plain English gloss, "h": sound hint, "ctx": 2-4 words copied exactly from the tweet that contain "o"}.
Default is to swap: in every tweet of 6+ words, ${target} (usually ${examples}). Swap only whole list words, never other forms. Return empty swaps only when a rule forbids it or no list word fits.`;
}

export function buildUserContent(batch) {
  return 'Tweets:\n' + JSON.stringify(batch.map(({ id, text }) => ({ id, text })));
}
