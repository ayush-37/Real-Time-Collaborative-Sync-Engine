// SyncClient: connects ONE local Document to the sync server over a WebSocket.
// Works in the browser and in Node 22+ (both have a global WebSocket with the same API).
//
//   local edit  -> Document emits a local op -> batched into one 'ops' message -> server
//   server msg  -> validated -> remote ops applied to the Document (buffer/dedup inside)
//   on 'sync'   -> also RE-SEND our own ops the server lacks (typed while offline / lost in flight)
//
// status: 'disconnected' -> 'connecting' -> 'syncing' (joined, waiting for catch-up) -> 'online'
//
// Day 8: if the connection drops (or never opens) the client retries by itself using
// exponential backoff with full jitter, so thousands of clients do not hammer a restarting
// server in lockstep. Nothing typed while offline is lost: it stays in the Document's log and
// is re-sent by the 'sync' handshake of the next connection.
import { parseMessage, encode, MAX_OPS_PER_MESSAGE } from '../net/protocol.js';

// "Full jitter": wait a RANDOM time between 0 and min(maxMs, baseMs * 2^attempt).
// attempt 0 -> up to base, attempt 1 -> up to 2*base, attempt 2 -> up to 4*base ... capped at maxMs.
export function backoffDelay(attempt, { baseMs = 500, maxMs = 15_000, random = Math.random } = {}) {
  const cap = Math.min(maxMs, baseMs * 2 ** attempt);
  return Math.floor(random() * cap);
}

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
  #retryListeners = new Set();

  // --- Day 8: reconnect state ---
  #reconnect;
  #wantOpen = false;   // true between connect() and close()
  #attempt = 0;        // consecutive failed attempts; reset only after a successful sync
  #retryTimer = null;

  constructor({ url, docId, document, WebSocketImpl = globalThis.WebSocket, reconnect = {} }) {
    this.#url = url;
    this.#docId = docId;
    this.#doc = document;
    this.#WS = WebSocketImpl;
    this.#reconnect = { enabled: true, baseMs: 500, maxMs: 15_000, random: Math.random, ...reconnect };

    // every LOCAL op goes to the server; remote ops are ignored here (no echo loops)
    this.#doc.onChange(({ source, op }) => {
      if (source === 'local') this.#enqueue(op);
    });
  }

  get status() { return this.#status; }
  get attempt() { return this.#attempt; }

  onStatus(fn) { this.#statusListeners.add(fn); return () => this.#statusListeners.delete(fn); }
  onError(fn) { this.#errorListeners.add(fn); return () => this.#errorListeners.delete(fn); }
  // fn({ attempt, delayMs }) every time a retry gets scheduled (handy for "retrying in 3s" in the UI)
  onRetry(fn) { this.#retryListeners.add(fn); return () => this.#retryListeners.delete(fn); }

  connect() {
    this.#wantOpen = true;
    this.#clearRetryTimer();
    this.#open();
  }

  // Skip the backoff wait right now (e.g. the browser fired its 'online' event).
  retryNow() {
    if (!this.#wantOpen || this.#ws) return;
    this.#clearRetryTimer();
    this.#open();
  }

  #open() {
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
    // Browsers fire 'error' and then 'close'; Node's built-in WebSocket fires ONLY 'error' when a
    // connection is refused. So BOTH events mean "this connection is gone". The guard makes the
    // second one a no-op.
    const gone = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      this.#outbox.length = 0; // anything unsent is still in the Document's log
      try { ws.close(); } catch { /* already dead */ }
      this.#setStatus('disconnected');
      this.#scheduleRetry();
    };
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
  }

  // intentional close: no more retries
  close() {
    this.#wantOpen = false;
    this.#clearRetryTimer();
    this.#ws?.close();
  }

  #scheduleRetry() {
    if (!this.#wantOpen || !this.#reconnect.enabled || this.#retryTimer) return;
    const { baseMs, maxMs, random } = this.#reconnect;
    const delayMs = backoffDelay(this.#attempt, { baseMs, maxMs, random });
    const attempt = this.#attempt++;
    for (const fn of this.#retryListeners) fn({ attempt, delayMs });
    this.#retryTimer = setTimeout(() => {
      this.#retryTimer = null;
      if (this.#wantOpen) this.#open();
    }, delayMs);
  }

  #clearRetryTimer() {
    if (this.#retryTimer) clearTimeout(this.#retryTimer);
    this.#retryTimer = null;
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
      this.#attempt = 0; // a full handshake worked: the next outage starts from the short delay again
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