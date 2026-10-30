// LWW-Register: last-writer-wins register (state-based CRDT).
// Each write is tagged with (timestamp, replicaId). Higher tag wins.
// replicaId breaks ties, so the order is TOTAL and merge is deterministic.
class LWWRegister {
  constructor(replicaId) {
    this.id = replicaId;
    this.value = undefined;
    this.ts = 0;
    this.writer = '';
  }
  set(value, ts) {
    this.value = value;
    this.ts = ts;
    this.writer = this.id;
  }
  merge(other) {
    const otherWins =
      other.ts > this.ts || (other.ts === this.ts && other.writer > this.writer);
    if (otherWins) {
      this.value = other.value;
      this.ts = other.ts;
      this.writer = other.writer;
    }
    return this;
  }
}
export { LWWRegister };
