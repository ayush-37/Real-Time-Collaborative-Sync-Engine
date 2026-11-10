import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { startSyncServer } from '../src/server/server.js';
import { DocStorage } from '../src/server/storage.js';
import { Document } from '../src/doc/document.js';
import { SyncClient } from '../src/client/sync-client.js';
import { encode } from '../src/net/protocol.js';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const until = async (fn, ms = 3000) => {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error('timed out waiting for condition');
    await sleep(2);
  }
};
const tmpDir = () => fs.mkdtemp(path.join(os.tmpdir(), 'sync-'));
const rm = (dir) => fs.rm(dir, { recursive: true, force: true });

// connect a client, wait until it is fully synced, run fn, disconnect
async function withClient(port, site, fn) {
  const doc = new Document(site);
  const client = new SyncClient({
    url: `ws://127.0.0.1:${port}`, docId: 'doc1', document: doc, reconnect: { enabled: false },
  });
  client.connect();
  await until(() => client.status === 'online');
  try {
    return await fn(doc);
  } finally {
    client.close();
  }
}

// a bare WebSocket (no SyncClient) so a test can send raw messages
async function rawJoin(port, docId, site) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`);
  const got = [];
  ws.addEventListener('message', (e) => got.push(JSON.parse(e.data)));
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  ws.send(encode({ type: 'join', docId, site, version: new Document(site).version() }));
  return { ws, got };
}

const start = (dir, extra = {}) => startSyncServer({ port: 0, dataDir: dir, fsync: false, ...extra });

// ---------- the gap Day 8 left open ----------

test('a restarted server still has the document even though its author is long gone', async () => {
  const dir = await tmpDir();
  try {
    const s1 = await start(dir);
    await withClient(s1.port, 'alice', async (doc) => {
      doc.setText('hello durable world');
      await until(() => s1.rooms.get('doc1')?.doc.text === 'hello durable world');
    });
    await s1.close(); // alice is gone AND the server's memory is gone

    const s2 = await start(dir);
    try {
      await withClient(s2.port, 'bob', async (doc) => {
        assert.equal(doc.text, 'hello durable world');
      });
    } finally {
      await s2.close();
    }
  } finally {
    await rm(dir);
  }
});

test('restarting several times never duplicates anything on disk (loaded ops are not re-appended)', async () => {
  const dir = await tmpDir();
  try {
    const run = async (site, fn) => {
      const s = await start(dir);
      try {
        await withClient(s.port, site, (doc) => fn(doc, s));
      } finally {
        await s.close();
      }
    };
    await run('alice', async (doc, s) => {
      doc.setText('abc');
      await until(() => s.rooms.get('doc1')?.doc.text === 'abc');
    });
    await run('bob', async (doc, s) => {
      assert.equal(doc.text, 'abc');
      doc.setText('abcdef');
      await until(() => s.rooms.get('doc1').doc.text === 'abcdef');
    });
    await run('carol', async (doc) => assert.equal(doc.text, 'abcdef'));

    const wal = await fs.readFile(path.join(dir, 'doc1.wal'), 'utf8');
    assert.equal(wal.trim().split('\n').length, 6); // 3 + 3 ops, nothing twice
  } finally {
    await rm(dir);
  }
});

// ---------- crash damage ----------

test('a torn last line (crash mid-write) is dropped and repaired; earlier ops survive', async () => {
  const dir = await tmpDir();
  try {
    const st = new DocStorage(dir, 'doc1', { fsync: false });
    await st.append(new Document('alice').insertText(0, 'abc'));
    await st.flush();
    const walPath = path.join(dir, 'doc1.wal');
    await fs.appendFile(walPath, '{"type":"insert","ch":"d","id":{"cl'); // power cut mid-write

    const { ops, repaired } = await new DocStorage(dir, 'doc1').load();
    assert.equal(ops.length, 3);
    assert.equal(repaired, true);
    const raw = await fs.readFile(walPath, 'utf8');
    assert.ok(raw.endsWith('\n'));                 // repaired: the next append starts on a clean line
    assert.equal(raw.split('\n').length, 4);
  } finally {
    await rm(dir);
  }
});

test('corruption in the MIDDLE of the WAL is not silently skipped: loading throws, the server refuses the doc', async () => {
  const dir = await tmpDir();
  try {
    const good = new Document('alice').insertText(0, 'ab').map((op) => JSON.stringify(op));
    await fs.writeFile(path.join(dir, 'doc1.wal'), ['garbage', ...good].join('\n') + '\n');
    await assert.rejects(() => new DocStorage(dir, 'doc1').load(), /corrupt WAL/);

    const s = await start(dir);
    const origError = console.error;
    console.error = () => {}; // the server logs this on purpose
    try {
      const { ws, got } = await rawJoin(s.port, 'doc1', 'alice');
      await until(() => got.some((m) => m.type === 'error'));
      assert.equal(got.find((m) => m.type === 'error').message, 'document unavailable');
      ws.close();
    } finally {
      console.error = origError;
      await s.close();
    }
  } finally {
    await rm(dir);
  }
});

// ---------- snapshots ----------

test('crash between snapshot rename and WAL truncate: ops are in BOTH files and that is harmless', async () => {
  const dir = await tmpDir();
  try {
    const st = new DocStorage(dir, 'doc1', { fsync: false });
    const doc = new Document('alice');
    doc.insertText(0, 'hello');
    doc.deleteRange(0, 1);
    await st.append(doc.log);
    await st.compact(() => doc.log);
    assert.equal((await fs.stat(path.join(dir, 'doc1.wal'))).size, 0);   // WAL emptied
    await fs.stat(path.join(dir, 'doc1.snap.json'));                     // snapshot exists

    // simulate the crash: the WAL still holds everything the snapshot holds
    await fs.appendFile(path.join(dir, 'doc1.wal'), doc.log.map((o) => JSON.stringify(o)).join('\n') + '\n');

    const { ops } = await new DocStorage(dir, 'doc1').load();
    assert.equal(ops.length, doc.log.length * 2);                         // loaded twice...
    const rebuilt = new Document('server');
    ops.forEach((op) => rebuilt.applyRemote(op));
    assert.equal(rebuilt.text, doc.text);                                 // ...but replay is idempotent
    assert.equal(rebuilt.log.length, doc.log.length);
  } finally {
    await rm(dir);
  }
});

test('the server compacts by itself once the WAL is long, and a restart still sees everything', async () => {
  const dir = await tmpDir();
  try {
    const s1 = await start(dir, { snapshotEvery: 20 });
    try {
      await withClient(s1.port, 'alice', async (doc) => {
        for (let i = 1; i <= 10; i++) {
          doc.setText('x'.repeat(i * 5)); // 5 new ops per batch, 50 in total
          await sleep(10);
        }
        await until(() => s1.rooms.get('doc1').doc.text.length === 50);
      });
    } finally {
      await s1.close();
    }
    await assert.doesNotReject(fs.stat(path.join(dir, 'doc1.snap.json')));

    const s2 = await start(dir);
    try {
      await withClient(s2.port, 'bob', async (doc) => assert.equal(doc.text, 'x'.repeat(50)));
    } finally {
      await s2.close();
    }
  } finally {
    await rm(dir);
  }
});

// ---------- the async bugs ----------

test('ops sent right behind the join are not rejected while the room is still loading from disk', async () => {
  const dir = await tmpDir();
  try {
    const st = new DocStorage(dir, 'doc1', { fsync: false });
    await st.append(new Document('zed').insertText(0, 'x'.repeat(2000))); // make loading take a moment
    await st.flush();

    const s = await start(dir);
    try {
      const alice = new Document('alice');
      const { ws, got } = await rawJoin(s.port, 'doc1', 'alice');
      ws.send(encode({ type: 'ops', ops: alice.insertText(0, 'hi') })); // immediately behind the join
      await until(() => s.rooms.get('doc1')?.doc.log.length === 2002);
      assert.deepEqual(got.filter((m) => m.type === 'error'), []);
      ws.close();
    } finally {
      await s.close();
    }
  } finally {
    await rm(dir);
  }
});

test('a document id that would escape the data folder is rejected', async () => {
  const dir = await tmpDir();
  try {
    assert.throws(() => new DocStorage(dir, '../evil'), /unsafe/);
    assert.throws(() => new DocStorage(dir, 'a/b'), /unsafe/);
  } finally {
    await rm(dir);
  }
});