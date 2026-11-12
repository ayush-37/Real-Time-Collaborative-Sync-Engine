// Usage: node scripts/convergence-report.js [seeds] [shuffles]
import { buildScenario } from '../src/sim/scenario.js';
import { checkOrder, permutations } from '../src/sim/check.js';
import { makeRng } from '../src/sim/prng.js';

const SEEDS = Number(process.argv[2] ?? 50);
const SHUFFLES = Number(process.argv[3] ?? 200);
const t0 = Date.now();
let scenarios = 0, ops = 0, orders = 0;

try {
  for (let seed = 1; seed <= SEEDS; seed++) {            // small histories: EVERY order
    const s = buildScenario({ seed, replicas: 3, rounds: 2 });
    scenarios++; ops += s.ops.length;
    for (const order of permutations(s.ops)) { checkOrder(order, s.reference, `seed ${seed}`); orders++; }
  }
  for (let seed = 1; seed <= SEEDS; seed++) {            // larger histories: random orders
    const seedUsed = 1000 + seed;
    const s = buildScenario({ seed: seedUsed, replicas: 5, rounds: 8, editsPerRound: 2, maxLen: 3 });
    const rng = makeRng(seed);
    scenarios++; ops += s.ops.length;
    for (let k = 0; k < SHUFFLES; k++) { checkOrder(rng.shuffle(s.ops), s.reference, `seed ${seedUsed}`); orders++; }
  }
} catch (err) {
  console.error(err.message);
  process.exit(1);
}

console.log(`${scenarios} scenarios, ${ops} ops, ${orders.toLocaleString()} arrival orders checked, 0 divergences (${((Date.now() - t0) / 1000).toFixed(1)}s)`);