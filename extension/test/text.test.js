import { describe, test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { flatten, locate, applySwaps, revert, toggle, tipFor } from '../src/text.js';

const win = new Window();
const document = win.document;

// Markup shapes copied from x.com on 2026-09-20.
function tweet(inner) {
  const wrap = document.createElement('div');
  wrap.innerHTML = `<div dir="auto" lang="en" data-testid="tweetText">${inner}</div>`;
  return wrap.firstElementChild;
}
const S = (swap) => ({ g: swap.g || 'and', h: swap.h || 'ay', ctx: '', ...swap });

describe('flatten', () => {
  test('collapses whitespace and keeps a map back to raw offsets', () => {
    const el = tweet('<span>one\n\ntwo  three</span>');
    const f = flatten(el);
    expect(f.text).toBe('one two three');
    expect(f.raw).toBe('one\n\ntwo  three');
    expect(f.raw.slice(f.map[4], f.map[6] + 1)).toBe('two');
  });
  test('emoji alt text and link text are in the text but not touchable', () => {
    const el = tweet('<span>fire </span><img alt="🔥"><span> and </span><a href="https://t.co/x"><span>https://</span>bit.ly/abc</a>');
    const f = flatten(el);
    expect(f.text).toBe('fire 🔥 and https://bit.ly/abc');
    expect(f.segs.filter((s) => s.ok).length).toBe(2);
    expect(f.segs.filter((s) => !s.ok).length).toBe(3);
  });
  test('trims ends', () => {
    expect(flatten(tweet('<span>  hi there  </span>')).text).toBe('hi there');
  });
});

describe('locate', () => {
  test('ctx disambiguates repeated words', () => {
    const f = flatten(tweet('<span>cats and dogs and birds</span>'));
    expect(locate(f, 'and', 'cats and dogs')).toEqual({ start: 5, end: 8 });
    expect(locate(f, 'and', 'dogs and birds')).toEqual({ start: 14, end: 17 });
    expect(locate(f, 'and', '')).toBeNull();
    expect(locate(f, 'and', 'no such context')).toBeNull();
  });
  test('word boundaries: "and" never matches inside "brand"', () => {
    const f = flatten(tweet('<span>brand new and shiny</span>'));
    expect(locate(f, 'and', '')).toEqual({ start: 10, end: 13 });
    expect(locate(f, 'and', 'brand new')).toEqual({ start: 10, end: 13 }); // ctx has no whole-word "and" -> whole-text fallback
    expect(locate(flatten(tweet('<span>brand new</span>')), 'and', '')).toBeNull();
  });
  test('phrases and punctuation neighbours', () => {
    const f = flatten(tweet('<span>late, because I slept.</span>'));
    expect(locate(f, 'because', 'late, because I')).toEqual({ start: 6, end: 13 });
    const g = flatten(tweet('<span>this is a little odd</span>'));
    expect(locate(g, 'a little', '')).toEqual({ start: 8, end: 16 });
  });
});

describe('applySwaps', () => {
  test('wraps exactly the word, leaves the rest untouched', () => {
    const el = tweet('<span>cats and dogs and birds</span>');
    const n = applySwaps(el, [S({ o: 'and', f: 'et', ctx: 'dogs and birds' })]);
    expect(n).toBe(1);
    expect(el.innerHTML).toBe('<span>cats and dogs <span class="fw-word" data-en="and" data-fr="et" data-tip="and · &quot;ay&quot;" data-fw-split="1">et</span> birds</span>');
    expect(el.textContent).toBe('cats and dogs et birds');
  });
  test('two swaps in one text node, applied in any order', () => {
    const el = tweet('<span>cats and dogs and birds</span>');
    const n = applySwaps(el, [
      S({ o: 'and', f: 'et', ctx: 'cats and dogs' }),
      S({ o: 'and', f: 'et', ctx: 'dogs and birds' }),
    ]);
    expect(n).toBe(2);
    expect(el.textContent).toBe('cats et dogs et birds');
    expect(el.querySelectorAll('.fw-word').length).toBe(2);
  });
  test('mentions: ctx may straddle the link, the swap lands in plain text, handles are never touched', () => {
    const el = tweet('<span>thanks </span><div><span><a href="/foo">@foo</a></span></div><span> and you too friend</span>');
    const n = applySwaps(el, [
      S({ o: 'and', f: 'et', ctx: '@foo and you' }),
      S({ o: '@foo', f: 'et', ctx: 'thanks @foo and' }),
    ]);
    expect(n).toBe(1);
    expect(el.querySelector('a').textContent).toBe('@foo');
    expect(el.textContent).toBe('thanks @foo et you too friend');
  });
  test('emoji alt in ctx, link text never swapped', () => {
    const el = tweet('<span>fire </span><img alt="🔥"><span> and ice </span><a href="https://t.co/x"><span>https://</span>bit.ly/and</a>');
    const n = applySwaps(el, [
      S({ o: 'and', f: 'et', ctx: '🔥 and ice' }),
      S({ o: 'bit.ly/and', f: 'et', ctx: 'https://bit.ly/and' }),
    ]);
    expect(n).toBe(1);
    expect(el.querySelector('a').textContent).toBe('https://bit.ly/and');
    expect(el.textContent).toBe('fire  et ice https://bit.ly/and');
  });
  test('code is never touched', () => {
    const el = tweet('<span>run </span><code>git rebase and squash</code><span> and ship</span>');
    const n = applySwaps(el, [S({ o: 'and', f: 'et', ctx: 'and ship' })]);
    expect(n).toBe(1);
    expect(el.querySelector('code').textContent).toBe('git rebase and squash');
  });
  test('swap spanning two nodes is dropped; newline inside the phrase is dropped', () => {
    const el = tweet('<span>a </span><span>little</span><span> odd and fun</span>');
    expect(applySwaps(el, [S({ o: 'a little', f: 'un peu', ctx: 'a little odd' })])).toBe(0);
    const el2 = tweet('<span>this is a\nlittle odd and fun</span>');
    expect(applySwaps(el2, [S({ o: 'a little', f: 'un peu', ctx: 'a little odd' })])).toBe(0);
    expect(el2.textContent).toBe('this is a\nlittle odd and fun');
  });
  test('newlines in the node survive a swap elsewhere in it', () => {
    const el = tweet('<span>one\n\ntwo and three</span>');
    applySwaps(el, [S({ o: 'and', f: 'et', ctx: 'two and three' })]);
    expect(el.textContent).toBe('one\n\ntwo et three');
  });
  test('overlapping swaps: first wins', () => {
    const el = tweet('<span>not because of that, honestly</span>');
    const n = applySwaps(el, [
      S({ o: 'because', f: 'parce que', ctx: 'not because of' }),
      S({ o: 'because of', f: 'parce que', ctx: 'because of that' }),
    ]);
    expect(n).toBe(1);
    expect(el.textContent).toBe('not parce que of that, honestly');
  });
  test('missing or ambiguous anchors are dropped, nothing else changes', () => {
    const el = tweet('<span>cats and dogs and birds</span>');
    const before = el.innerHTML;
    expect(applySwaps(el, [S({ o: 'and', f: 'et', ctx: '' }), S({ o: 'zebra', f: 'et', ctx: 'zebra' })])).toBe(0);
    expect(el.innerHTML).toBe(before);
  });
  test('tip without hint is just the gloss', () => {
    expect(tipFor({ g: 'and', h: '' })).toBe('and');
    expect(tipFor({ g: 'and', h: 'ay' })).toBe('and · "ay"');
  });
});

describe('revert and toggle', () => {
  test('revert restores the original DOM and the same text node object', () => {
    const el = tweet('<span>cats and dogs and birds</span>');
    const original = el.querySelector('span').firstChild;
    const before = el.innerHTML;
    applySwaps(el, [
      S({ o: 'and', f: 'et', ctx: 'cats and dogs' }),
      S({ o: 'and', f: 'et', ctx: 'dogs and birds' }),
    ]);
    expect(el.querySelectorAll('.fw-word').length).toBe(2);
    expect(revert(el)).toBe(2);
    expect(el.innerHTML).toBe(before);
    expect(el.querySelector('span').firstChild).toBe(original);
    expect(el.querySelector('span').childNodes.length).toBe(1);
    expect(revert(el)).toBe(0);
  });
  test('revert after a swap at offset 0 and at the very end', () => {
    const el = tweet('<span>and then and</span>');
    const before = el.innerHTML;
    applySwaps(el, [S({ o: 'and', f: 'et', ctx: 'and then' }), S({ o: 'and', f: 'et', ctx: 'then and' })]);
    expect(el.textContent).toBe('et then et');
    revert(el);
    expect(el.innerHTML).toBe(before);
  });
  test('apply again after revert gives the same result', () => {
    const el = tweet('<span>cats and dogs</span>');
    const swaps = [S({ o: 'and', f: 'et', ctx: 'cats and dogs' })];
    applySwaps(el, swaps);
    const first = el.innerHTML;
    revert(el);
    applySwaps(el, swaps);
    expect(el.innerHTML).toBe(first);
  });
  test('toggle flips between French and English, underline span stays', () => {
    const el = tweet('<span>cats and dogs</span>');
    applySwaps(el, [S({ o: 'And', f: 'Et', ctx: 'cats And' }), S({ o: 'and', f: 'et', ctx: 'cats and dogs' })]);
    const span = el.querySelector('.fw-word');
    expect(span.textContent).toBe('et');
    expect(toggle(span)).toBe(true);
    expect(span.textContent).toBe('and');
    expect(span.classList.contains('fw-en')).toBe(true);
    expect(toggle(span)).toBe(false);
    expect(span.textContent).toBe('et');
    expect(el.querySelectorAll('.fw-word').length).toBe(1);
  });
});
