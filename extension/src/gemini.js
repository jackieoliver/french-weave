// Gemini generateContent call. No chrome APIs; fetch is injectable for tests.
export const MODELS = {
  'gemini-3.5-flash-lite': 'Gemini 3.5 Flash-Lite',
  'gemini-3.8-flash': 'Gemini 3.8 Flash',
};
export const FALLBACK_MODEL = { 'gemini-3.8-flash': 'gemini-3.5-flash-lite' };
export const THINKING_LEVEL = 'low';
export const API_BASE = 'https://generativelanguage.googleapis.com/v1beta/models/';

export function buildRequest({ system, user, schema, thinkingLevel = THINKING_LEVEL }) {
  return {
    systemInstruction: { parts: [{ text: system }] },
    contents: [{ role: 'user', parts: [{ text: user }] }],
    generationConfig: {
      responseMimeType: 'application/json',
      responseSchema: schema,
      thinkingConfig: { thinkingLevel },
    },
  };
}

// Returns Map<id, swaps[]> from the model's JSON. Throws on HTTP error, timeout, or unparseable output.
export async function callGemini({ fetchImpl = globalThis.fetch, apiKey, model, body, timeoutMs = 20000 }) {
  const res = await fetchImpl(`${API_BASE}${model}:generateContent`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-goog-api-key': apiKey },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(timeoutMs),
  });
  if (!res.ok) {
    const error = new Error(`HTTP ${res.status}`);
    error.status = res.status;
    // 429 bodies carry RetryInfo ("retryDelay": "36s"); fall back to Retry-After. A free-tier daily quota says
    // hours (gemini-3.8-flash allows 20 requests a day), so honor up to a day instead of retrying every 10 minutes.
    let detail = '';
    try { detail = await res.text(); } catch { /* status alone is enough */ }
    const delay = Number(/"retryDelay"\s*:\s*"(\d+(?:\.\d+)?)s"/.exec(detail)?.[1] || res.headers?.get?.('retry-after'));
    if (delay > 0) error.retryAfterMs = Math.min(delay, 86400) * 1000;
    Object.assign(error, quotaFailure(detail));
    if (error.daily && !error.retryAfterMs) error.retryAfterMs = DAILY_RECHECK_MS;
    throw error;
  }
  const data = await res.json();
  const text = (data?.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
  return parseSwapsResponse(text);
}

// A daily quota without a retry time is checked again after this long.
export const DAILY_RECHECK_MS = 3600000;

// The quota a 429 names (google.rpc.QuotaFailure): daily when its quotaId is a per-day one
// ("GenerateRequestsPerDayPerProjectPerModel-FreeTier"), with the day's limit when given (quotaValue "500").
export function quotaFailure(detail) {
  let body = null;
  try { body = JSON.parse(detail); } catch { return {}; }
  const violations = (Array.isArray(body?.error?.details) ? body.error.details : []).flatMap((d) => (Array.isArray(d?.violations) ? d.violations : []));
  const day = violations.find((v) => /PerDay/.test(String(v?.quotaId || '')));
  const any = day || violations.find((v) => v?.quotaId);
  if (!any) return {};
  const limit = Number(day?.quotaValue);
  return { quotaId: String(any.quotaId), ...(day ? { daily: true } : {}), ...(limit > 0 ? { dailyLimit: limit } : {}) };
}

export function parseSwapsResponse(text) {
  const data = JSON.parse(text);
  const out = new Map();
  for (const t of data?.passages || data?.tweets || []) {
    // topic "avoid": the model judged the page or passage a zero-language topic; nothing is swapped.
    if (t && typeof t.id === 'string') out.set(t.id, t.topic !== 'avoid' && Array.isArray(t.swaps) ? t.swaps : []);
  }
  return out;
}
