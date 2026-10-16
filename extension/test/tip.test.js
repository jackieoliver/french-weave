import { test, expect } from 'bun:test';
import { Window } from 'happy-dom';

// The gloss shows on the hover or focus itself; only a pointer that stays on one word counts as a peek.
test('hover tip is instant and only a dwell on one word records a peek', async () => {
  const win = new Window({ url: 'https://example.com/article' });
  const keys = ['chrome', 'document', 'window', 'location', 'MutationObserver', 'IntersectionObserver', 'setInterval'];
  const saved = Object.fromEntries(keys.map((k) => [k, globalThis[k]]));
  class IO {
    constructor(cb, options) { this.cb = cb; this.options = options; this.els = new Set(); }
    observe(el) { this.els.add(el); if (this.options.rootMargin) queueMicrotask(() => { if (this.els.has(el)) this.cb([{ target: el, isIntersecting: true, intersectionRatio: 1 }]); }); }
    unobserve(el) { this.els.delete(el); }
    disconnect() { this.els.clear(); }
  }
  const config = { settings: { enabled: true, newSitesEnabled: true, siteOverrides: {} }, level: 1, revision: 'r1', hasKey: true, tier: 'gemini', paused: false, origins: ['<all_urls>'], stage: 1 };
  const events = [];
  const runtime = {
    id: 'fw-test',
    onMessage: { addListener: () => {} },
    sendMessage: async (msg) => {
      if (msg.type === 'config') return config;
      if (msg.type === 'swaps') {
        return { results: Object.fromEntries(msg.items.map((i) => [i.key, [
          { o: 'and', f: 'et', g: 'and', h: 'ay', ctx: '', word: 'et' },
          { o: 'very', f: 'très', g: 'very', h: 'treh', ctx: '', word: 'très' },
        ]])) };
      }
      if (msg.type === 'event') { events.push(`${msg.word}:${msg.event}`); return { ok: true }; }
      return { ok: true };
    },
  };
  Object.assign(globalThis, { window: win, document: win.document, location: win.location, MutationObserver: win.MutationObserver,
    IntersectionObserver: IO, setInterval: win.setInterval.bind(win), chrome: { runtime } });
  const wait = (ms = 400) => new Promise((done) => setTimeout(done, ms));
  const user = (e) => Object.defineProperty(e, 'isTrusted', { value: true });
  const over = (el) => el.dispatchEvent(user(new win.MouseEvent('mouseover', { bubbles: true })));
  const out = (el, to = null) => el.dispatchEvent(user(new win.MouseEvent('mouseout', { bubbles: true, relatedTarget: to })));
  const tip = (el) => el.classList.contains('fw-tip');
  try {
    win.document.body.innerHTML = '<main><p id="a">I enjoy cats and dogs, very much, every single day.</p></main>';
    await import('../src/content.js?tip');
    await wait();
    const [et, tres] = win.document.querySelectorAll('#a .fw-word');
    expect([et?.textContent, tres?.textContent]).toEqual(['et', 'très']);

    // Script-dispatched hovers show nothing and record nothing.
    tres.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true }));
    expect(tip(tres)).toBe(false);
    await wait(800);
    expect(events).toEqual([]);

    // No wait: the class is on before the handler returns.
    over(et);
    expect(tip(et)).toBe(true);
    // Sliding straight onto the next word moves the gloss and restarts the dwell there; neither pass is a peek.
    await wait(400);
    out(et, tres); over(tres);
    expect([tip(et), tip(tres)]).toEqual([false, true]);
    await wait(400);
    out(tres);
    await wait(800);
    expect(events).toEqual([]);

    // Clicking during the dwell flips the word and cancels the peek; the flip is the only event.
    over(et);
    await wait(200);
    et.dispatchEvent(user(new win.MouseEvent('click', { bubbles: true })));
    expect(et.textContent).toBe('and');
    expect(tip(et)).toBe(false);
    await wait(800);
    expect(events).toEqual(['et:flip']);
    // A word showing English has no gloss to show and records no peek; reaching it hides any other gloss.
    out(et);
    tres.dispatchEvent(user(new win.FocusEvent('focusin', { bubbles: true })));
    expect(tip(tres)).toBe(true);
    over(et);
    expect([tip(et), tip(tres)]).toEqual([false, false]);
    await wait(800);
    expect(events).toEqual(['et:flip']);
    out(et);

    // A dwell records one peek for the word under the pointer.
    over(tres);
    await wait(800);
    expect(events).toEqual(['et:flip', 'très:peek']);
    expect(tip(tres)).toBe(true);
    await wait(800);
    expect(events).toEqual(['et:flip', 'très:peek']);
    out(tres);
    expect(tip(tres)).toBe(false);
  } finally {
    await win.happyDOM.close();
    Object.assign(globalThis, saved);
  }
}, 30000);
