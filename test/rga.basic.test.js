import test from 'node:test';
import assert from 'node:assert/strict';
import { RGA } from '../src/crdt/rga.js';
import { makeId, ROOT_ID } from '../src/crdt/charId.js';

// helper: type a whole string on a replica, return the ops
const type = (doc, text, startIndex = 0) =>
  [...text].map((ch, i) => doc.insertAt(startIndex + i, ch));

test('typing builds the string', () => {
  const doc = new RGA('alice');
  type(doc, 'hello');
  assert.equal(doc.toString(), 'hello');
  assert.equal(doc.length, 5);
});

test('insert in the middle and at the start', () => {
  const doc = new RGA('alice');
  type(doc, 'ac');
  doc.insertAt(1, 'b');
  doc.insertAt(0, '>');
  assert.equal(doc.toString(), '>abc');
});

test('delete leaves a tombstone but hides the char', () => {
  const doc = new RGA('alice');
  type(doc, 'abc');
  doc.deleteAt(1);
  assert.equal(doc.toString(), 'ac');
  assert.equal(doc.tombstoneCount, 1);
  assert.equal(doc.dump().length, 3); // still 3 nodes inside
});

test('out-of-range edits throw', () => {
  const doc = new RGA('alice');
  type(doc, 'ab');
  assert.throws(() => doc.insertAt(5, 'x'), RangeError);
  assert.throws(() => doc.deleteAt(2), RangeError);
  assert.throws(() => doc.deleteAt(-1), RangeError);
});

test('a second replica rebuilds the same text from the ops', () => {
  const alice = new RGA('alice');
  const bob = new RGA('bob');
  const ops = type(alice, 'hello');
  ops.push(alice.deleteAt(0));
  for (const op of ops) bob.applyRemote(op);
  assert.equal(bob.toString(), 'ello');
  assert.equal(bob.toString(), alice.toString());
});

test('duplicate ops are ignored (idempotence)', () => {
  const alice = new RGA('alice');
  const bob = new RGA('bob');
  const ops = type(alice, 'hi');
  for (const op of ops) bob.applyRemote(op);
  const again = ops.map((op) => bob.applyRemote(op)); // redeliver everything
  assert.deepEqual(again, [false, false]);
  assert.equal(bob.toString(), 'hi');
});

test('applying the same delete twice is harmless', () => {
  const alice = new RGA('alice');
  const bob = new RGA('bob');
  const ops = type(alice, 'ab');
  const del = alice.deleteAt(0);
  [...ops, del, del].forEach((op) => bob.applyRemote(op));
  assert.equal(bob.toString(), 'b');
});

test('op whose parent has not arrived is rejected (causality)', () => {
  const bob = new RGA('bob');
  const orphan = { type: 'insert', id: makeId(9, 'alice'), afterId: makeId(8, 'alice'), ch: 'x' };
  assert.throws(() => bob.applyRemote(orphan), /parent/);
});

test('ROOT cannot be deleted by a remote op', () => {
  const bob = new RGA('bob');
  assert.throws(() => bob.applyRemote({ type: 'delete', targetId: ROOT_ID }));
});