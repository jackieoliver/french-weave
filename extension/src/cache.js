// Decision cache: key -> swaps. Storage adapter is injected (chrome.storage.local in the extension).
const PREFIX = 'c:';

export function createCache(storage, { max = 5000, pruneBy = 1000, pruneEvery = 100 } = {}) {
  let sinceCheck = 0;
  const cache = {
    async getMany(keys) {
      const obj = await storage.get(keys.map((k) => PREFIX + k));
      const out = {};
      for (const k of keys) {
        const v = obj[PREFIX + k];
        if (v && Array.isArray(v.s)) out[k] = v.s;
      }
      return out;
    },
    async setMany(entries) {
      const keys = Object.keys(entries);
      if (!keys.length) return;
      const obj = {};
      const t = Date.now();
      for (const k of keys) obj[PREFIX + k] = { s: entries[k], t };
      await storage.set(obj);
      sinceCheck += keys.length;
      if (sinceCheck >= pruneEvery) {
        sinceCheck = 0;
        await cache.prune();
      }
    },
    async prune() {
      const all = await storage.getAll();
      const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX));
      if (keys.length <= max) return 0;
      keys.sort((a, b) => (all[a].t || 0) - (all[b].t || 0));
      const drop = keys.slice(0, keys.length - max + pruneBy);
      await storage.remove(drop);
      return drop.length;
    },
    async clear() {
      const all = await storage.getAll();
      const keys = Object.keys(all).filter((k) => k.startsWith(PREFIX));
      if (keys.length) await storage.remove(keys);
      return keys.length;
    },
  };
  return cache;
}

export function memoryStorage(initial = {}) {
  const data = { ...initial };
  return {
    async get(keys) {
      const out = {};
      for (const k of keys) if (k in data) out[k] = data[k];
      return out;
    },
    async set(obj) { Object.assign(data, obj); },
    async remove(keys) { for (const k of keys) delete data[k]; },
    async getAll() { return { ...data }; },
  };
}

export const chromeStorage = {
  get: (keys) => chrome.storage.local.get(keys),
  set: (obj) => chrome.storage.local.set(obj),
  remove: (keys) => chrome.storage.local.remove(keys),
  getAll: () => chrome.storage.local.get(null),
};
