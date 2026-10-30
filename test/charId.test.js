import test from 'node:test';
import assert from 'node:assert/strict';
import { makeId, compareIds, isEqual, idToString, parseId, ROOT_ID } from '../src/crdt/charId.js';

const rnd = (n) => Math.floor(Math.random() * n);
const randomId = () => makeId(rnd(5), ['alice', 'bob', 'carol'][rnd(3)]);

test('ids with the same clock on different sites are different (site breaks the tie)', () => {
  const a = makeId(7, 'alice');
  const b = makeId(7, 'bob');
  assert.notEqual(compareIds(a, b), 0);
  assert.ok(compareIds(a, b) < 0); // 'alice' < 'bob'
});

test('clock is compared before site', () => {
  assert.ok(compareIds(makeId(2, 'zed'), makeId(3, 'aaa')) < 0);
});

test('compareIds is a TOTAL order (500 random trials)', () => {
  for (let t = 0; t < 500; t++) {
    const a = randomId(), b = randomId(), c = randomId();
    // antisymmetry: a<b implies b>a
    assert.equal(Math.sign(compareIds(a, b)) + Math.sign(compareIds(b, a)), 0);
    // totality: any two ids are comparable; equal only if identical
    if (compareIds(a, b) === 0) assert.equal(idToString(a), idToString(b));
    // transitivity: a<=b and b<=c implies a<=c
    if (compareIds(a, b) <= 0 && compareIds(b, c) <= 0) {
      assert.ok(compareIds(a, c) <= 0);
    }
  }
});

test('sorting the same ids in any starting order gives the same result', () => {
  const ids = [makeId(3, 'bob'), makeId(1, 'alice'), makeId(3, 'alice'), makeId(2, 'carol')];
  const a = [...ids].sort(compareIds).map(idToString);
  const b = [...ids].reverse().sort(compareIds).map(idToString);
  assert.deepEqual(a, b);
});

test('idToString / parseId round-trip', () => {
  const id = makeId(42, 'alice');
  assert.ok(isEqual(parseId(idToString(id)), id));
});

test('ROOT_ID sorts before every real id', () => {
  assert.ok(compareIds(ROOT_ID, makeId(1, 'a')) < 0);
});