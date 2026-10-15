// Preferences, stored under chrome.storage.local["settings"]. The Gemini key is stored apart from these, so
// the config pages get never carries it.
export const DEFAULT_SETTINGS = {
  enabled: true,
  model: 'gemini-3.5-flash-lite', // on free keys 3.8 Flash mostly answered 503 or timed out (QA, 2026-10-15)
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

// Private sites start off even when every site is on, so their text never goes to Gemini unless the user turns
// the site on from the popup: webmail and messaging, AI chat, password managers, banking and payments, health
// portals, government, and local or intranet addresses. Each domain also covers its subdomains.
const OFF_DOMAINS = new Set([
  // webmail, messaging, personal documents
  'mail.google.com', 'outlook.live.com', 'outlook.office.com', 'outlook.office365.com', 'mail.proton.me',
  'mail.yahoo.com', 'mail.aol.com', 'mail.zoho.com', 'icloud.com', 'fastmail.com', 'hey.com', 'tuta.com',
  'web.whatsapp.com', 'messages.google.com', 'chat.google.com', 'web.telegram.org', 'messenger.com', 'discord.com',
  'app.slack.com', 'teams.microsoft.com', 'teams.live.com', 'docs.google.com', 'drive.google.com',
  'calendar.google.com', 'contacts.google.com', 'onedrive.live.com',
  // AI chat
  'claude.ai', 'chatgpt.com', 'chat.openai.com', 'gemini.google.com', 'aistudio.google.com', 'copilot.microsoft.com',
  'perplexity.ai', 'poe.com', 'chat.mistral.ai', 'grok.com', 'chat.deepseek.com',
  // password managers
  'proton.me', '1password.com', 'bitwarden.com', 'lastpass.com', 'dashlane.com', 'keepersecurity.com',
  // banking, payments, brokerage, credit
  'paypal.com', 'venmo.com', 'cash.app', 'wise.com', 'revolut.com', 'monzo.com', 'chase.com', 'wellsfargo.com',
  'citi.com', 'capitalone.com', 'americanexpress.com', 'discover.com', 'ally.com', 'sofi.com', 'chime.com', 'pnc.com',
  'schwab.com', 'fidelity.com', 'vanguard.com', 'robinhood.com', 'coinbase.com', 'creditkarma.com', 'intuit.com',
  'hsbc.com', 'barclays.co.uk', 'santander.co.uk', 'natwest.com', 'lloydsbank.com',
  // health portals
  'kp.org', 'followmyhealth.com', 'healow.com', 'athenahealth.com', 'onemedical.com', 'nhs.uk',
]);
// Hostnames that name a bank, credit union or patient portal (bankofamerica.com, mychart.example.org).
const OFF_WORDS = /bank|creditunion|mychart|patient/;
export function offByDefault(hostname) {
  const host = hostname.replace(/\.$/, '');
  const labels = host.split('.');
  return labels.some((_, i) => OFF_DOMAINS.has(labels.slice(i).join('.'))) ||
    OFF_WORDS.test(labels.slice(0, -1).join('.')) ||
    !host.includes('.') || host === '0.0.0.0' || host.startsWith('[') || // single-label intranet names, IPv6
    /\.(gov|mil|bank|insurance)$/.test(host) || /\.(gov|gob|gouv|govt|gv|mil)\.[a-z]{2}$/.test(host) || /\.gc\.ca$/.test(host) ||
    /\.(local|localhost|internal|intranet|corp|home|lan|localdomain|private|test|home\.arpa|ts\.net)$/.test(host) ||
    /^(127|10)\.\d+\.\d+\.\d+$/.test(host) || /^(192\.168|169\.254)\.\d+\.\d+$/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\.\d+\.\d+$/.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\.\d+\.\d+$/.test(host);
}

// `settings` here has newSitesEnabled resolved to a boolean (see newSitesDefault). A popup choice wins.
export function siteOn(settings, hostname) {
  const host = String(hostname).toLowerCase().replace(/\.$/, ''); // "example.com." is the same site
  const override = Object.hasOwn(settings.siteOverrides, host) ? settings.siteOverrides[host] : undefined;
  return override ?? (settings.newSitesEnabled && !offByDefault(host));
}

export function siteEnabled(settings, url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) && settings.enabled && siteOn(settings, u.hostname);
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
