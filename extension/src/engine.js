// One batch, one model call (fallback model once on failure), validated swaps out.
import { buildSystemPrompt, buildUserContent, RESPONSE_SCHEMA } from './prompt.js';
import { buildRequest, callGemini, FALLBACK_MODEL } from './gemini.js';
import { validateSwaps, capSwaps } from './levels.js';

// cooldown: Map<model, until ms>. Rate-limited or overloaded models are skipped until then, so the
// free tier's per-minute limit does not cost every batch a failed request before the fallback.
export const COOLDOWN_MS = { 429: 60000, 503: 30000, timeout: 30000 };

export async function requestSwaps({ apiKey, model, level, batch, words, shownToday, fetchImpl, timeoutMs, cooldown = new Map(), now = Date.now }) {
  const body = buildRequest({ system: buildSystemPrompt(level, words, shownToday), user: buildUserContent(batch), schema: RESPONSE_SCHEMA });
  const candidates = [model];
  if (FALLBACK_MODEL[model]) candidates.push(FALLBACK_MODEL[model]);
  const models = candidates.filter((m) => !(cooldown.get(m) > now()));
  const errors = [];
  if (!models.length) {
    const error = new Error('Model rate limit; retrying shortly');
    error.retryAfterMs = Math.max(1000, Math.min(...candidates.map((m) => cooldown.get(m))) - now());
    throw error;
  }
  for (const m of models) {
    try {
      const byId = await callGemini({ fetchImpl, apiKey, model: m, body, timeoutMs });
      const results = {};
      for (const { id, text } of batch) {
        if (!byId.has(id)) throw new Error('Incomplete model response');
        results[id] = capSwaps(level, validateSwaps(level, byId.get(id), words), text, words);
      }
      return { results, model: m, errors };
    } catch (e) {
      const timeout = e?.name === 'TimeoutError';
      const wait = e?.retryAfterMs || COOLDOWN_MS[timeout ? 'timeout' : e?.status];
      if (wait) cooldown.set(m, now() + wait);
      errors.push(`${m}: ${timeout ? 'timeout' : e?.message || e}`);
    }
  }
  const error = new Error(errors.join('; '));
  const until = candidates.map((m) => cooldown.get(m) || 0).filter((t) => t > now());
  if (until.length === candidates.length) error.retryAfterMs = Math.max(1000, Math.min(...until) - now());
  throw error;
}
