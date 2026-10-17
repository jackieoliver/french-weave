// How many model calls run at once, and the paid providers' daily caps under that concurrency. No chrome APIs.
import { paidBlocked } from './quota.js';

// A first-in, first-out semaphore. run(fn) waits for a free slot; exclusive(fn) waits for every slot, so it starts
// once all earlier calls are done, and calls queued after it wait for it.
export function createLimiter(max) {
  let active = 0;
  const queue = [];
  const pump = () => {
    while (queue.length && active + queue[0].n <= max) {
      const next = queue.shift();
      active += next.n;
      next.go();
    }
  };
  const acquire = (n) => new Promise((go) => { queue.push({ n, go }); pump(); });
  const release = (n) => { active -= n; pump(); };
  const run = async (fn, n = 1) => {
    await acquire(n);
    try { return await fn(); } finally { release(n); }
  };
  return {
    run: (fn) => run(fn, 1),
    exclusive: (fn) => run(fn, max),
    // A slot held until the returned function is called (once).
    async take() {
      await acquire(1);
      let held = true;
      return () => { if (held) { held = false; release(1); } };
    },
    get active() { return active; },
    get waiting() { return queue.length; },
  };
}

// The daily spend caps under concurrency. A paid call is checked against today's spend before it starts; with calls
// to the same provider still out, their cost is not counted yet, so each call in flight holds a reservation of the
// most it can cost (boundUsd). A new call starts at once only when today's spend plus every reservation plus its own
// stays under the cap, which means it would pass the check even after every call in flight had cost its most; else it
// waits for one to finish and checks again. With nothing in flight the check is the plain one (spend under the cap),
// so the cap holds exactly as with one call at a time: no call starts that one-at-a-time calls would have refused.
// locked: the worker's storage lock, which the spend counts are written under too, so a check never reads a count
// half written. today(provider): { usd, stopped }. A call's release must come after its cost is counted.
export function createSpendGate({ locked, today }) {
  const providers = new Map(); // provider -> { held: Set of bounds, waiters: [resolve] }
  const of = (provider) => {
    if (!providers.has(provider)) providers.set(provider, { held: new Set(), waiters: [] });
    return providers.get(provider);
  };
  // Resolves to { release } once the call may start, or { blocked: 'cap' | 'credits' | 'key' } when it may not.
  async function acquire(provider, capUsd, boundUsd) {
    const bound = Number.isFinite(boundUsd) && boundUsd > 0 ? boundUsd : Infinity;
    for (;;) {
      const verdict = await locked(async () => {
        const spent = await today(provider);
        const blocked = paidBlocked(spent, capUsd);
        if (blocked) return { blocked };
        const s = of(provider);
        const reserved = [...s.held].reduce((sum, b) => sum + b.usd, 0);
        if (!s.held.size || (spent.usd || 0) + reserved + bound < capUsd) {
          const hold = { usd: bound };
          s.held.add(hold);
          let held = true;
          return { release: () => {
            if (!held) return;
            held = false;
            s.held.delete(hold);
            for (const wake of s.waiters.splice(0)) wake();
          } };
        }
        return { wait: new Promise((wake) => s.waiters.push(wake)) };
      });
      if (!verdict.wait) return verdict;
      await verdict.wait;
    }
  }
  return { acquire, inFlight: (provider) => of(provider).held.size };
}
