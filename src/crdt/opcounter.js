// Op-based counter: instead of shipping STATE, we ship OPERATIONS.
// Each op has a unique id so a duplicate delivery can be ignored (idempotence
// is NOT free in op-based CRDTs - the delivery layer or the data type must provide it).
class OpCounter {
  constructor(replicaId) {
    this.id = replicaId;
    this.seq = 0;     // Counts operations created by this replica
    this.total = 0;
    this.seen = new Set();
  }

  // Why do we need both seq and seen?
  // seq helps the sender create unique IDs for its operations.
  // seen helps the receiver recognize operations it has already applied.


  // local op: returns the op so the caller can broadcast it
  localAdd(delta) {
    const op = { opId: `${this.id}:${++this.seq}`, delta };
    // Suppose we have a replica named "A".
    // a.localAdd(3);

    // Initially, a.seq = 0.
    // - ++this.seq increases it to 1.
    // - this.id is "A".
    // - The operation ID becomes "A:1".
    // - delta is 3.
    // So the operation is:
    // { opId: "A:1", delta: 3 }
    // This operation can be sent to other replicas for processing.
    // The receiving replicas will apply the operation if it hasn't been seen before.

    this.apply(op);
    return op;
  }
  
  apply(op) {
    if (this.seen.has(op.opId)) return false; // duplicate -> ignore
    this.seen.add(op.opId);
    this.total += op.delta;
    return true;
  }
}
export { OpCounter };
