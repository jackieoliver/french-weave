// Content script: watch readable text (tweets on X, prose elsewhere), ask the background for swaps, paint them,
// handle the delayed gloss, click/Enter flip and seen/peek/flip events. Every async reply belongs to one config generation.
import { flatten, applySwaps, revert, toggle, SWAP_CLASS } from './text.js';
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
const pending = new Map();
const inflight = new Set();
const tracked = new Set();
const visibleWords = new Set();
const seen = new Set();
const failures = new Map(); // text key -> failed model attempts; retried with backoff
const MAX_RETRIES = 3;
const TIP_DELAY_MS = 700; // a beat to recall the word before the meaning appears
let tipTimer = null;
const send = (msg) => chrome.runtime.sendMessage(msg);
const on = () => config?.hasKey && !config.paused && siteEnabled(config.settings, location.href) && hasSiteAccess(location.href, config.origins);
const targets = () => selector(location.href);

function record(span, event) {
  if (!span.dataset.fwWord || !on()) return;
  const id = new Date().toISOString().slice(0, 10) + ':' + event + ':' + span.dataset.fwWord;
  const daily = event === 'seen' || event === 'peek';
  if (daily && seen.has(id)) return;
  if (daily) seen.add(id);
  void send({ type: 'event', word: span.dataset.fwWord, event }).then((r) => {
    if (!r?.ok && daily) seen.delete(id);
  }).catch(() => { if (daily) seen.delete(id); });
}
// The gloss appears only after a short dwell; reaching it counts as a peek (the reader needed the meaning).
function hideTip() {
  clearTimeout(tipTimer); tipTimer = null;
  for (const el of document.querySelectorAll(`.${SWAP_CLASS}.fw-tip`)) el.classList.remove('fw-tip');
}
function armTip(e) {
  const span = e.target?.closest?.(`span.${SWAP_CLASS}`);
  if (!span || !on() || span.classList.contains('fw-tip')) return;
  hideTip();
  tipTimer = setTimeout(() => {
    tipTimer = null;
    if (!span.isConnected || span.classList.contains('fw-en')) return;
    span.classList.add('fw-tip');
    record(span, 'peek');
  }, TIP_DELAY_MS);
}
function disarmTip(e) {
  const span = e.target?.closest?.(`span.${SWAP_CLASS}`);
  if (span && !span.contains(e.relatedTarget)) hideTip();
}
function seenVisible() {
  if (document.visibilityState === 'hidden') return;
  for (const span of visibleWords) if (span.isConnected) record(span, 'seen');
}
function paint(el, key) {
  if (!on() || el.dataset.fwKey !== key || !readable(el, location.href)) return;
  const swaps = memo.get(key);
  if (!swaps?.length) return;
  applySwaps(el, swaps);
  for (const span of el.querySelectorAll(`.${SWAP_CLASS}`)) visible.observe(span);
  observer?.takeRecords();
}
function consider(el) {
  if (!on() || !el.isConnected) return;
  if (el.querySelector(`.${SWAP_CLASS}`)) revert(el);
  observer?.takeRecords();
  if (!readable(el, location.href)) { delete el.dataset.fwKey; return; }
  const text = flatten(el).text;
  const key = `${config.revision}:${hashKey(text)}`;
  el.dataset.fwKey = key;
  if (memo.has(key)) { paint(el, key); return; }
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
        setTimeout(() => { if (gen === generation) for (const el of p.els) if (el.dataset.fwKey === i.key) { delete el.dataset.fwKey; consider(el); } }, wait);
      }
      continue;
    }
    failures.delete(i.key);
    memo.set(i.key, swaps);
    if (p) for (const el of p.els) paint(el, i.key);
  }
  if (result?.stale) { update(await send({ type: 'config' })); return; }
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
    delete el.dataset.fwKey;
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
    for (const e of entries) if (e.isIntersecting && !e.target.dataset.fwKey) consider(e.target);
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
  for (const el of tracked) { revert(el); delete el.dataset.fwKey; }
  tracked.clear(); visibleWords.clear();
}
function update(next, retry = false) {
  if (!next?.settings || !next.revision) return;
  if (!retry && next.revision === config?.revision) return;
  stop(); config = next; start();
}
function reveal(e) {
  const span = e.target?.closest?.(`span.${SWAP_CLASS}`);
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
document.addEventListener('mouseover', armTip, true);
document.addEventListener('focusin', armTip, true);
document.addEventListener('mouseout', disarmTip, true);
document.addEventListener('focusout', disarmTip, true);
window.addEventListener('scroll', hideTip, { passive: true, capture: true });
document.addEventListener('visibilitychange', seenVisible);
window.addEventListener('online', () => { void send({ type: 'config' }).then((c) => update(c, true)).catch(() => {}); });
// SPA navigation can reuse DOM nodes without changing their text.
let page = location.href;
setInterval(() => {
  if (page !== location.href) { page = location.href; if (config) update(config, true); }
}, 1000);
void send({ type: 'config' }).then(update).catch(() => {});
