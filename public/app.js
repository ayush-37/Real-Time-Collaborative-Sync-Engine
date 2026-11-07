// Browser entry point: textarea <-> Document <-> SyncClient <-> server.
// Imports the SAME CRDT modules the server uses (served from /src/...).
import { Document } from '/src/doc/document.js';
import { SyncClient } from '/src/client/sync-client.js';
import { ROOT_ID } from '/src/crdt/charId.js';

const params = new URLSearchParams(location.search);
const wanted = params.get('doc') ?? '';
const docId = /^[A-Za-z0-9_-]{1,64}$/.test(wanted) ? wanted : 'demo';

// A NEW site id on every page load. Never reuse a site id with a reset counter:
// a reloaded tab would start again at seq 1 and the server would drop those ops as duplicates.
const site = `u-${crypto.randomUUID().slice(0, 8)}`;

const editor = document.querySelector('#editor');
const statusEl = document.querySelector('#status');
const statsEl = document.querySelector('#stats');
document.querySelector('#docId').textContent = docId;
document.querySelector('#site').textContent = site;

const doc = new Document(site);
const scheme = location.protocol === 'https:' ? 'wss' : 'ws';
const client = new SyncClient({ url: `${scheme}://${location.host}`, docId, document: doc });

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
    // if (document.activeElement === editor) editor.setSelectionRange(start, end);
    editor.setSelectionRange(start, end);
    editor.scrollTop = scroll;
  }
  statsEl.textContent =
    `${doc.length} chars · ${doc.log.length} ops · ${doc.tombstoneCount} tombstones · ${doc.pendingCount} pending`;
}
doc.onChange(scheduleRender);

// ----- connection status (typing keeps working offline) -----
client.onStatus((state) => {
  statusEl.textContent = state;
  statusEl.dataset.state = state;
});
client.onError((err) => console.warn('[sync]', err.message));

client.connect();
render();
window.addEventListener('beforeunload', () => client.close());
window.__sync = { doc, client }; // handy for poking around in the browser console