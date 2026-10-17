// Anthropic's Messages API, direct: the Claude Haiku 5.5 step (first at every level) when the reader has an Anthropic key
// (paid; under its own daily spend cap). The same prompt and schema as the Gemini body; no chrome APIs; fetch is
// injectable for tests. The key goes only in the x-api-key header.
// Request shapes checked 2026-10-17 against platform.claude.com/docs (via context7 /websites/platform_claude_en and
// the pricing page): structured outputs are output_config.format {type: 'json_schema', schema} and every object in the
// schema needs additionalProperties: false (build-with-claude/structured-outputs); thinking on Haiku 5.5 is adaptive
// only, its depth set by output_config.effort low|medium|high|xhigh|max (default medium), and {type: 'disabled'} is
// accepted at low to high; usage.output_tokens includes thinking, with output_tokens_details.thinking_tokens as the
// breakdown (api/messages); errors: 401 authentication, 402 billing, 403 permission, 429 rate limit, 529 overloaded
// (api/errors). A fetch from the extension's service worker has no host permission for api.anthropic.com (the
// manifest has none, so no new permission prompt), so it is a CORS request: the API answers the preflight only when
// the request carries anthropic-dangerous-direct-browser-access: true, the header the official SDK sends with
// dangerouslyAllowBrowser (@anthropic-ai/sdk client.ts; preflight checked with curl 2026-10-17: 200 with the header,
// 400 without).
export const ANTHROPIC_URL = 'https://api.anthropic.com/v1/messages';
export const ANTHROPIC_VERSION = '2023-06-01';
// Jackie, 2026-10-17: "for the claude credit, cap it to $5 a day".
export const DEFAULT_ANTHROPIC_DAILY_CAP_USD = 5;
// USD per million tokens (platform.claude.com/docs/en/about-claude/pricing, 2026-10-17). Claude Haiku 5.5 has two rate
// cards by prompt length: up to 100,000 prompt tokens (cache reads and writes included), and over. Cache writes are
// 1.25x input (5 minutes) and cache reads 0.1x; this module asks for no caching, but counts any it is billed for.
export const PRICES = {
  'claude-haiku-5-5': { input: 0.10, output: 0.50, longInput: 0.50, longOutput: 2.50, longOver: 100000 },
};
const MAX_TOKENS = 8000; // thinking counts toward it; a batch's answer is a few hundred tokens

// Every object in the schema closed (additionalProperties: false), as structured outputs require; constraints the
// API refuses (minimum, maxLength, ...) dropped. Nothing else changes.
const UNSUPPORTED = new Set(['minimum', 'maximum', 'exclusiveMinimum', 'exclusiveMaximum', 'multipleOf', 'minLength', 'maxLength',
  'pattern', 'maxItems', 'uniqueItems', 'propertyOrdering', 'nullable']);
export function toAnthropicSchema(schema) {
  if (Array.isArray(schema)) return schema.map(toAnthropicSchema);
  if (!schema || typeof schema !== 'object') return schema;
  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (k === 'properties' && v && typeof v === 'object') { // property names, not keywords
      out[k] = Object.fromEntries(Object.entries(v).map(([name, s]) => [name, toAnthropicSchema(s)]));
      continue;
    }
    if (UNSUPPORTED.has(k) || (k === 'minItems' && v > 1)) continue;
    out[k] = k === 'enum' || k === 'required' ? v : toAnthropicSchema(v);
  }
  if (out.type === 'object') out.additionalProperties = false;
  return out;
}

// The chain's thinking setting -> thinking and effort. 'off': thinking disabled at low effort; any other level is
// adaptive thinking at that effort ('low' for the Haiku step).
export function thinkingFor(thinking = 'low') {
  if (!thinking || thinking === 'off') return { thinking: { type: 'disabled' }, effort: 'low' };
  return { thinking: { type: 'adaptive' }, effort: ['low', 'medium', 'high', 'xhigh', 'max'].includes(thinking) ? thinking : 'low' };
}

// A Gemini generateContent body (gemini.js buildRequest) -> a Messages API body.
export function toAnthropicBody(model, geminiBody, { thinking = 'low' } = {}) {
  const text = (parts) => (parts || []).map((p) => p.text || '').join('');
  const system = text(geminiBody.systemInstruction?.parts);
  const user = (geminiBody.contents || []).map((c) => text(c.parts)).join('\n');
  const schema = geminiBody.generationConfig?.responseSchema;
  const t = thinkingFor(thinking);
  return {
    model,
    max_tokens: MAX_TOKENS,
    ...(system ? { system } : {}),
    messages: [{ role: 'user', content: user }],
    thinking: t.thinking,
    output_config: { effort: t.effort, ...(schema ? { format: { type: 'json_schema', schema: toAnthropicSchema(schema) } } : {}) },
  };
}

// Tokens from a reply's usage: prompt (input, cache reads and writes), answer (output without thinking), thinking.
export function usageOf(usage = {}) {
  const n = (v) => (Number(v) > 0 ? Number(v) : 0);
  const prompt = n(usage.input_tokens) + n(usage.cache_creation_input_tokens) + n(usage.cache_read_input_tokens);
  const thinking = Math.min(n(usage.output_tokens_details?.thinking_tokens), n(usage.output_tokens));
  return { promptTokens: prompt, answerTokens: n(usage.output_tokens) - thinking, thinkingTokens: thinking };
}

// USD for one reply, from its usage at the model's published price (0 for a model without one).
export function costOf(model, usage = {}) {
  const p = PRICES[model];
  if (!p) return 0;
  const n = (v) => (Number(v) > 0 ? Number(v) : 0);
  const write = n(usage.cache_creation_input_tokens);
  const read = n(usage.cache_read_input_tokens);
  const long = n(usage.input_tokens) + write + read > p.longOver;
  const input = long ? p.longInput : p.input;
  const output = long ? p.longOutput : p.output;
  const usd = (n(usage.input_tokens) * input + write * input * 1.25 + read * input * 0.1 + n(usage.output_tokens) * output) / 1e6;
  return Math.round(usd * 1e8) / 1e8;
}

// One request. Returns { text, costUsd, usage: { promptTokens, answerTokens, thinkingTokens } }; throws an Error with
// status on HTTP failure. keyRejected: 401 or 403. credits: the account can't pay (402, "credit balance is too low",
// or a spend limit reached), so further calls would only fail too. Only these fixed facts leave this function, never
// the reply's text, so nothing stored or shown can carry the key.
export async function callAnthropic({ fetchImpl = globalThis.fetch, apiKey, model, body, thinking = 'low', timeoutMs = 35000 }) {
  let res;
  try {
    res = await fetchImpl(ANTHROPIC_URL, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-api-key': apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-dangerous-direct-browser-access': 'true',
      },
      body: JSON.stringify(toAnthropicBody(model, body, { thinking })),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    if (e?.name === 'TypeError') e.network = true;
    throw e;
  }
  let raw = '';
  try { raw = await res.text(); } catch { /* status alone is enough */ }
  let data = null;
  try { data = JSON.parse(raw); } catch { /* not JSON */ }
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status}`);
    error.status = res.status;
    if (res.status === 401 || res.status === 403) error.keyRejected = true;
    const detail = String(data?.error?.message || '');
    if (res.status === 402 || /credit balance is too low/i.test(detail) || data?.error?.details?.error_code === 'enforced_spend_limit_reached') {
      error.credits = true;
    }
    const wait = Number(res.headers?.get?.('retry-after'));
    if (res.status === 429 && wait > 0) error.retryAfterMs = Math.min(wait, 3600) * 1000;
    throw error;
  }
  const usage = usageOf(data?.usage);
  const costUsd = costOf(model, data?.usage);
  if (data?.stop_reason === 'refusal' || data?.stop_reason === 'max_tokens') {
    throw Object.assign(new Error(`Anthropic stopped: ${data.stop_reason}`), { costUsd, usage });
  }
  const text = (Array.isArray(data?.content) ? data.content : []).filter((b) => b?.type === 'text').map((b) => b.text || '').join('');
  return { text, costUsd, usage };
}
