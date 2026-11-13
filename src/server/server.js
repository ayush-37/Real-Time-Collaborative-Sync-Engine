// Sync server: a WebSocket hub that keeps ONE authoritative CRDT replica per document
// and relays ops between the clients of that document.
//
// The server is just another replica (a peer), NOT a transformer or a referee:
//   - it applies every op to its own Document (dedup + causal buffering come for free)
//   - it broadcasts each op exactly once, at the moment it is APPLIED, to every client except the author
//   - a client that joins later is caught up with opsSince(its version vector)
//
// Day 9: with `dataDir` set, every applied op is also appended to a write-ahead log on disk, and a
// room is rebuilt from snapshot + WAL the first time someone asks for it. Without `dataDir` the
// server is memory-only like before.
import http from 'node:http';
import fs from 'node:fs/promises';
import { WebSocketServer, WebSocket } from 'ws';
import { Document } from '../doc/document.js';
import { parseMessage, encode, ProtocolError, MAX_OPS_PER_MESSAGE } from '../net/protocol.js';
import { serveStatic } from './static.js';
import { DocStorage } from './storage.js';
import { createPresence } from './presence.js';
import { buildMergeEvent, isDivergent, covers } from '../ai/merge-event.js';

const DOC_ID = /^[A-Za-z0-9_-]{1,64}$/;

export async function startSyncServer({
  port = 3000,
  heartbeatMs = 30_000,
  dataDir = null,         // folder for the logs; null = memory only
  snapshotEvery = 1000,   // compact when the WAL holds this many ops
  fsync = true,           // true = survive power loss; false = faster (tests)
  ai = null,
  presenceThrottleMs = 30,
} = {}) {
  if (dataDir) await fs.mkdir(dataDir, { recursive: true });

  const rooms = new Map();   // docId -> { doc, clients, outbox, storage }
  const loading = new Map(); // docId -> Promise<room>, so two joins never load the same doc twice

  // plain HTTP server underneath: /health plus the static files for the browser client
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }

    let url;
    try {
      url = new URL(req.url, 'http://localhost');
    } catch {
      res.writeHead(400);
      res.end();
      return;
    }
    // read-only: reports are produced by the server itself. The browser can never send text to the model.
    if (req.method === 'GET' && url.pathname === '/ai/reports') {
      const id = url.searchParams.get('doc') ?? '';
      const room = DOC_ID.test(id) ? rooms.get(id) : null; // never CREATES a room
      res.writeHead(200, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify({ enabled: Boolean(ai), reports: room ? room.aiReports : [] }));
      return;
    }

    serveStatic(req, res).catch(() => {
      res.writeHead(500);
      res.end();
    });
  });
    // two WebSocket endpoints on ONE http server, routed by path:
  //   /presence -> ephemeral presence channel;  anything else -> the document sync protocol
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 * 1024 });
  const presence = createPresence({ throttleMs: presenceThrottleMs, heartbeatMs });
  httpServer.on('upgrade', (req, socket, head) => {
    const { pathname } = new URL(req.url, 'http://localhost');
    if (pathname === '/presence') presence.handleUpgrade(req, socket, head);
    else wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
  });

  async function createRoom(docId) {
    const doc = new Document('server');
        const room = { doc, clients: new Set(), outbox: [], storage: null, aiReports: [], reportSeq: 0 };
    if (dataDir) {
      room.storage = new DocStorage(dataDir, docId, { fsync });
      const { ops, repaired } = await room.storage.load();
      for (const op of ops) doc.applyRemote(op); // replay BEFORE listening, so loaded ops are not re-appended
      if (repaired) console.warn(`[storage] ${docId}: dropped a torn record at the end of the WAL`);
    }
    // every op that ENTERS the server's log (directly, or released from the buffer) is queued here
    doc.onChange(({ op }) => room.outbox.push(op));
    return room;
  }

  const getRoom = async (docId) => {
    const existing = rooms.get(docId);
    if (existing) return existing;
    if (!loading.has(docId)) {
      loading.set(
        docId,
        createRoom(docId)
          .then((room) => {
            rooms.set(docId, room);
            return room;
          })
          .finally(() => loading.delete(docId)),
      );
    }
    return loading.get(docId);
  };

  const send = (ws, msg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encode(msg));
  };

  // fire-and-forget persistence: broadcasting does not wait for the disk (write-behind).
  // Authors still hold their own ops, so a crash in this window is repaired by Day 8's resend.
  const persist = (room, ops) => {
    if (!room.storage) return;
    room.storage.append(ops).catch((err) => console.error('[storage] append failed:', err.message));
    room.storage
      .maybeCompact(() => room.doc.log, snapshotEvery)
      ?.catch((err) => console.error('[storage] compaction failed:', err.message));
  };

  // Send everything applied since the last flush: one batched message per client,
  // never containing a client's own ops (it already has them).
  const flushOutbox = (room) => {
    const applied = room.outbox.splice(0);
    if (applied.length === 0) return;
    persist(room, applied);
    for (const client of room.clients) {
      const theirs = applied.filter((op) => op.site !== client.site);
      for (let i = 0; i < theirs.length; i += MAX_OPS_PER_MESSAGE) {
        send(client, { type: 'ops', ops: theirs.slice(i, i + MAX_OPS_PER_MESSAGE) });
      }
    }
  };

  // The reconnecting client re-sends its offline ops in a LATER message. Once the server has applied
  // everything the client claimed at join time, both sides' work is in the log: build the merge event once.

  function maybeFinishMerge(room, ws) {
    const pending = ws.aiReconnect;

    if (!pending) return;

    // Wait until the server has received all operations Alice had
    // when she originally joined.
    if (!covers(room.doc.version(), pending.localVersion)) return;

    // Clear first so this reconnect can trigger analysis only once.
    ws.aiReconnect = null;

    const event = buildMergeEvent(
      room.doc.log,
      pending.localVersion,
      pending.remoteVersion
    );

    if (!event) return;

    const report = {
      id: ++room.reportSeq,
      at: new Date().toISOString(),
      site: pending.site,
      status: 'pending',
      localAuthors: event.localAuthors,
      remoteAuthors: event.remoteAuthors,
    };

    room.aiReports.push(report);

    // AI runs asynchronously; normal editing and synchronization do not wait.
    ai.analyzeMerge(event)
      .then((result) => {
        Object.assign(report, result);
      })
      .catch((err) => {
        console.error('[ai] analysis failed:', err.message);
        Object.assign(report, {
          status: 'error',
          reason: 'the AI call failed',
        });
      });
  }

  async function handleJoin(ws, msg) {
    if (ws.room) {
      throw new ProtocolError('Client has already joined a document');
    }

    let room;
    try {
      room = await getRoom(msg.docId);
    } catch (err) {
      console.error(`Failed to load document ${msg.docId}:`, err);

      send(ws, {
        type: 'error',
        message: 'document unavailable'
      });

      ws.close(1011, 'document unavailable');
      return;
    }

    ws.room = room;
    ws.site = msg.site;

    room.clients.add(ws);

    // Capture the two versions before sending the sync response.
    // localVersion: operations the reconnecting client already has.
    // remoteVersion: operations the server has at this moment.
    const localVersion = { ...msg.version };
    const remoteVersion = room.doc.version();

    // Check whether the client and server have diverged.
    if (ai && isDivergent(localVersion, remoteVersion)) {
      ws.aiReconnect = {
        site: msg.site,
        localVersion,
        remoteVersion,
      };
    } else {
      ws.aiReconnect = null;
    }

    // Send the client all operations it is missing.
    send(ws, {
      type: 'sync',
      ops: room.doc.opsSince(localVersion),
      version: remoteVersion,
    });
  }


  function startAnalysis(room, site, event) {
    const report = {
      id: ++room.reportSeq, at: Date.now(), site, status: 'pending',
      localAuthors: event.localAuthors, remoteAuthors: event.remoteAuthors,
    };
    room.aiReports.push(report);
    if (room.aiReports.length > 20) room.aiReports.shift();
    ai.analyzeMerge(event) // asynchronous and NOT awaited: it never delays syncing
      .then((result) => Object.assign(report, result))
      .catch((err) => {
        console.error('[ai] analysis failed:', err.message);
        Object.assign(report, { status: 'error', reason: 'analysis failed' });
      });
  }
  
  function handleOps(ws, msg) {
    const room = ws.room;

    if (!room) {
      throw new ProtocolError('Join a document first');
    }

    for (const op of msg.ops) {
      if (op.site !== ws.site) {
        throw new ProtocolError(
          'Operation site mismatch',
          { fatal: true }
        );
      }
    }

    for (const op of msg.ops) {
      room.doc.applyRemote(op);
    }

    flushOutbox(room);
    maybeFinishMerge(room, ws);
  }


  async function handleMessage(ws, data, isBinary) {
    try {
      if (isBinary) throw new ProtocolError('binary frames are not supported');
      const msg = parseMessage(data.toString());
      if (msg.type === 'join') await handleJoin(ws, msg);
      else if (msg.type === 'ops') handleOps(ws, msg);
      else throw new ProtocolError(`clients may not send "${msg.type}"`);
    } catch (err) {
      if (err instanceof ProtocolError) {
        send(ws, { type: 'error', message: err.message });
        if (err.fatal) ws.close(1008, 'policy violation');
      } else {
        console.error('unexpected server error:', err); // a bug on OUR side: never crash the server
        send(ws, { type: 'error', message: 'internal error' });
      }
    }
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    // join is async now (it may read the disk), so messages of ONE socket are processed strictly
    // one after another. Otherwise an 'ops' message sent right behind 'join' would overtake it.
    ws.queue = Promise.resolve();
    ws.on('message', (data, isBinary) => {
      ws.queue = ws.queue.then(() => handleMessage(ws, data, isBinary)); // handleMessage never rejects
    });

    ws.on('close', () => { ws.room?.clients.delete(ws); });
    ws.on('error', () => ws.terminate());
  });

  // heartbeat: a half-open TCP connection (laptop lid shut, wifi gone) never fires 'close'.
  // ping every interval; a client that did not answer the previous ping is terminated.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatMs);

  await new Promise((resolve) => httpServer.listen(port, resolve));

  return {
    port: httpServer.address().port,
    rooms,
    presence,
    async close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await presence.close();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => httpServer.close(resolve));
      // graceful shutdown: let every queued disk write finish
      await Promise.all([...rooms.values()].map((room) => room.storage?.flush()));
    },
  };
}