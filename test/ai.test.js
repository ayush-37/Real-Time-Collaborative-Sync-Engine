import test from 'node:test';
import assert from 'node:assert/strict';
import { Document } from '../src/doc/document.js';
import { SyncClient } from '../src/client/sync-client.js';
import { startSyncServer } from '../src/server/server.js';
import { buildMergeEvent, isDivergent, minVersion, maxVersion, covers } from '../src/ai/merge-event.js';
import { createAiService } from '../src/ai/service.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 5000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await sleep(3);
  }
};
const sync = (from, to) => from.opsSince(to.version()).forEach((op) => to.applyRemote(op));

// two people edit the same time concurrently, then everything is exchanged
function diverge() {
  const alice = new Document('alice');
  const bob = new Document('bob');
  alice.setText('meeting at 3pm');
  sync(alice, bob);
  alice.setText('meeting at 5pm');
  bob.setText('meeting at 4pm');
  const vAlice = alice.version();
  const vBob = bob.version();
  sync(alice, bob);
  sync(bob, alice);
  return { alice, bob, vAlice, vBob };
}

const quiet = async (fn) => {           // some tests make the service log an error on purpose
  const orig = console.error;
  console.error = () => {};
  try { return await fn(); } finally { console.error = orig; }
};

// ---------- merge-event (pure) ----------

test('version helpers: min = common ancestor, max = union, covers / isDivergent', () => {
  const a = { alice: 5, bob: 2 };
  const b = { alice: 3, bob: 4 };
  assert.deepEqual(minVersion(a, b), { alice: 3, bob: 2 });
  assert.deepEqual(maxVersion(a, b), { alice: 5, bob: 4 });
  assert.equal(isDivergent(a, b), true);
  assert.equal(isDivergent({ alice: 5 }, { alice: 3 }), false);   // one side is simply behind
  assert.equal(isDivergent(a, a), false);
  assert.equal(covers(maxVersion(a, b), a), true);
});

test('buildMergeEvent rebuilds base / local / remote / merged from version vectors alone', () => {
  const { alice, vAlice, vBob } = diverge();
  const event = buildMergeEvent(alice.log, vAlice, vBob);
  assert.equal(event.base, 'meeting at 3pm');
  assert.equal(event.local, 'meeting at 5pm');
  assert.equal(event.remote, 'meeting at 4pm');
  assert.equal(event.merged, alice.text);
  assert.match(event.merged, /^meeting at (45|54)pm$/);          // the CRDT converged... to nonsense
  assert.deepEqual(event.localAuthors, ['alice']);
  assert.deepEqual(event.remoteAuthors, ['bob']);
});

test('no merge event when one side is just behind (a plain catch-up is not a conflict)', () => {
  const { alice, vAlice } = diverge();
  assert.equal(buildMergeEvent(alice.log, vAlice, alice.version()), null);
});

// ---------- service (fake chains) ----------

const goodChains = {
  conflicts: async () => ({
    coherent: false,
    conflicts: [{ kind: 'garbled_text', severity: 'high', description: 'digits blended', evidence: '45pm', suggestion: 'pick one' }],
  }),
  changelog: async () => ({ summary: 'Both changed the time', changes: [{ side: 'local', description: 'set 5pm' }] }),
};
const event = { base: 'a', local: 'b', remote: 'c', merged: 'bc', localAuthors: ['alice'], remoteAuthors: ['bob'] };

test('service: the happy path returns a clean report', async () => {
  const r = await createAiService({ chains: goodChains }).analyzeMerge(event);
  assert.equal(r.status, 'done');
  assert.equal(r.coherent, false);
  assert.equal(r.conflicts[0].kind, 'garbled_text');
  assert.equal(r.changelog.summary, 'Both changed the time');
});

test('service: a huge document is skipped WITHOUT calling the model', async () => {
  const boom = { conflicts: () => { throw new Error('must not be called'); }, changelog: () => { throw new Error('must not be called'); } };
  const r = await createAiService({ chains: boom, maxChars: 10 }).analyzeMerge({ ...event, merged: 'x'.repeat(11) });
  assert.equal(r.status, 'skipped');
});

test('service: the rate limit stops a flood of calls', async () => {
  const service = createAiService({ chains: goodChains, maxPerMinute: 2 });
  assert.equal((await service.analyzeMerge(event)).status, 'done');
  assert.equal((await service.analyzeMerge(event)).status, 'done');
  assert.equal((await service.analyzeMerge(event)).status, 'skipped');
});

test('service: one chain failing keeps the other half; both failing gives status "error"', async () => {
  await quiet(async () => {
    const half = createAiService({ chains: { conflicts: async () => { throw new Error('boom'); }, changelog: goodChains.changelog } });
    const r = await half.analyzeMerge(event);
    assert.equal(r.status, 'done');
    assert.equal(r.coherent, null);                              // unknown, not "fine"
    assert.ok(r.changelog);

    const dead = createAiService({ chains: { conflicts: async () => { throw new Error('x'); }, changelog: async () => { throw new Error('y'); } } });
    assert.equal((await dead.analyzeMerge(event)).status, 'error');
  });
});

test('service: a hanging model is cut off by the timeout', async () => {
  await quiet(async () => {
    const hang = () => new Promise(() => {});
    const r = await createAiService({ chains: { conflicts: hang, changelog: hang }, timeoutMs: 30 }).analyzeMerge(event);
    assert.equal(r.status, 'error');
  });
});

test('service: model output is clipped and unknown values are normalised', async () => {
  const wild = {
    conflicts: async () => ({
      coherent: true,
      conflicts: [{ kind: 'x', severity: 'catastrophic', description: 'd'.repeat(5000), evidence: 'e', suggestion: 's' }],
    }),
    changelog: async () => ({ summary: 's'.repeat(5000), changes: Array.from({ length: 50 }, () => ({ side: 'weird', description: 'x' })) }),
  };
  const r = await createAiService({ chains: wild }).analyzeMerge(event);
  assert.equal(r.conflicts[0].severity, 'medium');
  assert.ok(r.conflicts[0].description.length <= 300);
  assert.equal(r.coherent, false);                               // a model that lists problems cannot also say "coherent"
  assert.ok(r.changelog.summary.length <= 400);
  assert.equal(r.changelog.changes.length, 8);
});

// ---------- server integration (fake AI) ----------

function fakeAi(calls) {
  return createAiService({
    chains: {
      conflicts: async (e) => {
        calls.push(e);
        return { coherent: false, conflicts: [{ kind: 'garbled_text', severity: 'high', description: 'two digits were blended', evidence: e.merged, suggestion: 'pick one time' }] };
      },
      changelog: async () => ({ summary: 'Both changed the time', changes: [{ side: 'local', description: 'set 5pm' }, { side: 'remote', description: 'set 4pm' }] }),
    },
  });
}

async function twoPeers(server) {
  const url = `ws://127.0.0.1:${server.port}`;
  const opts = { reconnect: { enabled: false } };
  const aliceDoc = new Document('alice');
  const bobDoc = new Document('bob');
  const c1 = new SyncClient({ url, docId: 'doc1', document: aliceDoc, ...opts });
  const cb = new SyncClient({ url, docId: 'doc1', document: bobDoc, ...opts });
  c1.connect(); cb.connect();
  await until(() => c1.status === 'online' && cb.status === 'online');
  return { url, opts, aliceDoc, bobDoc, c1, cb };
}

test('reconnect after concurrent offline edits: the server runs the AI review once and serves the report', async () => {
  const calls = [];
  const server = await startSyncServer({ port: 0, ai: fakeAi(calls) });
  let p; let c2;
  try {
    p = await twoPeers(server);
    p.aliceDoc.setText('meeting at 3pm');
    await until(() => p.bobDoc.text === 'meeting at 3pm');

    p.c1.close();                                                // alice goes offline...
    await until(() => p.c1.status === 'disconnected');
    p.aliceDoc.setText('meeting at 5pm');                        // ...and edits
    p.bobDoc.setText('meeting at 4pm');                          // bob edits at the same time, online
    await until(() => server.rooms.get('doc1').doc.text === 'meeting at 4pm');

    c2 = new SyncClient({ url: p.url, docId: 'doc1', document: p.aliceDoc, ...p.opts });
    c2.connect();                                                // alice comes back
    await until(() => server.rooms.get('doc1').aiReports.some((r) => r.status === 'done'));

    assert.equal(calls.length, 1);
    assert.equal(calls[0].base, 'meeting at 3pm');
    assert.equal(calls[0].local, 'meeting at 5pm');
    assert.equal(calls[0].remote, 'meeting at 4pm');
    assert.match(calls[0].merged, /^meeting at (45|54)pm$/);

    const res = await fetch(`http://127.0.0.1:${server.port}/ai/reports?doc=doc1`);
    const body = await res.json();
    assert.equal(body.enabled, true);
    assert.equal(body.reports[0].site, 'alice');
    assert.equal(body.reports[0].conflicts[0].kind, 'garbled_text');
    assert.deepEqual(body.reports[0].localAuthors, ['alice']);
    assert.deepEqual(body.reports[0].remoteAuthors, ['bob']);
  } finally {
    p?.c1.close(); p?.cb.close(); c2?.close();
    await server.close();
  }
});

test('no review when only ONE side changed (offline typing alone is not a conflict)', async () => {
  const calls = [];
  const server = await startSyncServer({ port: 0, ai: fakeAi(calls) });
  let p; let c2;
  try {
    p = await twoPeers(server);
    p.aliceDoc.setText('hello');
    await until(() => p.bobDoc.text === 'hello');
    p.c1.close();
    await until(() => p.c1.status === 'disconnected');
    p.aliceDoc.setText('hello world');                          // only alice edits
    c2 = new SyncClient({ url: p.url, docId: 'doc1', document: p.aliceDoc, ...p.opts });
    c2.connect();
    await until(() => server.rooms.get('doc1').doc.text === 'hello world');
    await sleep(100);
    assert.equal(calls.length, 0);
    assert.equal(server.rooms.get('doc1').aiReports.length, 0);
  } finally {
    p?.c1.close(); p?.cb.close(); c2?.close();
    await server.close();
  }
});

test('with AI switched off the endpoint says so, and bad doc ids are harmless', async () => {
  const server = await startSyncServer({ port: 0 });
  try {
    for (const doc of ['doc1', '../etc/passwd', '']) {
      const res = await fetch(`http://127.0.0.1:${server.port}/ai/reports?doc=${encodeURIComponent(doc)}`);
      assert.equal(res.status, 200);
      assert.deepEqual(await res.json(), { enabled: false, reports: [] });
    }
    assert.equal(server.rooms.size, 0);                          // asking for reports never creates a room
  } finally {
    await server.close();
  }
});

test('server-side AI code is not served to browsers', async () => {
  const server = await startSyncServer({ port: 0 });
  try {
    for (const p of ['/src/ai/service.js', '/src/ai/chains.js', '/src/ai/setup.js']) {
      const res = await fetch(`http://127.0.0.1:${server.port}${p}`);
      assert.notEqual(res.status, 200, `${p} is being served`);
    }
  } finally {
    await server.close();
  }
});