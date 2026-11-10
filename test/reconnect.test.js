import test from 'node:test';
import assert from 'node:assert/strict';
import { startSyncServer } from '../src/server/server.js';
import { Document } from '../src/doc/document.js';
import { SyncClient, backoffDelay } from '../src/client/sync-client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await sleep(2);
  }
};

// ---------- backoffDelay (pure function) ----------

test('backoff: the upper bound doubles each attempt and is capped at maxMs', () => {
  const opts = { baseMs: 100, maxMs: 1000, random: () => 0.999999 };
  const maxima = [0, 1, 2, 3, 4, 5, 10].map((a) => backoffDelay(a, opts));
  assert.deepEqual(maxima.map((d) => Math.ceil(d / 10) * 10), [100, 200, 400, 800, 1000, 1000, 1000]);
});

test('backoff: "full jitter" picks anywhere from 0 up to the cap', () => {
  assert.equal(backoffDelay(3, { baseMs: 100, maxMs: 10_000, random: () => 0 }), 0);
  assert.equal(backoffDelay(3, { baseMs: 100, maxMs: 10_000, random: () => 0.5 }), 400);   // half of 800
});

test('backoff: delays are random (many clients do not retry in lockstep)', () => {
  const delays = new Set(Array.from({ length: 200 }, () => backoffDelay(5, { baseMs: 500, maxMs: 15_000 })));
  assert.ok(delays.size > 150, `only ${delays.size} distinct delays out of 200`);
});

test('backoff: always an integer within [0, cap)', () => {
  for (let a = 0; a < 30; a++) {
    const d = backoffDelay(a, { baseMs: 500, maxMs: 15_000 });
    assert.ok(Number.isInteger(d) && d >= 0 && d < 15_000);
  }
});

// ---------- reconnect behaviour ----------

const fast = { baseMs: 10, maxMs: 40 };
const mk = (url, site, docId = 'doc1', reconnect = fast) => {
  const doc = new Document(site);
  const client = new SyncClient({ url, docId, document: doc, reconnect });
  return { doc, client };
};
const online = async (...ps) => { for (const p of ps) { p.client.connect(); await until(() => p.client.status === 'online'); } };

test('after the server restarts (all memory lost) clients reconnect by themselves and heal it', async () => {
  const s1 = await startSyncServer({ port: 0 });
  const port = s1.port;
  const url = `ws://127.0.0.1:${port}`;
  const a = mk(url, 'alice'), b = mk(url, 'bob');
  let s2;
  try {
    await online(a, b);
    a.doc.setText('hello');
    await until(() => b.doc.text === 'hello');

    await s1.close();                                              // outage: sockets die, server state is gone
    await until(() => a.client.status === 'disconnected' && b.client.status === 'disconnected');

    s2 = await startSyncServer({ port });                          // a brand-new, EMPTY server
    await until(() => a.client.status === 'online' && b.client.status === 'online');

    // the new server was rebuilt from what the clients re-sent
    await until(() => s2.rooms.get('doc1')?.doc.text === 'hello');
    assert.equal(a.client.attempt, 0);                             // backoff counter reset after success
  } finally {
    a.client.close(); b.client.close();
    await s2?.close();
  }
});

test('BOTH clients edit while offline (server down), then reconnect: both edits survive and converge', async () => {
  const s1 = await startSyncServer({ port: 0 });
  const port = s1.port;
  const url = `ws://127.0.0.1:${port}`;
  const a = mk(url, 'alice'), b = mk(url, 'bob');
  let s2;
  try {
    await online(a, b);
    a.doc.setText('hello');
    await until(() => b.doc.text === 'hello');

    await s1.close();
    await until(() => a.client.status === 'disconnected' && b.client.status === 'disconnected');

    a.doc.setText('hello world');       // offline edit 1
    b.doc.setText('Hello');             // offline edit 2 (concurrent)
    assert.notEqual(a.doc.text, b.doc.text);

    s2 = await startSyncServer({ port });
    await until(() => a.doc.text === b.doc.text && a.doc.text === 'Hello world', 4000);
    assert.equal(s2.rooms.get('doc1').doc.text, 'Hello world');
    assert.deepEqual(a.doc.version(), b.doc.version());
  } finally {
    a.client.close(); b.client.close();
    await s2?.close();
  }
});

test('a client started while the server is DOWN keeps retrying and connects once it is up', async () => {
  const probe = await startSyncServer({ port: 0 });
  const port = probe.port;
  await probe.close();                                             // nothing listens on this port now

  const a = mk(`ws://127.0.0.1:${port}`, 'alice');
  const retries = [];
  a.client.onRetry((r) => retries.push(r));
  a.doc.setText('typed before the server existed');
  a.client.connect();
  await until(() => retries.length >= 3);
  assert.equal(a.client.status, 'disconnected');
  assert.deepEqual(retries.map((r) => r.attempt).slice(0, 3), [0, 1, 2]);

  const s = await startSyncServer({ port });
  try {
    await until(() => a.client.status === 'online');
    await until(() => s.rooms.get('doc1')?.doc.text === 'typed before the server existed');
  } finally {
    a.client.close();
    await s.close();
  }
});

test('close() stops the retry loop for good', async () => {
  const probe = await startSyncServer({ port: 0 });
  const port = probe.port;
  await probe.close();

  const a = mk(`ws://127.0.0.1:${port}`, 'alice');
  let retries = 0;
  a.client.onRetry(() => retries++);
  a.client.connect();
  await until(() => retries >= 2);
  a.client.close();
  const seen = retries;
  await sleep(250);                                                // plenty of time for more retries
  assert.equal(retries, seen);
  assert.equal(a.client.status, 'disconnected');
});

test('retryNow() skips the backoff wait', async () => {
  const probe = await startSyncServer({ port: 0 });
  const port = probe.port;
  await probe.close();

  // a huge backoff: without retryNow() the next attempt would be seconds away
  const a = mk(`ws://127.0.0.1:${port}`, 'alice', 'doc1', { baseMs: 20_000, maxMs: 20_000, random: () => 0.99 });
  let scheduled = null;
  a.client.onRetry((r) => { scheduled ??= r; });
  a.client.connect();
  await until(() => scheduled !== null);
  assert.ok(scheduled.delayMs > 10_000);

  const s = await startSyncServer({ port });
  try {
    a.client.retryNow();
    await until(() => a.client.status === 'online', 1500);
  } finally {
    a.client.close();
    await s.close();
  }
});

test('disabling reconnect: a dropped connection stays dropped', async () => {
  const s = await startSyncServer({ port: 0 });
  const a = mk(`ws://127.0.0.1:${s.port}`, 'alice', 'doc1', { enabled: false });
  let retries = 0;
  a.client.onRetry(() => retries++);
  try {
    await online(a);
    for (const c of s.rooms.get('doc1').clients) c.terminate();
    await until(() => a.client.status === 'disconnected');
    await sleep(150);
    assert.equal(retries, 0);
    assert.equal(a.client.status, 'disconnected');
  } finally {
    a.client.close();
    await s.close();
  }
});