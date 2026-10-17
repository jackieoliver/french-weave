// What the popup says about the engine making the swaps (config.tier from the worker), in plain words.
export const TIER_TEXT = {
  gemini: {
    label: 'Gemini, with your key',
    note: '',
    privacy: "Sites where it's on send readable page text to Gemini with your key (with an OpenRouter key, also to OpenRouter and the model's provider: Anthropic first at Levels 1-2, and OpenAI when Gemini can't answer). With a free key, Google may use it to improve its products; a paid key avoids that. Links and inline code go with their sentence but are never changed; code blocks, forms and editable text are skipped.",
  },
  local: {
    label: 'Built-in list, no key',
    note: 'Only a few words that mean the same in any sentence (and, but, with, because, always…), so fewer than with a key. Add a Gemini key below for the rest of your words.',
    privacy: 'No key: swaps come from a list inside the extension, and no page text leaves your computer. Links, code, forms and editable text are never changed.',
  },
  none: {
    label: 'None',
    note: 'The built-in list is French only. Add a Gemini key below to weave your language.',
    privacy: 'Without a key nothing is swapped and no page text leaves your computer.',
  },
};
export const tierText = (tier) => TIER_TEXT[tier] || TIER_TEXT.none;
