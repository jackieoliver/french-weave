import { resolveLevel, MAX_BUILT_LEVEL } from './levels.js';
import { MODELS } from './gemini.js';
import { withDefaults } from './settings.js';

const $ = (id) => document.getElementById(id);
let settings = withDefaults();
let words = { count: 0, stage: 0 };

function renderLevel() {
  const { stage, chosen, effective } = resolveLevel(settings, words.stage);
  let s = `L${chosen}`;
  if (stage && chosen !== stage) s += ` (Claude Code stage ${stage})`;
  if (effective < chosen) s += ` · using L${MAX_BUILT_LEVEL} rules for now`;
  $('levelInfo').textContent = s;
}

function ago(t) {
  if (!t) return '';
  const m = Math.round((Date.now() - t) / 60000);
  if (m < 1) return 'just now';
  if (m < 60) return `${m}m ago`;
  const h = Math.round(m / 60);
  return h < 24 ? `${h}h ago` : `${Math.round(h / 24)}d ago`;
}

// Words come from the Claude Code plugin through its native host; the bundled list runs without it.
async function renderWords() {
  words = (await chrome.runtime.sendMessage({ type: 'wordState' })) || { count: 0 };
  $('wordInfo').textContent = words.count
    ? `${words.count} from Claude Code · ${ago(words.fetchedAt)}${words.paused ? ' · paused' : ''}`
    : 'built-in list';
  $('apiKey').placeholder = words.hostKey ? 'from setup (paste to override)' : 'AIza…';
  if (!settings.apiKey && !words.hostKey) $('status').textContent = 'no key: off';
  renderLevel();
}

function render() {
  $('enabled').checked = !!settings.enabled;
  $('levelOverride').value = String(settings.levelOverride || 0);
  $('model').value = settings.model;
  $('apiKey').value = settings.apiKey || '';
  $('status').textContent = '';
  renderLevel();
  renderWords();
}

async function save(patch) {
  settings = { ...settings, ...patch };
  await chrome.storage.local.set({ settings });
  render();
}

for (const [id, label] of Object.entries(MODELS)) {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = label;
  $('model').appendChild(opt);
}

$('enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }));
$('levelOverride').addEventListener('change', (e) => save({ levelOverride: Number(e.target.value) || 0 }));
$('model').addEventListener('change', (e) => save({ model: e.target.value }));
$('apiKey').addEventListener('change', (e) => save({ apiKey: e.target.value.trim() }));
$('syncWords').addEventListener('click', async () => {
  $('status').textContent = 'syncing…';
  const res = await chrome.runtime.sendMessage({ type: 'syncWords' });
  $('status').textContent = res?.ok ? `${res.count} words, stage ${res.stage}` : `no Claude Code sync (${res?.error || 'failed'})`;
  renderWords();
});
$('clearCache').addEventListener('click', async () => {
  const res = await chrome.runtime.sendMessage({ type: 'clearCache' });
  $('status').textContent = res?.ok ? `cleared ${res.removed}` : (res?.error || 'failed');
});

chrome.storage.local.get('settings').then(({ settings: s }) => {
  settings = withDefaults(s);
  render();
});
