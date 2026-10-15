import { test, expect } from 'bun:test';
import { Window } from 'happy-dom';
import { selector, readable } from '../src/page.js';

const X = 'https://x.com/someone/status/1';
const setup = (html, url = X) => {
  const win = new Window({ url });
  win.document.body.innerHTML = html;
  return win.document;
};

test('X: post text is found in both the test-id markup and the logged-out markup', () => {
  const doc = setup(`
    <article><div lang="en" dir="auto" data-testid="tweetText"><span>Old markup with plenty of words in this post.</span></div></article>
    <article><div><a href="/someone"><div>Some Name</div></a></div>
      <div dir="auto"><span>"No one is born hating another person because of the color of his skin."</span></div>
      <a href="/someone/status/1">5:06 PM · Aug 12, 2017</a><span dir="ltr">58K</span></article>`);
  const found = [...doc.querySelectorAll(selector(X))].map((el) => el.textContent.trim());
  expect(found).toEqual(['Old markup with plenty of words in this post.', '"No one is born hating another person because of the color of his skin."']);
  for (const el of doc.querySelectorAll(selector(X))) expect(readable(el, X)).toBe(true);
});

test('other sites keep the prose selector', () => {
  expect(selector('https://example.com/a')).toBe('p,li,blockquote,h1,h2,h3,h4,article,main');
});
