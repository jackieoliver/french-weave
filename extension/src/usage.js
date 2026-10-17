// Public build: the dev build's local usage log is left out, and this stub keeps its API so the worker's hooks
// (background.js) stay as they are. Nothing is recorded, stored or sent. RELEASING.md on the dev side says how a
// release keeps this file.
const ok = async () => ({ ok: true });

// Same options as the dev build's createUsage; all are ignored.
export function createUsage() {
  return {
    record() {},
    flush: async () => ({ on: false }),
    isOn: () => false,
    flag: async () => ({}),
    note() {},
    batch: (msg, sender, run) => run(),
    pageView: async (msg, sender, ctxPromise) => ctxPromise,
    pageEvents: () => ({ ok: false }),
    word() {},
    settings() {},
    host: ok,
    reloading: ok,
    today: async () => ({ ok: true, dev: false, on: false, line: '', error: '' }),
    toggle: async () => ({ ok: true, on: false }),
  };
}
