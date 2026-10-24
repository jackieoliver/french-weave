import { describe, it, test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { voiceFor } from '../src/speech.js';

const v = (name, lang, localService = true, extra = {}) => ({ name, lang, localService, default: false, ...extra });
// What Chrome lists on Linux (probed 2026-10-16): Google Chrome alone has only its online "Google" voices; with
// --enable-speech-dispatcher it adds espeak-ng's, Belgian French first.
const GOOGLE = [v('Google Deutsch', 'de-DE', false), v('Google español', 'es-ES', false), v('Google español de Estados Unidos', 'es-US', false),
  v('Google français', 'fr-FR', false), v('Google Bahasa Indonesia', 'id-ID', false), v('Google 日本語', 'ja-JP', false)];
const ESPEAK = [v('French (Belgium) espeak-ng', 'fr-BE'), v('French (Belgium)+Adam espeak-ng', 'fr-BE'), v('French (Switzerland) espeak-ng', 'fr-CH'),
  v('French (France) espeak-ng', 'fr-FR'), v('French (France)+Adam espeak-ng', 'fr-FR'), v('Western Frisian espeak-ng', 'fy')];

describe('voiceFor', () => {
  it('prefers a voice on this machine, in the language home region', () => {
    expect(voiceFor([...GOOGLE, ...ESPEAK], 'French').name).toBe('French (France) espeak-ng');
    expect(voiceFor([v('French (Canada)', 'fr-CA'), v('French (Belgium)', 'fr-BE')], 'French').name).toBe('French (Canada)'); // no fr-FR: list order
  });
  it('falls back to an online voice when it is the only one', () => {
    expect(voiceFor(GOOGLE, 'French').name).toBe('Google français');
    expect(voiceFor(GOOGLE).name).toBe('Google français'); // French by default
  });
  it('finds nothing when no voice says the language', () => {
    expect(voiceFor(GOOGLE.filter((x) => !x.lang.startsWith('fr')), 'French')).toBeNull();
    expect(voiceFor([v('Western Frisian espeak-ng', 'fy')], 'French')).toBeNull();
    expect(voiceFor([], 'French')).toBeNull();
    expect(voiceFor(undefined, 'French')).toBeNull();
    expect(voiceFor(GOOGLE, 'Klingon')).toBeNull();
  });
  it('follows the language setting', () => {
    expect(voiceFor(GOOGLE, 'Spanish').name).toBe('Google español'); // es-ES before es-US
    expect(voiceFor(GOOGLE, 'japanese').name).toBe('Google 日本語');
    expect(voiceFor(GOOGLE, 'Indonesian').name).toBe('Google Bahasa Indonesia');
    expect(voiceFor(GOOGLE, 'Bahasa Indonesia').name).toBe('Google Bahasa Indonesia'); // the language's own name
    expect(voiceFor(GOOGLE, 'Mexican Spanish').name).toBe('Google español'); // no es-MX voice: any Spanish
    expect(voiceFor([...GOOGLE, v('Paulina', 'es-MX', false)], 'Mexican Spanish').name).toBe('Paulina');
  });
  it('a voice on this machine wins even over the online regional variant the setting names', () => {
    const canada = [...ESPEAK, v('Google français du Canada', 'fr-CA', false)];
    expect(voiceFor(canada, 'Canadian French').name).toBe('French (France) espeak-ng');
    expect(voiceFor([...canada, v('French (Canada) espeak-ng', 'fr-CA')], 'Canadian French').name).toBe('French (Canada) espeak-ng');
    expect(voiceFor([...canada, v('French (Canada) espeak-ng', 'fr-CA')], 'French (Canada)').name).toBe('French (Canada) espeak-ng');
    expect(voiceFor([v('Online bare fr', 'fr', false), ...ESPEAK], 'French').name).toBe('French (France) espeak-ng');
    expect(voiceFor(GOOGLE, 'Canadian French').name).toBe('Google français'); // only online voices: the closest one
    expect(voiceFor(GOOGLE, 'French (Canada)').name).toBe('Google français'); // no fr-CA voice: any French
    expect(voiceFor(ESPEAK, 'French (Canada)').name).toBe('French (France) espeak-ng');
  });
  it('reads underscore tags, skips tags Intl cannot read, and breaks ties on the default voice', () => {
    expect(voiceFor([v('bad', ''), v('worse', 'not a tag!'), v('Android', 'fr_FR')], 'French').name).toBe('Android');
    expect(voiceFor([v('A', 'fr-FR'), v('B', 'fr-FR', true, { default: true })], 'French').name).toBe('B');
  });
});


// Content script with a fake speechSynthesis. Returns helpers; the caller closes the window.
async function page(tag, { voices: initialVoices, language }) {
  let voices = initialVoices;
  const win = new Window({ url: 'https://example.com/article' });
  class IO {
    constructor(cb, options) { this.cb = cb; this.options = options; this.els = new Set(); }
    observe(el) { this.els.add(el); if (this.options.rootMargin) queueMicrotask(() => { if (this.els.has(el)) this.cb([{ target: el, isIntersecting: true, intersectionRatio: 1 }]); }); }
    unobserve(el) { this.els.delete(el); }
    disconnect() { this.els.clear(); }
  }
  const config = { settings: { enabled: true, newSitesEnabled: true, siteOverrides: {} }, level: 1, revision: 'r1', hasKey: true, tier: 'gemini',
    paused: false, origins: ['<all_urls>'], stage: 1, ...(language ? { language } : {}) };
  const events = [];
  let swapCalls = 0;
  const spoken = [];
  const changed = [];
  const speechSynthesis = {
    speaking: false, pending: false, cancels: 0,
    getVoices: () => voices,
    speak(u) { spoken.push({ text: u.text, voice: u.voice?.name, lang: u.lang }); },
    cancel() { this.cancels++; },
    addEventListener(type, fn) { if (type === 'voiceschanged') changed.push(fn); },
  };
  const runtime = {
    id: 'fw-test',
    onMessage: { addListener: () => {} },
    sendMessage: async (msg) => {
      if (msg.type === 'config') return config;
      if (msg.type === 'swaps') {
        swapCalls++;
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
    IntersectionObserver: IO, setInterval: win.setInterval.bind(win), chrome: { runtime }, speechSynthesis,
    SpeechSynthesisUtterance: class { constructor(text) { this.text = text; } } });
  win.document.body.innerHTML = '<main><p id="a">I enjoy cats and dogs, very much, every single day.</p></main>';
  await import(`../src/content.js?${tag}`);
  await new Promise((done) => setTimeout(done, 400));
  // happy-dom has no isTrusted; real user input is marked by hand, a page's dispatchEvent is left untrusted.
  const user = (e) => Object.defineProperty(e, 'isTrusted', { value: true });
  const key = (el, k, options = {}) => { const e = user(new win.KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...options })); el.dispatchEvent(e); return e; };
  return {
    win, events, spoken, speechSynthesis, swapCalls: () => swapCalls, key,
    setVoices: (list) => { voices = list; for (const fn of changed) fn(); },
    focus: (el, from = null) => el.dispatchEvent(user(new win.FocusEvent('focusin', { bubbles: true, relatedTarget: from }))),
    blur: (el, to = null) => el.dispatchEvent(user(new win.FocusEvent('focusout', { bubbles: true, relatedTarget: to }))),
    words: () => [...win.document.querySelectorAll('#a .fw-word')],
    // The one gloss box, while it shows.
    gloss: () => win.document.querySelector('fw-gloss.fw-gloss-on'),
    over: (el, from = null) => el.dispatchEvent(user(new win.MouseEvent('mouseover', { bubbles: true, relatedTarget: from }))),
    out: (el, to = null) => el.dispatchEvent(user(new win.MouseEvent('mouseout', { bubbles: true, relatedTarget: to }))),
    click: (el, trusted = true) => { const e = new win.MouseEvent('click', { bubbles: true, cancelable: true }); el.dispatchEvent(trusted ? user(e) : e); },
  };
}
const GLOBALS = ['chrome', 'document', 'window', 'location', 'MutationObserver', 'IntersectionObserver', 'setInterval', 'speechSynthesis', 'SpeechSynthesisUtterance'];
const wait = (ms) => new Promise((done) => setTimeout(done, ms));

test('speaker in the gloss box says the word on a click or key press, and is never a flip', async () => {
  const saved = Object.fromEntries(GLOBALS.map((k) => [k, globalThis[k]]));
  const p = await page('say', { voices: [...GOOGLE, ...ESPEAK] });
  try {
    const [et, tres] = p.words();
    expect([et?.textContent, tres?.textContent]).toEqual(['et', 'très']);
    const calls = p.swapCalls();
    // Script-dispatched hovers show nothing.
    tres.dispatchEvent(new p.win.MouseEvent('mouseover', { bubbles: true }));
    expect(p.gloss()).toBeNull();

    // A hover shows the one fixed gloss box at once, outside the text, the speaker first. Nothing plays by itself.
    p.over(et);
    const box = p.gloss();
    const button = box?.querySelector('fw-say');
    expect([box?.parentNode, et.contains(box), box?.firstChild, box?.textContent]).toEqual([p.win.document.documentElement, false, button, 'et = and, "ay"']);
    expect([button?.getAttribute('role'), button?.getAttribute('aria-label'), button?.title, button?.tabIndex]).toEqual(['button', 'Say et', 'Say "et"', -1]);
    // The gloss text stays hidden from screen readers (the word's aria-label carries it); the button does not.
    expect([box.getAttribute('aria-hidden'), box.querySelector('fw-text')?.getAttribute('aria-hidden')]).toEqual([null, 'true']);
    expect([et.classList.contains('fw-tip'), box.classList.contains('fw-gloss-say')]).toEqual([true, true]);
    expect(p.spoken).toEqual([]);
    // Filling the box is not a page change: the passage keeps its swaps and asks for nothing new.
    await wait(50);
    expect(p.words().length).toBe(2);
    expect(p.swapCalls()).toBe(calls);

    // The pointer can move from the word to the button and back without the gloss closing (the rest of the box lets
    // the pointer through to the page).
    p.out(et, button); p.over(button, et);
    expect([p.gloss(), et.classList.contains('fw-tip')]).toEqual([box, true]);
    p.out(button, et); p.over(et, button);
    p.out(et, button); p.over(button, et);
    expect(p.gloss()).toBe(box);

    // A click on the speaker says the French word with the local French voice; the word stays French.
    p.click(button);
    expect(p.spoken).toEqual([{ text: 'et', voice: 'French (France) espeak-ng', lang: 'fr-FR' }]);
    expect([et.firstChild.data, et.classList.contains('fw-en'), p.gloss()]).toEqual(['et', false, box]);
    // A page can't make it speak; Enter and Space on the focused button do; anything else in the box does nothing.
    p.click(button, false);
    p.key(button, 'Enter');
    p.key(button, ' ');
    p.key(button, 'a');
    p.key(button, 'Enter', { repeat: true }); // a held key says it once
    p.click(box.querySelector('fw-text'));
    p.click(box.querySelector('path'));
    expect(p.spoken.map((s) => s.text)).toEqual(['et', 'et', 'et', 'et']);
    // Presses queue after whatever is being said, the page's own speech included, which is never cancelled.
    p.speechSynthesis.speaking = true;
    p.click(button);
    expect([p.spoken.length, p.speechSynthesis.cancels]).toEqual([5, 0]);
    expect(et.classList.contains('fw-en')).toBe(false);

    // The dwell still counts one peek (time on the speaker is time on the word); the speaker added no flip.
    await wait(800);
    expect(p.events).toEqual(['et:peek']);

    // Leaving the speaker for the page closes the gloss after a moment, again without touching the passage.
    p.out(button, p.win.document.body);
    expect(p.gloss()).toBe(box);
    await wait(350);
    expect([p.gloss(), et.classList.contains('fw-tip')]).toEqual([null, false]);
    await wait(50);
    expect(p.words().length).toBe(2);
    expect(p.swapCalls()).toBe(calls);
    // Going straight from the word to another word moves the gloss there, with that word's speaker.
    p.over(et); p.out(et, tres); p.over(tres, et);
    expect([et.classList.contains('fw-tip'), p.gloss()?.querySelector('fw-say')?.title]).toEqual([false, 'Say "très"']);
    p.out(tres);
    await wait(350);

    // A click on the word itself still flips it, and an English word gets no gloss and no speaker.
    p.over(et);
    p.click(et);
    expect([et.textContent, p.gloss()]).toEqual(['and', null]);
    p.out(et);
    p.over(et);
    expect(p.gloss()).toBeNull();
    await wait(50);
    expect(p.events).toEqual(['et:peek', 'et:flip']);
  } finally {
    await p.win.happyDOM.close();
    Object.assign(globalThis, saved);
  }
}, 30000);

test('no voice for the language: the gloss box has no speaker', async () => {
  const saved = Object.fromEntries(GLOBALS.map((k) => [k, globalThis[k]]));
  const p = await page('say-none', { voices: [...ESPEAK], language: 'Japanese' });
  try {
    const [et] = p.words();
    p.over(et);
    const box = p.gloss();
    expect([et.classList.contains('fw-tip'), box?.textContent, box?.querySelector('fw-say'), box?.classList.contains('fw-gloss-say')])
      .toEqual([true, 'et = and, "ay"', null, false]);
    p.key(et, 'Tab'); // Tab is the page's own
    expect(p.key(et, 'Tab').defaultPrevented).toBe(false);
    expect(et.textContent).toBe('et');
    p.click(et);
    expect(et.textContent).toBe('and');
    expect(p.spoken).toEqual([]);
  } finally {
    await p.win.happyDOM.close();
    Object.assign(globalThis, saved);
  }
}, 30000);

test('another language set up: its voice, and an online voice says so on the button', async () => {
  const saved = Object.fromEntries(GLOBALS.map((k) => [k, globalThis[k]]));
  const p = await page('say-es', { voices: [...GOOGLE, ...ESPEAK], language: 'Spanish' });
  try {
    const [et] = p.words();
    p.over(et);
    const button = p.gloss().querySelector('fw-say');
    expect(button.title).toBe('Say "et" (online voice: the word is sent to Google)');
    p.click(button);
    expect(p.spoken).toEqual([{ text: 'et', voice: 'Google español', lang: 'es-ES' }]);
  } finally {
    await p.win.happyDOM.close();
    Object.assign(globalThis, saved);
  }
}, 30000);

test('keyboard: Tab from the word reaches its speaker, Tab goes on from the word, and a scroll keeps a focused speaker', async () => {
  const saved = Object.fromEntries(GLOBALS.map((k) => [k, globalThis[k]]));
  const p = await page('say-keys', { voices: [...ESPEAK] });
  try {
    const { document } = p.win;
    const [et, tres] = p.words();
    et.focus(); p.focus(et);
    const box = p.gloss();
    const button = box?.querySelector('fw-say');
    expect(button).not.toBeNull();
    // Tab from the word goes into its speaker (the box sits at the end of the page, so the browser's Tab never would);
    // the gloss stays. (happy-dom's own focus events are untrusted and ignored, so the trusted ones are sent by hand.)
    const tab = p.key(et, 'Tab');
    expect([tab.defaultPrevented, document.activeElement]).toEqual([true, button]);
    p.blur(et, button); p.focus(button, et);
    expect(p.gloss()?.querySelector('fw-say')).toBe(button);
    // A scroll while the speaker has focus keeps the gloss, which follows its word.
    p.win.dispatchEvent(new p.win.Event('scroll'));
    expect(p.gloss()?.querySelector('fw-say')).toBe(button);
    p.key(button, 'Enter');
    expect(p.spoken.map((s) => s.text)).toEqual(['et']);
    // Shift+Tab goes back to the word.
    const back = p.key(button, 'Tab', { shiftKey: true });
    expect([back.defaultPrevented, document.activeElement]).toEqual([true, et]);
    p.blur(button, et); p.focus(et, button);
    expect(p.gloss()?.querySelector('fw-say')).toBe(button);
    // Tab from the speaker puts focus back on the word and lets the browser's own Tab move on from there.
    p.key(et, 'Tab'); p.blur(et, button); p.focus(button, et);
    const on = p.key(button, 'Tab');
    expect([on.defaultPrevented, document.activeElement]).toEqual([false, et]);
    p.blur(button, et); p.focus(et, button);
    expect(p.gloss()).toBe(box);
    // Leaving for the next word closes this gloss; with focus elsewhere a scroll closes it, as before.
    tres.focus(); p.blur(et, tres); p.focus(tres, et);
    expect(p.gloss()?.querySelector('fw-say')?.title).toBe('Say "très"');
    p.blur(tres); tres.blur();
    p.over(tres);
    p.win.dispatchEvent(new p.win.Event('scroll'));
    expect([p.gloss(), tres.classList.contains('fw-tip')]).toEqual([null, false]);
    // Tab with no gloss open, or from a word whose gloss is not the open one, is left to the page.
    expect(p.key(et, 'Tab').defaultPrevented).toBe(false);
    et.focus(); p.focus(et); p.over(tres);
    expect([p.gloss()?.querySelector('fw-say')?.title, p.key(et, 'Tab').defaultPrevented]).toEqual(['Say "très"', false]);
  } finally {
    await p.win.happyDOM.close();
    Object.assign(globalThis, saved);
  }
}, 30000);

test('voices that load after the page give the next hover a speaker', async () => {
  const saved = Object.fromEntries(GLOBALS.map((k) => [k, globalThis[k]]));
  const p = await page('say-late', { voices: [] });
  try {
    const [et] = p.words();
    p.over(et);
    expect([et.classList.contains('fw-tip'), p.gloss()?.querySelector('fw-say')]).toEqual([true, null]);
    p.out(et);
    p.setVoices([...GOOGLE]);
    p.over(et);
    expect(p.gloss()?.querySelector('fw-say')?.title).toBe('Say "et" (online voice: the word is sent to Google)');
  } finally {
    await p.win.happyDOM.close();
    Object.assign(globalThis, saved);
  }
}, 30000);

test('the speaker bridge points at the word: down when the gloss is above it, up when there is no room above', async () => {
  const saved = Object.fromEntries(GLOBALS.map((k) => [k, globalThis[k]]));
  const p = await page('say-place', { voices: [...ESPEAK] });
  try {
    const [et] = p.words();
    const at = (top) => { et.getBoundingClientRect = () => ({ top, bottom: top + 16, left: 40, right: 60, width: 20, height: 16 }); };
    at(200);
    p.over(et);
    expect([p.gloss().classList.contains('fw-gloss-below'), p.gloss().style.top, p.gloss().style.left]).toEqual([false, '196px', '40px']);
    p.out(et);
    await wait(350);
    at(0);
    p.over(et);
    expect([p.gloss().classList.contains('fw-gloss-below'), p.gloss().style.top]).toEqual([true, '20px']);
  } finally {
    await p.win.happyDOM.close();
    Object.assign(globalThis, saved);
  }
}, 30000);

test('a pointer gets a moment to reach the speaker by any route, and the dwell stops counting meanwhile', async () => {
  const saved = Object.fromEntries(GLOBALS.map((k) => [k, globalThis[k]]));
  const p = await page('say-grace', { voices: [...ESPEAK] });
  try {
    const { body } = p.win.document;
    const [et] = p.words();
    // A pass over the word that leaves for the page: the box stays a moment, but it is no peek, then closes.
    p.over(et);
    await wait(400);
    p.out(et, body);
    expect(p.gloss()).not.toBeNull();
    await wait(400);
    expect([p.gloss(), et.classList.contains('fw-tip'), p.events]).toEqual([null, false, []]);
    // Off the word, across the page, onto the speaker: the gloss stays, and resting there is a peek of the word.
    p.over(et);
    const button = p.gloss().querySelector('fw-say');
    p.out(et, body);
    await wait(150);
    p.over(button, body);
    await wait(800);
    expect([p.gloss()?.querySelector('fw-say'), p.events]).toEqual([button, ['et:peek']]);
    // Off the speaker and back onto the word in time: still open.
    p.out(button, body);
    await wait(150);
    p.over(et, body);
    await wait(300);
    expect(p.gloss()?.querySelector('fw-say')).toBe(button);
    // Focus leaving does not wait.
    p.focus(et); p.blur(et, body);
    expect(p.gloss()).toBeNull();
  } finally {
    await p.win.happyDOM.close();
    Object.assign(globalThis, saved);
  }
}, 30000);

test('pressing the speaker leaves the page focus alone and is not the page\'s to see; keyboard focus on it survives other words', async () => {
  const saved = Object.fromEntries(GLOBALS.map((k) => [k, globalThis[k]]));
  const p = await page('say-press', { voices: [...ESPEAK] });
  try {
    const { document } = p.win;
    const [et, tres] = p.words();
    const seenByPage = []; // the page's own bubbling listeners (capturing ones on window still see a press, as with flips)
    for (const type of ['pointerdown', 'mousedown', 'click']) p.win.addEventListener(type, () => seenByPage.push(type));
    p.over(et);
    const button = p.gloss().querySelector('fw-say');
    const press = (type, trusted = true) => {
      const e = new p.win.MouseEvent(type, { bubbles: true, cancelable: true });
      if (trusted) Object.defineProperty(e, 'isTrusted', { value: true });
      button.dispatchEvent(e);
      return e.defaultPrevented;
    };
    // mousedown is what moves focus, so only it is prevented; none of the three reaches the page.
    expect([press('pointerdown'), press('mousedown'), (p.click(button), p.spoken.length)]).toEqual([false, true, 1]);
    expect(seenByPage).toEqual([]);
    // A page's own synthetic press is not touched.
    expect(press('mousedown', false)).toBe(false);
    expect(seenByPage).toEqual(['mousedown']);
    // With keyboard focus on the speaker, a pointer resting on another word (after a scroll) leaves the gloss be.
    p.out(et, document.body);
    et.focus(); p.focus(et);
    p.key(et, 'Tab'); p.blur(et, button); p.focus(button, et);
    expect(document.activeElement).toBe(button);
    p.win.dispatchEvent(new p.win.Event('scroll'));
    p.over(tres); p.out(tres, document.body);
    await wait(350);
    expect([p.gloss()?.querySelector('fw-say'), tres.classList.contains('fw-tip'), document.activeElement]).toEqual([button, false, button]);
    // Nor does a pointer leaving the word itself, and a quick pass over it is still no peek.
    p.over(et); p.out(et, document.body);
    await wait(800);
    expect([p.gloss()?.querySelector('fw-say'), p.events]).toEqual([button, []]);
    // Another window taking focus keeps the gloss for the speaker's return.
    document.hasFocus = () => false;
    p.blur(button);
    expect(p.gloss()?.querySelector('fw-say')).toBe(button);
    document.hasFocus = () => true;
    p.focus(button);
    // Focus leaving the speaker within the page closes the gloss.
    p.blur(button, document.body);
    expect(p.gloss()).toBeNull();
    // Anything else that closes it while the speaker has focus puts focus back on the word, not in a hidden box.
    const tabToSpeaker = () => {
      et.focus(); p.focus(et);
      const b = p.gloss().querySelector('fw-say');
      p.key(et, 'Tab'); p.blur(et, b); p.focus(b, et);
      return b;
    };
    tabToSpeaker();
    p.click(et);
    expect([p.gloss(), et.textContent, document.activeElement]).toEqual([null, 'and', et]);
    p.click(et);
    // A scroll that finds the word gone closes the gloss too.
    tabToSpeaker();
    p.win.document.querySelector('#a').remove();
    p.win.dispatchEvent(new p.win.Event('scroll'));
    expect(p.gloss()).toBeNull();
  } finally {
    await p.win.happyDOM.close();
    Object.assign(globalThis, saved);
  }
}, 30000);

test('modal pages: no Tab into the speaker past an aria-modal focus trap, or when it cannot take focus', async () => {
  const saved = Object.fromEntries(GLOBALS.map((k) => [k, globalThis[k]]));
  const p = await page('say-modal', { voices: [...ESPEAK] });
  try {
    const [et] = p.words();
    et.focus(); p.focus(et);
    // Focus that does not move (an inert box behind a modal <dialog>): Tab is left to the page.
    p.gloss().querySelector('fw-say').focus = () => {};
    expect(p.key(et, 'Tab').defaultPrevented).toBe(false);
    // A word inside an aria-modal dialog: the redirect is skipped, the speaker still shows for the pointer.
    p.blur(et); p.win.document.querySelector('main').setAttribute('aria-modal', 'true');
    et.focus(); p.focus(et);
    expect([p.key(et, 'Tab').defaultPrevented, p.gloss()?.querySelector('fw-say') !== null]).toEqual([false, true]);
  } finally {
    await p.win.happyDOM.close();
    Object.assign(globalThis, saved);
  }
}, 30000);
