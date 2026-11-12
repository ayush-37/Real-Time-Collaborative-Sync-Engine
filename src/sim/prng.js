// Small seeded PRNG (mulberry32). Same seed -> same "random" numbers, so every failure can be replayed.
export function makeRng(seed) {
  let s = seed >>> 0;
  const next = () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  const int = (n) => Math.floor(next() * n);          // 0 .. n-1
  const pick = (items) => items[int(items.length)];   // works for arrays and strings
  const chance = (p) => next() < p;
  const shuffle = (items) => {                        // Fisher-Yates on a copy
    const a = [...items];
    for (let i = a.length - 1; i > 0; i--) {
      const j = int(i + 1);
      [a[i], a[j]] = [a[j], a[i]];
    }
    return a;
  };
  return { next, int, pick, chance, shuffle };
}