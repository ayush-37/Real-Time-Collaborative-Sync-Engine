import test from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '../src/doc/document.js';

test('insertText returns one stamped op per char, with seq 1..n', () => {
  const doc = new Document('alice');
  const ops = doc.insertText(0, 'hey');
  assert.equal(doc.text, 'hey');
  assert.deepEqual(ops.map((o) => o.seq), [1, 2, 3]);
  assert.ok(ops.every((o) => o.site === 'alice' && o.type === 'insert'));
});

test('deleteRange removes a block and keeps tombstones', () => {
  const doc = new Document('alice');
  doc.insertText(0, 'abcdef');
  const ops = doc.deleteRange(1, 3); // remove "bcd"
  assert.equal(doc.text, 'aef');
  assert.equal(ops.length, 3);
  assert.equal(doc.tombstoneCount, 3);
});

test('seq keeps counting across inserts and deletes (gap-free per site)', () => {
  const doc = new Document('alice');
  doc.insertText(0, 'ab');
  doc.deleteRange(0, 1);
  doc.insertText(1, 'c');
  assert.deepEqual(doc.log.map((o) => o.seq), [1, 2, 3, 4]);
});

test('setText: append, prepend, middle replace, clear, no-op', () => {
  const doc = new Document('alice');
  doc.setText('hello world');
  assert.equal(doc.text, 'hello world');

  const ins = doc.setText('hello brave world');
  assert.equal(doc.text, 'hello brave world');
  assert.ok(ins.every((o) => o.type === 'insert') && ins.length === 6);

  doc.setText('>> hello brave world');
  assert.equal(doc.text, '>> hello brave world');

  doc.setText('>> hello BRAVE world');
  assert.equal(doc.text, '>> hello BRAVE world');

  assert.deepEqual(doc.setText('>> hello BRAVE world'), []); // nothing changed

  doc.setText('');
  assert.equal(doc.text, '');
});

test('setText on two replicas converges after exchanging ops', () => {
  const alice = new Document('alice');
  const bob = new Document('bob');
  for (const op of alice.insertText(0, 'hello')) bob.applyRemote(op);

  const a = alice.setText('hello!');   // alice appends !
  const b = bob.setText('Hello');      // bob capitalises H

  a.forEach((op) => bob.applyRemote(op));
  b.forEach((op) => alice.applyRemote(op));

  assert.equal(alice.text, bob.text);
  assert.equal(alice.text, 'Hello!');
});

test('onChange fires for local and remote edits; unsubscribe works', () => {
  const alice = new Document('alice');
  const bob = new Document('bob');
  const seen = [];
  const off = bob.onChange((e) => seen.push(e.source));

  bob.insertText(0, 'x');                        // local
  alice.insertText(0, 'y').forEach((op) => bob.applyRemote(op)); // remote
  assert.deepEqual(seen, ['local', 'remote']);

  off();
  bob.insertText(0, 'z');
  assert.equal(seen.length, 2); // no more events
});

test('duplicate remote ops are not logged twice and do not fire events', () => {
  const alice = new Document('alice');
  const bob = new Document('bob');
  const ops = alice.insertText(0, 'hi');
  let events = 0;
  bob.onChange(() => events++);

  ops.forEach((op) => bob.applyRemote(op));
  ops.forEach((op) => bob.applyRemote(op)); // redelivered
  assert.equal(bob.log.length, 2);
  assert.equal(events, 2);
});

test('replaying the log rebuilds the exact same text', () => {
  const alice = new Document('alice');
  alice.insertText(0, 'hello world');
  alice.deleteRange(5, 6);
  alice.insertText(5, '!');
  const rebuilt = Document.replay('replayer', alice.log);
  assert.equal(rebuilt.text, alice.text);
});

test('replaying a PREFIX of the log gives an earlier version (preview of history/revert)', () => {
  const alice = new Document('alice');
  alice.insertText(0, 'hello');          // ops 1-5
  const afterHello = alice.log.length;
  alice.deleteRange(0, 5);               // ops 6-10
  alice.insertText(0, 'bye');            // ops 11-13

  assert.equal(Document.replay('r', alice.log.slice(0, afterHello)).text, 'hello');
  assert.equal(Document.replay('r', alice.log.slice(0, afterHello + 5)).text, '');
  assert.equal(Document.replay('r', alice.log).text, 'bye');
});

test('log is a copy: mutating it does not change history', () => {
  const doc = new Document('alice');
  doc.insertText(0, 'ab');
  const copy = doc.log;
  copy.length = 0;
  assert.equal(doc.log.length, 2);
});

test('ops are frozen (immutable log entries)', () => {
  const doc = new Document('alice');
  const [op] = doc.insertText(0, 'a');
  assert.throws(() => { 'use strict'; op.ch = 'z'; }, TypeError);
});

// ----- integration fuzz: random textarea-style edits on 3 docs -----
const rnd = (n) => Math.floor(Math.random() * n);
const randomEditedText = (t) => {
  const i = rnd(t.length + 1);
  if (t.length > 0 && Math.random() < 0.4) {
    const j = Math.min(t.length, i + 1 + rnd(3));
    return t.slice(0, i) + t.slice(j);
  }
  const word = ['a', 'bc', 'xyz'][rnd(3)];
  return t.slice(0, i) + word + t.slice(i);
};

test('fuzz: 3 documents using setText + exchanging ops always converge', () => {
  for (let trial = 0; trial < 150; trial++) {
    const docs = ['alice', 'bob', 'carol'].map((s) => new Document(s));
    for (let round = 0; round < 4; round++) {
      const opsBy = docs.map((d) => {
        const ops = [];
        for (let k = 0; k < 1 + rnd(3); k++) ops.push(...d.setText(randomEditedText(d.text)));
        return ops;
      });
      docs.forEach((d, i) => {
        opsBy.forEach((ops, j) => { if (i !== j) ops.forEach((op) => d.applyRemote(op)); });
      });
      assert.equal(docs[0].text, docs[1].text, `trial ${trial} round ${round}`);
      assert.equal(docs[1].text, docs[2].text, `trial ${trial} round ${round}`);
    }
  }
});