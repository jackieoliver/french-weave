// What the popup and the toolbar badge say when Gemini requests fail. The worker stores modelStatus as
// { at, error, kind, httpStatus, googleStatus, retryAt }: kind is one of the cases below, httpStatus the HTTP code,
// googleStatus Google's status word (RESOURCE_EXHAUSTED), retryAt when calls start again. error keeps the raw
// message the engine threw, which pages also get.

// "5:00 PM" or "17:00", the reader's own clock.
export const clockTime = (ms) => new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
// The same, with "tomorrow" when that is not today (a limit can run a full day from when it was hit).
const when = (ms, now) => `${new Date(ms).toDateString() === new Date(now).toDateString() ? '' : 'tomorrow '}about ${clockTime(ms)}`;

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
export function modelErrorText(modelStatus, now = Date.now()) {
  const s = modelStatus || {};
  if (!s.error || !s.kind) return ''; // no kind: stored before 0.2.2, see replaceLegacyStatus
  const code = s.httpStatus;
  switch (s.kind) {
    case 'daily': return `Daily Gemini limit reached (${code || 429})${!s.retryAt ? '' : s.retryAt > now
      ? `; resumes ${when(s.retryAt, now)}` : '; should work again with the next page'}`;
    case 'rate': return `Gemini rate limit (${code || 429}). Retrying shortly.`;
    case 'key': return s.keyName === 'backup' ? `Gemini rejected the backup key (${code}). Paste a new one under Backup and paid keys.`
      : `Gemini rejected the key (${code}). Paste a new one below.`;
    case 'busy': return `Gemini is busy (${code || 'timed out'}). Retrying.`;
    case 'network': return "Can't reach Gemini.";
    case 'other': return code ? `Gemini request failed (${[code, s.googleStatus].filter(Boolean).join(' ')}).` : `Gemini request failed: ${s.error}`;
    default: return s.error; // the local daily cap
  }
}

// A failure stored before 0.2.2 has no kind, and its text can be wrong (0.2.1 said "Model rate limit; retrying
// shortly" for the per-day quota). Its replacement: the local cap's notice (localCap, its text) while today's calls are
// used up; else the daily notice while every model the next request would try still has its per-day quota spent
// (dailyQuota: { model: until ms }, which builds after 2026-10-15 13:30 still labelled 0.2.1 stored); else no error.
// null: nothing to replace.
export function replaceLegacyStatus(modelStatus, dailyQuota, models, now = Date.now(), localCap = '') {
  if (!modelStatus?.error || modelStatus.kind) return null;
  if (localCap) return { at: now, error: localCap, kind: 'local' };
  const until = models.map((m) => Number(dailyQuota?.[m]) || 0);
  if (!until.length || !until.every((t) => t > now)) return { at: now, error: '' };
  const retryAt = Math.min(...until);
  return { at: now, error: `Daily Gemini limit reached; resumes about ${clockTime(retryAt)}`, kind: 'daily', retryAt,
    httpStatus: 429, googleStatus: '' };
}

// The popup's OpenRouter line: today's spend against the cap, or why it stopped (st: the worker's status reply).
export function openRouterText(st, cap) {
  if (!st.openRouterKey && !st.hostOpenRouterKey) {
    return 'Optional, paid: Claude Haiku 5.5 goes first (direct instead with an Anthropic key); otherwise used only when every Gemini step fails.';
  }
  const spent = `OpenRouter today: $${(st.openRouter?.usd || 0).toFixed(4)} of $${Number(cap).toFixed(2)}`;
  if (st.openRouter?.blocked === 'credits') return `${spent}. Credits used up (402): stopped until tomorrow.`;
  if (st.openRouter?.blocked === 'cap') return `${spent}. Daily cap reached: stopped until tomorrow.`;
  if (st.openRouter?.blocked === 'key') return `${spent}. OpenRouter rejected the key: stopped until tomorrow or a new key.`;
  return spent;
}

// The popup's Anthropic line, the same way: the direct Claude Haiku 5.5 step.
export function anthropicText(st, cap) {
  if (!st.anthropicKey && !st.hostAnthropicKey) return 'Optional, paid: Claude Haiku 5.5 goes first, straight to Anthropic (OpenRouter is then not used for it).';
  const spent = `Anthropic today: $${(st.anthropic?.usd || 0).toFixed(4)} of $${Number(cap).toFixed(2)}`;
  if (st.anthropic?.blocked === 'credits') return `${spent}. Credit balance too low: stopped until tomorrow or a new key.`;
  if (st.anthropic?.blocked === 'cap') return `${spent}. Daily cap reached: stopped until tomorrow.`;
  if (st.anthropic?.blocked === 'key') return `${spent}. Anthropic rejected the key: stopped until tomorrow or a new key.`;
  return spent;
}
