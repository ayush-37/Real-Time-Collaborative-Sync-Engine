// WHY index-based ops fail for text, and why "ID + tombstone" fixes it.
// The tiny helpers below are throw-away demos, NOT your real RGA (that is Day 3).
import test from 'node:test';
import assert from 'node:assert/strict';

// ---------- Demo 1: index-based ops (BROKEN) ----------
const applyIndexOp = (doc, op) => {
  const chars = [...doc];
  if (op.type === 'insert') chars.splice(op.index, 0, op.ch);
  if (op.type === 'delete') chars.splice(op.index, 1);
  return chars.join('');
};

test('index-based ops DIVERGE when applied in different orders', () => {
  const alice = { type: 'insert', index: 1, ch: 'X' }; // "ABC" -> insert X after A
  const bob = { type: 'delete', index: 0 };            // "ABC" -> delete A

  const replica1 = applyIndexOp(applyIndexOp('ABC', alice), bob); // alice then bob
  const replica2 = applyIndexOp(applyIndexOp('ABC', bob), alice); // bob then alice

  assert.equal(replica1, 'XBC');
  assert.equal(replica2, 'BXC');
  assert.notEqual(replica1, replica2); // DIVERGED: same ops, different order
});

// ---------- Demo 2: ID-based ops with tombstones (CONVERGES) ----------
// element = { id, ch, deleted }
const initial = () => [
  { id: 'A', ch: 'A', deleted: false },
  { id: 'B', ch: 'B', deleted: false },
  { id: 'C', ch: 'C', deleted: false },
];
const applyIdOp = (list, op) => {
  const out = list.map((e) => ({ ...e }));
  if (op.type === 'insertAfter') {
    const pos = out.findIndex((e) => e.id === op.afterId);
    out.splice(pos + 1, 0, { id: op.id, ch: op.ch, deleted: false });
  }
  if (op.type === 'delete') {
    out.find((e) => e.id === op.targetId).deleted = true; // tombstone, never removed
  }
  return out;
};
const visible = (list) => list.filter((e) => !e.deleted).map((e) => e.ch).join('');

test('ID-based ops + tombstones CONVERGE in either order', () => {
  const alice = { type: 'insertAfter', afterId: 'A', id: '1@alice', ch: 'X' };
  const bob = { type: 'delete', targetId: 'A' };

  const r1 = visible(applyIdOp(applyIdOp(initial(), alice), bob));
  const r2 = visible(applyIdOp(applyIdOp(initial(), bob), alice));

  assert.equal(r1, 'XBC');
  assert.equal(r2, 'XBC');
});