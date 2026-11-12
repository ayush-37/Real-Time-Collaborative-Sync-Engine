// Helpers for convergence testing.
//   syncAll      : full mesh sync between live replicas until they agree (the "reference" outcome)
//   unionOps     : every distinct op that exists anywhere
//   checkOrder   : deliver ONE arrival order to a brand-new replica and compare it with the reference
//   permutations : every ordering of a small set of ops
import { isDeepStrictEqual } from 'node:util';
import { Document } from '../doc/document.js';

const key = (op) => `${op.site}:${op.seq}`;

export function syncAll(docs) {
  const agree = () => docs.every((d) => d.text === docs[0].text && isDeepStrictEqual(d.version(), docs[0].version()));
  for (let pass = 0; pass <= docs.length; pass++) {
    for (const from of docs) {
      for (const to of docs) {
        if (from !== to) from.opsSince(to.version()).forEach((op) => to.applyRemote(op));
      }
    }
    if (agree()) return;
  }
  throw new Error('replicas still disagree after a full mesh sync: the sync itself is broken');
}

export function unionOps(docs) {
  const seen = new Map();
  for (const doc of docs) for (const op of doc.log) seen.set(key(op), op);
  return [...seen.values()];
}

export function applyInOrder(ops, site = 'observer') {
  const doc = new Document(site);
  for (const op of ops) doc.applyRemote(op);
  return doc;
}

// `order` may contain duplicates. Throws a readable error naming the exact order that diverged.
export function checkOrder(order, reference, label) {
  const doc = applyInOrder(order);
  const problems = [];
  if (doc.text !== reference.text) {
    problems.push(`text ${JSON.stringify(doc.text)} !== ${JSON.stringify(reference.text)}`);
  }
  if (!isDeepStrictEqual(doc.version(), reference.version())) problems.push('version vectors differ');
  if (doc.pendingCount !== 0) problems.push(`${doc.pendingCount} op(s) still parked in the causal buffer`);
  if (doc.log.length !== reference.log.length) {
    problems.push(`log has ${doc.log.length} ops, expected ${reference.log.length}`);
  }
  if (problems.length > 0) {
    throw new Error(`DIVERGENCE (${label}): ${problems.join('; ')}\n  order: ${order.map(key).join(' ')}`);
  }
}

// Heap's algorithm: yields every ordering of `items` (n! of them), each as a fresh array.
export function* permutations(items) {
  const a = [...items];
  const c = new Array(a.length).fill(0);
  yield [...a];
  let i = 0;
  while (i < a.length) {
    if (c[i] < i) {
      if (i % 2 === 0) [a[0], a[i]] = [a[i], a[0]];
      else [a[c[i]], a[i]] = [a[i], a[c[i]]];
      yield [...a];
      c[i]++;
      i = 0;
    } else {
      c[i] = 0;
      i++;
    }
  }
}