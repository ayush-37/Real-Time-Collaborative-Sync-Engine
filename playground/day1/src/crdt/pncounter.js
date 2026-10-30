// PN-Counter: counter that supports decrement, built from TWO G-Counters.

// value = P.value() - N.value()
import { GCounter } from './gcounter.js';

class PNCounter {
  constructor(replicaId) {
    this.id = replicaId;
    this.p = new GCounter(replicaId); // increments
    this.n = new GCounter(replicaId); // decrements
  }
  increment(k = 1) { this.p.increment(k); }
  decrement(k = 1) { this.n.increment(k); }
  value() { return this.p.value() - this.n.value(); }
  merge(other) {
    this.p.merge(other.p);
    this.n.merge(other.n);
    return this;
  }
}
export { PNCounter };

// PN-Counter (Positive-Negative Counter): A state-based CRDT supporting both increments and decrements.
// It is built from two G-Counters: P stores increments, and N stores decrement magnitudes.
// The final value is P.value() - N.value(). Both underlying counters only increase.
// Merge the P-Counters together and the N-Counters together using the G-Counter merge rule.
// This preserves the convergence properties of the underlying G-Counters, assuming valid replica identities and correct usage.