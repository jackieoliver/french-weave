// DOM side of a swap: flatten a tweet's text, locate the model's anchor, wrap one text-node slice.
// Pure DOM functions (use node.ownerDocument), so they run under happy-dom in tests.

const SKIP_TAGS = new Set(['A', 'CODE', 'PRE', 'BUTTON', 'INPUT', 'TEXTAREA', 'SELECT', 'SCRIPT', 'STYLE', 'KBD', 'SAMP']);
const WORD_CHAR = /[\p{L}\p{N}_]/u;
const TEXT_NODE = 3;
const ELEMENT_NODE = 1;
export const SWAP_CLASS = 'fw-word';
// Remember synthetic siblings so a framework replacing its original text node wins.
const splitGroups = new WeakMap();
const spanGroups = new WeakMap();

// Returns { text, map, segs, raw }:
//   raw   = every text node's data in order (plus emoji alt text), untouched
//   text  = raw with whitespace runs collapsed to one space and ends trimmed (what the model sees)
//   map   = text index -> raw index
//   segs  = [{ node, start, end, ok }] raw ranges; ok=false inside links/code/etc or for virtual text
export function flatten(root) {
  const segs = [];
  let raw = '';
  const push = (node, data, ok) => {
    if (!data) return;
    segs.push({ node, start: raw.length, end: raw.length + data.length, ok });
    raw += data;
  };
  const walk = (node, blocked) => {
    for (const child of node.childNodes) {
      if (child.nodeType === TEXT_NODE) {
        push(child, child.data, !blocked);
      } else if (child.nodeType === ELEMENT_NODE) {
        const tag = child.tagName;
        if (tag === 'IMG') {
          push(null, child.getAttribute('alt') || '', false);
        } else if (tag === 'BR') {
          push(null, '\n', false);
        } else if (child.classList && child.classList.contains(SWAP_CLASS)) {
          push(null, child.getAttribute('data-en') || child.textContent, false);
        } else {
          walk(child, blocked || SKIP_TAGS.has(tag) || child.matches('[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="button"],[hidden],[aria-hidden="true"],[translate="no"],.notranslate'));
        }
      }
    }
  };
  walk(root, false);

  let text = '';
  const map = [];
  let inWs = true; // trims leading whitespace
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (/\s/.test(ch)) {
      if (!inWs) {
        text += ' ';
        map.push(i);
        inWs = true;
      }
    } else {
      text += ch;
      map.push(i);
      inWs = false;
    }
  }
  if (text.endsWith(' ')) {
    text = text.slice(0, -1);
    map.pop();
  }
  return { text, map, segs, raw };
}

function findAll(text, needle, from, to) {
  const out = [];
  if (!needle) return out;
  let i = text.indexOf(needle, from);
  while (i !== -1 && i + needle.length <= to) {
    out.push(i);
    i = text.indexOf(needle, i + 1);
  }
  return out;
}

function wordMatches(text, needle, from, to) {
  return findAll(text, needle, from, to)
    .filter((i) => {
      const before = i === 0 ? '' : text[i - 1];
      const after = text[i + needle.length] ?? '';
      return (!before || !WORD_CHAR.test(before)) && (!after || !WORD_CHAR.test(after));
    })
    .map((i) => ({ start: i, end: i + needle.length }));
}

// Position of the swap in flat.text, or null. ctx narrows the search; a unique whole-text match is the fallback.
export function locate(flat, o, ctx) {
  const { text } = flat;
  if (!o) return null;
  if (ctx && ctx.length >= o.length) {
    const c = findAll(text, ctx, 0, text.length);
    if (c.length === 1) {
      const m = wordMatches(text, o, c[0], c[0] + ctx.length);
      if (m.length === 1) return m[0];
    }
  }
  const m = wordMatches(text, o, 0, text.length);
  return m.length === 1 ? m[0] : null;
}

// Map a flat.text range to one touchable text node. Null when it straddles nodes, sits in a link, etc.
export function toNode(flat, m, o) {
  const rs = flat.map[m.start];
  const re = flat.map[m.end - 1] + 1;
  if (rs === undefined || re === undefined) return null;
  if (flat.raw.slice(rs, re) !== o) return null;
  for (let i = 0; i < flat.segs.length; i++) {
    const s = flat.segs[i];
    if (s.node && s.ok && s.start <= rs && re <= s.end) {
      return { node: s.node, offset: rs - s.start, length: re - rs, seg: i };
    }
  }
  return null;
}

export function tipFor(swap) {
  return swap.h ? `${swap.g} · "${swap.h}"` : swap.g;
}

function wrap(place, swap) {
  const { node, offset, length } = place;
  const doc = node.ownerDocument;
  const mid = node.splitText(offset);
  const suffix = mid.splitText(length);
  const span = doc.createElement('span');
  span.className = SWAP_CLASS;
  span.setAttribute('data-en', mid.data);
  span.setAttribute('data-fr', swap.f);
  span.setAttribute('data-tip', tipFor(swap));
  span.setAttribute('data-fw-split', '1');
  if (swap.word) span.dataset.fwWord = swap.word;
  if (swap.status) span.dataset.fwStatus = swap.status;
  span.tabIndex = 0;
  span.setAttribute('role', 'button');
  span.setAttribute('aria-label', `${swap.f}: ${swap.g}. Show English`);
  span.textContent = swap.f;
  mid.parentNode.replaceChild(span, mid);
  const group = splitGroups.get(node) || { node, pieces: new Set() };
  group.prefix = node.data;
  group.pieces.add(span); group.pieces.add(suffix);
  splitGroups.set(node, group); spanGroups.set(span, group);
  return span;
}

// Applies validated swaps [{o, f, g, h, ctx}] to root. Returns the number placed.
export function applySwaps(root, swaps) {
  const flat = flatten(root);
  const placed = [];
  const used = [];
  for (const swap of swaps) {
    const m = locate(flat, swap.o, swap.ctx);
    if (!m) continue;
    if (used.some((u) => m.start < u.end && u.start < m.end)) continue;
    const place = toNode(flat, m, swap.o);
    if (!place) continue;
    used.push(m);
    placed.push({ place, swap });
  }
  // Later positions first, so earlier offsets in the same text node stay valid.
  placed.sort((a, b) => b.place.seg - a.place.seg || b.place.offset - a.place.offset);
  for (const { place, swap } of placed) wrap(place, swap);
  return placed.length;
}

// Removes every swap under root and merges the split text nodes back, restoring the original node.
export function revert(root) {
  const spans = Array.from(root.querySelectorAll(`span.${SWAP_CLASS}`));
  const groups = new Set(spans.map((span) => spanGroups.get(span)).filter(Boolean));
  for (const group of groups) {
    if (group.node.data !== group.prefix && group.node.parentNode) {
      for (const piece of group.pieces) if (piece.parentNode === group.node.parentNode) piece.remove();
    }
    splitGroups.delete(group.node);
  }
  for (const span of spans) {
    const parent = span.parentNode;
    if (!parent) continue;
    const en = span.getAttribute('data-en') ?? span.textContent;
    const prev = span.previousSibling;
    const next = span.nextSibling;
    if (
      span.getAttribute('data-fw-split') === '1' &&
      prev && prev.nodeType === TEXT_NODE &&
      next && next.nodeType === TEXT_NODE
    ) {
      prev.data = prev.data + en + next.data;
      parent.removeChild(span);
      parent.removeChild(next);
    } else {
      parent.replaceChild(span.ownerDocument.createTextNode(en), span);
    }
  }
  return spans.length;
}

// Click: flip one swap between French and English.
export function toggle(span) {
  const showEn = !span.classList.contains('fw-en');
  span.classList.toggle('fw-en', showEn);
  span.textContent = showEn ? span.getAttribute('data-en') : span.getAttribute('data-fr');
  span.setAttribute('aria-label', `${span.textContent}. Show ${showEn ? 'French' : 'English'}`);
  return showEn;
}
