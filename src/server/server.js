// Sync server: a WebSocket hub that keeps ONE authoritative CRDT replica per document
// and relays ops between the clients of that document.
//
// The server is just another replica (a peer), NOT a transformer or a referee:
//   - it applies every op to its own Document (dedup + causal buffering come for free)
//   - it broadcasts each op exactly once (when it is first seen) to every OTHER client
//   - a client that joins later is caught up with opsSince(its version vector)
//
// State lives in memory only: restarting the server loses documents (persistence = later).
import http from 'node:http';
import { WebSocketServer, WebSocket } from 'ws';
import { Document } from '../doc/document.js';
import { parseMessage, encode, ProtocolError } from '../net/protocol.js';
import { serveStatic } from './static.js';

export async function startSyncServer({ port = 3000, heartbeatMs = 30_000 ,host = '172.20.66.128' } = {} /*Without = {}, calling it without arguments would cause an error because JavaScript cannot destructure undefined.*/ ) {
  const rooms = new Map(); // docId -> { doc: Document, clients: Set<WebSocket> }

  // plain HTTP server underneath: gives us /health now and static files for the browser on Day 7
  const httpServer = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200/*the request succeeded*/, { 'Content-Type': 'text/plain' });
      res.end('ok');
      return;
    }
    serveStatic(req,res).catch(() =>{
      res.writeHead(404); /*the requested route was not found.*/
      res.end();
    });
  });
  const wss = new WebSocketServer({ server: httpServer, maxPayload: 1024 * 1024 });

  const getRoom = (docId) => {
    if (!rooms.has(docId)) rooms.set(docId, { doc: new Document('server'), clients: new Set() });
    return rooms.get(docId);
  };

  const send = (ws, msg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(encode(msg));
  };

  const broadcast = (room, sender, msg) => {
    const frame = encode(msg); // serialise once, send to everyone
    for (const client of room.clients) {
      if (client !== sender && client.readyState === WebSocket.OPEN) client.send(frame);
    }
  };

  function handleJoin(ws, msg) {
    if (ws.room) throw new ProtocolError('already joined');
    const room = getRoom(msg.docId);
    ws.room = room;
    ws.site = msg.site;
    room.clients.add(ws);
    // anti-entropy on join: send only what this client is missing
    send(ws, { type: 'sync', ops: room.doc.opsSince(msg.version), version: room.doc.version() });
  }

  function handleOps(ws, msg) {
    if (!ws.room) throw new ProtocolError('join a document first');

    // a client may only send ITS OWN ops: otherwise anyone could forge edits as someone else
    for (const op of msg.ops) {
      if (op.site !== ws.site) {
        throw new ProtocolError('op.site does not match the joined site', { fatal: true });
      }
    }

    const fresh = [];
    for (const op of msg.ops) {
      const status = ws.room.doc.applyRemote(op); // 'applied' | 'buffered' | 'duplicate'
      if (status !== 'duplicate') fresh.push(op);  // duplicates were already broadcast once
    }
    if (fresh.length > 0) broadcast(ws.room, ws, { type: 'ops', ops: fresh });
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) throw new ProtocolError('binary frames are not supported');
        const msg = parseMessage(data.toString());
        if (msg.type === 'join') handleJoin(ws, msg);
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

  await new Promise((resolve) => httpServer.listen(port, '0.0.0.0', resolve));

  return {
    port: httpServer.address().port,
    rooms,
    async close() {
      clearInterval(heartbeat);
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
      await new Promise((resolve) => httpServer.close(resolve));
    },
  };
}