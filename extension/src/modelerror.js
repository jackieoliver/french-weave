// What the popup and the toolbar badge say when Gemini requests fail. The worker stores modelStatus as
// { at, error, kind, httpStatus, googleStatus, retryAt }: kind is one of the cases below, httpStatus the HTTP code,
// googleStatus Google's status word (RESOURCE_EXHAUSTED), retryAt when calls start again. error keeps the raw
// message the engine threw, which pages also get.

// "5:00 PM" or "17:00", the reader's own clock.
export const clockTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

// The case a failed request falls in. daily: Google's per-day quota; rate: per-minute 429; key: Google refused the
// key (a 400 only when its body says so, since a malformed request is a 400 too); busy: 5xx or no answer in time;
// network: no answer at all; other: anything else (a 404 for a retired model, a broken response).
export function errorKind({ status, daily, timeout, network, keyRejected } = {}) {
  if (daily) return 'daily';
  if (status === 429) return 'rate';
  if (status === 401 || status === 403 || (status === 400 && keyRejected)) return 'key';
  if (timeout || status >= 500) return 'busy';
  if (network) return 'network';
  return 'other';
}

// One plain line with the HTTP code and when it retries; '' when the last request worked.
export function modelErrorText(modelStatus) {
  const s = modelStatus || {};
  if (!s.error) return '';
  const code = s.httpStatus;
  switch (s.kind) {
    case 'daily': return `Daily Gemini limit reached (${code || 429})${s.retryAt ? `; resumes about ${clockTime(s.retryAt)}` : ''}`;
    case 'rate': return `Gemini rate limit (${code || 429}). Retrying shortly.`;
    case 'key': return `Gemini rejected the key (${code}). Paste a new one below.`;
    case 'busy': return `Gemini is busy (${code || 'timed out'}). Retrying.`;
    case 'network': return "Can't reach Gemini.";
    case 'other': return code ? `Gemini request failed (${[code, s.googleStatus].filter(Boolean).join(' ')}).` : `Gemini request failed: ${s.error}`;
    default: return s.error; // the local daily cap, and statuses stored before kinds existed
  }
}
