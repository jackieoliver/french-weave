import { test, expect } from 'bun:test';
import { Window } from 'happy-dom';

// After the extension reloads itself, content scripts in open tabs are cut off (chrome.runtime.id is gone and
// sendMessage throws). They must go quiet: no throws from event handlers, no more requests, woven words kept.
test('an orphaned content script stays quiet and leaves the page as it is', async () => {
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
  let sent = 0;
  const runtime = {
    id: 'fw-test',
    onMessage: { addListener: () => {} },
    sendMessage: async (msg) => {
      sent++;
      if (msg.type === 'config') return config;
      if (msg.type === 'swaps') return { results: Object.fromEntries(msg.items.map((i) => [i.key, [{ o: 'and', f: 'et', g: 'and', h: 'ay', ctx: '' }]])) };
      return { ok: true };
    },
  };
  Object.assign(globalThis, { window: win, document: win.document, location: win.location, MutationObserver: win.MutationObserver,
    IntersectionObserver: IO, setInterval: win.setInterval.bind(win), chrome: { runtime } });
  const wait = (ms = 400) => new Promise((done) => setTimeout(done, ms));
  const user = (e) => Object.defineProperty(e, 'isTrusted', { value: true });
  const errors = [];
  const onError = (e) => errors.push(String(e?.reason || e?.message || e));
  process.on('unhandledRejection', onError);
  try {
    win.document.body.innerHTML = '<main><p id="a">I enjoy cats and dogs every single day here.</p></main>';
    await import('../src/content.js?orphan');
    await wait();
    const span = win.document.querySelector('#a .fw-word');
    expect(span?.textContent).toBe('et');

    // The extension reloads: this copy loses its runtime.
    delete runtime.id;
    runtime.sendMessage = () => { sent++; throw new Error('Extension context invalidated.'); };
    const before = sent;
    const p = win.document.createElement('p');
    p.textContent = 'We read books and drink tea on quiet evenings.';
    win.document.querySelector('main').append(p);
    span.dispatchEvent(user(new win.MouseEvent('mouseover', { bubbles: true })));
    await wait(800);
    span.dispatchEvent(user(new win.MouseEvent('click', { bubbles: true })));
    await wait();
    expect(errors).toEqual([]);
    expect(sent - before).toBeLessThanOrEqual(1); // at most the one request that discovered the reload
    const after = sent;
    p.textContent = 'They walk home and talk about the long week.';
    await wait();
    expect(sent).toBe(after); // quiet from then on
    expect(win.document.querySelector('#a .fw-word')?.textContent).toBe('et'); // woven text stays
  } finally {
    process.off('unhandledRejection', onError);
    await win.happyDOM.close();
    Object.assign(globalThis, saved);
  }
}, 30000);
