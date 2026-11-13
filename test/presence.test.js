import test from 'node:test';
import assert from 'node:assert/strict';
import { startSyncServer } from '../src/server/server.js';
import { PresenceClient } from '../src/client/presence-client.js';
import { resolvePeer } from '../src/client/presence-model.js';
import { Document } from '../src/doc/document.js';
import { idToString } from '../src/crdt/charId.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await sleep(3);
  }
};

const mk = (server, site, name = site, extra = {}) => new PresenceClient({
  url: `ws://127.0.0.1:${server.port}/presence`, docId: 'doc1', site, name, color: '#4363d8',
  throttleMs: 5, reconnect: { baseMs: 10, maxMs: 40 }, ...extra,
});

async function rawPresence(port) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/presence`);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  return ws;
}

// ---------- resolvePeer (pure logic) ----------

test('resolvePeer: a known anchor becomes index, line and column, and follows remote inserts', () => {
  const doc = new Document('alice');
  doc.insertText(0, 'ab\ncd');
  const anchor = idToString(doc.anchorAt(4));                    // right after "c"
  const peer = { id: '1', name: 'bob', color: '#4363d8', start: anchor, end: anchor };

  let r = resolvePeer(doc, peer);
  assert.deepEqual([r.state, r.index ?? r.start, r.line, r.col], ['ready', 4, 2, 2]);

  doc.insertText(0, 'XY');                                       // an edit BEFORE the cursor
  r = resolvePeer(doc, peer);
  assert.equal(r.start, 6);                                      // the anchor moved with its character
});

test('resolvePeer: an anchor whose character has not arrived yet is "pending", then resolves', () => {
  const alice = new Document('alice');
  const bob = new Document('bob');
  const ops = alice.insertText(0, 'hi');
  const anchor = idToString(alice.anchorAt(2));
  const peer = { start: anchor, end: anchor };

  assert.equal(resolvePeer(bob, peer).state, 'pending');         // presence outran the sync channel
  ops.forEach((op) => bob.applyRemote(op));
  const r = resolvePeer(bob, peer);
  assert.equal(r.state, 'ready');
  assert.equal(r.col, 3);
});

test('resolvePeer: no cursor -> "none", garbage anchors never throw', () => {
  const doc = new Document('alice');
  assert.equal(resolvePeer(doc, { start: null, end: null }).state, 'none');
  assert.equal(resolvePeer(doc, { start: '%%%', end: '%%%' }).state, 'pending');
  assert.equal(resolvePeer(doc, { start: 12, end: {} }).state, 'pending');
});

// ---------- the presence channel ----------

test('a cursor update reaches the other client, never the sender, and never touches the document', async () => {
  const server = await startSyncServer({ port: 0 });
  const a = mk(server, 'alice', 'Alice');
  const b = mk(server, 'bob', 'Bob');
  try {
    a.connect(); b.connect();
    await until(() => a.peers.length === 1 && b.peers.length === 1);
    assert.equal(b.peers[0].name, 'Alice');
    assert.equal(a.peers[0].name, 'Bob');                        // each sees ONLY the other

    a.setCursor({ start: 'x1', end: 'x2' });
    await until(() => b.peers[0].start === 'x1' && b.peers[0].end === 'x2');
    assert.equal(server.rooms.size, 0);                          // no document room, so nothing in the log or WAL
  } finally {
    a.close(); b.close();
    await server.close();
  }
});

test('leaving removes you from everyone else\'s roster; other documents are isolated', async () => {
  const server = await startSyncServer({ port: 0 });
  const a = mk(server, 'alice');
  const b = mk(server, 'bob');
  const c = mk(server, 'carol', 'carol', { docId: 'doc2' });
  try {
    a.connect(); b.connect(); c.connect();
    await until(() => a.peers.length === 1 && b.peers.length === 1);
    await sleep(60);
    assert.equal(c.peers.length, 0);                             // carol is in another document
    assert.deepEqual(a.peers.map((p) => p.site), ['bob']);

    b.close();
    await until(() => a.peers.length === 0);
  } finally {
    a.close(); b.close(); c.close();
    await server.close();
  }
});

test('invalid input closes the socket with 1008 instead of crashing or being trusted', async () => {
  const server = await startSyncServer({ port: 0 });
  const bad = [
    { type: 'cursor', start: 'a', end: 'a' },                                                       // before hello
    { type: 'hello', docId: 'doc1', site: 'x', name: '<img src=x onerror=alert(1)>', color: '#4363d8' },
    { type: 'hello', docId: 'doc1', site: 'x', name: 'Ok', color: 'red; background:url(x)' },
    { type: 'hello', docId: '../etc', site: 'x', name: 'Ok', color: '#4363d8' },
    'not json at all',
  ];
  try {
    for (const message of bad) {
      const ws = await rawPresence(server.port);
      const closed = new Promise((resolve) => ws.addEventListener('close', (e) => resolve(e.code)));
      ws.send(typeof message === 'string' ? message : JSON.stringify(message));
      assert.equal(await closed, 1008);
    }
  } finally {
    await server.close();
  }
});

test('a burst of 200 cursor updates is coalesced into a few broadcasts and the LAST one wins', async () => {
  const server = await startSyncServer({ port: 0, presenceThrottleMs: 30 });
  const b = mk(server, 'bob');
  let updates = 0;
  b.onPeers(() => updates++);
  const ws = await rawPresence(server.port);
  try {
    b.connect();
    await until(() => updates >= 1);
    ws.send(JSON.stringify({ type: 'hello', docId: 'doc1', site: 'raw', name: 'Raw', color: '#3cb44b' }));
    await until(() => b.peers.length === 1);

    updates = 0;
    for (let i = 0; i < 200; i++) ws.send(JSON.stringify({ type: 'cursor', start: `k${i}`, end: `k${i}` }));
    await until(() => b.peers[0]?.start === 'k199');
    assert.ok(updates < 20, `expected a few coalesced broadcasts, got ${updates}`);
  } finally {
    ws.close(); b.close();
    await server.close();
  }
});

test('presence is ephemeral and self-healing: after a server restart clients re-announce themselves', async () => {
  const s1 = await startSyncServer({ port: 0 });
  const port = s1.port;
  const a = mk(s1, 'alice', 'Alice');
  const b = mk(s1, 'bob', 'Bob');
  let s2;
  try {
    a.connect(); b.connect();
    a.setCursor({ start: 'c1', end: 'c1' });
    await until(() => b.peers[0]?.start === 'c1');

    await s1.close();                                            // the server forgets everything
    await until(() => a.peers.length === 0 && b.peers.length === 0);

    s2 = await startSyncServer({ port });
    await until(() => b.peers[0]?.start === 'c1');               // alice RE-SENT her cursor; the server did not remember it
  } finally {
    a.close(); b.close();
    await s2?.close();
  }
});