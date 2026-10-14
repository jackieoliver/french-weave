// Preferences, stored under chrome.storage.local["settings"]. The Gemini key is stored apart from these, so
// the config pages get never carries it.
export const DEFAULT_SETTINGS = {
  enabled: true,
  model: 'gemini-3.8-flash',
  levelOverride: 0, // 0 = follow the Claude Code stage (Level 1 without the plugin)
  newSitesEnabled: null, // null = what setup chose (prefs.extension_sites), else on
  siteOverrides: {}, // hostname -> true/false, set from the popup
};

export function cleanSettings(s = {}) {
  const d = { ...DEFAULT_SETTINGS, siteOverrides: {} };
  if (typeof s.enabled === 'boolean') d.enabled = s.enabled;
  if (typeof s.newSitesEnabled === 'boolean') d.newSitesEnabled = s.newSitesEnabled;
  if (['gemini-3.8-flash', 'gemini-3.5-flash-lite'].includes(s.model)) d.model = s.model;
  if (Number.isInteger(s.levelOverride) && s.levelOverride >= 0 && s.levelOverride <= 4) d.levelOverride = s.levelOverride;
  for (const [host, enabled] of Object.entries(s.siteOverrides || {})) {
    if (/^(?=.{1,253}$)[a-z0-9]+(?:[a-z0-9.-]*[a-z0-9])?$/.test(host) && typeof enabled === 'boolean') d.siteOverrides[host] = enabled;
  }
  return d;
}

// An explicit popup choice wins; otherwise setup's answer ("ask" = off until turned on); otherwise on.
export function newSitesDefault(settings, sites) {
  return typeof settings.newSitesEnabled === 'boolean' ? settings.newSitesEnabled : sites !== 'ask';
}

// `settings` here has newSitesEnabled resolved to a boolean (see newSitesDefault).
export function siteEnabled(settings, url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && settings.enabled && (settings.siteOverrides[u.hostname] ?? settings.newSitesEnabled);
  } catch { return false; }
}

export function hasSiteAccess(url, origins = []) {
  try {
    const u = new URL(url);
    return origins.some((pattern) => {
      if (pattern === '<all_urls>') return /^https?:$/.test(u.protocol);
      const m = pattern.match(/^(https?|\*):\/\/([^/]+)\/\*$/);
      return m && (m[1] === '*' || u.protocol === m[1] + ':') &&
        (m[2] === '*' || u.host === m[2] || u.hostname === m[2] || (m[2].startsWith('*.') && (u.hostname === m[2].slice(2) || u.hostname.endsWith(m[2].slice(1)))));
    });
  } catch { return false; }
}
