import { isZeroFrench, wordCount } from './levels.js';
import { flatten } from './text.js';

export const TWEET = '[data-testid="tweetText"]';
export const PROSE = 'p,li,blockquote,h1,h2,h3,h4,article,main';
const BLOCKED = 'a,button,input,textarea,select,form,nav,header,footer,code,pre,kbd,samp,script,style,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[role="button"],[hidden],[aria-hidden="true"],[translate="no"],.notranslate';
export const isX = (url) => /^(www\.)?(x\.com|twitter\.com)$/.test(new URL(url).hostname);
export function selector(url) { return isX(url) ? TWEET : PROSE; }
export function readable(el, url) {
  if (!el.isConnected || el.closest(BLOCKED)) return false;
  if (el.querySelector('input,textarea,select,form,[contenteditable]:not([contenteditable="false"]),[role="textbox"],[hidden],[aria-hidden="true"],script,style')) return false;
  if (/\/(?:login|signin|sign-in|checkout|payment|billing|settings|account)(?:\/|$)/i.test(new URL(url).pathname)) return false;
  const lang = el.closest('[lang]')?.getAttribute('lang') || '';
  if (lang && !/^(en(?:-|$)|und$|qme$|zxx$|art$)/i.test(lang)) return false;
  if (!isX(url) && el.querySelector(PROSE)) return false;
  const text = flatten(el).text;
  return text.length <= 2000 && wordCount(text) >= 6 && !isZeroFrench(text);
}
