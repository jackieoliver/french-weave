// One batch through the language's model chain (model-config.js), validated swaps out. Each Gemini step is tried with
// the main key, then the backup key, before the next step; an OpenRouter step comes only when the worker allows it.
import * as freeform from './prompt.js';
import * as candidates from './candidates.js';
import { buildRequest, callGemini, parseSwapsResponse, FALLBACK_MODEL } from './gemini.js';
import { callOpenRouter } from './openrouter.js';
import { validateSwaps, capSwaps } from './levels.js';
import { clockTime, errorKind } from './modelerror.js';
import { LAST_TIMEOUT_MS } from './model-config.js';

// cooldown: Map<slot, until ms>. Rate-limited or overloaded models are skipped until then, so the free tier's
// per-minute limit does not cost every batch a failed request before the next step.
export const COOLDOWN_MS = { 429: 60000, 503: 30000, timeout: 30000 };

export { clockTime };

// Where a step's state lives (cooldown, daily): the main key's Gemini slot is the bare model name, as stored before
// the chain existed; the backup key's is "backup:<model>", OpenRouter's "openrouter:<model>".
export const slotFor = (keyName, model) => (keyName === 'main' ? model : `${keyName}:${model}`);
const labelFor = (a) => (a.keyName === 'main' ? a.step.model : a.keyName === 'backup' ? `${a.step.model} (backup key)` : `OpenRouter ${a.step.model}`);

// The requests a chain makes, in order. keys: { main, backup, openrouter }; a step without its key is left out.
export function attemptsFor(chain, keys) {
  const out = [];
  chain.forEach((step, index) => {
    const names = step.provider === 'gemini' ? ['main', 'backup'] : step.provider === 'openrouter' ? ['openrouter'] : [];
    for (const keyName of names) {
      if (keys[keyName]) out.push({ step, index, keyName, key: keys[keyName], slot: slotFor(keyName, step.model) });
    }
  });
  return out;
}

// Without a chain (older callers and tests): the model and its fallback, free-form, main key only.
const legacyChain = (model) => [model, FALLBACK_MODEL[model]].filter(Boolean)
  .map((m, i, all) => ({ provider: 'gemini', model: m, thinking: 'low', timeoutMs: all.length > 1 && i === 0 ? 8000 : LAST_TIMEOUT_MS }));

// Every request is cooling down. When each one has spent its daily quota, say so and when it comes back, instead
// of a "retrying shortly" that would be wrong for hours.
function waitError(slots, cooldown, daily, now) {
  const until = Math.min(...slots.map((s) => Math.max(cooldown.get(s) || 0, daily.get(s) || 0)));
  const allDaily = slots.every((s) => daily.get(s) > now);
  const error = new Error(allDaily ? `Daily Gemini limit reached; resumes about ${clockTime(until)}` : 'Model rate limit; retrying shortly');
  error.retryAfterMs = Math.max(1000, until - now);
  // A wait without a request has no HTTP code of its own; the worker keeps the one from the request that started it.
  Object.assign(error, allDaily ? { daily: true, resumeAt: until, status: 429, kind: 'daily' } : { kind: 'wait' });
  return error;
}

// The prompt, schema and reply handling for a design. Candidates: passages without a candidate are left out of the
// request (they get no swaps), and a batch without any makes no request at all.
function designFor(design, { level, batch, words, language, shownToday, page }) {
  if (design === 'candidates') {
    const found = new Map(batch.map(({ id, text }) => [id, candidates.findCandidates(text, words || null, language, level)]));
    const send = batch.filter(({ id }) => found.get(id).length);
    return {
      send,
      system: candidates.buildSystemPrompt(level, words, shownToday, language),
      user: send.length ? candidates.buildUserContent(send, level, page, found) : '',
      schema: candidates.RESPONSE_SCHEMA,
      parse: candidates.parseKeepResponse,
      swaps: (id, keep) => candidates.toSwaps(found.get(id), keep),
    };
  }
  return {
    send: batch,
    system: freeform.buildSystemPrompt(level, words, shownToday, language),
    user: freeform.buildUserContent(batch, level, page),
    schema: freeform.RESPONSE_SCHEMA,
    parse: parseSwapsResponse,
    swaps: (id, swaps) => swaps,
  };
}

// keys: { main, backup, openrouter } (apiKey: the main key, for older callers). chain and design: configFor's.
// daily: Map<slot, until ms> for slots whose per-day quota is spent (the worker keeps it in storage, since a day outlives
// the worker); cooldown covers the per-minute limit and overload. page: the page title and site, for the topic check.
// onOpenRouter({ costUsd, status }): after each OpenRouter request, so the worker can count spend and stop on a 402.
// timeoutMs: tests only; otherwise each step's own.
export async function requestSwaps({ apiKey, keys: given, model, chain: givenChain, design = 'freeform', level: chosen, batch, words, language,
  shownToday, page = '', fetchImpl, timeoutMs, cooldown = new Map(), daily = new Map(), now = Date.now, onOpenRouter = async () => {} }) {
  const level = words ? chosen : Math.min(chosen, 2); // the bundled lists stop at Level 2
  const keys = given || { main: apiKey };
  const chain = givenChain || legacyChain(model);
  const plan = designFor(design, { level, batch, words, language, shownToday, page });
  const results = Object.fromEntries(batch.map(({ id }) => [id, []]));
  if (design === 'candidates' && !plan.send.length) return { results, model: '', provider: '', errors: [], dropped: {}, skipped: true };

  const all = attemptsFor(chain, keys);
  const blocked = (slot) => cooldown.get(slot) > now() || daily.get(slot) > now();
  const open = all.filter((a) => !blocked(a.slot));
  if (!all.length) throw Object.assign(new Error('No model key'), { kind: 'key' });
  if (!open.length) throw waitError(all.map((a) => a.slot), cooldown, daily, now());
  const errors = [];
  const failures = [];
  const overloaded = new Set(); // steps whose model was busy or slow: the backup key would only wait again
  for (const [n, a] of open.entries()) {
    if (overloaded.has(a.index) || blocked(a.slot)) continue;
    const later = open.slice(n + 1).some((b) => !overloaded.has(b.index) && !blocked(b.slot));
    const wait = timeoutMs || (later ? a.step.timeoutMs : Math.max(a.step.timeoutMs || 0, LAST_TIMEOUT_MS));
    const body = buildRequest({ system: plan.system, user: plan.user, schema: plan.schema, thinkingLevel: a.step.thinking, model: a.step.model });
    let costUsd = 0;
    try {
      let byId;
      if (a.keyName === 'openrouter') {
        try {
          const reply = await callOpenRouter({ fetchImpl, apiKey: a.key, model: a.step.model, body, thinking: a.step.thinking, timeoutMs: wait });
          costUsd = reply.costUsd;
          await onOpenRouter({ costUsd, status: 200 });
          byId = plan.parse(reply.text);
        } catch (e) {
          if (e?.status) await onOpenRouter({ costUsd: 0, status: e.status });
          throw e;
        }
      } else {
        byId = await callGemini({ fetchImpl, apiKey: a.key, model: a.step.model, body, timeoutMs: wait, now, parse: plan.parse });
      }
      const dropped = {}; // swaps the validator dropped, by reason (malformed: broken accents the model sent)
      for (const { id, text } of plan.send) {
        if (!byId.has(id)) throw new Error('Incomplete model response');
        results[id] = capSwaps(level, validateSwaps(level, plan.swaps(id, byId.get(id)), words, language, { stats: dropped, text }), text, words);
      }
      return { results, model: a.step.model, provider: a.step.provider, keyName: a.keyName, step: a.index + 1, errors, dropped, costUsd };
    } catch (e) {
      const timeout = e?.name === 'TimeoutError';
      const pause = e?.retryAfterMs || COOLDOWN_MS[timeout ? 'timeout' : e?.status];
      if (pause) cooldown.set(a.slot, now() + pause);
      if (pause && e?.daily) daily.set(a.slot, now() + pause);
      // A busy or slow model is busy for every key: cool the step down and move to the next one.
      if (timeout || e?.status >= 500) {
        overloaded.add(a.index);
        for (const b of all) if (b.index === a.index && pause) cooldown.set(b.slot, now() + pause);
      }
      errors.push(`${labelFor(a)}: ${timeout ? 'timeout' : e?.message || e}`);
      failures.push({ provider: a.step.provider, keyName: a.keyName, cooled: !!pause, status: e?.status, googleStatus: e?.googleStatus, keyRejected: e?.keyRejected,
        daily: e?.daily, timeout, network: !!e?.network });
    }
  }
  const gemini = all.filter((a) => a.step.provider === 'gemini').map((a) => a.slot);
  const geminiFailures = failures.filter((f) => f.provider === 'gemini');
  // Every Gemini step is on its daily block (now or from before), so the popup's line is the daily one even when
  // OpenRouter failed too (its own line says why). A short OpenRouter cooldown (429, timeout) brings the retry forward,
  // so passages don't wait for Google's reset when the paid step may answer in a minute.
  if (gemini.length && gemini.every((s) => daily.get(s) > now())) {
    const error = Object.assign(waitError(gemini, cooldown, daily, now()), { googleStatus: geminiFailures.at(-1)?.googleStatus });
    const soon = all.filter((a) => a.keyName === 'openrouter').map((a) => cooldown.get(a.slot) || 0).filter((t) => t > now());
    if (soon.length) error.retryAfterMs = Math.max(1000, Math.min(error.retryAfterMs, Math.min(...soon) - now()));
    // An OpenRouter failure with no cooldown and no stop (a 500, no connection, a broken reply) may pass in seconds.
    const passing = failures.some((f) => f.provider === 'openrouter' && !f.cooled && ![401, 402, 403].includes(f.status));
    if (passing) error.retryAfterMs = Math.min(error.retryAfterMs, COOLDOWN_MS[503]);
    throw error;
  }
  const error = new Error(errors.join('; '));
  // Every request failed. A refused Gemini key wins (it needs the reader; the main key's before the backup's);
  // otherwise the last Gemini failure. keyName says which key it was.
  const failure = geminiFailures.find((f) => errorKind(f) === 'key') || geminiFailures.at(-1) || failures.at(-1) || {};
  Object.assign(error, { kind: errorKind({ ...failure, daily: false }), status: failure.status, googleStatus: failure.googleStatus,
    keyName: failure.keyName });
  const until = all.map((a) => cooldown.get(a.slot) || 0).filter((t) => t > now());
  if (until.length === all.length) error.retryAfterMs = Math.max(1000, Math.min(...until) - now());
  throw error;
}
