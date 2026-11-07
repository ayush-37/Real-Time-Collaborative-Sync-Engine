import test from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '../src/doc/document.js';
import { ROOT_ID, idToString } from '../src/crdt/charId.js';

const pair = (text) => {
  const alice = new Document('alice');
  const bob = new Document('bob');
  alice.insertText(0, text).forEach((op) => bob.applyRemote(op));
  return { alice, bob };
};

test('a cursor at the start is anchored to ROOT', () => {
  const { alice } = pair('hello');
  assert.equal(idToString(alice.anchorAt(0)), idToString(ROOT_ID));
  assert.equal(alice.indexOfAnchor(ROOT_ID), 0);
});

test('a remote insert BEFORE the cursor pushes the cursor right', () => {
  const { alice, bob } = pair('hello');
  const anchor = bob.anchorAt(2);                 // bob's cursor: "he|llo"
  alice.insertText(0, 'XX').forEach((op) => bob.applyRemote(op));
  assert.equal(bob.text, 'XXhello');
  assert.equal(bob.indexOfAnchor(anchor), 4);     // "XXhe|llo"
});

test('a remote insert AFTER the cursor does not move it', () => {
  const { alice, bob } = pair('hello');
  const anchor = bob.anchorAt(2);
  alice.insertText(5, '!!!').forEach((op) => bob.applyRemote(op));
  assert.equal(bob.indexOfAnchor(anchor), 2);
});

test('a remote delete BEFORE the cursor pulls the cursor left', () => {
  const { alice, bob } = pair('hello');
  const anchor = bob.anchorAt(3);                 // "hel|lo"
  alice.deleteRange(0, 2).forEach((op) => bob.applyRemote(op));
  assert.equal(bob.text, 'llo');
  assert.equal(bob.indexOfAnchor(anchor), 1);     // "l|lo"
});

test('if the anchor char itself is deleted, the cursor stays at that spot (tombstone)', () => {
  const { alice, bob } = pair('hello');
  const anchor = bob.anchorAt(3);                 // anchored to the first 'l'
  alice.deleteRange(2, 1).forEach((op) => bob.applyRemote(op)); // alice deletes that 'l'
  assert.equal(bob.text, 'helo');
  assert.equal(bob.indexOfAnchor(anchor), 2);     // "he|lo"
});

test('a cursor at the very end follows the last character', () => {
  const { alice, bob } = pair('abc');
  const anchor = bob.anchorAt(3);
  alice.insertText(0, '>>').forEach((op) => bob.applyRemote(op));
  assert.equal(bob.indexOfAnchor(anchor), 5);
});

test('out-of-range and unknown anchors are errors', () => {
  const { alice } = pair('ab');
  assert.throws(() => alice.anchorAt(9), RangeError);
  assert.throws(() => alice.indexOfAnchor({ clock: 99, site: 'nobody' }), /unknown anchor/);
});