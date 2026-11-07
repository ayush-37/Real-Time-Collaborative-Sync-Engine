import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { startSyncServer } from '../src/server/server.js';
import { Document } from '../src/doc/document.js';
import { SyncClient } from '../src/client/sync-client.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 2000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await sleep(2);
  }
};

async function withServer(body) {
  const server = await startSyncServer({ port: 0 });
  const url = `ws://127.0.0.1:${server.port}`;
  const clients = [];
  const make = (site, docId = 'doc1') => {
    const doc = new Document(site);
    const client = new SyncClient({ url, docId, document: doc }); // uses the global WebSocket, like a browser
    clients.push(client);
    return { doc, client };
  };
  try { await body({ make, url, server }); } finally {
    clients.forEach((c) => c.close());
    await server.close();
  }
}
const online = async (...pairs) => { for (const p of pairs) { p.client.connect(); await until(() => p.client.status === 'online'); } };

test('status goes disconnected -> connecting -> syncing -> online -> disconnected', async () => {
  await withServer(async ({ make }) => {
    const a = make('alice');
    const seen = [a.client.status];
    a.client.onStatus((s) => seen.push(s));
    a.client.connect();
    await until(() => a.client.status === 'online');
    a.client.close();
    await until(() => a.client.status === 'disconnected');
    assert.deepEqual(seen, ['disconnected', 'connecting', 'syncing', 'online', 'disconnected']);
  });
});

test('typing in one client appears in the other, and every edit lands in well under a second', async () => {
  await withServer(async ({ make }) => {
    const a = make('alice'), b = make('bob');
    await online(a, b);

    const latencies = [];
    let text = '';
    for (const ch of 'collaborate') {
      text += ch;
      const t0 = performance.now();
      a.doc.setText(text);
      await until(() => b.doc.text === text, 1000);
      latencies.push(performance.now() - t0);
    }
    const worst = Math.max(...latencies);
    assert.ok(worst < 500, `slowest edit took ${worst.toFixed(1)}ms`);
    console.log(`      latency over ${latencies.length} edits: avg ${(latencies.reduce((x, y) => x + y) / latencies.length).toFixed(1)}ms, worst ${worst.toFixed(1)}ms`);
  });
});

test('edits typed BEFORE connecting are delivered once the client joins', async () => {
  await withServer(async ({ make }) => {
    const a = make('alice'), b = make('bob');
    a.doc.setText('typed while offline');       // no connection yet
    await online(b);
    assert.equal(b.doc.text, '');
    await online(a);                            // join -> sync -> resend own ops
    await until(() => b.doc.text === 'typed while offline');
  });
});

test('a late joiner receives the whole history, including deletes', async () => {
  await withServer(async ({ make }) => {
    const a = make('alice');
    await online(a);
    a.doc.setText('hello world');
    a.doc.setText('hello');
    await sleep(50);

    const late = make('carol');
    await online(late);
    assert.equal(late.doc.text, 'hello');
    assert.deepEqual(late.doc.version(), { alice: a.doc.version().alice });
  });
});

test('concurrent edits from two clients converge through the server', async () => {
  await withServer(async ({ make }) => {
    const a = make('alice'), b = make('bob');
    await online(a, b);
    a.doc.setText('hello');
    await until(() => b.doc.text === 'hello');

    a.doc.setText('hello world');   // both edit before hearing from each other
    b.doc.setText('Hello');
    await until(() => a.doc.text === b.doc.text && a.doc.text === 'Hello world');
    assert.deepEqual(a.doc.version(), b.doc.version());
  });
});

test('three clients, interleaved random typing: all converge', async () => {
  await withServer(async ({ make }) => {
    const cs = [make('alice'), make('bob'), make('carol')];
    await online(...cs);
    for (let round = 0; round < 15; round++) {
      for (const c of cs) {
        const t = c.doc.text;
        const i = Math.floor(Math.random() * (t.length + 1));
        c.doc.setText(Math.random() < 0.3 && t.length ? t.slice(0, i) + t.slice(i + 1) : t.slice(0, i) + 'abc'[round % 3] + t.slice(i));
      }
      await sleep(Math.random() * 5);
    }
    await until(() => cs.every((c) => c.doc.text === cs[0].doc.text) && cs.every((c) => c.doc.pendingCount === 0), 3000);
    assert.deepEqual(cs[0].doc.version(), cs[1].doc.version());
    assert.deepEqual(cs[1].doc.version(), cs[2].doc.version());
  });
});

test('a backlog bigger than one message (5000 ops) is split into chunks and still arrives', async () => {
  await withServer(async ({ make }) => {
    const a = make('alice'), b = make('bob');
    a.doc.insertText(0, 'x'.repeat(5300));    // typed offline: 5300 ops
    await online(b);
    await online(a);
    await until(() => b.doc.length === 5300, 4000);
  });
});

test('after close(), local edits stay in the log (nothing is lost, nothing is sent)', async () => {
  await withServer(async ({ make }) => {
    const a = make('alice'), b = make('bob');
    await online(a, b);
    a.client.close();
    await until(() => a.client.status === 'disconnected');

    a.doc.setText('offline edit');
    await sleep(60);
    assert.equal(b.doc.text, '');
    assert.equal(a.doc.log.length, 12);
  });
});

test('garbage from the server is reported through onError and does not break the client', async () => {
  const wss = new WebSocketServer({ port: 0 });
  await new Promise((r) => wss.on('listening', r));
  wss.on('connection', (ws) => {
    ws.send('{{{ garbage');
    ws.send(JSON.stringify({ type: 'sync', ops: [{ type: 'delete' }], version: {} })); // invalid op
    ws.send(JSON.stringify({ type: 'sync', ops: [], version: {} }));                    // valid
  });
  try {
    const doc = new Document('alice');
    const client = new SyncClient({ url: `ws://127.0.0.1:${wss.address().port}`, docId: 'd', document: doc });
    const errors = [];
    client.onError((e) => errors.push(e.message));
    client.connect();
    await until(() => client.status === 'online');
    assert.equal(errors.length, 2);
    client.close();
  } finally {
    wss.clients.forEach((c) => c.terminate());
    await new Promise((r) => wss.close(r));
  }
});

test('WHY every page load needs a NEW site id: reusing one with a reset counter silently diverges', async () => {
  await withServer(async ({ make }) => {
    const first = make('alice');
    await online(first);
    first.doc.setText('abc');
    await sleep(60);
    first.client.close();

    // "page reload" that wrongly keeps the same site id: a fresh Document, seq restarts at 1
    const reloaded = make('alice');
    reloaded.doc.setText('xyz');
    await online(reloaded);
    await sleep(150);

    // the server already has (alice, 1..3), so the new ops look like duplicates and are dropped,
    // and the old ones look like duplicates to the reloaded replica. They never converge.
    const watcher = make('bob');
    await online(watcher);
    assert.equal(watcher.doc.text, 'abc');
    assert.equal(reloaded.doc.text, 'xyz');
    assert.notEqual(watcher.doc.text, reloaded.doc.text);
  });
});