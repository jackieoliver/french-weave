import { localize, t } from './i18n.js';
import { statusLabel } from './quota-status.js';
import { resolveLevel } from './levels.js';
import { MODELS } from './gemini.js';
import { weekLine, headline } from './progress-text.js';

const $ = (id) => document.getElementById(id);
localize();
const ALL_SITES = ['http://*/*', 'https://*/*'];
let status;
let refreshGeneration = 0;

const send = async (msg) => {
  const res = await chrome.runtime.sendMessage(msg);
  if (res?.error && !('ok' in res)) throw new Error(res.error);
  return res;
};

async function refresh() {
  const generation = ++refreshGeneration;
  const next = await send({ type: 'status' });
  const all = await chrome.permissions.contains({ origins: ALL_SITES });
  const progress = await send({ type: 'progress' }).catch(() => null); // informational only
  if (generation !== refreshGeneration) return;
  status = next;
  const c = status.config;
  const s = c.settings;
  $('version').textContent = chrome.runtime.getManifest().version;
  $('update').hidden = !status.update;
  $('updateVersion').textContent = status.update || '';
  $('newSitesEnabled').value = String(s.newSitesEnabled);
  $('newSitesEnabled').disabled = !status.consentShown;
  $('consentNote').textContent = status.consentShown ? t('options_consent_chosen') : t('options_consent_pending');
  $('welcomeLink').hidden = status.consentShown;
  $('grantSites').hidden = !status.consentShown || all || !s.newSitesEnabled;
  $('accessNote').textContent = s.newSitesEnabled
    ? (all ? t('options_access_all') : t('options_access_needs_ok'))
    : t('options_access_off');
  const { effective } = resolveLevel(s);
  $('levelInfo').textContent = t('options_level_value', effective);
  $('levelOverride').value = String(s.levelOverride || 0);
  $('gradual').checked = s.gradual;
  $('newWordsPerDay').value = String(s.newWordsPerDay);
  $('newWordsPerDay').disabled = !s.gradual;
  $('density').value = s.density;
  $('inlineRecall').checked = s.inlineRecall;
  $('inlineRecall').disabled = !s.gradual;
  $('guessFirst').checked = s.guessFirst === true;
  $('guessFirst').disabled = !s.gradual;
  $('language').replaceChildren();
  for (const item of status.languages) {
    const option = document.createElement('option');
    option.value = item.code;
    option.textContent = item.experimental ? t('options_language_experimental', item.name) : item.name;
    $('language').append(option);
  }
  $('language').value = c.language;
  const selected = status.languages.find((item) => item.code === c.language);
  $('removeLanguage').hidden = !selected?.experimental;
  $('model').value = s.model;
  $('wordInfo').textContent = t('options_word_count', status.words, selected?.name || c.language);
  $('reviewInfo').textContent = String(status.review.due);
  $('progressSummary').textContent = progress ? `${headline(progress.verifiedKnown)} · ${weekLine(progress.practisedThisWeek)}` : '';
  $('apiKey').placeholder = status.pastedKey ? t('options_key_saved_placeholder') : 'AIza…';
  $('testKey').disabled = !status.pastedKey || !status.consentShown;
  $('addLanguage').disabled = !status.consentShown;
  $('removeKey').disabled = !status.pastedKey;
  if (status.modelStatus?.category === 'key_isolation_unavailable')
    $('keyFeedback').textContent = statusLabel(status.modelStatus);
  else if ($('keyFeedback').textContent === statusLabel({ category: 'key_isolation_unavailable' }))
    $('keyFeedback').textContent = '';
  const list = $('siteList');
  list.replaceChildren();
  for (const [name, enabled] of Object.entries(s.siteOverrides)) {
    const row = document.createElement('div');
    row.className = 'row';
    const label = document.createElement('span');
    label.textContent = enabled ? t('options_site_on', name) : t('options_site_off', name);
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = t('options_site_reset');
    button.addEventListener('click', () => run(() => save({ siteOverride: { host: name, enabled: null } })));
    row.append(label, button);
    list.append(row);
  }
  if (!list.childNodes.length) list.textContent = t('options_no_exceptions');
}

async function save(msg) {
  await send({ type: 'save', ...msg });
  await refresh();
}

async function run(fn) {
  $('notice').textContent = '';
  $('operation').textContent = '';
  try { await fn(); } catch (e) { $('notice').textContent = e.message || t('options_error_generic'); }
}

for (const [id, label] of Object.entries(MODELS)) {
  const opt = document.createElement('option');
  opt.value = id;
  opt.textContent = label;
  $('model').appendChild(opt);
}

$('newSitesEnabled').addEventListener('change', (e) => run(() => save({ settings: { newSitesEnabled: e.target.value === 'true' } })));
$('levelOverride').addEventListener('change', (e) => run(() => save({ settings: { levelOverride: Number(e.target.value) || 0 } })));
$('gradual').addEventListener('change', (e) => run(() => save({ settings: { gradual: e.target.checked } })));
$('newWordsPerDay').addEventListener('change', (e) => run(() => save({ settings: { newWordsPerDay: Number(e.target.value) } })));
$('density').addEventListener('change', (e) => run(() => save({ settings: { density: e.target.value } })));
$('inlineRecall').addEventListener('change', (e) => run(() => save({ settings: { inlineRecall: e.target.checked } })));
$('guessFirst').addEventListener('change', (e) => run(() => save({ settings: { guessFirst: e.target.checked } })));
$('language').addEventListener('change', (e) => run(() => save({ settings: { language: e.target.value } })));
$('addLanguage').addEventListener('click', () => run(async () => {
  const button = $('addLanguage');
  button.disabled = true;
  $('operation').textContent = t('options_generating');
  try { await send({ type: 'addLanguage', code: $('newLanguage').value.trim() }); await refresh(); }
  finally { button.disabled = false; $('operation').textContent = ''; }
}));
$('removeLanguage').addEventListener('click', () => run(async () => {
  await send({ type: 'removeLanguage', code: status.config.language });
  await refresh();
}));
$('model').addEventListener('change', (e) => run(() => save({ settings: { model: e.target.value } })));
const saveKey = () => run(async () => {
  $('keyFeedback').textContent = '';
  const key = $('apiKey').value.trim();
  if (!key) { $('keyFeedback').textContent = t('options_key_paste_first'); return; }
  await save({ apiKey: key });
  $('apiKey').value = '';
  $('keyFeedback').textContent = t('options_key_saved');
});
$('saveKey').addEventListener('click', saveKey);
$('apiKey').addEventListener('keydown', (e) => {
  if (e.key === 'Enter') { e.preventDefault(); void saveKey(); }
});
$('testKey').addEventListener('click', () => run(async () => {
  const button = $('testKey');
  button.disabled = true;
  $('keyFeedback').textContent = t('options_key_testing');
  try {
    const result = await send({ type: 'testKey' });
    await refresh();
    $('keyFeedback').textContent = result.ok ? t('options_key_works') : result.category === 'no_key'
      ? t('options_key_add_first') : result.category === 'changed' ? t('options_key_changed')
      : result.category === 'consent_required' ? t('options_key_consent_required')
      : statusLabel({ category: result.category }) || t('options_key_model_failed');
  } finally { button.disabled = !status?.pastedKey || !status?.consentShown; }
}));
$('removeKey').addEventListener('click', () => run(async () => {
  $('keyFeedback').textContent = '';
  await send({ type: 'removeKey' });
  await refresh();
  $('apiKey').value = '';
  $('keyFeedback').textContent = t('options_key_removed');
}));
$('grantSites').addEventListener('click', () => run(async () => {
  if (await chrome.permissions.request({ origins: ALL_SITES })) await refresh();
}));
$('clearCache').addEventListener('click', () => run(async () => {
  const res = await send({ type: 'clearCache' });
  await refresh();
  $('operation').textContent = t('options_cleared', res.removed);
}));
$('openExtensions').addEventListener('click', () => {
  void chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

const refreshAfterExternalChange = () => {
  $('operation').textContent = '';
  void refresh().catch((e) => { $('notice').textContent = e.message || t('options_error_refresh'); });
};
chrome.storage.onChanged.addListener((changes, area) => {
  if (area === 'local' && Object.keys(changes).some((key) =>
    ['settings', 'apiKey', 'languagePacks', 'recallReview', 'personalVocabularyV1'].includes(key) ||
    key.endsWith(':recallReview'))) {
    refreshAfterExternalChange();
  }
});
chrome.permissions.onAdded.addListener(refreshAfterExternalChange);
chrome.permissions.onRemoved.addListener(refreshAfterExternalChange);
document.addEventListener('visibilitychange', () => {
  if (!document.hidden) refreshAfterExternalChange();
});
// Due dates can pass without a storage write while this tab stays open.
document.defaultView.setInterval(() => {
  if (!document.hidden) refreshAfterExternalChange();
}, 5 * 60 * 1000);

void run(refresh);
