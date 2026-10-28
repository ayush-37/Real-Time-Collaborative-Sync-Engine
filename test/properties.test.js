// Day 1 tests: prove the THREE merge laws that make a state-based CRDT work.
//   commutative:  a ⊔ b == b ⊔ a
//   associative:  (a ⊔ b) ⊔ c == a ⊔ (b ⊔ c)
//   idempotent:   a ⊔ a == a
import test from 'node:test';
import assert from 'node:assert';
import { GCounter } from '../src/crdt/gcounter.js';
import { PNCounter } from '../src/crdt/pncounter.js';
import { LWWRegister } from '../src/crdt/lwwregister.js';
import { GSet } from '../src/crdt/gset.js';
import { OpCounter } from '../src/crdt/opcounter.js';

// ---- helpers: build fresh replicas with some random history ----
const rnd = (n) => Math.floor(Math.random() * n);

function randomGCounter(id) {
  const g = new GCounter(id);
  for (let i = 0; i < rnd(10); i++) g.increment(rnd(5) + 1);
  return g;
}
const copyG = (g) => g.clone();

// pure "join" so we never mutate the originals while checking laws
const joinG = (a, b) => copyG(a).merge(b);

test('G-Counter: merge is commutative, associative, idempotent (500 random trials)', () => {
  for (let t = 0; t < 500; t++) {
    const a = randomGCounter('A'), b = randomGCounter('B'), c = randomGCounter('C');
    assert.deepStrictEqual(joinG(a, b).counts, joinG(b, a).counts);                       // commutative
    assert.deepStrictEqual(joinG(joinG(a, b), c).counts, joinG(a, joinG(b, c)).counts);   // associative
    assert.deepStrictEqual(joinG(a, a).counts, a.counts);                                 // idempotent
  }
});

test('G-Counter: 3 replicas increment independently, converge in ANY merge order', () => {
  const A = new GCounter('A'), B = new GCounter('B'), C = new GCounter('C');
  A.increment(3); B.increment(5); C.increment(2);

  const orders = [[A, B, C], [A, C, B], [B, A, C], [B, C, A], [C, A, B], [C, B, A]];
  const results = orders.map(([x, y, z]) => joinG(joinG(x, y), z).value());
  assert.ok(results.every((v) => v === 10), `all orders should give 10, got ${results}`);
});

test('G-Counter: duplicate delivery of the same state changes nothing (idempotence)', () => {
  const A = new GCounter('A'); A.increment(4);
  const B = new GCounter('B'); B.increment(1);
  B.merge(A); B.merge(A); B.merge(A); // same message delivered 3 times
  assert.strictEqual(B.value(), 5);
});

test('PN-Counter: increments and decrements from different replicas converge', () => {
  const A = new PNCounter('A'), B = new PNCounter('B');
  A.increment(10); B.decrement(3); A.decrement(1);
  const ab = new PNCounter('X').merge(A).merge(B);
  const ba = new PNCounter('Y').merge(B).merge(A);
  assert.strictEqual(ab.value(), 6);
  assert.strictEqual(ba.value(), 6);
});

test('LWW-Register: concurrent writes with the same timestamp are broken by replicaId', () => {
  const A = new LWWRegister('A'), B = new LWWRegister('B');
  A.set('hello', 100);
  B.set('world', 100); // exact tie
  const x = new LWWRegister('X').merge(A).merge(B);
  const y = new LWWRegister('Y').merge(B).merge(A);
  assert.strictEqual(x.value, y.value);   // deterministic, order-independent
  assert.strictEqual(x.value, 'world');   // 'B' > 'A'
});

test('LWW-Register: shows the PROBLEM — one concurrent write silently disappears', () => {
  const A = new LWWRegister('A'), B = new LWWRegister('B');
  A.set('Hello', 1);
  B.set('World', 2);
  const merged = new LWWRegister('X').merge(A).merge(B);
  // Converged, yes. But A's edit is LOST. This is why LWW is wrong for text.
  assert.strictEqual(merged.value, 'World');
});

test('G-Set: union converges regardless of order', () => {
  const A = new GSet(), B = new GSet(), C = new GSet();
  A.add('x'); B.add('y'); C.add('z'); C.add('x');
  const r1 = new GSet().merge(A).merge(B).merge(C);
  const r2 = new GSet().merge(C).merge(B).merge(A);
  assert.deepStrictEqual(r1.toSortedArray(), r2.toSortedArray());
});

test('Op-based counter: ops commute, duplicates are ignored via opId', () => {
  const A = new OpCounter('A'), B = new OpCounter('B');
  const op1 = A.localAdd(5);
  const op2 = B.localAdd(7);
  // deliver in opposite orders, with a duplicate thrown in
  const R1 = new OpCounter('R1'); R1.apply(op1); R1.apply(op2); R1.apply(op1);
  const R2 = new OpCounter('R2'); R2.apply(op2); R2.apply(op1);
  assert.strictEqual(R1.total, 12);
  assert.strictEqual(R2.total, 12);
});

test('Op-based counter WITHOUT dedup would break idempotence (why the seen-set exists)', () => {
  let naiveTotal = 0;
  const op = { delta: 5 };
  naiveTotal += op.delta; naiveTotal += op.delta; // network delivered twice
  assert.strictEqual(naiveTotal, 10); // wrong! should be 5
});
