import { test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { hashKey } from '../src/hash.js';
import { DAILY_MODEL_CALLS } from '../src/quota.js';

// The real worker and content modules together on a plain article page, with a fake native host and Gemini.
test('runtime: key privacy, native host sync and events, site controls, setup default, stale replies, retries', async () => {
  const win = new Window({ url: 'https://example.com/article' });
  const originalGlobals = Object.fromEntries(['chrome', 'fetch', 'document', 'window', 'location', 'MutationObserver', 'IntersectionObserver', 'setInterval'].map((k) => [k, globalThis[k]]));
  const local = { settings: { apiKey: 'synthetic-gemini', enabled: true, levelOverride: 1 } }; // 0.1 kept the key in settings
  const messageListeners = [], contentListeners = [];
  const toPages = [];
  const pageReplies = []; // replies to the content script's own requests // everything the worker sends to content scripts
  const originEvents = { added: [], removed: [] };
  let accessLevel;
  let origins = ['https://*/*', 'http://*/*'];
  let modelCalls = 0;
  let modelThrows = 0;
  let delayed = null;
  let release;
  const hostEvents = [];
  let hostState = { version: 'test.1', stage: 1, paused: false, prefs: { extension_sites: 'ask' }, words: [
    { fr: 'et', en: 'and', hint: 'ay', status: 'active' },
    { fr: 'très', en: 'very', hint: 'treh', status: 'shaky' },
  ] };
  const listener = (arr) => ({ addListener: (fn) => arr.push(fn) });
  const storageArea = (data) => ({
    async setAccessLevel(v) { accessLevel = v.accessLevel; },
    async get(keys) { return structuredClone(keys == null ? data : Object.fromEntries((typeof keys === 'string' ? [keys] : keys).filter((k) => k in data).map((k) => [k, data[k]]))); },
    async set(values) { for (const [k, v] of Object.entries(values)) data[k] = structuredClone(v); },
    async remove(keys) { for (const k of keys) delete data[k]; },
  });
  const page = () => ({ id: 'fw-test', tab: { id: 1 }, url: win.location.href });
  const popup = { id: 'fw-test', url: 'chrome-extension://fw-test/src/popup.html' };
  const dispatch = (msg, sender) => new Promise((done, reject) => {
    let handled = false;
    try { for (const fn of messageListeners) if (fn(msg, sender, done)) handled = true; }
    catch (e) { reject(e); }
    if (!handled) done(undefined);
  });
  const io = [];
  class IO {
    constructor(callback, options) { this.cb = callback; this.options = options; this.elements = new Set(); io.push(this); }
    observe(el) { this.elements.add(el); if (this.options.rootMargin) queueMicrotask(() => { if (this.elements.has(el)) this.cb([{ target: el, isIntersecting: true, intersectionRatio: 1 }]); }); }
    unobserve(el) { this.elements.delete(el); }
    disconnect() { this.elements.clear(); }
  }
  const reply = (body, status = 200) => ({ ok: status >= 200 && status < 300, status, json: async () => body });
  Object.assign(globalThis, {
    window: win, document: win.document, location: win.location, MutationObserver: win.MutationObserver, IntersectionObserver: IO,
    setInterval: win.setInterval.bind(win),
    chrome: {
      storage: { local: storageArea(local) },
      runtime: {
        id: 'fw-test', getURL: (path) => `chrome-extension://fw-test/${path}`,
        onMessage: listener(messageListeners), onInstalled: listener([]), onStartup: listener([]),
        sendMessage: (msg) => dispatch(msg, page()).then((r) => { pageReplies.push(JSON.stringify(r ?? null)); return r; }),
        sendNativeMessage: async (_host, msg) => {
          if (msg.type === 'state') return { ok: true, ...structuredClone(hostState), geminiKey: 'synthetic-host' };
          if (msg.type === 'events') { hostEvents.push(...msg.events); return { ok: true, applied: msg.events.length }; }
          return { ok: false };
        },
      },
      tabs: { query: async () => [{ id: 1, url: win.location.href }], sendMessage: async (_id, msg) => { toPages.push(JSON.stringify(msg)); for (const fn of contentListeners) fn(msg); } },
      alarms: { create: async () => {}, onAlarm: listener([]) },
      permissions: { getAll: async () => ({ origins }), onAdded: listener(originEvents.added), onRemoved: listener(originEvents.removed) },
      scripting: { getRegisteredContentScripts: async () => [], updateContentScripts: async () => {}, unregisterContentScripts: async () => {}, registerContentScripts: async () => {} },
    },
    fetch: async (url, init) => {
      expect(url.startsWith('https://generativelanguage.googleapis.com/')).toBe(true);
      expect(init.headers['x-goog-api-key']).toBe('synthetic-gemini'); // a pasted key wins over the setup key
      modelCalls++;
      if (modelThrows > 0) { modelThrows--; throw new TypeError('Failed to fetch'); }
      if (delayed) { release = () => { delayed = null; }; await new Promise((done) => { const free = release; release = () => { free(); done(); }; }); }
      const body = JSON.parse(init.body);
      const items = JSON.parse(body.contents[0].parts[0].text.replace(/^Passages:\n/, ''));
      // Free-form replies carry swaps; the candidates design (the default) keeps candidate numbers.
      const passages = items.map(({ id, text, candidates = [] }) => ({ id, swaps: text.includes(' and ') ? [{ o: 'and', f: 'et', ctx: '' }] : [],
        keep: candidates.filter((c) => c.o === 'and').map((c) => c.n) }));
      return reply({ candidates: [{ content: { parts: [{ text: JSON.stringify({ passages }) }] } }] });
    },
  });
  const call = (msg) => dispatch(msg, popup);
  const wait = (ms = 400) => new Promise((done) => setTimeout(done, ms));
  // happy-dom has no isTrusted; real user input is marked by hand, a page's dispatchEvent is left untrusted.
  const user = (e) => Object.defineProperty(e, 'isTrusted', { value: true });
  try {
    await import('../src/background.js');
    let config = await dispatch({ type: 'config' }, page());
    expect(accessLevel).toBe('TRUSTED_CONTEXTS');
    expect(local.settings.apiKey).toBeUndefined();
    expect(local.apiKey).toBe('synthetic-gemini');
    expect(await dispatch({ type: 'status' }, page())).toBeUndefined();
    expect(await dispatch({ type: 'save', apiKey: 'stolen' }, page())).toBeUndefined();
    expect(await call({ type: 'syncWords' })).toEqual({ ok: true, error: null, count: 2, stage: 1 });
    expect(local.hostKey).toBe('synthetic-host');
    config = await dispatch({ type: 'config' }, page());
    expect(JSON.stringify(config)).not.toContain('synthetic-');
    expect(config.language).toBe('French'); // picks the gloss speaker's voice; no language in the word state means French
    // Setup chose "ask": sites stay off until turned on; an explicit popup choice wins.
    expect(config.settings.newSitesEnabled).toBe(false);
    await call({ type: 'save', settings: { newSitesEnabled: true } });
    expect((await dispatch({ type: 'config' }, page())).settings.newSitesEnabled).toBe(true);

    // Route worker broadcasts to the content module without pretending they came from a page.
    const beforeContent = messageListeners.length;
    win.document.body.innerHTML = '<main><p id="reading">I enjoy cats and dogs every single day.</p><form><p>Private typing and secrets should stay exactly here.</p></form><p contenteditable="true">Private words and typing must never leave this editor.</p><p id="nested">Keep these and other words <span contenteditable="true">private typed text</span> here.</p><p>My doctor says medication and rest are important.</p><p lang="fr">Bonjour et merci pour cette belle journee ici.</p></main>';
    await import('../src/content.js');
    contentListeners.push(...messageListeners.splice(beforeContent));
    await wait();
    expect(modelCalls).toBe(1);
    const el = win.document.querySelector('#reading');
    expect(el.querySelector('.fw-word')?.textContent).toBe('et');
    expect(win.document.querySelectorAll('.fw-word').length).toBe(1);
    expect(local.pendingEvents || []).toHaveLength(0); // prefetch is not exposure
    const visibility = io.findLast((o) => !o.options.rootMargin);
    const span = el.querySelector('.fw-word');
    visibility.cb([{ target: span, isIntersecting: true, intersectionRatio: 1 }]);
    await wait(20);
    expect(local.pendingEvents.map((e) => e.kind)).toEqual(['seen']);
    expect(span.dataset.fwStatus).toBe('active');
    // The gloss shows on the hover itself, with no wait; a passing pointer records nothing.
    span.dispatchEvent(user(new win.MouseEvent('mouseover', { bubbles: true })));
    expect(span.classList.contains('fw-tip')).toBe(true);
    await wait(100);
    span.dispatchEvent(user(new win.MouseEvent('mouseout', { bubbles: true })));
    expect(span.classList.contains('fw-tip')).toBe(false);
    await wait(800);
    expect(local.pendingEvents).toHaveLength(1);
    // Scrolling during the dwell hides the gloss and cancels the peek too.
    span.dispatchEvent(user(new win.MouseEvent('mouseover', { bubbles: true })));
    await wait(100);
    win.dispatchEvent(new win.Event('scroll'));
    expect(span.classList.contains('fw-tip')).toBe(false);
    await wait(800);
    expect(local.pendingEvents).toHaveLength(1);
    // Focus shows the gloss at once for keyboard readers but never records a peek, since a page can focus a span from script.
    span.dispatchEvent(user(new win.FocusEvent('focusin', { bubbles: true })));
    expect(span.classList.contains('fw-tip')).toBe(true);
    await wait(800);
    expect(local.pendingEvents).toHaveLength(1);
    // The gloss is one fixed box outside the text (so overflow: hidden can't clip it), never inside the word.
    const gloss = win.document.querySelector('fw-gloss');
    expect(gloss.parentNode).toBe(win.document.documentElement);
    expect(gloss.textContent).toBe(span.getAttribute('data-tip'));
    expect(gloss.classList.contains('fw-gloss-on')).toBe(true);
    expect(gloss.style.top).toMatch(/px$/);
    expect(span.contains(gloss) || el.contains(gloss)).toBe(false);
    span.dispatchEvent(user(new win.FocusEvent('focusout', { bubbles: true })));
    expect(span.classList.contains('fw-tip')).toBe(false);
    expect(gloss.classList.contains('fw-gloss-on')).toBe(false);
    // A dwell of PEEK_DWELL_MS on the same word records exactly one peek, however long the pointer stays.
    span.dispatchEvent(user(new win.MouseEvent('mouseover', { bubbles: true })));
    expect(span.classList.contains('fw-tip')).toBe(true);
    await wait(500);
    expect(local.pendingEvents).toHaveLength(1);
    span.dispatchEvent(user(new win.MouseEvent('mouseover', { bubbles: true }))); // moving within the word restarts nothing
    await wait(300);
    expect(local.pendingEvents.map((e) => e.kind)).toEqual(['seen', 'peek']);
    await wait(800);
    expect(local.pendingEvents).toHaveLength(2);
    span.dispatchEvent(user(new win.MouseEvent('mouseout', { bubbles: true })));
    span.dispatchEvent(user(new win.MouseEvent('mouseover', { bubbles: true })));
    await wait(800);
    expect(local.pendingEvents).toHaveLength(2); // one peek per word per day
    span.dispatchEvent(user(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true })));
    await wait(20);
    expect(span.textContent).toBe('and');
    expect(local.pendingEvents.map((e) => e.kind)).toEqual(['seen', 'peek', 'flip']);
    expect(await dispatch({ type: 'event', word: 'bonjour', event: 'seen' }, page())).toEqual({ ok: false }); // not a known word
    // Nothing in the DOM names the word or the revision; pages can't forge events with fake spans or synthetic input.
    expect(win.document.body.innerHTML).not.toMatch(/data-fw-(word|key)/);
    const fake = win.document.createElement('span');
    fake.className = 'fw-word';
    fake.dataset.fwWord = 'très';
    fake.setAttribute('data-en', 'very');
    fake.textContent = 'très';
    win.document.querySelector('main').append(fake);
    await wait(20);
    expect(span.isConnected).toBe(true);
    fake.dispatchEvent(user(new win.MouseEvent('click', { bubbles: true })));
    fake.dispatchEvent(new win.MouseEvent('click', { bubbles: true }));
    span.dispatchEvent(new win.MouseEvent('click', { bubbles: true })); // untrusted click on a real swap
    span.dispatchEvent(user(new win.MouseEvent('mouseout', { bubbles: true })));
    span.dispatchEvent(new win.MouseEvent('mouseover', { bubbles: true })); // untrusted: no gloss, no peek
    expect(span.classList.contains('fw-tip')).toBe(false);
    await wait(800);
    expect(fake.textContent).toBe('très');
    expect(span.textContent).toBe('and');
    expect(local.pendingEvents.map((e) => e.kind)).toEqual(['seen', 'peek', 'flip']);
    fake.remove(); await wait();

    // Syncing flushes the queue to the host first; only words and kinds leave, never page text.
    await call({ type: 'syncWords' });
    expect(hostEvents.map((e) => `${e.word}:${e.kind}`)).toEqual(['et:seen', 'et:peek', 'et:flip']);
    expect(JSON.stringify(hostEvents)).not.toContain('cats');
    expect(local.pendingEvents).toHaveLength(0);

    const beforeClear = modelCalls;
    await call({ type: 'clearCache' }); await wait();
    expect(modelCalls).toBe(beforeClear + 1);
    expect(el.querySelector('.fw-word')?.textContent).toBe('et');
    await call({ type: 'save', siteOverride: { host: 'example.com', enabled: false } });
    expect(el.textContent).toBe('I enjoy cats and dogs every single day.');
    expect(el.querySelector('.fw-word')).toBeNull();
    await call({ type: 'save', settings: { newSitesEnabled: false }, siteOverride: { host: 'example.com', enabled: true } });
    await wait(); expect(el.querySelector('.fw-word')).not.toBeNull();

    // Clearing/off during a delayed API request must not resurrect the old generation.
    delayed = true;
    await call({ type: 'clearCache' }); await wait();
    expect(typeof release).toBe('function');
    await call({ type: 'save', settings: { enabled: false } });
    release(); await wait();
    expect(el.querySelector('.fw-word')).toBeNull();
    expect(Object.keys(local).filter((k) => k.startsWith('c:'))).toHaveLength(0);

    // A new word-list version keeps the revision (cached swaps stay up to 3 days); an old revision's request is stale.
    const oldRevision = (await dispatch({ type: 'config' }, page())).revision;
    hostState = { ...hostState, version: 'test.2', stage: 2 };
    await call({ type: 'syncWords' });
    config = await dispatch({ type: 'config' }, page());
    expect(config.revision).toBe(oldRevision);
    const text = 'I enjoy cats and dogs every single day.';
    const oldReply = await dispatch({ type: 'swaps', revision: 'an-old-revision', items: [{ key: `an-old-revision:${hashKey(text)}`, text }] }, page());
    expect(oldReply.stale).toBe(true);
    const disabledReply = await dispatch({ type: 'swaps', revision: config.revision, items: [{ key: `${config.revision}:${hashKey(text)}`, text }] }, page());
    expect(disabledReply.stale).toBe(true);
    await call({ type: 'save', settings: { enabled: true } }); await wait();
    expect(el.querySelector('.fw-word')).not.toBeNull();
    const dynamic = win.document.createElement('p');
    dynamic.textContent = 'We enjoy books and music every quiet evening.';
    win.document.querySelector('main').append(dynamic); await wait();
    expect(dynamic.querySelector('.fw-word')).not.toBeNull();

    // Pausing from Claude Code reverts pages.
    hostState = { ...hostState, paused: true };
    await call({ type: 'syncWords' }); await wait(20);
    expect(el.querySelector('.fw-word')).toBeNull();
    hostState = { ...hostState, paused: false };
    await call({ type: 'syncWords' }); await wait();
    expect(el.querySelector('.fw-word')).not.toBeNull();

    // A failed model call is retried after a backoff instead of leaving the passage English.
    modelThrows = 2; // the default chain's two Gemini steps (one key) both fail, then the retry
    const retried = win.document.createElement('p');
    retried.textContent = 'They walk home and talk about the long week.';
    win.document.querySelector('main').append(retried); await wait();
    expect(retried.querySelector('.fw-word')).toBeNull();
    await wait(5500);
    expect(retried.querySelector('.fw-word')?.textContent).toBe('et');

    // Past the daily cap, no more Gemini requests until tomorrow.
    const callsBefore = modelCalls;
    const counted = local.modelCalls;
    local.modelCalls = { ...counted, count: DAILY_MODEL_CALLS };
    const capped = win.document.createElement('p');
    capped.textContent = 'She reads late and sleeps in on quiet mornings.';
    win.document.querySelector('main').append(capped); await wait();
    expect(modelCalls).toBe(callsBefore);
    expect(capped.querySelector('.fw-word')).toBeNull();
    expect(local.modelStatus.error).toContain('Daily limit');
    local.modelCalls = counted;

    // Removing website access reverts the page.
    origins = [];
    for (const fn of originEvents.removed) fn();
    await wait(20);
    expect(el.querySelector('.fw-word')).toBeNull();
    expect(dynamic.querySelector('.fw-word')).toBeNull();
    // Neither key ever reached the content-script side: not in broadcasts, not in replies to page requests.
    expect(toPages.length).toBeGreaterThan(5);
    expect(toPages.join('')).not.toContain('synthetic-');
    expect(pageReplies.join('')).not.toContain('synthetic-');
    expect(pageReplies.some((r) => r.includes('"hasKey":true'))).toBe(true);
    expect(local.modelCalls.count).toBe(modelCalls); // every Gemini request counts toward the daily cap
  } finally {
    if (release) release();
    await win.happyDOM.close();
    Object.assign(globalThis, originalGlobals);
  }
}, 30000);
