// Word state from the French Weave Claude Code plugin, through the Chrome native messaging host that its
// setup step installs. No chrome APIs here: the native-message function and storage are injected so this
// tests without Chrome. Without the host, the bundled lists in levels.js keep working.

export const HOST = 'com.frenchweave.host';
export const STATE_KEY = 'wordState';
export const PENDING_KEY = 'pendingEvents';
export const SENT_KEY = 'seenSent';

// Drops unusable rows, keeps the rest. Throws when nothing usable is left, so a bad reply never replaces a good list.
export function parseState(data) {
  const words = [];
  const seen = new Set();
  for (const w of data?.words || []) {
    if (!w || typeof w.fr !== 'string' || typeof w.en !== 'string') continue;
    const fr = w.fr.trim();
    const en = w.en.trim();
    if (!fr || !en || seen.has(fr)) continue;
    seen.add(fr);
    const reading = typeof w.reading === 'string' ? w.reading.trim() : ''; // kana and the like (profile script.reading)
    words.push({ fr, en, hint: typeof w.hint === 'string' ? w.hint.trim() : '', ...(reading ? { reading } : {}),
      status: typeof w.status === 'string' ? w.status : 'active' });
  }
  if (!words.length) throw new Error('host sent no usable words');
  const stage = Math.floor(Number(data?.stage));
  return {
    version: String(data?.version ?? ''),
    stage: stage >= 1 && stage <= 4 ? stage : 1,
    paused: data?.paused === true,
    sites: data?.prefs?.extension_sites === 'ask' ? 'ask' : 'all', // setup's default for sites not set in the popup
    // Another language set up with fw.py setup --language; absent means French.
    ...(/^[\p{L} ()-]{1,40}$/u.test(String(data?.language ?? '').trim()) && data.language.trim() !== 'French'
      ? { language: data.language.trim() } : {}),
    words,
  };
}

export async function readCached(storage) {
  const obj = await storage.get([STATE_KEY]);
  const s = obj?.[STATE_KEY];
  if (!s || !Array.isArray(s.words) || !s.words.length) return null;
  return s;
}

// Asks the host for the word state and stores it. Never throws: a missing host leaves the cached (or bundled)
// list in place and reports the reason. The keys the plugin's setup stored come along, kept separately.
export async function refresh({ storage, send, now = () => Date.now() }) {
  const cached = await readCached(storage);
  try {
    const reply = await send({ type: 'state' });
    if (!reply?.ok) throw new Error(reply?.error || 'no reply from the French Weave host');
    const state = parseState(reply);
    const changed = !cached || cached.version !== state.version;
    const stored = { ...state, fetchedAt: now() };
    const text = (v) => (typeof v === 'string' ? v : '');
    await storage.set({ [STATE_KEY]: stored, hostKey: text(reply.geminiKey), hostBackupKey: text(reply.geminiBackupKey),
      hostOpenRouterKey: text(reply.openRouterKey), hostAnthropicKey: text(reply.anthropicKey) });
    return { state: stored, changed, error: null };
  } catch (e) {
    return { state: cached, changed: false, error: String(e?.message || e) };
  }
}

export function localDay(d = new Date()) {
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

// Queues seen/flip/peek events. Seen and peek count once per word per day, so a busy timeline stays cheap.
export async function queueEvents(storage, events, day = localDay()) {
  const obj = await storage.get([PENDING_KEY, SENT_KEY]);
  const pending = Array.isArray(obj[PENDING_KEY]) ? obj[PENDING_KEY] : [];
  const sent = obj[SENT_KEY]?.day === day ? obj[SENT_KEY] : { day, words: [] };
  for (const e of events || []) {
    if (!e || typeof e.word !== 'string' || !['seen', 'flip', 'peek'].includes(e.kind)) continue;
    const word = e.word.toLowerCase();
    if (e.kind !== 'flip') {
      const tag = e.kind === 'seen' ? word : `${e.kind}:${word}`;
      if (sent.words.includes(tag)) continue;
      sent.words.push(tag);
    }
    pending.push({ word, kind: e.kind, day });
  }
  await storage.set({ [PENDING_KEY]: pending.slice(-500), [SENT_KEY]: sent });
  return pending.length;
}

// Words already seen today, so the prompt can put the ones not yet shown first.
export async function shownToday(storage, day = localDay()) {
  const obj = await storage.get([SENT_KEY]);
  const sent = obj?.[SENT_KEY];
  return sent?.day === day ? sent.words.filter((w) => !w.includes(':')) : [];
}

// Sends queued events to the host; keeps them queued if the host is missing or fails.
export async function flushEvents({ storage, send }) {
  const obj = await storage.get([PENDING_KEY]);
  const pending = Array.isArray(obj[PENDING_KEY]) ? obj[PENDING_KEY] : [];
  if (!pending.length) return { sent: 0 };
  try {
    const reply = await send({ type: 'events', events: pending });
    if (!reply?.ok) throw new Error(reply?.error || 'host refused events');
    const now = await storage.get([PENDING_KEY]);
    const rest = (now[PENDING_KEY] || []).slice(pending.length); // events queued while we were sending
    await storage.set({ [PENDING_KEY]: rest });
    return { sent: pending.length, applied: reply.applied };
  } catch (e) {
    return { sent: 0, error: String(e?.message || e) };
  }
}
