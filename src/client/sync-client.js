// SyncClient: connects ONE local Document to the sync server over a WebSocket.
// Works in the browser and in Node 22+ (both have a global WebSocket with the same API).
//
//   local edit  -> Document emits a local op -> batched into one 'ops' message -> server
//   server msg  -> validated -> remote ops applied to the Document (buffer/dedup inside)
//   on 'sync'   -> also RE-SEND our own ops the server lacks (typed while offline / lost in flight)
//
// status: 'disconnected' -> 'connecting' -> 'syncing' (joined, waiting for catch-up) -> 'online'
import { parseMessage, encode, MAX_OPS_PER_MESSAGE } from '../net/protocol.js';

export class SyncClient {
  #url;
  #docId;
  #doc;
  #WS;
  #ws = null;
  #status = 'disconnected';
  #outbox = [];
  #flushScheduled = false;
  #statusListeners = new Set();
  #errorListeners = new Set();

  constructor({ url, docId, document, WebSocketImpl = globalThis.WebSocket }) {
    this.#url = url;
    this.#docId = docId;
    this.#doc = document;
    this.#WS = WebSocketImpl;

    // every LOCAL op goes to the server; remote ops are ignored here (no echo loops)
    this.#doc.onChange(({ source, op }) => {
      if (source === 'local') this.#enqueue(op);
    });
  }

  get status() { return this.#status; }

  onStatus(fn) { this.#statusListeners.add(fn); return () => this.#statusListeners.delete(fn); }
  onError(fn) { this.#errorListeners.add(fn); return () => this.#errorListeners.delete(fn); }

  connect() {
    if (this.#ws) return;
    this.#setStatus('connecting');
    const ws = new this.#WS(this.#url);
    this.#ws = ws;

    ws.addEventListener('open', () => {
      // tell the server who we are and exactly which ops we already have
      ws.send(encode({
        type: 'join',
        docId: this.#docId,
        site: this.#doc.site,
        version: this.#doc.version(),
      }));
      this.#setStatus('syncing');
    });
    ws.addEventListener('message', (event) => this.#onMessage(event.data));
    ws.addEventListener('close', () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#outbox.length = 0; // anything unsent is still in the Document's log
      this.#setStatus('disconnected');
    });
    ws.addEventListener('error', () => { /* a 'close' event always follows */ });
  }

  close() {
    this.#ws?.close();
  }

  // ---------- incoming ----------
  #onMessage(data) {
    let msg;
    try {
      msg = parseMessage(typeof data === 'string' ? data : String(data)); // never trust the server blindly either
    } catch (err) {
      this.#emitError(err);
      return;
    }

    if (msg.type === 'ops') {
      msg.ops.forEach((op) => this.#doc.applyRemote(op));
    } else if (msg.type === 'sync') {
      msg.ops.forEach((op) => this.#doc.applyRemote(op));
      this.#resendOwnOps(msg.version);
      this.#setStatus('online');
    } else if (msg.type === 'error') {
      this.#emitError(new Error(`server: ${msg.message}`));
    }
  }

  // The server told us its version vector. Anything of OURS above it never arrived
  // (typed before connecting, or in flight when a connection died): send it now.
  #resendOwnOps(serverVersion) {
    const mine = this.#doc.opsSince(serverVersion).filter((op) => op.site === this.#doc.site);
    for (let i = 0; i < mine.length; i += MAX_OPS_PER_MESSAGE) {
      this.#send({ type: 'ops', ops: mine.slice(i, i + MAX_OPS_PER_MESSAGE) });
    }
  }

  // ---------- outgoing (batched) ----------
  #enqueue(op) {
    if (this.#status !== 'syncing' && this.#status !== 'online') return; // offline: stays in the log
    this.#outbox.push(op);
    if (this.#flushScheduled) return;
    this.#flushScheduled = true;
    queueMicrotask(() => {
      this.#flushScheduled = false;
      const batch = this.#outbox.splice(0);
      for (let i = 0; i < batch.length; i += MAX_OPS_PER_MESSAGE) {
        this.#send({ type: 'ops', ops: batch.slice(i, i + MAX_OPS_PER_MESSAGE) });
      }
    });
  }

  #send(msg) {
    if (this.#ws && this.#ws.readyState === 1) this.#ws.send(encode(msg)); // 1 = OPEN
  }

  #setStatus(status) {
    this.#status = status;
    for (const fn of this.#statusListeners) fn(status);
  }

  #emitError(err) {
    for (const fn of this.#errorListeners) fn(err);
  }
}