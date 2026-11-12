// Browser entry point: textarea <-> Document <-> SyncClient <-> server.
// Imports the SAME CRDT modules the server uses (served from /src/...).
import { Document } from '/src/doc/document.js';
import { SyncClient } from '/src/client/sync-client.js';
import { LocalStore, autosave, memoryStorage } from '/src/client/persistence.js';
import { ROOT_ID } from '/src/crdt/charId.js';
import { mountHistory } from '/src/client/history-view.js';

const params = new URLSearchParams(location.search);
const wanted = params.get('doc') ?? '';
const docId = /^[A-Za-z0-9_-]{1,64}$/.test(wanted) ? wanted : 'demo';

// Tab-scoped storage: sessionStorage survives a RELOAD of this tab but is not shared with other tabs,
// so two tabs never end up with the same identity. (Falls back to memory if the browser blocks it.)
function tabStorage() {
  try {
    sessionStorage.setItem('__probe', '1');
    sessionStorage.removeItem('__probe');
    return sessionStorage;
  } catch {
    return memoryStorage();
  }
}
const store = new LocalStore(tabStorage(), docId);

// First visit: brand-new identity. Reload: continue AS the same site with the same log, so the
// seq counter carries on and ops typed while offline are still there to be re-sent.
// Caveat: "Duplicate tab" copies sessionStorage, so two live tabs could share one identity.
// Production fix: claim the identity with the Web Locks API.
const saved = store.load();
const site = saved?.site ?? `u-${crypto.randomUUID().slice(0, 8)}`;

const editor = document.querySelector('#editor');
const statusEl = document.querySelector('#status');
const statsEl = document.querySelector('#stats');
document.querySelector('#docId').textContent = docId;
document.querySelector('#site').textContent = site;

const doc = saved ? Document.restore(saved.site, saved.log) : new Document(site);
const saver = autosave(doc, store, { onError: (err) => console.warn('[save]', err.message) });
const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
const client = new SyncClient({
  url: `${scheme}://${location.host}`, docId, document: doc,
  beforeSend: () => saver.flush(),
});
  
// ----- local typing -> ops -----
editor.addEventListener('input', () => {
  doc.setText(editor.value);   // diff the textarea into CRDT ops (they are sent by SyncClient)
  saveCursor();
});

// ----- cursor = anchors (character ids), so remote edits cannot shove it around -----
let cursor = { start: ROOT_ID, end: ROOT_ID };

function saveCursor() {
  if (editor.value !== doc.text) return; // indexes only make sense when both texts match
  cursor = {
    start: doc.anchorAt(editor.selectionStart),
    end: doc.anchorAt(editor.selectionEnd),
  };
}
document.addEventListener('selectionchange', () => {
  if (document.activeElement === editor) saveCursor();
});

// ----- remote edits -> textarea (one render per batch of ops) -----
let renderQueued = false;
function scheduleRender() {
  if (renderQueued) return;
  renderQueued = true;
  queueMicrotask(() => {
    renderQueued = false;
    render();
  });
}

function render() {
  const text = doc.text;
  if (editor.value !== text) {
    const start = doc.indexOfAnchor(cursor.start);
    const end = doc.indexOfAnchor(cursor.end);
    const scroll = editor.scrollTop;
    editor.value = text;
    if (document.activeElement === editor) editor.setSelectionRange(start, end);
    editor.scrollTop = scroll;
  }
  statsEl.textContent =
    `${doc.length} chars · ${doc.log.length} ops · ${doc.tombstoneCount} tombstones · ${doc.pendingCount} pending`;
}
doc.onChange(scheduleRender);
mountHistory({ doc });

// ----- connection status (typing keeps working offline) -----
client.onStatus((state) => {
  statusEl.dataset.state = state;
  statusEl.textContent = state === 'disconnected' ? 'offline' : state;
});
client.onRetry(({ delayMs }) => {
  statusEl.textContent = `offline · retrying in ${(delayMs / 1000).toFixed(1)}s`;
});
client.onError((err) => console.warn('[sync]', err.message));

// the browser's 'online' event is only a HINT (Wi-Fi without internet still says online),
// so we never trust it as truth: it just skips the backoff wait and tries right away
window.addEventListener('online', () => client.retryNow());

// make sure the latest edits are on disk when the page goes away
window.addEventListener('pagehide', () => saver.flush());
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') saver.flush();
});

client.connect();
render();
window.addEventListener('beforeunload', () => client.close());
window.__sync = { doc, client, store }; // handy for poking around in the browser console