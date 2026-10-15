// Content script: watch readable text (tweets on X, prose elsewhere), ask the background for swaps, paint them,
// show the gloss on hover or focus, handle click/Enter flip and seen/peek/flip events. Every async reply belongs to one config generation.
import { flatten, applySwaps, revert, toggle, isSwap, swapWord, SWAP_CLASS } from './text.js';
import { hashKey } from './hash.js';
import { siteEnabled, hasSiteAccess } from './settings.js';
import { selector, readable } from './page.js';

let config = null;
let observer = null;
let near = null;
let visible = null;
let timer = null;
let generation = 0;
const memo = new Map();
const keys = new WeakMap(); // element -> revision:text hash, kept off the DOM so pages can't read it
const pending = new Map();
const inflight = new Set();
const tracked = new Set();
const visibleWords = new Set();
const seen = new Set();
const failures = new Map(); // text key -> failed model attempts; retried with backoff
const MAX_RETRIES = 3;
// Live text (countdowns, tickers, "updated 5s ago") would cost a model call per change, and a page that undoes
// swaps would be repainted forever. Such an element stays English until the next page view.
const CHURN = { asks: 3, paints: 6 }; // new texts needing a model call / repaints, per element per window
const CHURN_WINDOW_MS = 60000;
let churn = new WeakMap(); // element -> { text, asks: [ms], paints: [ms], live }
// The gloss shows at once, but only a pointer that stays on the word this long counts as a peek, so passing the
// mouse over a word on the way somewhere else doesn't hold it back.
const PEEK_DWELL_MS = 700;
let peekTimer = null;
// After the extension reloads itself for an update, this copy is cut off from the worker. It then goes quiet:
// no more requests or errors, woven words stay as they are, and a page reload brings in the new copy.
let orphaned = false;
const alive = () => { try { return !orphaned && !!chrome.runtime?.id; } catch { return false; } };
function orphan() {
  if (orphaned) return;
  orphaned = true;
  generation++;
  observer?.disconnect(); observer = null;
  near?.disconnect(); visible?.disconnect();
  clearTimeout(timer); timer = null; clearInterval(navTimer); hideTip();
  pending.clear(); inflight.clear();
}
const send = (msg) => {
  if (!alive()) { orphan(); return Promise.reject(new Error('French Weave was reloaded')); }
  try {
    return chrome.runtime.sendMessage(msg).catch((e) => { if (!alive()) orphan(); throw e; });
  } catch (e) {
    orphan();
    return Promise.reject(e);
  }
};
const on = () => !orphaned && config?.hasKey && !config.paused && siteEnabled(config.settings, location.href) && hasSiteAccess(location.href, config.origins);
const targets = () => selector(location.href);
// Only real user input on spans this extension made; pages can't forge flips, peeks or seen events.
const swapFor = (e) => {
  const span = e.isTrusted && e.target?.closest?.(`span.${SWAP_CLASS}`);
  return span && isSwap(span) ? span : null;
};

function record(span, event) {
  const word = swapWord(span);
  if (!word || !on()) return;
  const id = new Date().toISOString().slice(0, 10) + ':' + event + ':' + word;
  const daily = event === 'seen' || event === 'peek';
  if (daily && seen.has(id)) return;
  if (daily) seen.add(id);
  void send({ type: 'event', word, event }).then((r) => {
    if (!r?.ok && daily) seen.delete(id);
  }).catch(() => { if (daily) seen.delete(id); });
}
// The gloss shows on the same event that brings the pointer or focus to a word; a dwell counts as a peek.
function hideTip() {
  clearTimeout(peekTimer); peekTimer = null;
  for (const el of document.querySelectorAll(`.${SWAP_CLASS}.fw-tip`)) el.classList.remove('fw-tip');
}
function showTip(e) {
  const span = swapFor(e);
  if (!span || !on()) return;
  if (!alive()) { orphan(); return; } // reloaded: no gloss that would vanish when the peek can't be sent
  if (span.classList.contains('fw-en')) { hideTip(); return; } // English showing: nothing to gloss
  if (!span.classList.contains('fw-tip')) { hideTip(); span.classList.add('fw-tip'); }
  if (e.type !== 'mouseover' || peekTimer) return; // a page can focus a span from script, so focus never counts
  peekTimer = setTimeout(() => {
    peekTimer = null;
    if (span.isConnected && span.classList.contains('fw-tip')) record(span, 'peek');
  }, PEEK_DWELL_MS);
}
function disarmTip(e) {
  const span = swapFor(e);
  if (span && !span.contains(e.relatedTarget)) hideTip();
}
function seenVisible() {
  if (document.visibilityState === 'hidden') return;
  for (const span of visibleWords) if (span.isConnected) record(span, 'seen');
}
function paint(el, key) {
  if (!on() || keys.get(el) !== key || !readable(el, location.href)) return;
  const swaps = memo.get(key);
  if (!swaps?.length || busy(el, 'paints')) return;
  applySwaps(el, swaps);
  for (const span of el.querySelectorAll(`.${SWAP_CLASS}`)) if (isSwap(span)) visible.observe(span);
  observer?.takeRecords();
}
// True when this element churns; same-text retries never count as a new ask.
function busy(el, kind, text = '') {
  const c = churn.get(el) || { text: '', asks: [], paints: [], live: false };
  churn.set(el, c);
  if (c.live || (kind === 'asks' && c.text === text)) return c.live;
  const now = Date.now();
  c[kind] = c[kind].filter((t) => now - t < CHURN_WINDOW_MS);
  if (c[kind].length >= CHURN[kind]) return (c.live = true);
  c[kind].push(now);
  if (kind === 'asks') c.text = text;
  return false;
}
function consider(el) {
  if (!on() || !el.isConnected) return;
  if (el.querySelector(`.${SWAP_CLASS}`)) revert(el);
  observer?.takeRecords();
  if (!readable(el, location.href)) { keys.delete(el); return; }
  const text = flatten(el).text;
  const key = `${config.revision}:${hashKey(text)}`;
  keys.set(el, key);
  if (memo.has(key)) { paint(el, key); return; }
  if (busy(el, 'asks', text)) return;
  let p = pending.get(key);
  if (!p) { p = { text, els: new Set() }; pending.set(key, p); }
  p.els.add(el);
  if (!timer) timer = setTimeout(flush, 250);
}
async function flush() {
  timer = null;
  if (!on()) return;
  const gen = generation;
  const items = [...pending].filter(([key]) => !inflight.has(key)).slice(0, 8).map(([key, p]) => ({ key, text: p.text }));
  if (!items.length) return;
  for (const i of items) inflight.add(i.key);
  let result;
  try { result = await send({ type: 'swaps', revision: config.revision, items }); }
  catch { result = { error: 'Extension unavailable' }; }
  if (gen !== generation || !on()) return;
  for (const i of items) {
    inflight.delete(i.key);
    const p = pending.get(i.key);
    pending.delete(i.key);
    const swaps = result?.results?.[i.key];
    if (!Array.isArray(swaps)) {
      // A failed model call (usually the free tier's rate limit) is retried instead of leaving the passage English.
      const tries = (failures.get(i.key) || 0) + 1;
      failures.set(i.key, tries);
      if (p && tries <= MAX_RETRIES) {
        const wait = Math.max(result?.retryAfterMs || 0, 5000 * tries);
        setTimeout(() => { if (gen === generation) for (const el of p.els) if (keys.get(el) === i.key) { keys.delete(el); consider(el); } }, wait);
      }
      continue;
    }
    failures.delete(i.key);
    memo.set(i.key, swaps);
    if (p) for (const el of p.els) paint(el, i.key);
  }
  if (result?.stale) { try { update(await send({ type: 'config' })); } catch { /* reloaded or gone */ } return; }
  if ([...pending.keys()].some((k) => !inflight.has(k))) timer = setTimeout(flush, 50);
}
function track(root) {
  if (root.nodeType !== 1) return;
  const elements = root.matches(targets()) ? [root, ...root.querySelectorAll(targets())] : root.querySelectorAll(targets());
  for (const el of elements) {
    if (tracked.has(el) || !readable(el, location.href)) continue;
    tracked.add(el);
    near.observe(el);
  }
}
function mutations(records) {
  const changed = new Set();
  for (const r of records) {
    for (const n of r.addedNodes || []) if (n.nodeType === 1) track(n);
    const base = r.target.nodeType === 1 ? r.target : r.target.parentElement;
    const el = base?.closest(targets());
    if (el && tracked.has(el)) changed.add(el);
    else if (el) track(el);
  }
  for (const el of changed) {
    if (el.querySelector(`.${SWAP_CLASS}`)) revert(el);
    keys.delete(el);
    if (readable(el, location.href)) { near.unobserve(el); near.observe(el); }
  }
  observer?.takeRecords();
  for (const el of tracked) if (!el.isConnected) { tracked.delete(el); near.unobserve(el); }
  for (const span of visibleWords) if (!span.isConnected) { visibleWords.delete(span); visible.unobserve(span); }
}
function start() {
  if (observer || !on()) return;
  visible = new IntersectionObserver((entries) => {
    for (const e of entries) {
      if (e.isIntersecting && e.intersectionRatio >= 0.5) visibleWords.add(e.target);
      else visibleWords.delete(e.target);
    }
    seenVisible();
  }, { threshold: [0, 0.5] });
  near = new IntersectionObserver((entries) => {
    for (const e of entries) if (e.isIntersecting && !keys.has(e.target)) consider(e.target);
  }, { rootMargin: '600px' });
  observer = new MutationObserver(mutations);
  observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  track(document.documentElement);
}
function stop() {
  generation++;
  observer?.disconnect(); observer = null;
  near?.disconnect(); visible?.disconnect();
  clearTimeout(timer); timer = null;
  pending.clear(); inflight.clear(); memo.clear(); failures.clear(); hideTip();
  churn = new WeakMap();
  for (const el of tracked) { revert(el); keys.delete(el); }
  tracked.clear(); visibleWords.clear();
}
function update(next, retry = false) {
  if (!next?.settings || !next.revision) return;
  if (!retry && next.revision === config?.revision) return;
  stop(); config = next; start();
}
function reveal(e) {
  const span = swapFor(e);
  if (!span || !on()) return;
  if (e.type === 'keydown' && !['Enter', ' '].includes(e.key)) return;
  e.preventDefault(); e.stopPropagation();
  hideTip();
  if (toggle(span)) record(span, 'flip');
  observer?.takeRecords();
}
chrome.runtime.onMessage.addListener((msg) => {
  if (['config', 'retry'].includes(msg?.type)) update(msg.config, msg.type === 'retry');
});
document.addEventListener('click', reveal, true);
document.addEventListener('keydown', reveal, true);
document.addEventListener('mouseover', showTip, true);
document.addEventListener('focusin', showTip, true);
document.addEventListener('mouseout', disarmTip, true);
document.addEventListener('focusout', disarmTip, true);
window.addEventListener('scroll', hideTip, { passive: true, capture: true });
document.addEventListener('visibilitychange', seenVisible);
window.addEventListener('online', () => { void send({ type: 'config' }).then((c) => update(c, true)).catch(() => {}); });
// SPA navigation can reuse DOM nodes without changing their text.
let page = location.href;
const navTimer = setInterval(() => {
  if (page !== location.href) { page = location.href; if (config) update(config, true); }
}, 1000);
void send({ type: 'config' }).then(update).catch(() => {});
