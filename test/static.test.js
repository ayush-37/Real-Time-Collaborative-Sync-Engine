import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startSyncServer } from '../src/server/server.js';

async function withServer(body) {
  const server = await startSyncServer({ port: 0 });
  try { await body(`http://127.0.0.1:${server.port}`, server.port); } finally { await server.close(); }
}

// fetch() normalises '..' for us, so to test REAL traversal attempts we send the raw request path
function rawGet(port, rawPath) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: rawPath, method: 'GET' }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

test('/ serves the editor page as HTML', async () => {
  await withServer(async (base) => {
    const res = await fetch(`${base}/`);
    assert.equal(res.status, 200);
    assert.match(res.headers.get('content-type'), /text\/html/);
    assert.match(await res.text(), /<textarea id="editor"/);
  });
});

test('shared CRDT modules are served as JavaScript', async () => {
  await withServer(async (base) => {
    for (const p of ['/app.js', '/src/doc/document.js', '/src/crdt/rga.js', '/src/net/protocol.js', '/src/client/sync-client.js']) {
      const res = await fetch(base + p);
      assert.equal(res.status, 200, p);
      assert.match(res.headers.get('content-type'), /text\/javascript/, p);
      assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    }
  });
});

test('server-only code, config and other files are NOT served', async () => {
  await withServer(async (base) => {
    for (const p of ['/src/server/server.js', '/src/server/static.js', '/package.json', '/node_modules/ws/package.json', '/test/server.test.js']) {
      assert.equal((await fetch(base + p)).status, 404, p);
    }
  });
});

test('path traversal attempts are refused', async () => {
  await withServer(async (_base, port) => {
    const attempts = [
      '/src/crdt/../server/server.js',
      '/src/crdt/..%2Fserver/server.js',
      '/src/crdt/%2e%2e/server/server.js',
      '/..%2F..%2Fpackage.json',
      '/%2e%2e/%2e%2e/etc/passwd',
      '/src/crdt/rga.js%00.js',
      '/src/%5c..%5cserver%5cserver.js',
    ];
    for (const p of attempts) {
      const status = await rawGet(port, p);
      assert.ok(status === 404 || status === 400, `${p} -> ${status}`);
    }
  });
});

test('only GET and HEAD are allowed', async () => {
  await withServer(async (base) => {
    assert.equal((await fetch(`${base}/`, { method: 'POST', body: 'x' })).status, 405);
    assert.equal((await fetch(`${base}/`, { method: 'HEAD' })).status, 200);
  });
});

test('every import in the browser code resolves (no broken or Node-only imports)', async () => {
  await withServer(async (base) => {
    const seen = new Set();
    const queue = ['/app.js'];
    while (queue.length) {
      const p = queue.pop();
      if (seen.has(p)) continue;
      seen.add(p);
      const res = await fetch(base + p);
      assert.equal(res.status, 200, `cannot load ${p}`);
      const code = await res.text();
      for (const m of code.matchAll(/^\s*import\s[^'"]*['"]([^'"]+)['"]/gm)) {
        const spec = m[1];
        assert.ok(spec.startsWith('/') || spec.startsWith('.'), `${p} imports bare specifier "${spec}" (browsers cannot resolve it)`);
        queue.push(new URL(spec, `http://x${p}`).pathname);
      }
    }
    for (const required of ['/app.js', '/src/doc/document.js', '/src/crdt/rga.js', '/src/crdt/lamport.js',
                            '/src/crdt/charId.js', '/src/net/protocol.js', '/src/client/sync-client.js']) {
      assert.ok(seen.has(required), `module graph is missing ${required}`);
    }
  });
});