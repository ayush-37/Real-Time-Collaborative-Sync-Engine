import test from 'node:test';
import assert from 'node:assert/strict';
import { startSyncServer } from '../src/server/server.js';
import { Document } from '../src/doc/document.js';
import { SyncClient } from '../src/client/sync-client.js';
import { LocalStore, autosave, memoryStorage } from '../src/client/persistence.js';
import { makeRng } from '../src/sim/prng.js';
import { makeChaos } from '../src/sim/chaos.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 20_000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await sleep(5);
  }
};
const SEEDS = Number(process.env.CHAOS_SEEDS ?? 3);

// each peer types ONLY its own letter, so "nothing lost, nothing duplicated" = exact letter counts
function makePeer(url, site, WebSocketImpl, rng) {
  const doc = new Document(site);
  const client = new SyncClient({
    url, docId: 'doc1', document: doc, WebSocketImpl,
    reconnect: { baseMs: 5, maxMs: 30, random: rng.next },
  });
  return { site, ch: site[0], doc, client };
}

async function settle(server, peers, expectedLen) {
  await until(() =>
    peers.every((p) => p.client.status === 'online' && p.doc.log.length === expectedLen) &&
    server.rooms.get('doc1')?.doc.log.length === expectedLen);
}

function assertClean(server, peers, perPeer) {
  const room = server.rooms.get('doc1').doc;
  for (const p of peers) {
    assert.equal(p.doc.text, room.text, `${p.site} differs from the server`);
    assert.equal([...room.text].filter((c) => c === p.ch).length, perPeer, `letters of ${p.site}`);
    assert.equal(p.doc.pendingCount, 0, `${p.site} has ops stuck in the buffer`);
  }
  assert.equal(room.pendingCount, 0);
}

test('STRESS: bursts of typing while connections die at random: nothing lost, nothing duplicated', async () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const server = await startSyncServer({ port: 0 });
    const rng = makeRng(seed);
    const chaos = makeChaos({ rng, killChance: 0.08, lifetimeKillMs: 80 });
    const url = `ws://127.0.0.1:${server.port}`;
    const peers = ['alice', 'bob', 'carol'].map((site) => makePeer(url, site, chaos.Socket, rng));
    const BURSTS = 15, PER_BURST = 4;
    try {
      peers.forEach((p) => p.client.connect());
      await Promise.all(peers.map(async (p) => {
        for (let b = 0; b < BURSTS; b++) {
          for (let i = 0; i < PER_BURST; i++) p.doc.setText(p.doc.text + p.ch); // one burst = several keystrokes
          await sleep(1 + rng.int(8));
        }
      }));
      chaos.stop();                                                // liveness needs the faults to end
      await settle(server, peers, peers.length * BURSTS * PER_BURST);
      assertClean(server, peers, BURSTS * PER_BURST);
      assert.equal(server.rooms.get('doc1').doc.log.length, peers.length * BURSTS * PER_BURST); // no duplicated ops
      assert.ok(chaos.stats.kills > 0, `seed ${seed}: the chaos never fired, so this proves nothing`);
      console.log(`seed ${seed}:`, JSON.stringify(chaos.stats));
    } finally {
      peers.forEach((p) => p.client.close());
      await server.close();
    }
  }
});

test('BACKLOG: 600 ops typed offline are re-sent through a connection that keeps dying', async () => {
  const server = await startSyncServer({ port: 0 });
  const rng = makeRng(77);
  const chaos = makeChaos({ rng, killChance: 0.3 });
  const peer = makePeer(`ws://127.0.0.1:${server.port}`, 'alice', chaos.Socket, rng);
  try {
    for (let i = 0; i < 600; i++) peer.doc.setText(peer.doc.text + 'a'); // typed while never connected
    peer.client.connect();
    await until(() => server.rooms.get('doc1')?.doc.log.length === 600);
    chaos.stop();
    await settle(server, [peer], 600);
    assertClean(server, [peer], 600);
    assert.ok(chaos.stats.kills > 0);
  } finally {
    peer.client.close();
    await server.close();
  }
});

test('SERVER STORM: the server keeps terminating every connection while two clients type', async () => {
  const server = await startSyncServer({ port: 0 });
  const rng = makeRng(5);
  const url = `ws://127.0.0.1:${server.port}`;
  const peers = ['alice', 'bob'].map((site) => makePeer(url, site, undefined, rng));
  const BURSTS = 25, PER_BURST = 4;
  const storm = setInterval(() => {
    for (const c of server.rooms.get('doc1')?.clients ?? []) c.terminate();
  }, 15);
  try {
    peers.forEach((p) => p.client.connect());
    await Promise.all(peers.map(async (p) => {
      for (let b = 0; b < BURSTS; b++) {
        for (let i = 0; i < PER_BURST; i++) p.doc.setText(p.doc.text + p.ch);
        await sleep(2 + rng.int(6));
      }
    }));
    clearInterval(storm);
    await settle(server, peers, peers.length * BURSTS * PER_BURST);
    assertClean(server, peers, BURSTS * PER_BURST);
  } finally {
    clearInterval(storm);
    peers.forEach((p) => p.client.close());
    await server.close();
  }
});

test('DIAGNOSTIC: a reload from a STALE save must not re-use (site, seq) the server already has', async () => {
  const server = await startSyncServer({ port: 0 });
  const url = `ws://127.0.0.1:${server.port}`;
  const opts = { reconnect: { enabled: false } };
  const store = new LocalStore(memoryStorage(), 'doc1');
  try {
    // first life: 'ab' is saved, 'c' reaches the server but the tab crashes before it is saved
    const doc1 = new Document('alice');
    const c1 = new SyncClient({ url, docId: 'doc1', document: doc1, ...opts });
    c1.connect();
    await until(() => c1.status === 'online');
    doc1.setText('ab');
    store.save(doc1.site, doc1.log);
    doc1.setText('abc');
    await until(() => server.rooms.get('doc1')?.doc.text === 'abc');
    c1.close();

    // second life: restore from the stale save (knows 2 ops, the server has 3)
    const saved = store.load();
    const doc2 = Document.restore(saved.site, saved.log);
    const c2 = new SyncClient({ url, docId: 'doc1', document: doc2, ...opts });
    c2.connect();
    await until(() => c2.status === 'online');
    assert.equal(doc2.text, 'abc');                  // the server handed our own third op back
    doc2.setText('abcd');
    await until(() => server.rooms.get('doc1').doc.text === 'abcd', 3000); // times out if 'd' was dropped as a duplicate
    c2.close();
  } finally {
    await server.close();
  }
});

test('WRITE-AHEAD: whatever the server received was already saved locally first', async () => {
  const server = await startSyncServer({ port: 0 });
  const store = new LocalStore(memoryStorage(), 'doc1');
  const doc = new Document('alice');
  const saver = autosave(doc, store, { delayMs: 60_000 });   // the throttle timer never fires in this test
  const client = new SyncClient({
    url: `ws://127.0.0.1:${server.port}`, docId: 'doc1', document: doc,
    reconnect: { enabled: false }, beforeSend: () => saver.flush(),
  });
  try {
    client.connect();
    await until(() => client.status === 'online');
    doc.setText('hello');
    await until(() => server.rooms.get('doc1')?.doc.text === 'hello');
    // "crash" here: no flush(), no pagehide
    const saved = store.load();
    assert.ok(saved, 'nothing was saved before the ops were sent');
    assert.equal(saved.log.length, 5);
  } finally {
    saver.stop();
    client.close();
    await server.close();
  }
});