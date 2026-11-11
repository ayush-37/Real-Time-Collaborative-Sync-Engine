import test from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '../src/doc/document.js';
import { timeline, textAt, textAtVersion, revertTo } from '../src/doc/history.js';

// send `to` everything it is missing from `from`
const sync = (from, to) => from.opsSince(to.version()).forEach((op) => to.applyRemote(op));

test('textAt shows the document after the first n ops', () => {
  const doc = new Document('alice');
  doc.insertText(0, 'abc');   // ops 1..3
  doc.deleteRange(0, 1);      // op 4: removes "a"
  assert.equal(textAt(doc.log, 0), '');
  assert.equal(textAt(doc.log, 2), 'ab');
  assert.equal(textAt(doc.log, 3), 'abc');
  assert.equal(textAt(doc.log, 4), 'bc');
});

test('textAt rejects an index outside the log', () => {
  const doc = new Document('alice');
  doc.insertText(0, 'abc');
  assert.throws(() => textAt(doc.log, 99), RangeError);
  assert.throws(() => textAt(doc.log, -1), RangeError);
  assert.throws(() => textAt(doc.log, 1.5), RangeError);
});

test('timeline groups consecutive ops by author and kind', () => {
  const doc = new Document('alice');
  doc.insertText(0, 'abc');
  doc.deleteRange(0, 1);
  doc.insertText(2, 'd');
  assert.deepEqual(
    timeline(doc.log).map((r) => [r.type, r.count, r.end]),
    [['insert', 3, 3], ['delete', 1, 4], ['insert', 1, 5]],
  );
});

test('every prefix of an applied log is causally complete (nothing is left waiting for a parent)', () => {
  const alice = new Document('alice');
  const bob = new Document('bob');
  alice.insertText(0, 'hello');
  bob.insertText(0, 'XY');
  sync(alice, bob); sync(bob, alice);
  alice.insertText(3, '!!');
  bob.deleteRange(0, 1);
  sync(alice, bob); sync(bob, alice);
  assert.equal(alice.text, bob.text);

  for (const doc of [alice, bob]) {
    for (let n = 0; n <= doc.log.length; n++) {
      assert.equal(Document.replay('viewer', doc.log.slice(0, n)).pendingCount, 0, `prefix ${n}`);
    }
    assert.equal(textAt(doc.log, doc.log.length), doc.text);
  }
});

test('an INDEX is replica-local, a VERSION VECTOR means the same moment on every replica', () => {
  const alice = new Document('alice');
  const bob = new Document('bob');
  alice.insertText(0, 'ab');   // alice seq 1..2
  bob.insertText(0, 'XY');     // bob seq 1..2, concurrent
  sync(alice, bob);            // bob.log   = [b1 b2 a1 a2]
  sync(bob, alice);            // alice.log = [a1 a2 b1 b2]
  assert.equal(alice.text, bob.text);

  // the same index names DIFFERENT moments on the two replicas
  assert.notEqual(textAt(alice.log, 2), textAt(bob.log, 2));

  // the same version vector names the SAME moment on both
  const vector = { alice: 2 };
  assert.equal(textAtVersion(alice.log, vector), 'ab');
  assert.equal(textAtVersion(bob.log, vector), 'ab');
});

test('revert is a NEW edit: it syncs to others, and history still contains everything', () => {
  const alice = new Document('alice');
  const bob = new Document('bob');
  alice.insertText(0, 'hello'); sync(alice, bob);
  alice.insertText(5, ' world'); sync(alice, bob);
  const before = alice.log.length;

  assert.equal(revertTo(alice, 5), 'hello');
  assert.equal(alice.text, 'hello');
  assert.ok(alice.log.length > before);                          // history only grows
  assert.equal(textAt(alice.log, before), 'hello world');        // the moment before the revert is still reachable

  sync(alice, bob);
  assert.equal(bob.text, 'hello');                               // the revert reached the other replica
});

test('concurrent work survives a revert', () => {
  const alice = new Document('alice');
  const bob = new Document('bob');
  alice.insertText(0, 'hello world'); sync(alice, bob);

  bob.insertText(11, '!');          // bob types while alice reverts
  revertTo(alice, 5);               // alice goes back to "hello"
  sync(alice, bob); sync(bob, alice);

  assert.equal(alice.text, bob.text);
  assert.equal(alice.text, 'hello!');
});