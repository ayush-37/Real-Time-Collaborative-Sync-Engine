// Build a random editing history between N replicas.
//   Each round: every replica edits at the same time without hearing from the others (CONCURRENT),
//   then random pairs sync, so later edits are made on top of partial knowledge. Messy on purpose.
// Edits go through the public API (setText), so the diffing code is exercised as well.
import { Document } from '../doc/document.js';
import { makeRng } from './prng.js';
import { syncAll, unionOps } from './check.js';

const ALPHABET = 'abcdefgh';

function randomEdit(doc, rng, maxLen) {
  const text = doc.text;
  if (text.length === 0 || rng.chance(0.65)) {
    const chars = Array.from({ length: 1 + rng.int(maxLen) }, () => rng.pick(ALPHABET)).join('');
    const pos = rng.int(text.length + 1);
    doc.setText(text.slice(0, pos) + chars + text.slice(pos));
  } else {
    const pos = rng.int(text.length);
    const len = 1 + rng.int(Math.min(maxLen, text.length - pos));
    doc.setText(text.slice(0, pos) + text.slice(pos + len));
  }
}

export function buildScenario({ seed, replicas = 3, rounds = 3, editsPerRound = 1, maxLen = 1, syncChance = 0.5 }) {
  const rng = makeRng(seed);
  const docs = Array.from({ length: replicas }, (_, i) => new Document(`r${i + 1}`));

  for (let round = 0; round < rounds; round++) {
    for (const doc of docs) {
      for (let e = 0; e < editsPerRound; e++) randomEdit(doc, rng, maxLen);
    }
    for (const from of docs) {
      for (const to of docs) {
        if (from !== to && rng.chance(syncChance)) {
          from.opsSince(to.version()).forEach((op) => to.applyRemote(op));
        }
      }
    }
  }

  syncAll(docs); // the reference outcome: live replicas that have heard everything
  return { seed, docs, ops: unionOps(docs), reference: docs[0] };
}