// One batch, one model call (fallback model once on failure), validated swaps out.
import { buildSystemPrompt, buildUserContent, RESPONSE_SCHEMA } from './prompt.js';
import { buildRequest, callGemini, FALLBACK_MODEL } from './gemini.js';
import { validateSwaps, capSwaps } from './levels.js';
import { clockTime, errorKind } from './modelerror.js';

// cooldown: Map<model, until ms>. Rate-limited or overloaded models are skipped until then, so the
// free tier's per-minute limit does not cost every batch a failed request before the fallback.
export const COOLDOWN_MS = { 429: 60000, 503: 30000, timeout: 30000 };
// A model with a fallback gets a short wait, so an overloaded model costs seconds before the fallback, not 20.
export const PRIMARY_TIMEOUT_MS = 8000;
export const timeoutFor = (m, models, timeoutMs) =>
  models.length > 1 && m === models[0] ? Math.min(timeoutMs || 20000, PRIMARY_TIMEOUT_MS) : timeoutMs;

export { clockTime };

// Every candidate is cooling down. When each one has spent its daily quota, say so and when it comes back, instead
// of a "retrying shortly" that would be wrong for hours.
function waitError(candidates, cooldown, daily, now) {
  const until = Math.min(...candidates.map((m) => Math.max(cooldown.get(m) || 0, daily.get(m) || 0)));
  const allDaily = candidates.every((m) => daily.get(m) > now);
  const error = new Error(allDaily ? `Daily Gemini limit reached; resumes about ${clockTime(until)}` : 'Model rate limit; retrying shortly');
  error.retryAfterMs = Math.max(1000, until - now);
  // A wait without a request has no HTTP code of its own; the worker keeps the one from the request that started it.
  Object.assign(error, allDaily ? { daily: true, resumeAt: until, status: 429, kind: 'daily' } : { kind: 'wait' });
  return error;
}

// daily: Map<model, until ms> for models whose per-day quota is spent (the worker keeps it in storage, since a day
// outlives the worker); cooldown covers the per-minute limit and overload.
export async function requestSwaps({ apiKey, model, level, batch, words, language, shownToday, fetchImpl, timeoutMs, cooldown = new Map(), daily = new Map(), now = Date.now }) {
  const body = buildRequest({ system: buildSystemPrompt(level, words, shownToday, language), user: buildUserContent(batch), schema: RESPONSE_SCHEMA });
  const candidates = [model];
  if (FALLBACK_MODEL[model]) candidates.push(FALLBACK_MODEL[model]);
  const blocked = (m) => cooldown.get(m) > now() || daily.get(m) > now();
  const models = candidates.filter((m) => !blocked(m));
  const errors = [];
  const failures = [];
  if (!models.length) throw waitError(candidates, cooldown, daily, now());
  for (const m of models) {
    try {
      const byId = await callGemini({ fetchImpl, apiKey, model: m, body, timeoutMs: timeoutFor(m, models, timeoutMs), now });
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
      if (wait && e?.daily) daily.set(m, now() + wait);
      errors.push(`${m}: ${timeout ? 'timeout' : e?.message || e}`);
      failures.push({ status: e?.status, googleStatus: e?.googleStatus, keyRejected: e?.keyRejected, daily: e?.daily, timeout,
        network: !!e?.network });
    }
  }
  if (candidates.every((m) => daily.get(m) > now())) {
    throw Object.assign(waitError(candidates, cooldown, daily, now()), { googleStatus: failures.at(-1)?.googleStatus });
  }
  const error = new Error(errors.join('; '));
  // Every candidate failed. A refused key is refused for every model, so it wins; otherwise the last model's failure.
  const failure = failures.find((f) => errorKind(f) === 'key') || failures.at(-1) || {};
  Object.assign(error, { kind: errorKind({ ...failure, daily: false }), status: failure.status, googleStatus: failure.googleStatus });
  const until = candidates.map((m) => cooldown.get(m) || 0).filter((t) => t > now());
  if (until.length === candidates.length) error.retryAfterMs = Math.max(1000, Math.min(...until) - now());
  throw error;
}
