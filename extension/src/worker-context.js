// The page-facing reading context and its broadcast. Every handler derives consent and
// policy from context(); its revision changes whenever anything that affects swaps does.
import { chromeStorage } from './cache.js';
import { cleanSettings, newSitesDefault, siteEnabled, hasSiteAccess } from './settings.js';
import { resolveLevel, wordsForLevel } from './levels.js';
import { hashKey } from './hash.js';
import { bundledLanguage, GUARANI_STARTER } from './language-name.js';
import { GUARANI_PACK } from './guarani.js';
import { PACKS_KEY, cleanPacks, packWords } from './languages.js';
import { scopedStorage } from './scope.js';
import { englishAnchors } from './catalog.js';
import { PERSONAL_KEY, cleanPersonal, personalWords, targetAliases } from './personal.js';

export const activeOn = (ctx, url) => ctx.hasKey && !ctx.paused && siteEnabled(ctx.settings, url) && hasSiteAccess(url, ctx.origins);
// Review scheduling only: never part of the reading revision or of what pages receive.
const pageSettings = ({ desiredRetention, ...settings }) => settings;
// Guess first changes only how a hover answers, not which words are swapped: pages receive it, but
// it stays out of the reading revision, so turning it on or off costs no cache or model call.
const readingSettings = ({ guessFirst, ...settings }) => pageSettings(settings);
export const publicContext = ({ words, allWords, legacyWords, legacyAllWords, personal, captureEpoch,
  activePersonal, personalAuto, settings, ...safe }) => ({ ...safe, settings: pageSettings(settings) });
export const personalScope = (language) => scopedStorage(chromeStorage, `personal:${language}`);
export const laterDay = (a, b) => a > b ? a : b; // ISO local dates or empty string

export function createContext({ store, ready, worker }) {
  // What pages get. The revision changes whenever anything that affects swaps does, so stale replies are dropped.
  async function context() {
    await ready;
    const data = await store.get(['settings', 'epoch', PACKS_KEY, PERSONAL_KEY,
      ...(!worker.keyIsolationUnavailable ? ['apiKey'] : [])]);
    const saved = cleanSettings(data.settings);
    const packs = cleanPacks(data[PACKS_KEY]);
    if (!bundledLanguage(saved.language) && !packs[saved.language]) saved.language = 'es';
    const settings = { ...saved, newSitesEnabled: newSitesDefault(saved) };
    const level = resolveLevel(saved).effective;
    const pack = saved.language === GUARANI_STARTER ? GUARANI_PACK : packs[saved.language];
    const legacyAllWords = pack ? packWords(pack, 2) : wordsForLevel(2);
    const legacyWords = level <= 1 ? (pack ? packWords(pack, 1) : wordsForLevel(1)) : legacyAllWords;
    const personal = cleanPersonal(data[PERSONAL_KEY], settings.gradual);
    const activePersonal = personalWords(personal, saved.language, legacyAllWords);
    const personalAuto = activePersonal.filter(({ reviewOnly }) => !reviewOnly);
    const separate = activePersonal.filter(({ entry }) => !entry.linkedLegacy).map(({ entry }) => entry);
    const blockedLegacy = (word) => separate.some((entry) => {
      // An exact pack match is already teachable by the pack. Keep it available;
      // a separate personal ID survives if the generated pack is later removed.
      if (entry.source === word.en && entry.target === word.fr && entry.sense === word.en) return false;
      return targetAliases(entry.target, saved.language).some((target) =>
        targetAliases(word.fr, saved.language).includes(target)) ||
        englishAnchors({ en: entry.source }).some((anchor) => englishAnchors(word).includes(anchor));
    });
    const safeLegacyWords = legacyWords.filter((word) => !blockedLegacy(word));
    const autoWords = settings.gradual ? personalAuto.map(({ word }) => word) : [];
    const allWords = [...legacyAllWords, ...autoWords];
    const words = [...safeLegacyWords, ...autoWords];
    const scope = pack ? `${saved.language}:${pack.version}` : 'es';
    const hasKey = !!data.apiKey;
    const paused = false; // retained in the page config protocol; pause is settings.enabled
    const { origins = [] } = await chrome.permissions.getAll();
    const revision = hashKey(JSON.stringify([data.epoch || '', readingSettings(settings), level, scope,
      safeLegacyWords.map((word) => [word.fr, word.en]), personalAuto.map(({ entry }) =>
        [entry.id, entry.source, entry.target]), personal.unsupported === true,
      chrome.runtime.getManifest().version, hasKey, origins]));
    return { settings, level, revision, hasKey, paused, origins, captureEpoch: data.epoch || '',
      stage: 0, language: saved.language,
      scope, words, allWords, legacyWords, legacyAllWords, personal, activePersonal, personalAuto };
  }

  async function broadcast(type = 'config') {
    const config = publicContext(await context());
    const tabs = await chrome.tabs.query({});
    await Promise.allSettled(tabs.map((t) => chrome.tabs.sendMessage(t.id, { type, config })));
  }
  return { context, broadcast };
}
