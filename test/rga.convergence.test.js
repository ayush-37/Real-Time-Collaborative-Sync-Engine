import test from 'node:test';
import assert from 'node:assert/strict';
import { RGA } from '../src/crdt/rga.js';
import { makeId, ROOT_ID } from '../src/crdt/charId.js';

const type = (doc, text) => [...text].map((ch, i) => doc.insertAt(i, ch));

// Build two replicas that already share the text "ABC".
function sharedABC() {
  const alice = new RGA('alice');
  const bob = new RGA('bob');
  for (const op of type(alice, 'ABC')) bob.applyRemote(op);
  return { alice, bob };
}

test('concurrent inserts at the same spot converge (either delivery order)', () => {
  const { alice, bob } = sharedABC();
  const x = alice.insertAt(1, 'X'); // after A
  const y = bob.insertAt(1, 'Y');   // after A, at the same time

  alice.applyRemote(y);
  bob.applyRemote(x);

  assert.equal(alice.toString(), bob.toString());
  assert.equal(alice.length, 5);
});

test('same clock on two sites: larger site id goes first (deterministic tie-break)', () => {
  const r1 = new RGA('r1');
  const r2 = new RGA('r2');
  const a = { type: 'insert', id: makeId(5, 'alice'), afterId: ROOT_ID, ch: 'a' };
  const b = { type: 'insert', id: makeId(5, 'bob'), afterId: ROOT_ID, ch: 'b' };

  r1.applyRemote(a); r1.applyRemote(b);   // order 1
  r2.applyRemote(b); r2.applyRemote(a);   // order 2

  assert.equal(r1.toString(), 'ba'); // bob > alice, so bob's char comes first
  assert.equal(r2.toString(), 'ba');
});

test('concurrent insert + delete of its parent: tombstone keeps it working', () => {
  const { alice, bob } = sharedABC();
  const del = alice.deleteAt(0);    // alice deletes A
  const ins = bob.insertAt(1, 'X'); // bob inserts X after A (hasn't seen the delete)

  alice.applyRemote(ins);
  bob.applyRemote(del);

  assert.equal(alice.toString(), 'XBC');
  assert.equal(bob.toString(), 'XBC');
});

test('concurrent deletes of the same char converge', () => {
  const { alice, bob } = sharedABC();
  const d1 = alice.deleteAt(1);
  const d2 = bob.deleteAt(1);
  alice.applyRemote(d2);
  bob.applyRemote(d1);
  assert.equal(alice.toString(), 'AC');
  assert.equal(bob.toString(), 'AC');
});

// ----- randomized convergence test -----
const rnd = (n) => Math.floor(Math.random() * n);

// merge several op streams in random order while keeping each stream's own order
function randomInterleave(streams) {
  const queues = streams.map((s) => [...s]);
  const out = [];
  for (;;) {
    const nonEmpty = queues.filter((q) => q.length);
    if (nonEmpty.length === 0) return out;
    out.push(nonEmpty[rnd(nonEmpty.length)].shift());
  }
}

function randomEdit(doc) {
  if (doc.length > 0 && Math.random() < 0.3) return doc.deleteAt(rnd(doc.length));
  return doc.insertAt(rnd(doc.length + 1), String.fromCharCode(97 + rnd(26)));
}

test('3 replicas, random concurrent edits, random delivery order: always converge', () => {
  for (let trial = 0; trial < 200; trial++) {
    const replicas = ['alice', 'bob', 'carol'].map((s) => new RGA(s));

    for (let round = 0; round < 5; round++) {
      // everyone edits locally WITHOUT seeing the others (fully concurrent)
      const opsByReplica = replicas.map((r) => {
        const mine = [];
        for (let k = 0, n = 1 + rnd(4); k < n; k++) mine.push(randomEdit(r));
        return mine;
      });

      // then everyone receives everyone else's ops in a random interleaving
      replicas.forEach((r, i) => {
        const others = opsByReplica.filter((_, j) => j !== i);
        for (const op of randomInterleave(others)) r.applyRemote(op);
      });

      const texts = replicas.map((r) => r.toString());
      assert.equal(texts[0], texts[1], `trial ${trial} round ${round}: alice vs bob`);
      assert.equal(texts[1], texts[2], `trial ${trial} round ${round}: bob vs carol`);
    }
  }
});