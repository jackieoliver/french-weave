// Which prompt design and which models serve each language: data only, read by the engine (engine.js) and popup.
// Each step is tried in order until one answers. A Gemini step runs with the main key, then the backup key; an
// OpenRouter step runs only when an OpenRouter key is set and today's spend is under the cap. thinking: Gemini's
// thinkingLevel, "off" for none (OpenRouter: reasoning off); Gemma models never get one. timeoutMs: how long the step
// may take while a later step could still answer; the last step that runs waits at least LAST_TIMEOUT_MS.
// Measurements behind the defaults: internal evaluation notes (not published), 2026-10-15 (gemini-3.1-flash-lite at
// medium thinking matched paid 3.8 Flash on density with zero leaks in Spanish and French, 6 s median and 21 s p90
// per batch; gpt-6-luna with reasoning off leaked nothing in six languages at about $0.0006 a request).
export const MODEL_CONFIG = {
  default: {
    design: 'candidates', // or 'freeform': the model writes the swaps itself (prompt.js)
    chain: [
      { provider: 'gemini', model: 'gemini-3.1-flash-lite', thinking: 'medium', timeoutMs: 30000 },
      { provider: 'gemini', model: 'gemini-3.5-flash-lite', thinking: 'low', timeoutMs: 8000 },
      { provider: 'openrouter', model: 'openai/gpt-6-luna', thinking: 'off', timeoutMs: 20000 },
    ],
  },
  // Per-language overrides, by the word state's language name: any of design and chain, e.g.
  // Japanese: { design: 'freeform' }. None yet: every language measured so far does best with the default.
  languages: {},
};

export const LAST_TIMEOUT_MS = 20000;

// Models the popup offers as the first step instead of the language's own (Auto).
export const MODELS = {
  'gemini-3.1-flash-lite': 'Gemini 3.1 Flash-Lite',
  'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
  'gemini-3.8-flash': 'Gemini 3.8 Flash (paid key)',
};
export const THINKING = { 'gemini-3.1-flash-lite': 'medium', 'gemini-3.5-flash-lite': 'low', 'gemini-3.8-flash': 'low' };
export const STEP_TIMEOUT_MS = { 'gemini-3.1-flash-lite': 30000, 'gemini-3.5-flash-lite': 8000, 'gemini-3.8-flash': 20000 };

// The design and chain for a language; choice: the popup's model ('auto', or a key of MODELS), which goes first,
// followed by the rest of the language's chain.
export function configFor(language, choice = 'auto', config = MODEL_CONFIG) {
  const own = config.languages?.[language] || {};
  const design = own.design || config.default.design;
  let chain = own.chain || config.default.chain;
  if (choice && choice !== 'auto' && MODELS[choice]) {
    const first = { provider: 'gemini', model: choice, thinking: THINKING[choice], timeoutMs: STEP_TIMEOUT_MS[choice] };
    chain = [first, ...chain.filter((s) => !(s.provider === 'gemini' && s.model === choice))];
  }
  return { design, chain };
}

export const modelLabel = (model) => MODELS[model] || String(model || '').replace(/^.*\//, '');
