// Content scripts cannot be ES modules, so this classic script pulls the module in.
(async () => {
  try {
    await import(chrome.runtime.getURL('src/content.js'));
  } catch (e) {
    console.error('[french-weave] failed to load', e);
  }
})();
