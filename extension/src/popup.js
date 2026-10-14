import { resolveLevel, MAX_BUILT_LEVEL } from './levels.js';
import { MODELS } from './gemini.js';
import { siteEnabled, siteOn, hasSiteAccess } from './settings.js';

const $ = (id) => document.getElementById(id);
const ALL_SITES = ['http://*/*', 'https://*/*'];
let status;
let tab;
let host = '';

const send = async (msg) => {
  const res = await chrome.runtime.sendMessage(msg);
  if (res?.error && !('ok' in res)) throw new Error(res.error);
  return res;
};

function ago(t) {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

async function refresh() {
  status = await send({ type: 'status' });
  const c = status.config;
  const s = c.settings; // newSitesEnabled resolved: popup choice, else setup's answer, else on
  const all = await chrome.permissions.contains({ origins: ALL_SITES });
  $('enabled').checked = s.enabled;
  $('newSitesEnabled').value = String(s.newSitesEnabled);
  $('siteEnabled').checked = !!host && siteOn(s, host) && hasSiteAccess(tab.url, c.origins);
  $('siteEnabled').disabled = !host;
  $('siteName').textContent = host || 'This page (not a website)';
  $('grantSites').hidden = all || !s.newSitesEnabled;
  $('accessNote').textContent = s.newSitesEnabled
    ? (all ? 'On for every site except the ones you turn off. Webmail, AI chat and local addresses start off.' : 'Chrome needs your OK before it can run on other sites.')
    : 'Off on sites until you turn them on here.';
  const { stage, chosen } = resolveLevel(s, c.stage);
  $('levelInfo').textContent = `L${chosen}${stage && chosen !== stage ? ` (Claude Code stage ${stage})` : ''}${chosen > MAX_BUILT_LEVEL ? ` · L${MAX_BUILT_LEVEL} rules for now` : ''}`;
  $('levelOverride').value = String(s.levelOverride || 0);
  $('model').value = s.model;
  $('apiKey').value = '';
  $('apiKey').placeholder = status.pastedKey ? 'saved (paste to replace)' : status.hostKey ? 'from setup (paste to override)' : 'AIza…';
  $('wordInfo').textContent = status.words
    ? `${status.words} from Claude Code · ${ago(status.fetchedAt)}${c.paused ? ' · paused' : ''}`
    : 'built-in list';
  $('operation').textContent = !s.enabled ? 'Off'
    : !c.hasKey ? 'Add a Gemini key to start'
    : c.paused ? 'Paused from Claude Code'
    : host && !siteEnabled(s, tab.url) ? 'Off on this site'
    : host && !hasSiteAccess(tab.url, c.origins) ? 'This site needs your OK'
    : status.modelStatus?.error || 'On';
  const list = $('siteList');
  list.replaceChildren();
  for (const [name, enabled] of Object.entries(s.siteOverrides)) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('span');
    label.textContent = `${name}: ${enabled ? 'on' : 'off'}`;
    const button = document.createElement('button');
    button.textContent = 'Reset';
    button.addEventListener('click', () => run(() => save({ siteOverride: { host: name, enabled: null } })));
    row.append(label, button);
    list.append(row);
  }
  if (!list.childNodes.length) list.textContent = 'None';
}

async function save(msg) {
  await send({ type: 'save', ...msg });
  await refresh();
}

async function run(fn) {
  $('notice').textContent = '';
  try { await fn(); } catch (e) { $('notice').textContent = e.message || 'Could not do that'; }
}

// The registered content script only reaches pages loaded after a grant; this covers the open tab.
async function inject() {
  if (!tab?.id || !host) return;
  try {
    await chrome.scripting.insertCSS({ target: { tabId: tab.id }, files: ['src/content.css'] });
    await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['src/content-loader.js'] });
  } catch { $('notice').textContent = 'Reload this page to start. Chrome blocks extensions on some pages.'; }
}

for (const [id, label] of Object.entries(MODELS)) {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = label;
  $('model').appendChild(opt);
}

$('enabled').addEventListener('change', (e) => run(() => save({ settings: { enabled: e.target.checked } })));
$('newSitesEnabled').addEventListener('change', (e) => run(() => save({ settings: { newSitesEnabled: e.target.value === 'true' } })));
$('levelOverride').addEventListener('change', (e) => run(() => save({ settings: { levelOverride: Number(e.target.value) || 0 } })));
$('model').addEventListener('change', (e) => run(() => save({ settings: { model: e.target.value } })));
$('apiKey').addEventListener('change', (e) => run(() => save({ apiKey: e.target.value })));
$('siteEnabled').addEventListener('change', (e) => run(async () => {
  const enabled = e.target.checked;
  if (enabled && !hasSiteAccess(tab.url, status.config.origins)) {
    // Chrome asks for this one site only; requests need the click that opened this, so it happens first.
    const accepted = await chrome.permissions.request({ origins: [`${new URL(tab.url).protocol}//${host}/*`] });
    if (!accepted) { await refresh(); return; }
  }
  await save({ siteOverride: { host, enabled } });
  if (enabled) await inject();
}));
$('grantSites').addEventListener('click', () => run(async () => {
  if (await chrome.permissions.request({ origins: ALL_SITES })) { await refresh(); await inject(); }
}));
$('syncWords').addEventListener('click', () => run(async () => {
  $('wordInfo').textContent = 'syncing…';
  const res = await send({ type: 'syncWords' });
  await refresh();
  if (!res?.ok) $('notice').textContent = `No Claude Code sync (${res?.error || 'failed'})`;
}));
$('clearCache').addEventListener('click', () => run(async () => {
  const res = await send({ type: 'clearCache' });
  await refresh();
  $('operation').textContent = `Cleared ${res.removed}`;
}));

void run(async () => {
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  try { const u = new URL(tab?.url); if (/^https?:$/.test(u.protocol)) host = u.hostname; } catch { /* internal tab */ }
  await refresh();
});
