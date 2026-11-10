import test from 'node:test';
import assert from 'node:assert/strict';
import WebSocket from 'ws';
import { startSyncServer } from '../src/server/server.js';
import { Document } from '../src/doc/document.js';

// ---------- helpers ----------
const until = async (fn, ms = 1500) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await new Promise((r) => setTimeout(r, 5));
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function connect(port, onMessage) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    const inbox = [];
    ws.on('message', (d) => {
      const msg = JSON.parse(d.toString());
      inbox.push(msg);
      onMessage?.(msg);
    });
    ws.on('open', () => resolve({
      ws, inbox,
      send: (m) => ws.send(JSON.stringify(m)),
      sendRaw: (s) => ws.send(s),
      ofType: (t) => inbox.filter((m) => m.type === t),
    }));
    ws.on('error', reject);
  });
}

// create server, run body, always shut down
async function withServer(body, opts) {
  const server = await startSyncServer({ port: 0, ...opts });
  const clients = [];
  const open = async (onMessage) => { const c = await connect(server.port, onMessage); clients.push(c); return c; };
  try {
    await body({ server, open });
  } finally {
    clients.forEach((c) => c.ws.terminate());
    await server.close();
  }
}

const join = (c, docId, site, version = {}) => c.send({ type: 'join', docId, site, version });

// ---------- tests ----------

test('health endpoint answers over plain HTTP', async () => {
  await withServer(async ({ server }) => {
    const res = await fetch(`http://127.0.0.1:${server.port}/health`);
    assert.equal(res.status, 200);
    assert.equal(await res.text(), 'ok');
  });
});

test('join gets an (empty) sync message first', async () => {
  await withServer(async ({ open }) => {
    const a = await open();
    join(a, 'doc1', 'alice');
    await until(() => a.ofType('sync').length === 1);
    assert.deepEqual(a.ofType('sync')[0].ops, []);
  });
});

test('ops from one client reach the other, and are NOT echoed back to the sender', async () => {
  await withServer(async ({ open }) => {
    const [a, b] = [await open(), await open()];
    join(a, 'doc1', 'alice'); join(b, 'doc1', 'bob');
    await until(() => a.ofType('sync').length && b.ofType('sync').length);

    const alice = new Document('alice');
    const ops = alice.insertText(0, 'hi');
    a.send({ type: 'ops', ops });

    await until(() => b.ofType('ops').length === 1);
    assert.equal(b.ofType('ops')[0].ops.length, 2);
    await sleep(50);
    assert.equal(a.ofType('ops').length, 0); // sender got nothing back
  });
});

test('documents are isolated: other rooms never see the ops', async () => {
  await withServer(async ({ open }) => {
    const [a, b, c] = [await open(), await open(), await open()];
    join(a, 'docA', 'alice'); join(b, 'docA', 'bob'); join(c, 'docB', 'carol');
    await until(() => [a, b, c].every((x) => x.ofType('sync').length));

    a.send({ type: 'ops', ops: new Document('alice').insertText(0, 'x') });
    await until(() => b.ofType('ops').length === 1);
    await sleep(50);
    assert.equal(c.ofType('ops').length, 0);
  });
});

test('late joiner is caught up with the full history', async () => {
  await withServer(async ({ open }) => {
    const a = await open();
    join(a, 'doc1', 'alice');
    await until(() => a.ofType('sync').length);
    const alice = new Document('alice');
    a.send({ type: 'ops', ops: [...alice.insertText(0, 'hello'), ...alice.deleteRange(0, 1)] });
    await sleep(50);

    const late = await open();
    join(late, 'doc1', 'bob');
    await until(() => late.ofType('sync').length);
    const catchUp = late.ofType('sync')[0];
    assert.equal(catchUp.ops.length, 6);

    const bob = new Document('bob');
    catchUp.ops.forEach((op) => bob.applyRemote(op));
    assert.equal(bob.text, 'ello');
  });
});

test('join with a version vector gets only the missing ops', async () => {
  await withServer(async ({ open }) => {
    const a = await open();
    join(a, 'doc1', 'alice');
    await until(() => a.ofType('sync').length);
    a.send({ type: 'ops', ops: new Document('alice').insertText(0, 'abcde') });
    await sleep(50);

    const b = await open();
    join(b, 'doc1', 'bob', { alice: 3 });   // "I already have alice's ops 1..3"
    await until(() => b.ofType('sync').length);
    assert.deepEqual(b.ofType('sync')[0].ops.map((o) => o.seq), [4, 5]);
  });
});

test('a duplicate op (client retry) is not broadcast a second time', async () => {
  await withServer(async ({ open }) => {
    const [a, b] = [await open(), await open()];
    join(a, 'doc1', 'alice'); join(b, 'doc1', 'bob');
    await until(() => a.ofType('sync').length && b.ofType('sync').length);

    const ops = new Document('alice').insertText(0, 'x');
    a.send({ type: 'ops', ops });
    a.send({ type: 'ops', ops });   // retry
    a.send({ type: 'ops', ops });   // retry again
    await until(() => b.ofType('ops').length >= 1);
    await sleep(80);
    assert.equal(b.ofType('ops').length, 1);
  });
});

test('forged ops (site != joined site) are rejected and the socket is closed with 1008', async () => {
  await withServer(async ({ open }) => {
    const [a, b] = [await open(), await open()];
    join(a, 'doc1', 'alice'); join(b, 'doc1', 'bob');
    await until(() => a.ofType('sync').length && b.ofType('sync').length);

    const closed = new Promise((resolve) => a.ws.on('close', (code) => resolve(code)));
    a.send({ type: 'ops', ops: new Document('mallory').insertText(0, 'x') }); // claims to be mallory
    const code = await Promise.race([closed, sleep(1000).then(() => 'socket was NOT closed')]);
    assert.equal(code, 1008);
    assert.ok(a.ofType('error').length >= 1);
    await sleep(50);
    assert.equal(b.ofType('ops').length, 0);
  });
});

test('ops before join, malformed JSON and unknown types give an error but keep the server alive', async () => {
  await withServer(async ({ open }) => {
    const a = await open();
    a.send({ type: 'ops', ops: [] });                     // not joined yet
    a.sendRaw('{{{ not json');
    a.send({ type: 'teleport' });
    await until(() => a.ofType('error').length === 3);

    join(a, 'doc1', 'alice');                              // the same socket still works
    await until(() => a.ofType('sync').length === 1);
  });
});

test('a client cannot join twice', async () => {
  await withServer(async ({ open }) => {
    const a = await open();
    join(a, 'doc1', 'alice'); join(a, 'doc2', 'alice');
    await until(() => a.ofType('error').length === 1);
    assert.match(a.ofType('error')[0].message, /already joined/);
  });
});

test('a hostile delete of ROOT is rejected by validation (cannot crash the server)', async () => {
  await withServer(async ({ open }) => {
    const a = await open();
    join(a, 'doc1', 'alice');
    await until(() => a.ofType('sync').length);
    a.send({ type: 'ops', ops: [{ type: 'delete', targetId: { clock: 0, site: 'ROOT' }, site: 'alice', seq: 1 }] });
    await until(() => a.ofType('error').length === 1);
    a.send({ type: 'ops', ops: new Document('alice').insertText(0, 'ok') }); // still serving
    await sleep(50);
    assert.equal(a.ws.readyState, WebSocket.OPEN);
  });
});

test('propagation is sub-second: 200 ops reach the other client in well under 1s', async () => {
  await withServer(async ({ open }) => {
    const [a, b] = [await open(), await open()];
    join(a, 'doc1', 'alice'); join(b, 'doc1', 'bob');
    await until(() => a.ofType('sync').length && b.ofType('sync').length);

    const alice = new Document('alice');
    const t0 = performance.now();
    alice.insertText(0, 'x'.repeat(200)).forEach((op) => a.send({ type: 'ops', ops: [op] })); // one op per frame, like keystrokes
    await until(() => b.ofType('ops').reduce((n, m) => n + m.ops.length, 0) === 200, 1000);
    const ms = performance.now() - t0;
    assert.ok(ms < 1000, `took ${ms.toFixed(0)}ms`);
  });
});

test('a client that never answers pings is terminated by the heartbeat', async () => {
  await withServer(async ({ server }) => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.port}`, { autoPong: false }); // "dead" client
    await new Promise((r) => ws.on('open', r));
    const closed = new Promise((r) => ws.on('close', r));
    await Promise.race([closed, sleep(1000).then(() => { throw new Error('heartbeat did not kill it'); })]);
  }, { heartbeatMs: 60 });
});

test('REGRESSION: an op parked in the server buffer is still delivered to a client that joined meanwhile', async () => {
  await withServer(async ({ open }) => {
    // alice's two chars, and bob's op that DEPENDS on alice's second char
    const alice = new Document('alice');
    const aOps = alice.insertText(0, 'ab');
    const bobDoc = new Document('bob');
    aOps.forEach((op) => bobDoc.applyRemote(op));
    const [bOp] = bobDoc.insertText(2, 'c');           // its parent is alice's 'b'

    const bob = await open();
    join(bob, 'doc1', 'bob');
    await until(() => bob.ofType('sync').length === 1);
    bob.send({ type: 'ops', ops: [bOp] });             // the server lacks alice's chars -> parks it
    await sleep(50);

    const a = await open();
    join(a, 'doc1', 'alice');                          // alice joins while bob's op is parked
    await until(() => a.ofType('sync').length === 1);
    assert.equal(a.ofType('sync')[0].ops.length, 0);   // parked ops are not in the log, so not in the catch-up

    a.send({ type: 'ops', ops: aOps });                // alice's ops arrive -> the server releases bob's op
    await until(() => a.ofType('ops').length >= 1);
    assert.deepEqual(a.ofType('ops').flatMap((m) => m.ops).map((o) => `${o.site}:${o.seq}`), ['bob:1']);
    await until(() => bob.ofType('ops').flatMap((m) => m.ops).length === 2);   // bob gets alice's 2 ops
  });
});

test('END TO END: two Documents wired through the server converge, including concurrent edits', async () => {
  await withServer(async ({ open }) => {
    const alice = new Document('alice');
    const bob = new Document('bob');

    const wire = async (doc) => {
      const c = await open((msg) => {
        if (msg.type === 'ops' || msg.type === 'sync') msg.ops.forEach((op) => doc.applyRemote(op));
      });
      doc.onChange((e) => { if (e.source === 'local') c.send({ type: 'ops', ops: [e.op] }); });
      join(c, 'shared', doc.site, doc.version());
      await until(() => c.ofType('sync').length === 1);
      return c;
    };
    await wire(alice);
    await wire(bob);

    alice.setText('hello');
    await until(() => bob.text === 'hello');

    // concurrent: both edit before hearing from each other
    alice.setText('hello world');
    bob.setText('Hello');
    await until(() => alice.text === bob.text && alice.text.length > 0 && alice.pendingCount === 0 && bob.pendingCount === 0);
    assert.equal(alice.text, 'Hello world');
    assert.deepEqual(alice.version(), bob.version());
  });
});