// Popup handlers: settings, key, language packs, cache and status.
import { chromeStorage } from './cache.js';
import { classifyProviderFailure, cleanQuotaState, newCooldownEntry, readBoundedBody,
  safeModelStatus, statusLabel, visibleModelStatus, rejectedForEpoch, STATUS_KEY, QUOTA_STATE_KEY } from './quota-status.js';
import { API_BASE } from './gemini.js';
import { cleanSettings } from './settings.js';
import { MIN_RETENTION, MAX_RETENTION } from './fsrs.js';
import { localDay } from './events.js';
import { DAILY_MODEL_CALLS, callsToday, countCall } from './quota.js';
import { futureBudgetDay } from './learning.js';
import { bundledLanguage, GUARANI_STARTER } from './language-name.js';
import { PACKS_KEY, MAX_PACKS, cleanPacks, generatePack, languageCode, languageName } from './languages.js';
import { publicContext, laterDay } from './worker-context.js';
import { personalReview } from './review-state.js';

export function createSettingsHandlers({ store, cache, locked, modelCall, worker, cooldown, cooldownKinds,
    context, broadcast, reviewState, reviewStatus, checkUpdate }) {
  async function clearCache() {
    const removed = await locked(async () => {
      await store.set({ epoch: crypto.randomUUID() });
      return cache.clear();
    });
    await broadcast('retry');
    return { ok: true, removed };
  }

  async function addLanguage(msg) {
    if (worker.keyIsolationUnavailable) throw new Error(statusLabel({ category: 'key_isolation_unavailable' }));
    const code = languageCode(msg.code);
    if (!code) throw new Error('Enter a valid target-language code such as fr or ja');
    const before = await store.get(['settings', 'apiKey', 'keyEpoch', STATUS_KEY, PACKS_KEY]);
    if ((await store.get('consentShown')).consentShown === false) throw new Error('Choose site access on the welcome page first');
    const selected = cleanSettings(before.settings).language;
    if (!before.apiKey) throw new Error('Add your Gemini key first');
    if ((before.keyEpoch && worker.keyRejectedEpoch === before.keyEpoch) || rejectedForEpoch(before[STATUS_KEY], before.keyEpoch))
      throw new Error(statusLabel({ category: 'key_rejected' }));
    if (cleanPacks(before[PACKS_KEY])[code]) throw new Error('This language is already available');
    if (Object.keys(cleanPacks(before[PACKS_KEY])).length >= MAX_PACKS) throw new Error(`Maximum of ${MAX_PACKS} generated languages reached`);
    const model = cleanSettings(before.settings).model;
    const pack = await modelCall(async () => {
      const current = await store.get(['apiKey', 'keyEpoch', 'settings', STATUS_KEY, 'consentShown']);
      if (current.apiKey !== before.apiKey || current.keyEpoch !== before.keyEpoch ||
          cleanSettings(current.settings).model !== model || cleanSettings(current.settings).language !== selected)
        throw new Error('Model settings changed while generating; try again');
      if (current.consentShown === false) throw new Error('Choose site access on the welcome page first');
      if ((current.keyEpoch && worker.keyRejectedEpoch === current.keyEpoch) || rejectedForEpoch(current[STATUS_KEY], current.keyEpoch))
        throw new Error(statusLabel({ category: 'key_rejected' }));
      if (await callsToday(chromeStorage) >= DAILY_MODEL_CALLS) throw new Error('Daily model limit reached; try again tomorrow');
      try {
        return await generatePack({ code, apiKey: before.apiKey, model,
          fetchImpl: async (...args) => {
            const { response } = await locked(async () => {
              const latest = await store.get(['apiKey', 'keyEpoch', 'settings', STATUS_KEY, 'consentShown']);
              if (latest.apiKey !== before.apiKey || latest.keyEpoch !== before.keyEpoch ||
                  cleanSettings(latest.settings).model !== model ||
                  cleanSettings(latest.settings).language !== selected)
                throw new Error('Model settings changed while generating; try again');
              if (latest.consentShown === false) throw new Error('Choose site access on the welcome page first');
              if ((latest.keyEpoch && worker.keyRejectedEpoch === latest.keyEpoch) || rejectedForEpoch(latest[STATUS_KEY], latest.keyEpoch))
                throw new Error(statusLabel({ category: 'key_rejected' }));
              await countCall(chromeStorage);
              return { response: fetch(...args) };
            });
            return response;
          } });
      } catch (error) {
        if (error?.category === 'key_rejected') {
          try {
            await locked(async () => {
              const latest = await store.get(['apiKey', 'keyEpoch']);
              if (latest.apiKey !== before.apiKey || latest.keyEpoch !== before.keyEpoch) return;
              worker.keyRejectedEpoch = before.keyEpoch;
              await store.set({ [STATUS_KEY]: safeModelStatus({ category: 'key_rejected',
                at: Date.now(), model, keyEpoch: before.keyEpoch }) });
            });
          } catch { /* the worker-memory rejection still prevents another call */ }
        }
        throw error;
      }
    });
    await locked(async () => {
      const current = await store.get(['settings', 'apiKey', PACKS_KEY]);
      const packs = cleanPacks(current[PACKS_KEY]);
      if (packs[code] || Object.keys(packs).length >= MAX_PACKS) throw new Error('Languages changed while generating; try again');
      if (cleanSettings(current.settings).language !== selected) throw new Error('Selection changed while generating; try again');
      if (current.apiKey !== before.apiKey || cleanSettings(current.settings).model !== model) throw new Error('Model settings changed while generating; try again');
      await store.set({ epoch: crypto.randomUUID(), [PACKS_KEY]: { ...packs, [code]: pack },
        settings: cleanSettings({ ...current.settings, language: code }) });
    });
    await broadcast();
    return { ok: true, language: code };
  }

  async function removeLanguage(msg) {
    const code = languageCode(msg.code);
    if (!code) throw new Error('Choose a generated language to remove');
    await locked(async () => {
      const current = await store.get(['settings', PACKS_KEY]);
      const packs = cleanPacks(current[PACKS_KEY]);
      const pack = packs[code];
      if (!pack) throw new Error('This language is not available');
      const settings = cleanSettings(current.settings);
      if (settings.language !== code) throw new Error('The selected language changed; refresh and try again');
      delete packs[code];
      settings.language = 'es';
      if (worker.keyIsolationUnavailable && typeof current.settings?.apiKey === 'string')
        settings.apiKey = current.settings.apiKey;
      await store.set({ epoch: crypto.randomUUID(), [PACKS_KEY]: packs, settings });
      const all = await store.get(null);
      const prefix = `lang:${code}:${pack.version}:`;
      const keys = Object.keys(all).filter((key) => key.startsWith(prefix));
      if (keys.length) await store.remove(keys);
    });
    await broadcast();
    return { ok: true };
  }

  // msg.settings: a partial patch; msg.siteOverride: { host, enabled: true | false | null (reset) }; msg.apiKey.
  async function save(msg, forceKeyRotation = false) {
    if (worker.keyIsolationUnavailable && typeof msg.apiKey === 'string' && msg.apiKey.trim())
      throw new Error(statusLabel({ category: 'key_isolation_unavailable' }));
    if (typeof msg.apiKey === 'string' && !msg.apiKey.trim() && !forceKeyRotation)
      throw new Error('Use Remove key to delete the saved key.');
    if (msg.consentShown === true && typeof msg.settings?.newSitesEnabled !== 'boolean')
      throw new Error('Choose a site policy before confirming consent');
    worker.settingsGeneration++;
    await locked(async () => {
      const saved = await store.get(['settings', 'apiKey']);
      if (msg.settings && typeof msg.settings === 'object' && Object.hasOwn(msg.settings, 'language') &&
          !bundledLanguage(msg.settings.language) && languageCode(msg.settings.language) !== msg.settings.language) {
        throw new Error('Invalid language code');
      }
      const merged = { ...saved.settings, ...msg.settings };
      // FSRS target recall: an explicit value must be valid; null returns to the 0.9 default.
      if (msg.settings && typeof msg.settings === 'object' && Object.hasOwn(msg.settings, 'desiredRetention')) {
        const value = msg.settings.desiredRetention;
        if (value === null) delete merged.desiredRetention;
        else if (!(typeof value === 'number' && value >= MIN_RETENTION && value <= MAX_RETENTION))
          throw new Error(`Target recall must be between ${MIN_RETENTION} and ${MAX_RETENTION}`);
      }
      if (msg.siteOverride && typeof msg.siteOverride.host === 'string') {
        merged.siteOverrides = { ...saved.settings?.siteOverrides };
        if (msg.siteOverride.enabled === null) delete merged.siteOverrides[msg.siteOverride.host];
        else merged.siteOverrides[msg.siteOverride.host] = msg.siteOverride.enabled;
      }
      const next = cleanSettings(merged);
      if (!bundledLanguage(next.language) && !cleanPacks((await store.get(PACKS_KEY))[PACKS_KEY])[next.language]) {
        if (msg.settings && Object.hasOwn(msg.settings, 'language')) throw new Error('Choose an available language');
        next.language = 'es';
      }
      // A settings round trip must not revive a result from its earlier revision.
      const patch = { settings: next, ...(msg.consentShown === true ? { consentShown: true } : {}) };
      // An old profile may still hold its key inside settings. Keep it until the
      // explicit removal path, even when this browser cannot isolate storage.
      if (worker.keyIsolationUnavailable && typeof saved.settings?.apiKey === 'string' &&
          typeof msg.apiKey !== 'string' && !forceKeyRotation) {
        patch.settings = { ...next, apiKey: saved.settings.apiKey };
      }
      if (typeof msg.apiKey === 'string') {
        if (msg.apiKey.length > 500) throw new Error('Key is too long');
        patch.apiKey = msg.apiKey.trim();
      }
      // Target recall affects only review scheduling, and guess first only how a hover answers, so
      // changing either alone keeps the reading epoch and its cached results.
      const reading = ({ desiredRetention, guessFirst, ...rest }) => JSON.stringify(rest);
      const before = cleanSettings(saved.settings);
      const keyChanged = forceKeyRotation || (Object.hasOwn(patch, 'apiKey') && patch.apiKey !== saved.apiKey);
      if (reading(next) === reading(before) && !keyChanged) {
        if (JSON.stringify(next) !== JSON.stringify(before) || msg.consentShown === true) await store.set(patch);
      } else {
        patch.epoch = crypto.randomUUID();
        if (forceKeyRotation || Object.hasOwn(patch, 'apiKey') && patch.apiKey !== saved.apiKey) {
          patch.keyEpoch = crypto.randomUUID();
          patch[QUOTA_STATE_KEY] = { keyEpoch: patch.keyEpoch, cooldowns: {} };
          patch[STATUS_KEY] = null;
          cooldown.clear();
          cooldownKinds.clear();
          worker.keyRejectedEpoch = '';
        }
        await store.set(patch);
      }
    });
    await broadcast();
    return { ok: true };
  }

  async function removeKey() {
    await save({ apiKey: '' }, true); // the key-change path rotates both epochs and clears all diagnostics
    return { ok: true };
  }

  async function testKey() {
    if (worker.keyIsolationUnavailable) return { ok: false, category: 'key_isolation_unavailable' };
    return modelCall(async () => {
      const settingsGeneration = worker.settingsGeneration;
      const before = await store.get(['apiKey', 'keyEpoch', 'settings', QUOTA_STATE_KEY, STATUS_KEY]);
      if ((await store.get('consentShown')).consentShown === false) return { ok: false, category: 'consent_required' };
      if (!before.apiKey) return { ok: false, category: 'no_key' };
      const epoch = before.keyEpoch || '';
      if ((epoch && worker.keyRejectedEpoch === epoch) || rejectedForEpoch(before[STATUS_KEY], epoch))
        return { ok: false, category: 'key_rejected' };
      const model = cleanSettings(before.settings).model;
      if (await callsToday(chromeStorage) >= DAILY_MODEL_CALLS) return { ok: false, category: 'local_budget' };
      const cooldowns = cleanQuotaState(before[QUOTA_STATE_KEY], epoch).cooldowns;
      const blocked = cooldowns[model];
      if (blocked?.until > Date.now()) return { ok: false, category: blocked.kind === 'daily' ? 'daily_quota'
        : blocked.kind === 'overloaded' ? 'overloaded' : blocked.kind === 'short' ? 'rate_limit' : 'request_failed' };
      let response;
      try {
        // The locked boundary prevents a key change between the final check, call count, and dispatch.
        ({ response } = await locked(async () => {
          const current = await store.get(['apiKey', 'keyEpoch', 'settings', 'consentShown']);
          if (current.consentShown === false) return { response: 'consent' };
          if (worker.settingsGeneration !== settingsGeneration || current.keyEpoch !== epoch || current.apiKey !== before.apiKey ||
              cleanSettings(current.settings).model !== model) return { response: null };
          if (await callsToday(chromeStorage) >= DAILY_MODEL_CALLS) return { response: 'budget' };
          await countCall(chromeStorage);
          if (worker.settingsGeneration !== settingsGeneration) return { response: null };
          const url = `${API_BASE}${model}:generateContent`;
          let request;
          try {
            request = fetch(url, { method: 'POST',
              headers: { 'Content-Type': 'application/json', 'x-goog-api-key': before.apiKey },
              body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: 'Reply OK.' }] }],
                generationConfig: { maxOutputTokens: 1 } }), signal: AbortSignal.timeout(8000) });
          } catch (error) { request = Promise.reject(error); }
          return { response: request };
        }));
      } catch { return { ok: false, category: 'storage_failed' }; }
      if (response === 'budget') return { ok: false, category: 'local_budget' };
      if (response === 'consent') return { ok: false, category: 'consent_required' };
      if (!response) return { ok: false, category: 'changed' };
      let category = 'ok';
      let failure;
      try {
        const result = await response;
        if (!result.ok) {
          const body = await readBoundedBody(result);
          failure = classifyProviderFailure({ status: result.status, body,
            retryAfter: result.headers?.get?.('retry-after') });
          category = failure.category;
        }
      } catch { category = 'request_failed'; }
      return locked(async () => {
        const current = await store.get(['apiKey', 'keyEpoch', 'settings', QUOTA_STATE_KEY]);
        if (worker.settingsGeneration !== settingsGeneration || current.keyEpoch !== epoch ||
            current.apiKey !== before.apiKey || cleanSettings(current.settings).model !== model) {
          return { ok: false, category: 'changed' };
        }
        if (category === 'key_rejected') worker.keyRejectedEpoch = epoch;
        const patch = { [STATUS_KEY]: safeModelStatus({ category, at: Date.now(), model, keyEpoch: epoch }) };
        if (failure?.retryAfterMs && ['daily_quota', 'rate_limit', 'overloaded'].includes(category)) {
          const state = cleanQuotaState(current[QUOTA_STATE_KEY], epoch);
          const kind = category === 'daily_quota' ? 'daily' : category === 'overloaded' ? 'overloaded' : 'short';
          const entry = newCooldownEntry(kind, failure.retryAfterMs, Date.now());
          if (entry) { state.cooldowns[model] = entry; patch[QUOTA_STATE_KEY] = state; }
        }
        await store.set(patch);
        return { ok: category === 'ok', category };
      });
    });
  }

  async function status() {
    const config = await context();
    const data = await store.get(['apiKey', 'settings', 'keyEpoch', STATUS_KEY, QUOTA_STATE_KEY, PACKS_KEY, 'consentShown']);
    const { state } = await reviewState(config);
    const modelStatus = visibleModelStatus(data[STATUS_KEY], data[QUOTA_STATE_KEY], data.keyEpoch,
      safeModelStatus(data[STATUS_KEY])?.category === 'local_budget' &&
        await callsToday(chromeStorage) >= DAILY_MODEL_CALLS);
    return { config: publicContext(config), words: config.words.length,
      languages: ['es', GUARANI_STARTER, ...Object.keys(cleanPacks(data[PACKS_KEY]))].map((code) =>
        ({ code, name: languageName(code), experimental: !bundledLanguage(code) })),
      pastedKey: !!(data.apiKey || data.settings?.apiKey), consentShown: data.consentShown !== false,
      modelStatus: worker.keyIsolationUnavailable ? { category: 'key_isolation_unavailable' } : modelStatus,
      budgetWarning: laterDay(futureBudgetDay(state.learning, localDay()),
        futureBudgetDay(personalReview(config).state.learning, localDay())),
      review: await reviewStatus(config),
      update: await checkUpdate() };
  }
  return { clearCache, addLanguage, removeLanguage, save, removeKey, testKey, status };
}
