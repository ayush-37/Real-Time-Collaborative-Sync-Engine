import test from 'node:test';
import assert from 'node:assert/strict';
import { buildScenario } from '../src/sim/scenario.js';
import { checkOrder, permutations, applyInOrder, syncAll } from '../src/sim/check.js';
import { makeRng } from '../src/sim/prng.js';
import { Document } from '../src/doc/document.js';

// turn the knobs up for a long run:  FUZZ_SEEDS=200 FUZZ_SHUFFLES=300 npm test
const SEEDS = Number(process.env.FUZZ_SEEDS ?? 20);
const SHUFFLES = Number(process.env.FUZZ_SHUFFLES ?? 100);

test('EXHAUSTIVE: every arrival order of every op gives the same document (3 replicas, 6 ops = 720 orders)', () => {
  let checked = 0;
  for (let seed = 1; seed <= SEEDS; seed++) {
    const { ops, reference } = buildScenario({ seed, replicas: 3, rounds: 2 });
    assert.ok(ops.length <= 7, `seed ${seed}: ${ops.length} ops is too many for exhaustive search`);
    for (const order of permutations(ops)) {
      checkOrder(order, reference, `seed ${seed}`);
      checked++;
    }
  }
  assert.ok(checked > 0);
});

test('RANDOM: bigger histories (5 replicas, longer edits), many random arrival orders', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const scenarioSeed = 1000 + seed;
    const { ops, reference } = buildScenario({
      seed: scenarioSeed, replicas: 5, rounds: 8, editsPerRound: 2, maxLen: 3,
    });
    const rng = makeRng(seed);
    for (let k = 0; k < SHUFFLES; k++) {
      checkOrder(rng.shuffle(ops), reference, `seed ${scenarioSeed}, shuffle ${k}`);
    }
  }
});

test('DUPLICATES: every op delivered 1 to 3 times, in a random order, still gives the same document', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const scenarioSeed = 2000 + seed;
    const { ops, reference } = buildScenario({ seed: scenarioSeed, replicas: 4, rounds: 6, editsPerRound: 2, maxLen: 2 });
    const rng = makeRng(seed);
    for (let k = 0; k < SHUFFLES / 2; k++) {
      const noisy = ops.flatMap((op) => Array.from({ length: 1 + rng.int(3) }, () => op));
      checkOrder(rng.shuffle(noisy), reference, `seed ${scenarioSeed}, noisy shuffle ${k}`);
    }
  }
});

test('NO LOSS, NO INVENTION: final text is exactly the inserted characters minus the deleted ones', () => {
  for (let seed = 1; seed <= SEEDS; seed++) {
    const { ops, reference } = buildScenario({ seed: 3000 + seed, replicas: 4, rounds: 6, editsPerRound: 2, maxLen: 3 });
    const inserted = new Map();
    const deleted = new Set();
    for (const op of ops) {
      if (op.type === 'insert') inserted.set(`${op.id.clock}:${op.id.site}`, op.ch);
      else if (op.type === 'delete') deleted.add(`${op.targetId.clock}:${op.targetId.site}`);
    }
    const expected = [...inserted].filter(([id]) => !deleted.has(id)).map(([, ch]) => ch).sort().join('');
    const actual = [...reference.text].sort().join('');
    assert.equal(actual, expected, `seed ${3000 + seed}`);
  }
});

test('INTENTION: two people typing a word at the same spot never interleave their letters', () => {
  for (const [a, b] of [['abc', 'XYZ'], ['hello', 'world']]) {
    const alice = new Document('alice');
    const bob = new Document('bob');
    alice.insertText(0, a);
    bob.insertText(0, b);                 // concurrent: neither has seen the other
    syncAll([alice, bob]);
    assert.equal(alice.text, bob.text);
    assert.ok([a + b, b + a].includes(alice.text), `interleaved: ${alice.text}`);
  }

  // same thing in the middle of a shared document
  const alice = new Document('alice');
  const bob = new Document('bob');
  alice.insertText(0, 'startend');
  syncAll([alice, bob]);
  alice.insertText(5, 'AAA');
  bob.insertText(5, 'BBB');
  syncAll([alice, bob]);
  assert.ok(['startAAABBBend', 'startBBBAAAend'].includes(alice.text), `got ${alice.text}`);
});

test('the checker is not vacuous: it reports a divergence when there is one (canary)', () => {
  const { ops } = buildScenario({ seed: 1 });
  const staleReference = applyInOrder(ops.slice(0, -1)); // a replica that never got the last op
  assert.throws(() => checkOrder(ops, staleReference, 'canary'), /DIVERGENCE/);
});