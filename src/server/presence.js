// Presence server: who is in a document, and where their cursor is. EPHEMERAL on purpose:
// nothing here is persisted, nothing enters the CRDT log, and a lost message is healed by the next one
// (every broadcast is the FULL roster, not a delta).
//
// Protocol (JSON), client -> server:
//   {type:'hello', docId, site, name, color}   first message, exactly once
//   {type:'cursor', start, end}                anchors as strings (char ids), or both null
// server -> client:
//   {type:'peers', peers:[{id, site, name, color, start, end}]}   everyone in the room EXCEPT the receiver
//
// Peers are keyed by CONNECTION (id), not by the claimed site, so a client cannot overwrite someone else's entry.
import { WebSocketServer, WebSocket } from 'ws';

const DOC_ID = /^[A-Za-z0-9_-]{1,64}$/;
const NAME = /^[\w .-]{1,24}$/;
const COLOR = /^#[0-9a-fA-F]{6}$/;
const ANCHOR = /^\S{1,100}$/;
const MAX_PEERS_PER_ROOM = 100;

export function createPresence({ throttleMs = 30, heartbeatMs = 15_000 } = {}) {
  const rooms = new Map(); // docId -> { clients: Set<ws>, timer }
  const wss = new WebSocketServer({ noServer: true, maxPayload: 1024 });
  let nextId = 0;
  let closed = false;

  const send = (ws, msg) => {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  };

  // coalesce: any number of changes inside one window cause ONE broadcast
  function schedule(room) {
    if (closed || room.timer) return;
    room.timer = setTimeout(() => {
      room.timer = null;
      broadcast(room);
    }, throttleMs);
  }

  function broadcast(room) {
    const joined = [...room.clients].filter((c) => c.hello);
    for (const client of joined) {
      const peers = joined
        .filter((p) => p !== client)
        .map((p) => ({ id: p.id, ...p.hello, start: p.cursor?.start ?? null, end: p.cursor?.end ?? null }));
      send(client, { type: 'peers', peers });
    }
  }

  function onHello(ws, msg) {
    const { docId, site, name, color } = msg;
    if (!DOC_ID.test(docId) || !DOC_ID.test(site) || !NAME.test(name) || !COLOR.test(color)) {
      throw new Error('bad hello');
    }
    let room = rooms.get(docId);
    if (!room) rooms.set(docId, (room = { clients: new Set(), timer: null }));
    if (room.clients.size >= MAX_PEERS_PER_ROOM) throw new Error('room full');
    ws.hello = { site, name, color };
    ws.room = room;
    room.clients.add(ws);
    schedule(room); // everyone (including the newcomer) gets a fresh roster
  }

  function onCursor(ws, msg) {
    const { start, end } = msg;
    if (start === null && end === null) {
      ws.cursor = null;
    } else if (typeof start === 'string' && typeof end === 'string' && ANCHOR.test(start) && ANCHOR.test(end)) {
      ws.cursor = { start, end };
    } else {
      throw new Error('bad cursor');
    }
    schedule(ws.room);
  }

  wss.on('connection', (ws) => {
    ws.id = String(++nextId);
    ws.isAlive = true;
    ws.hello = null;
    ws.cursor = null;
    ws.room = null;
    ws.on('pong', () => { ws.isAlive = true; });

    ws.on('message', (data, isBinary) => {
      try {
        if (isBinary) throw new Error('binary');
        const msg = JSON.parse(data.toString());
        if (msg?.type === 'hello' && !ws.hello) onHello(ws, msg);
        else if (msg?.type === 'cursor' && ws.hello) onCursor(ws, msg);
        else throw new Error('unexpected message');
      } catch {
        ws.close(1008, 'bad presence message'); // untrusted input: drop the connection, never crash
      }
    });

    ws.on('close', () => {
      const room = ws.room;
      if (!room) return;
      room.clients.delete(ws);
      if (room.clients.size === 0) {
        clearTimeout(room.timer);
        for (const [id, r] of rooms) if (r === room) rooms.delete(id);
      } else {
        schedule(room); // everyone else learns this peer left
      }
    });
    ws.on('error', () => ws.terminate());
  });

  // "online" means "answered a ping recently": a closed laptop never sends a close frame
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
    }
  }, heartbeatMs);

  return {
    rooms,
    handleUpgrade(req, socket, head) {
      wss.handleUpgrade(req, socket, head, (ws) => wss.emit('connection', ws, req));
    },
    async close() {
      closed = true;
      clearInterval(heartbeat);
      for (const room of rooms.values()) clearTimeout(room.timer);
      for (const ws of wss.clients) ws.terminate();
      await new Promise((resolve) => wss.close(resolve));
    },
  };
}