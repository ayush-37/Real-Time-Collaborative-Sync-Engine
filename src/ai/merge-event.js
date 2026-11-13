// Pure logic: from two version vectors, decide whether two replicas edited CONCURRENTLY and, if so,
// rebuild the four texts an AI reviewer needs. No network and no AI in this file.
//
// Why version vectors are enough (Day 10): a vector names a consistent cut of the log, the same on every replica.
//   base   = per-site MIN of the two vectors = what BOTH sides had seen (the common ancestor)
//   merged = per-site MAX                    = the union of their knowledge (what the CRDT converges to)
//   local / remote = each side's own vector
// Same shape as a Git three-way merge (base, ours, theirs, result), except a CRDT never stops to ask.
import { textAtVersion } from '../doc/history.js';

const siteSet = (...vs) => new Set(vs.flatMap((v) => Object.keys(v)));

export function minVersion(a, b) {
  const out = {};
  for (const s of siteSet(a, b)) {
    const m = Math.min(a[s] ?? 0, b[s] ?? 0);
    if (m > 0) out[s] = m;
  }
  return out;
}

export function maxVersion(a, b) {
  const out = {};
  for (const s of siteSet(a, b)) {
    const m = Math.max(a[s] ?? 0, b[s] ?? 0);
    if (m > 0) out[s] = m;
  }
  return out;
}

// does `a` contain everything `b` contains?
export function covers(a, b) {
  return Object.keys(b).every((s) => (a[s] ?? 0) >= b[s]);
}

// concurrent = each side has something the other has never seen
export function isDivergent(a, b) {
  return !covers(a, b) && !covers(b, a);
}

// sites that authored ops inside (from, to]
function authorsBetween(log, from, to) {
  const out = new Set();
  for (const op of log) {
    if (op.seq > (from[op.site] ?? 0) && op.seq <= (to[op.site] ?? 0)) out.add(op.site);
  }
  return [...out].sort();
}

// -> null when there was nothing concurrent, else { base, local, remote, merged, localAuthors, remoteAuthors }
export function buildMergeEvent(log, vLocal, vRemote) {
  if (!isDivergent(vLocal, vRemote)) return null;
  const base = minVersion(vLocal, vRemote);
  const merged = maxVersion(vLocal, vRemote);
  return {
    base: textAtVersion(log, base),
    local: textAtVersion(log, vLocal),
    remote: textAtVersion(log, vRemote),
    merged: textAtVersion(log, merged),
    localAuthors: authorsBetween(log, base, vLocal),
    remoteAuthors: authorsBetween(log, base, vRemote),
  };
}