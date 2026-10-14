// Shared settings shape. Stored under chrome.storage.local["settings"].
export const DEFAULT_SETTINGS = {
  enabled: true,
  apiKey: '', // empty: use the key the plugin's setup stored, if any
  model: 'gemini-3.8-flash',
  levelOverride: 0, // 0 = follow the Claude Code stage (Level 1 without the plugin)
};

export function withDefaults(s) {
  return { ...DEFAULT_SETTINGS, ...(s || {}) };
}
