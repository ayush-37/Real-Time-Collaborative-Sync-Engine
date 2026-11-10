// Local persistence for a replica, so a page refresh (even while offline) loses nothing.
// What is stored: { v, site, log }. The op log is enough: document state = replay of the log.
//
// `storage` is anything with getItem / setItem / removeItem (localStorage, sessionStorage,
// or memoryStorage() below), which keeps this module testable in Node.
//
// Storage is UNTRUSTED input too (corrupted, edited by the user, written by an old version):
// everything is re-validated on load, and anything suspicious means "start fresh".
import { parseOp, parseSite } from '../net/protocol.js';

const FORMAT_VERSION = 1;

export function memoryStorage() {
  const map = new Map();
  return {
    getItem: (k) => (map.has(k) ? map.get(k) : null),
    setItem: (k, v) => { map.set(k, String(v)); },
    removeItem: (k) => { map.delete(k); },
  };
}

export class LocalStore {
  #storage;
  #key;

  constructor(storage, docId) {
    this.#storage = storage;
    this.#key = `sync-engine:v${FORMAT_VERSION}:${docId}`;
  }

  // -> { site, log } or null (nothing saved, or what is saved cannot be trusted)
  load() {
    try {
      const raw = this.#storage.getItem(this.#key);
      if (!raw) return null;
      const data = JSON.parse(raw);
      if (!data || data.v !== FORMAT_VERSION || !Array.isArray(data.log)) return null;
      return { site: parseSite(data.site), log: data.log.map(parseOp) }; // parseOp throws on bad ops
    } catch {
      return null;
    }
  }

  // -> true if saved, false if the browser refused (quota exceeded, storage blocked...)
  save(site, log) {
    try {
      this.#storage.setItem(this.#key, JSON.stringify({ v: FORMAT_VERSION, site, log }));
      return true;
    } catch {
      return false;
    }
  }

  clear() {
    try { this.#storage.removeItem(this.#key); } catch { /* ignore */ }
  }
}

// Save the document after changes. Throttled, not debounced: the FIRST change starts a timer
// and everything that happens until it fires is saved together, so continuous typing can never
// postpone saving forever. Call flush() on pagehide / visibilitychange.
export function autosave(doc, store, { delayMs = 300, onError } = {}) {
  let timer = null;

  const flush = () => {
    if (timer) { clearTimeout(timer); timer = null; }
    const ok = store.save(doc.site, doc.log);
    if (!ok) onError?.(new Error('could not save locally (storage full or blocked)'));
    return ok;
  };

  const off = doc.onChange(() => {
    if (timer) return;
    timer = setTimeout(() => { timer = null; flush(); }, delayMs);
  });

  return {
    flush,
    stop() {
      off();
      if (timer) { clearTimeout(timer); timer = null; }
    },
  };
}