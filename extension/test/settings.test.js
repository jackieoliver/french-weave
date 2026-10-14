import { expect, it } from 'bun:test';
import { cleanSettings, siteEnabled } from '../src/settings.js';

it('webmail, AI chat and local addresses start off; a popup choice wins', () => {
  const every = { ...cleanSettings(), newSitesEnabled: true };
  for (const url of ['https://example.com/a', 'https://news.ycombinator.com/', 'http://172.32.0.1/', 'https://mail.example.com/', 'http://100.128.0.1/', 'https://1.1.1.1/'])
    expect(siteEnabled(every, url)).toBe(true);
  for (const url of ['https://mail.google.com/mail/u/0/', 'https://outlook.office.com/mail/', 'https://mail.proton.me/u/0',
    'https://claude.ai/chat/1', 'https://chatgpt.com/c/1', 'https://gemini.google.com/app', 'http://localhost:3000/',
    'http://127.0.0.1/', 'http://[::1]/', 'http://10.0.0.5/', 'http://172.16.4.2/', 'http://192.168.1.1/', 'http://printer.local/',
    'https://mail.google.com./', 'http://[::ffff:127.0.0.1]/', 'http://0.0.0.0:8000/', 'http://169.254.1.1/', 'http://100.100.1.1:4100/',
    'https://box.example.ts.net/', 'http://router.lan/', 'http://app.test/', 'http://svc.internal/'])
    expect(siteEnabled(every, url)).toBe(false);
  const chosen = cleanSettings({ siteOverrides: { 'mail.google.com': true, 'example.com': false, 'localhost': true } });
  const withChoices = { ...chosen, newSitesEnabled: true };
  expect(siteEnabled(withChoices, 'https://mail.google.com/mail/')).toBe(true);
  expect(siteEnabled(withChoices, 'http://localhost:8080/')).toBe(true);
  expect(siteEnabled(withChoices, 'https://example.com/')).toBe(false);
  expect(siteEnabled({ ...chosen, newSitesEnabled: false }, 'https://mail.google.com/')).toBe(true);
});
