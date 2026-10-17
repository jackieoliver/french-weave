// A page's part of the dev build's usage log (usage.js): what happened to passages in this page's queue. Retries
// and their reason, passages given up after the last retry, passages whose element left the page while queued, and
// passages cancelled when the page changed (navigation or a new config). Counts and short reasons only, never text.
// Sent to the worker every few seconds, and only while its config says the log is on (config.usage).
let config = () => null;
let send = null;
let timer = null;
const queue = [];
const counted = new WeakSet(); // pending entries already counted as unmounted
export const SEND_DELAY_MS = 5000;

// getConfig: the page's current config; sendMessage: content.js's send to the worker.
export function init(getConfig, sendMessage) {
  config = getConfig;
  send = sendMessage;
  globalThis.addEventListener?.('pagehide', sendNow);
}

const active = () => { try { return !!config()?.usage; } catch { return false; } };

function push(event) {
  if (!active()) return;
  queue.push(event);
  if (queue.length > 50) queue.splice(0, queue.length - 50);
  if (!timer) timer = setTimeout(sendNow, SEND_DELAY_MS);
}

export function sendNow() {
  clearTimeout(timer);
  timer = null;
  if (!queue.length || !send) return;
  const events = queue.splice(0);
  try { void Promise.resolve(send({ type: 'usage', events })).catch(() => {}); } catch { /* reloaded */ }
}

// The worker's reply for a passage had no swaps: a short reason from what it said (never its text).
export function reasonOf(result) {
  const error = String(result?.error || '');
  if (!result) return 'no_reply';
  if (result.stale) return 'stale';
  if (!error) return 'missing';
  if (/unavailable|reloaded/i.test(error)) return 'unavailable';
  if (/Daily limit of/i.test(error)) return 'cap';
  if (/daily/i.test(error)) return 'daily_quota';
  if (/rate limit|429/i.test(error)) return 'rate_limit';
  if (/busy|timeout|5\d\d/i.test(error)) return 'busy';
  if (/no model key/i.test(error)) return 'no_key';
  return 'error';
}

// A passage's model call failed for the tries-th time: a retry while tries <= max, else given up (counted once).
export function retry(tries, max, result) {
  if (tries <= max) push({ what: 'retry', n: 1, attempt: tries, reason: reasonOf(result) });
  else if (tries === max + 1) push({ what: 'gave_up', n: 1, reason: reasonOf(result) });
}

// The page stopped this config's work: passages in flight (their replies are dropped) and still queued.
export function cancelled(inflight, pending) {
  if (inflight || pending) push({ what: 'cancelled', n: inflight || 0, pending: pending || 0, reason: 'page_changed' });
}

// After DOM changes: queued passages whose every element has left the page.
export function unmounted(pending) {
  if (!active()) return;
  let n = 0;
  for (const p of pending.values()) {
    if (counted.has(p) || !p?.els?.size) continue;
    let gone = true;
    for (const el of p.els) if (el.isConnected) { gone = false; break; }
    if (gone) { counted.add(p); n++; }
  }
  if (n) push({ what: 'unmounted', n });
}
