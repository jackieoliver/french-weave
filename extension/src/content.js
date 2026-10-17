// Content script: watch readable text (tweets on X, prose elsewhere), ask the background for swaps, paint them,
// show the gloss on hover or focus (with a speaker button when a voice exists), handle click/Enter flip and
// seen/peek/flip events. Every async reply belongs to one config generation.
import { flatten, applySwaps, revert, toggle, isSwap, swapWord, SWAP_CLASS } from './text.js';
import { hashKey } from './hash.js';
import { siteEnabled, hasSiteAccess } from './settings.js';
import { selector, readable } from './page.js';
import { voiceFor } from './speech.js';

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
// Pronunciation: with a browser voice for the woven language, the gloss box starts with a speaker button (fw-say)
// that says the word on a click or key press, never on its own. Without a voice there is no button.
const speech = globalThis.speechSynthesis;
let voice; // undefined: pick again (voices load after the page and can change)
let voiceLanguage = '';
speech?.addEventListener?.('voiceschanged', () => { voice = undefined; });
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
const on = () => !orphaned && config?.tier && config.tier !== 'none' && !config.paused && siteEnabled(config.settings, location.href) && hasSiteAccess(location.href, config.origins);
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
function voiceNow() {
  if (!speech) return null;
  const language = config?.language || 'French';
  if (voice === undefined || voiceLanguage !== language) {
    voiceLanguage = language;
    voice = voiceFor(speech.getVoices(), language);
  }
  return voice;
}
const SVG = 'http://www.w3.org/2000/svg';
function speakerIcon() {
  const svg = document.createElementNS(SVG, 'svg');
  for (const [k, v] of Object.entries({ viewBox: '0 0 16 16', width: '12', height: '12', 'aria-hidden': 'true' })) svg.setAttribute(k, v);
  const cone = document.createElementNS(SVG, 'path');
  cone.setAttribute('d', 'M2 6h3l4-3v10l-4-3H2z');
  cone.setAttribute('fill', 'currentColor');
  const waves = document.createElementNS(SVG, 'path');
  for (const [k, v] of Object.entries({ d: 'M11.5 5.5a3.5 3.5 0 0 1 0 5M13.5 3.5a6.5 6.5 0 0 1 0 9', fill: 'none',
    stroke: 'currentColor', 'stroke-width': '1.5', 'stroke-linecap': 'round' })) waves.setAttribute(k, v);
  svg.append(cone, waves);
  return svg;
}
function speakerButton(span, v) {
  const word = span.getAttribute('data-fr') || '';
  const button = document.createElement('fw-say');
  button.setAttribute('role', 'button');
  button.tabIndex = -1; // reached from its word (speakerInput), never as a stop of its own at the end of the page
  button.setAttribute('aria-label', `Say ${word}`);
  // Chrome's "Google" voices (and other online ones) send the text off to be spoken; the button says so.
  const online = /^google/i.test(v.name) ? ' (online voice: the word is sent to Google)' : ' (online voice: the word leaves this computer)';
  button.title = `Say "${word}"${v.localService ? '' : online}`;
  button.append(speakerIcon());
  return button;
}
function say(span) {
  const v = voiceNow();
  if (!v || !span.isConnected) return;
  const utterance = new globalThis.SpeechSynthesisUtterance(span.getAttribute('data-fr') || '');
  utterance.voice = v;
  utterance.lang = v.lang;
  // Queued after anything already being said: cancel() would empty the page's own speech queue too.
  speech.speak(utterance);
}
// The gloss is one box for the whole page, fixed to the viewport and placed over the word, so a container with
// overflow: hidden (quoted posts on X, comment threads) can't clip or hide it the way a box inside the word could.
// It sits outside every text block the extension reads and lets the pointer through to the page; only the speaker
// button (first, above the start of the word) takes it. The gloss text is hidden from screen readers (the word's
// aria-label carries it); the button is not.
let tipBox = null;
let tipWord = null; // the word the open gloss belongs to
let tipButton = null; // its speaker, when a voice says the language
const TIP_GAP = 4; // content.css's bridge from the speaker down to the word spans this gap
// With a speaker, a pointer leaving the word or the speaker gets this long to reach the other by any route (the box
// sits off to the side of a word near the window's edge, and the bridge only covers the way straight up).
const TIP_GRACE_MS = 300;
let graceTimer = null;
// A modal <dialog> makes everything outside it inert, the gloss box included, so its speaker could not be pressed.
const modalOpen = () => { try { return !!document.querySelector('dialog:modal'); } catch { return false; } };
function placeTip(span) {
  if (!tipBox?.isConnected) {
    tipBox = document.createElement('fw-gloss');
    tipBox.className = 'fw-gloss';
    document.documentElement.append(tipBox);
  }
  const text = document.createElement('fw-text');
  text.setAttribute('aria-hidden', 'true');
  text.textContent = span.getAttribute('data-tip') || '';
  const v = modalOpen() ? null : voiceNow();
  tipButton = v ? speakerButton(span, v) : null;
  tipBox.replaceChildren(...(tipButton ? [tipButton] : []), text);
  tipBox.classList.toggle('fw-gloss-say', !!tipButton);
  tipBox.classList.add('fw-gloss-on');
  tipWord = span;
  moveTip(span);
}
function moveTip(span) {
  const word = span.getBoundingClientRect();
  const box = tipBox.getBoundingClientRect();
  const width = document.documentElement.clientWidth || window.innerWidth;
  const above = word.top - box.height - TIP_GAP >= 0;
  tipBox.classList.toggle('fw-gloss-below', !above); // the speaker's bridge then reaches up to the word
  tipBox.style.left = `${Math.max(TIP_GAP, Math.min(word.left, width - box.width - TIP_GAP))}px`;
  tipBox.style.top = `${above ? word.top - box.height - TIP_GAP : word.bottom + TIP_GAP}px`;
}
// The gloss shows on the same event that brings the pointer or focus to a word; a dwell counts as a peek.
function hideTip() {
  clearTimeout(peekTimer); peekTimer = null;
  clearTimeout(graceTimer); graceTimer = null;
  // Keyboard focus on the speaker goes back to its word rather than staying in a hidden box.
  if (tipButton && document.activeElement === tipButton && tipWord?.isConnected) tipWord.focus({ preventScroll: true });
  for (const el of document.querySelectorAll(`.${SWAP_CLASS}.fw-tip`)) el.classList.remove('fw-tip');
  tipBox?.classList.remove('fw-gloss-on');
  tipWord = null; tipButton = null;
}
// A scroll moves the page under a resting pointer, so it closes the gloss; but while the speaker has keyboard focus
// the gloss follows its word instead of taking the focused button away.
function scrolled() {
  if (tipButton && tipWord?.isConnected && document.activeElement === tipButton) moveTip(tipWord);
  else hideTip();
}
function showTip(e) {
  // The speaker counts as its word: reaching it keeps the gloss, and time on it is time on the word.
  const span = swapFor(e) || (e.isTrusted && tipButton?.contains(e.target) ? tipWord : null);
  if (!span || !on()) return;
  if (!alive()) { orphan(); return; } // reloaded: no gloss that would vanish when the peek can't be sent
  // Keyboard focus on the speaker keeps its gloss: a pointer resting on another word (the page scrolled under it)
  // would otherwise take the box, and the focused button with it.
  if (e.type === 'mouseover' && span !== tipWord && tipButton && document.activeElement === tipButton) return;
  if (span.classList.contains('fw-en')) { hideTip(); return; } // English showing: nothing to gloss
  clearTimeout(graceTimer); graceTimer = null;
  if (!span.classList.contains('fw-tip')) { hideTip(); span.classList.add('fw-tip'); placeTip(span); }
  if (e.type !== 'mouseover' || peekTimer) return; // a page can focus a span from script, so focus never counts
  peekTimer = setTimeout(() => {
    peekTimer = null;
    if (span.isConnected && span.classList.contains('fw-tip')) record(span, 'peek');
  }, PEEK_DWELL_MS);
}
// Leaving the word or its speaker closes the gloss, unless the pointer or focus is going from one to the other. A
// pointer leaving for anywhere else stops the dwell at once, but with a speaker the box waits TIP_GRACE_MS for it.
function disarmTip(e) {
  const from = swapFor(e) || (e.isTrusted && tipButton?.contains(e.target) ? tipButton : null);
  if (!from || (from !== tipWord && from !== tipButton)) return;
  const into = (el) => !!el?.contains(e.relatedTarget);
  if (into(tipWord) || into(tipButton)) return;
  // Another window or tab taking focus: the speaker gets it back on return, so its gloss stays.
  if (e.type === 'focusout' && from === tipButton && !e.relatedTarget && !document.hasFocus()) return;
  if (e.type === 'focusout' || !tipButton) { hideTip(); return; }
  clearTimeout(peekTimer); peekTimer = null;
  if (document.activeElement === tipButton) return; // keyboard focus is on the speaker: only focus leaving closes it
  clearTimeout(graceTimer); graceTimer = setTimeout(hideTip, TIP_GRACE_MS);
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
  try { result = await send({ type: 'swaps', revision: config.revision, items, title: document.title }); }
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
  voiceNow(); // Chrome starts loading its voice list on the first ask, so it is there by the first hover
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
// The speaker is in the gloss box, not in the word, so keyboard focus is carried across: Tab from a word whose
// gloss is open goes to its speaker, Shift+Tab goes back, and Tab from the speaker carries on from the word.
// A click, Enter or Space on the speaker says the word; it is never a flip. True when the event was the speaker's.
function speakerInput(e) {
  if (!e.isTrusted || !tipButton || !tipWord?.isConnected || !on()) return false;
  if (e.type === 'keydown' && e.key === 'Tab' && !e.altKey && !e.ctrlKey && !e.metaKey) {
    if (e.target === tipWord && !e.shiftKey) {
      if (tipWord.closest('[aria-modal="true"]')) return false; // the page's own focus trap would pull focus straight back
      tipButton.focus({ preventScroll: true });
      if (document.activeElement !== tipButton) return false; // it could not take focus: the Tab is the page's
      e.preventDefault(); e.stopPropagation();
      return true;
    }
    if (e.target !== tipButton) return false;
    if (e.shiftKey) { e.preventDefault(); e.stopPropagation(); }
    tipWord.focus({ preventScroll: true }); // a plain Tab's own move then starts from the word
    return true;
  }
  if (!tipButton.contains(e.target)) return false;
  if (e.type === 'keydown' && !['Enter', ' '].includes(e.key)) return true;
  e.preventDefault(); e.stopPropagation();
  if (!e.repeat) say(tipWord); // a held key would queue the word over and over, and the queue is never cancelled
  return true;
}
// A press on the speaker leaves the page's focus where it was (a reply being typed, say), and goes no further than
// this listener (a page's own capturing listeners on window, or added before this script, still see it, as with flips).
function pressSpeaker(e) {
  if (!e.isTrusted || !tipButton?.contains(e.target)) return;
  if (e.type === 'mousedown') e.preventDefault();
  e.stopPropagation();
}
function reveal(e) {
  if (speakerInput(e)) return;
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
document.addEventListener('pointerdown', pressSpeaker, true);
document.addEventListener('mousedown', pressSpeaker, true);
document.addEventListener('mouseover', showTip, true);
document.addEventListener('focusin', showTip, true);
document.addEventListener('mouseout', disarmTip, true);
document.addEventListener('focusout', disarmTip, true);
window.addEventListener('scroll', scrolled, { passive: true, capture: true });
document.addEventListener('visibilitychange', seenVisible);
window.addEventListener('online', () => { void send({ type: 'config' }).then((c) => update(c, true)).catch(() => {}); });
// SPA navigation can reuse DOM nodes without changing their text.
let page = location.href;
const navTimer = setInterval(() => {
  if (page !== location.href) { page = location.href; if (config) update(config, true); }
}, 1000);
void send({ type: 'config' }).then(update).catch(() => {});
