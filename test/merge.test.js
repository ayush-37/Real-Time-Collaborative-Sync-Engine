import test from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '../src/doc/document.js';
import { idToString } from '../src/crdt/charId.js';

const rnd = (n) => Math.floor(Math.random() * n);
const shuffle = (arr) => {
  const a = [...arr];
  for (let i = a.length - 1; i > 0; i--) {
    const j = rnd(i + 1);
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

// ---------- pending buffer ----------

test('ops delivered in REVERSE order are buffered, then released when the first arrives', () => {
  const alice = new Document('alice');
  const bob = new Document('bob');
  const ops = alice.insertText(0, 'abc');

  const statuses = [...ops].reverse().map((op) => bob.applyRemote(op));
  assert.deepEqual(statuses, ['buffered', 'buffered', 'applied']);
  assert.equal(bob.text, 'abc');
  assert.equal(bob.pendingCount, 0);
});

test('a delete that arrives BEFORE the insert it targets waits for it', () => {
  const alice = new Document('alice');
  const bob = new Document('bob');
  const [ins] = alice.insertText(0, 'a');
  const [del] = alice.deleteRange(0, 1);

  assert.equal(bob.applyRemote(del), 'buffered');
  assert.equal(bob.pendingCount, 1);
  assert.equal(bob.applyRemote(ins), 'applied');
  assert.equal(bob.text, '');
  assert.equal(bob.pendingCount, 0);
});

test('the same op arriving twice while buffered is not parked twice', () => {
  const alice = new Document('alice');
  const bob = new Document('bob');
  const [a, b] = alice.insertText(0, 'ab');
  assert.equal(bob.applyRemote(b), 'buffered');
  assert.equal(bob.applyRemote(b), 'duplicate');
  assert.equal(bob.pendingCount, 1);
  bob.applyRemote(a);
  assert.equal(bob.text, 'ab');
});

test('a whole random edit history delivered in fully shuffled order still rebuilds the text', () => {
  for (let t = 0; t < 100; t++) {
    const alice = new Document('alice');
    alice.insertText(0, 'the quick brown fox');
    alice.setText('the slow brown fox jumps');
    alice.setText('a slow fox');
    const bob = new Document('bob');
    shuffle(alice.log).forEach((op) => bob.applyRemote(op));
    assert.equal(bob.text, alice.text);
    assert.equal(bob.pendingCount, 0);
  }
});

test('duplicates + shuffling together change nothing', () => {
  const alice = new Document('alice');
  alice.insertText(0, 'hello world');
  alice.deleteRange(0, 6);
  const bob = new Document('bob');
  shuffle([...alice.log, ...alice.log, ...alice.log]).forEach((op) => bob.applyRemote(op));
  assert.equal(bob.text, 'world');
  assert.equal(bob.log.length, alice.log.length); // each op logged exactly once
});

test('replay works even if the log is shuffled (buffer fixes the order)', () => {
  const alice = new Document('alice');
  alice.insertText(0, 'abcdef');
  alice.deleteRange(2, 2);
  const rebuilt = Document.replay('r', shuffle(alice.log));
  assert.equal(rebuilt.text, alice.text);
});

// ---------- version vectors ----------

test('version() counts the contiguous ops seen per site', () => {
  const alice = new Document('alice');
  const bob = new Document('bob');
  alice.insertText(0, 'abc');
  assert.deepEqual(alice.version(), { alice: 3 });

  bob.insertText(0, 'xy');
  alice.merge(bob);
  assert.deepEqual(alice.version(), { alice: 3, bob: 2 });
});

test('a gap in seq is visible: version stops at the last CONTIGUOUS op', () => {
  const alice = new Document('alice');
  const bob = new Document('bob');
  const ops = alice.insertText(0, 'abcd');     // seq 1..4
  bob.applyRemote(ops[0]);                      // seq 1
  bob.applyRemote(ops[1]);                      // seq 2
  bob.applyRemote(ops[3]);                      // seq 4 (3 is missing; also buffered as its parent is missing)
  assert.deepEqual(bob.version(), { alice: 2 }); // not 4: op 3 is missing
  bob.applyRemote(ops[2]);                      // the missing op arrives
  assert.deepEqual(bob.version(), { alice: 4 });
  assert.equal(bob.text, 'abcd');
});

test('opsSince returns only what the peer lacks', () => {
  const alice = new Document('alice');
  alice.insertText(0, 'abcde');
  assert.equal(alice.opsSince({}).length, 5);
  assert.equal(alice.opsSince({ alice: 3 }).length, 2);
  assert.equal(alice.opsSince({ alice: 5 }).length, 0);
});

test('two users deleting the same char: both delete ops are logged (identity is site+seq)', () => {
  const alice = new Document('alice');
  const bob = new Document('bob');
  alice.insertText(0, 'abc').forEach((op) => bob.applyRemote(op));
  const [d1] = alice.deleteRange(0, 1);
  const [d2] = bob.deleteRange(0, 1);
  alice.applyRemote(d2);
  bob.applyRemote(d1);

  assert.equal(alice.text, 'bc');
  assert.equal(bob.text, 'bc');
  assert.deepEqual(alice.version(), bob.version());
  assert.equal(alice.log.length, 5); // 3 inserts + 2 deletes
});

// ---------- merge() ----------

test('offline scenario: both edit while disconnected, then merge both ways', () => {
  const alice = new Document('alice');
  const bob = new Document('bob');
  alice.insertText(0, 'hello').forEach((op) => bob.applyRemote(op));

  alice.setText('hello world');     // offline
  bob.setText('Hello');             // offline

  alice.merge(bob);
  bob.merge(alice);

  assert.equal(alice.text, bob.text);
  assert.equal(alice.text, 'Hello world');
  assert.deepEqual(alice.version(), bob.version());
});

test('merge is idempotent: merging again applies nothing', () => {
  const alice = new Document('alice');
  const bob = new Document('bob');
  alice.insertText(0, 'x');
  bob.insertText(0, 'y');
  assert.equal(alice.merge(bob), 1);
  assert.equal(alice.merge(bob), 0);
  assert.equal(alice.merge(bob), 0);
});

test('merge in either order gives the same text (commutative)', () => {
  const make = () => {
    const a = new Document('alice'), b = new Document('bob'), c = new Document('carol');
    a.insertText(0, 'AAA'); b.insertText(0, 'BBB'); c.insertText(0, 'CCC');
    return { a, b, c };
  };
  const one = make();
  one.a.merge(one.b); one.a.merge(one.c);
  const two = make();
  two.a.merge(two.c); two.a.merge(two.b);
  assert.equal(one.a.text.length, 9);
  assert.equal(one.a.text, two.a.text);
});

test('fuzz: 3 replicas edit offline, pairwise merge once around -> all converge', () => {
  const randomEditedText = (t) => {
    const i = rnd(t.length + 1);
    if (t.length > 0 && Math.random() < 0.4) return t.slice(0, i) + t.slice(Math.min(t.length, i + 1 + rnd(3)));
    return t.slice(0, i) + ['a', 'bc', 'xyz'][rnd(3)] + t.slice(i);
  };
  for (let trial = 0; trial < 150; trial++) {
    const [a, b, c] = ['alice', 'bob', 'carol'].map((s) => new Document(s));
    for (let round = 0; round < 3; round++) {
      for (const d of [a, b, c]) {
        for (let k = 0; k < 1 + rnd(3); k++) d.setText(randomEditedText(d.text));
      }
      a.merge(b); a.merge(c);
      b.merge(a); b.merge(c);
      c.merge(a); c.merge(b);
      assert.equal(a.text, b.text, `trial ${trial} round ${round}`);
      assert.equal(b.text, c.text, `trial ${trial} round ${round}`);
      assert.deepEqual(a.version(), b.version());
      assert.equal(a.pendingCount + b.pendingCount + c.pendingCount, 0);
    }
  }
});

// ---------- the Day 4 Q5 scenario, as a test ----------

test('paste "world" over "hello" while a collaborator types "!" after "hello" -> "world!"', () => {
  const alice = new Document('alice');
  const bob = new Document('bob');
  alice.insertText(0, 'hello').forEach((op) => bob.applyRemote(op));

  const paste = alice.setText('world');   // 5 deletes (by char id), then 5 inserts chained from ROOT
  const bang = bob.insertText(5, '!');    // anchored AFTER the old 'o'

  assert.equal(paste.filter((o) => o.type === 'delete').length, 5);
  assert.equal(paste.filter((o) => o.type === 'insert').length, 5);
  assert.equal(idToString(paste[5].afterId), '0@ROOT'); // 'w' goes right after ROOT

  paste.forEach((op) => bob.applyRemote(op));
  bang.forEach((op) => alice.applyRemote(op));
  assert.equal(alice.text, 'world!');
  assert.equal(bob.text, 'world!');
});