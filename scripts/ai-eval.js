// Usage: node --env-file=.env scripts/ai-eval.js [runsPerCase]
// A tiny golden set: each case is merged by the REAL CRDT, then the REAL model reviews it.
// Labels are my own judgement, so say "hand-labelled" when you quote the numbers.
import { Document } from '../src/doc/document.js';
import { buildMergeEvent } from '../src/ai/merge-event.js';
import { createChains } from '../src/ai/chains.js';
import { createModelFromEnv } from '../src/ai/model.js';

const RUNS = Number(process.argv[2] ?? 3);
const sync = (from, to) => from.opsSince(to.version()).forEach((op) => to.applyRemote(op));

function crdtMerge(base, localText, remoteText) {
  const a = new Document('alice');
  const b = new Document('bob');
  a.setText(base);
  sync(a, b);
  a.setText(localText);
  b.setText(remoteText);
  const vA = a.version();
  const vB = b.version();
  sync(a, b);
  sync(b, a);
  return buildMergeEvent(a.log, vA, vB);
}

const cases = [
  { name: 'two different times', expect: true,
    base: 'Team meeting at 3pm in room 4.', local: 'Team meeting at 5pm in room 4.', remote: 'Team meeting at 4pm in room 4.' },
  { name: 'edits in different places', expect: false,
    base: 'Title: Plan\n\nWe will launch in May.\n\nOwner: Sam',
    local: 'Title: Launch Plan\n\nWe will launch in May.\n\nOwner: Sam',
    remote: 'Title: Plan\n\nWe will launch in May.\n\nOwner: Sam Rao' },
  { name: 'approve vs reject', expect: true,
    base: 'Decision: we approve the budget.', local: 'Decision: we approve the budget of $10k.', remote: 'Decision: we reject the budget.' },
  { name: 'edit inside a deleted line', expect: true,
    base: 'Intro.\nThe launch is on Monday.\nBye.', local: 'Intro.\nThe launch is on Monday at 9am.\nBye.', remote: 'Intro.\nBye.' },
  { name: 'both append a list item', expect: false,
    base: 'Shopping:\n- milk', local: 'Shopping:\n- milk\n- eggs', remote: 'Shopping:\n- milk\n- bread' },
];

const chains = createChains({ model: await createModelFromEnv() });
let right = 0;
for (const c of cases) {
  const event = crdtMerge(c.base, c.local, c.remote);
  let flagged = 0;
  for (let i = 0; i < RUNS; i++) {
    const out = await chains.conflicts(event);
    if (!out.coherent || out.conflicts.length > 0) flagged++;
  }
  const majority = flagged > RUNS / 2;
  if (majority === c.expect) right++;
  console.log(`${majority === c.expect ? 'OK  ' : 'MISS'} ${c.name}: expected ${c.expect ? 'flag' : 'ok'}, flagged ${flagged}/${RUNS}`);
  console.log(`     merged: ${JSON.stringify(event.merged)}`);
}
console.log(`\n${right}/${cases.length} cases decided correctly (majority of ${RUNS} runs each)`);