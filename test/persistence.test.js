import test from 'node:test';
import assert from 'node:assert/strict';
import { LocalStore, autosave, memoryStorage } from '../src/client/persistence.js';
import { Document } from '../src/doc/document.js';
import { startSyncServer } from '../src/server/server.js';
import { SyncClient } from '../src/client/sync-client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await sleep(2);
  }
};

// ---------- Document.restore ----------

test('restore() continues the seq counter; replay() does NOT (that is why restore exists)', () => {
  const alice = new Document('alice');
  alice.insertText(0, 'abc');                     // seq 1..3

  const restored = Document.restore('alice', alice.log);
  const [op] = restored.insertText(3, 'd');
  assert.equal(op.seq, 4);                        // continues

  const replayed = Document.replay('alice', alice.log);
  const [bad] = replayed.insertText(3, 'd');
  assert.equal(bad.seq, 1);                       // restarts: the server would drop it as a duplicate
});

test('a restored replica produces ops that other replicas accept and converge on', () => {
  const alice = new Document('alice');
  const bob = new Document('bob');
  alice.insertText(0, 'abc').forEach((op) => bob.applyRemote(op));

  const reloaded = Document.restore('alice', alice.log);   // "page refresh"
  reloaded.insertText(3, 'XYZ').forEach((op) => bob.applyRemote(op));
  assert.equal(bob.text, 'abcXYZ');
  assert.equal(reloaded.text, 'abcXYZ');
  assert.deepEqual(reloaded.version(), bob.version());
});

test('restore() also restores the Lamport clock: new chars sort after everything seen', () => {
  const alice = new Document('alice');
  const bob = new Document('bob');
  bob.insertText(0, 'bbbbbb').forEach((op) => alice.applyRemote(op)); // alice's clock jumps ahead
  alice.insertText(6, 'a');
  const reloaded = Document.restore('alice', alice.log);
  const [op] = reloaded.insertText(7, 'z');
  const maxSeen = Math.max(...alice.log.filter((o) => o.type === 'insert').map((o) => o.id.clock));
  assert.ok(op.id.clock > maxSeen);
});

// ---------- LocalStore ----------

test('save then load round-trips the site and the whole log', () => {
  const store = new LocalStore(memoryStorage(), 'doc1');
  const doc = new Document('alice');
  doc.insertText(0, 'hello'); doc.deleteRange(0, 1);
  assert.equal(store.save(doc.site, doc.log), true);

  const loaded = store.load();
  assert.equal(loaded.site, 'alice');
  assert.equal(loaded.log.length, 6);
  assert.equal(Document.restore(loaded.site, loaded.log).text, 'ello');
});

test('nothing saved -> load() returns null', () => {
  assert.equal(new LocalStore(memoryStorage(), 'doc1').load(), null);
});

test('different documents are stored separately', () => {
  const storage = memoryStorage();
  const a = new LocalStore(storage, 'docA'), b = new LocalStore(storage, 'docB');
  const doc = new Document('alice'); doc.insertText(0, 'x');
  a.save('alice', doc.log);
  assert.equal(b.load(), null);
  assert.ok(a.load());
});

test('corrupted or tampered storage is rejected instead of crashing', () => {
  const doc = new Document('alice'); doc.insertText(0, 'ab');
  const goodOps = JSON.parse(JSON.stringify(doc.log));
  const cases = {
    'not json': '{{{',
    'wrong version': JSON.stringify({ v: 99, site: 'alice', log: goodOps }),
    'log is not an array': JSON.stringify({ v: 1, site: 'alice', log: 'nope' }),
    'reserved site': JSON.stringify({ v: 1, site: 'server', log: goodOps }),
    'bad site name': JSON.stringify({ v: 1, site: 'a b', log: goodOps }),
    'one invalid op': JSON.stringify({ v: 1, site: 'alice', log: [...goodOps, { type: 'insert', ch: 'xx' }] }),
    'delete of ROOT': JSON.stringify({ v: 1, site: 'alice', log: [{ type: 'delete', targetId: { clock: 0, site: 'ROOT' }, site: 'alice', seq: 9 }] }),
  };
  for (const [name, raw] of Object.entries(cases)) {
    const storage = memoryStorage();
    storage.setItem('sync-engine:v1:d', raw);
    assert.equal(new LocalStore(storage, 'd').load(), null, name);
  }
});

test('a full / blocked storage makes save() return false and does not throw', () => {
  const full = { getItem: () => null, removeItem() {}, setItem() { throw new DOMException('quota', 'QuotaExceededError'); } };
  const store = new LocalStore(full, 'd');
  assert.equal(store.save('alice', []), false);
});

test('storage that throws on read is treated as "nothing saved"', () => {
  const broken = { getItem() { throw new Error('blocked'); }, setItem() {}, removeItem() {} };
  assert.equal(new LocalStore(broken, 'd').load(), null);
});

test('clear() forgets everything', () => {
  const store = new LocalStore(memoryStorage(), 'd');
  const doc = new Document('alice'); doc.insertText(0, 'x');
  store.save('alice', doc.log);
  store.clear();
  assert.equal(store.load(), null);
});

// ---------- autosave ----------

test('autosave is throttled: many edits cause few writes, and flush() writes immediately', async () => {
  let writes = 0;
  const base = memoryStorage();
  const counting = { ...base, setItem: (k, v) => { writes++; base.setItem(k, v); } };
  const store = new LocalStore(counting, 'd');
  const doc = new Document('alice');
  const saver = autosave(doc, store, { delayMs: 30 });

  for (let i = 0; i < 200; i++) doc.insertText(i, 'x');   // 200 ops in a burst
  assert.equal(writes, 0);                                 // nothing yet
  await sleep(80);
  assert.equal(writes, 1);                                 // ONE write covers all of it
  assert.equal(store.load().log.length, 200);

  doc.insertText(200, 'y');
  saver.flush();                                           // e.g. on pagehide
  assert.equal(store.load().log.length, 201);
  saver.stop();
});

test('autosave reports a failed save through onError and editing keeps working', async () => {
  const full = { getItem: () => null, removeItem() {}, setItem() { throw new Error('quota'); } };
  const errors = [];
  const doc = new Document('alice');
  const saver = autosave(doc, new LocalStore(full, 'd'), { delayMs: 10, onError: (e) => errors.push(e.message) });
  doc.insertText(0, 'abc');
  await sleep(40);
  assert.equal(errors.length, 1);
  assert.equal(doc.text, 'abc');
  saver.stop();
});

test('stop() cancels a pending save', async () => {
  const storage = memoryStorage();
  const store = new LocalStore(storage, 'd');
  const doc = new Document('alice');
  const saver = autosave(doc, store, { delayMs: 20 });
  doc.insertText(0, 'a');
  saver.stop();
  await sleep(50);
  assert.equal(store.load(), null);
});

// ---------- the real scenario: refresh while offline ----------

test('typing while offline, then a page REFRESH, then reconnecting: nothing is lost', async () => {
  const server = await startSyncServer({ port: 0 });
  const url = `ws://127.0.0.1:${server.port}`;
  const storage = memoryStorage();                   // stands in for sessionStorage
  const closers = [];
  try {
    // --- first page load: never manages to connect, user types anyway ---
    const store1 = new LocalStore(storage, 'doc1');
    const doc1 = new Document('alice');
    const saver1 = autosave(doc1, store1, { delayMs: 10 });
    doc1.setText('written offline');
    saver1.flush();                                  // pagehide
    saver1.stop();

    // --- "refresh": a brand new page restores identity + log from storage ---
    const saved = new LocalStore(storage, 'doc1').load();
    const doc2 = Document.restore(saved.site, saved.log);
    assert.equal(doc2.text, 'written offline');
    const c2 = new SyncClient({ url, docId: 'doc1', document: doc2 });
    closers.push(c2);
    doc2.setText('written offline, then edited after refresh');   // seq continues, no collision

    // --- a collaborator joins and must see everything ---
    const bob = new Document('bob');
    const cb = new SyncClient({ url, docId: 'doc1', document: bob });
    closers.push(cb);
    c2.connect(); cb.connect();
    await until(() => bob.text === 'written offline, then edited after refresh');
    assert.equal(doc2.text, bob.text);
  } finally {
    closers.forEach((c) => c.close());
    await server.close();
  }
});