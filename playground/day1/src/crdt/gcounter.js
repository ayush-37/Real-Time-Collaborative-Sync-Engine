// G-Counter: grow-only counter (state-based CRDT).
// State = map { replicaId -> count that replica has incremented }.
// value() = sum of all slots. merge() = per-slot MAX.

class GCounter {
  constructor(replicaId) {
    this.id = replicaId;  // id of the instance (replica) of the counter
    this.counts = {};     //  map of contributions from each replica
  }

  increment(n = 1) {
    this.counts[this.id] = (this.counts[this.id] || 0) + n;
  }

  value() {
    return Object.values(this.counts).reduce((a, b) => a + b, 0);
  }

  // Join (least upper bound) of two states
  merge(other) {
    for (const [id, c] of Object.entries(other.counts)) {
      this.counts[id] = Math.max(this.counts[id] || 0, c);
      // this.counts[id] = (this.counts[id] || 0) + c;
    }
    return this;
  }

  clone(newId = this.id) {
    const g = new GCounter(newId);
    g.counts = { ...this.counts };
    // The above line creates a shallow copy of the counts object.
    // If we just did g.counts = this.counts, JavaScript would just pass a reference to the exact same object in computer memory. Any changes made to the clone would accidentally modify the original counter.
    // By wrapping it in curly braces { ...this.counts }, JavaScript creates a shallow copy—a brand-new, independent object that contains the exact same numbers, but lives entirely separately in memory.
    return g;
  }
}
export { GCounter };
























