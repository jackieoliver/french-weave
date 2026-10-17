// Which pending passages the next swaps request carries (content.js). No chrome APIs.
export const BATCH_SIZE = 8; // the worker takes at most 8 passages a request

// How far an element is from the window, in pixels (0 when any of it shows); top breaks ties, so on-screen
// passages go top to bottom.
export function placeOf(el, viewHeight) {
  const r = el.getBoundingClientRect();
  return { gap: r.bottom < 0 ? -r.bottom : r.top > viewHeight ? r.top - viewHeight : 0, top: r.top };
}

// pending: Map<key, { text, els: Set }>; sent: keys already out; keyOf(el): the key the element was last read as.
// Nearest the window first, not first come: on an infinite timeline the oldest pending passages are the ones that
// scrolled away. A passage whose elements have all left the page (the timeline unmounts what scrolled past) or now
// show other text is dropped from pending: if it comes back, it is asked for again then, or painted at once from the
// page's memo when its answer already came.
export function pickBatch(pending, sent, keyOf, viewHeight, size = BATCH_SIZE) {
  const ranked = [];
  for (const [key, p] of pending) {
    if (sent.has(key)) continue;
    for (const el of p.els) if (!el.isConnected || keyOf(el) !== key) p.els.delete(el);
    if (!p.els.size) { pending.delete(key); continue; }
    const places = [...p.els].map((el) => placeOf(el, viewHeight));
    ranked.push({ key, text: p.text, gap: Math.min(...places.map((x) => x.gap)), top: Math.min(...places.map((x) => x.top)) });
  }
  ranked.sort((a, b) => a.gap - b.gap || a.top - b.top);
  return ranked.slice(0, size).map(({ key, text }) => ({ key, text }));
}
