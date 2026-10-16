// OpenRouter, the optional last step of the chain (paid; only with an OpenRouter key and under the day's spend cap).
// The same prompt and schema as the Gemini body go through OpenRouter's chat API; the logic is the internal evaluation harness's
// (not published). No chrome APIs; fetch is injectable for tests. The key goes only in the Authorization header.
export const OPENROUTER_URL = 'https://openrouter.ai/api/v1/chat/completions';
export const DEFAULT_DAILY_CAP_USD = 0.25;

// A Gemini generateContent body -> an OpenRouter chat body. jsonOnly: plain JSON mode for an endpoint that refuses
// the schema (the prompt already spells out the shape).
export function toOpenRouterBody(model, geminiBody, { thinking = 'off', jsonOnly = false } = {}) {
  const text = (parts) => (parts || []).map((p) => p.text || '').join('');
  const system = text(geminiBody.systemInstruction?.parts);
  const user = (geminiBody.contents || []).map((c) => text(c.parts)).join('\n');
  const g = geminiBody.generationConfig || {};
  const body = {
    model: model.includes('/') ? model : `google/${model}`, // a bare Gemini name means Google's model
    messages: [...(system ? [{ role: 'system', content: system }] : []), { role: 'user', content: user }],
    usage: { include: true },
    reasoning: !thinking || thinking === 'off' ? { enabled: false } : { effort: thinking },
  };
  if (jsonOnly || !g.responseSchema) {
    body.response_format = { type: 'json_object' };
    return body;
  }
  body.provider = { require_parameters: true };
  body.response_format = { type: 'json_schema', json_schema: { name: 'weave', strict: false, schema: g.responseSchema } };
  return body;
}

// One request. Returns { text, costUsd }; throws an Error with status on HTTP failure (402: credits used up).
export async function callOpenRouter({ fetchImpl = globalThis.fetch, apiKey, model, body, thinking = 'off', timeoutMs = 20000 }) {
  const signal = AbortSignal.timeout(timeoutMs);
  const send = async (jsonOnly) => {
    try {
      return await fetchImpl(OPENROUTER_URL, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(toOpenRouterBody(model, body, { thinking, jsonOnly })),
        signal,
      });
    } catch (e) {
      if (e?.name === 'TypeError') e.network = true;
      throw e;
    }
  };
  let res = await send(false);
  let raw = '';
  try { raw = await res.text(); } catch { /* status alone is enough */ }
  // No endpoint takes the schema: once more in plain JSON mode.
  if (res.status === 404 || (res.status === 400 && /endpoint|support|response_format/i.test(raw))) {
    res = await send(true);
    try { raw = await res.text(); } catch { raw = ''; }
  }
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status}`);
    error.status = res.status;
    if (res.status === 401 || res.status === 403) error.keyRejected = true;
    throw error;
  }
  const data = JSON.parse(raw);
  const cost = Number(data?.usage?.cost);
  return { text: String(data?.choices?.[0]?.message?.content || ''), costUsd: cost > 0 ? cost : 0 };
}
