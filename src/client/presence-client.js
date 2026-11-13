// PresenceClient: the browser/Node side of the ephemeral presence channel.
//   - setCursor() is THROTTLED (trailing edge, latest wins): at most one update per throttleMs
//   - every roster message REPLACES the previous one (state-based, so a lost message is harmless)
//   - after a reconnect it re-announces itself (hello + last cursor), because the server forgets everything
import { backoffDelay } from './sync-client.js';

const COLOR = /^#[0-9a-fA-F]{6}$/;

// never trust the server blindly either: keep only the fields we expect, with the right types
function cleanPeer(p) {
  if (!p || typeof p !== 'object') return null;
  const str = (v, max) => (typeof v === 'string' && v.length <= max ? v : null);
  const name = str(p.name, 24);
  const id = str(p.id, 20);
  if (!name || !id) return null;
  return {
    id, name, site: str(p.site, 64) ?? '',
    color: COLOR.test(p.color) ? p.color : '#888888',
    start: str(p.start, 100), end: str(p.end, 100),
  };
}

export class PresenceClient {
  #url;
  #hello;
  #WS;
  #throttleMs;
  #reconnect;
  #ws = null;
  #cursor = null;
  #sendTimer = null;
  #wantOpen = false;
  #attempt = 0;
  #retryTimer = null;
  #peers = [];
  #listeners = new Set();

  constructor({ url, docId, site, name = site, color = '#888888', WebSocketImpl = globalThis.WebSocket,
                throttleMs = 50, reconnect = {} }) {
    this.#url = url;
    this.#hello = { docId, site, name, color };
    this.#WS = WebSocketImpl;
    this.#throttleMs = throttleMs;
    this.#reconnect = { baseMs: 500, maxMs: 15_000, random: Math.random, ...reconnect };
  }

  get peers() { return this.#peers; }
  onPeers(fn) { this.#listeners.add(fn); return () => this.#listeners.delete(fn); }

  connect() {
    this.#wantOpen = true;
    this.#open();
  }

  close() {
    this.#wantOpen = false;
    clearTimeout(this.#retryTimer);
    clearTimeout(this.#sendTimer);
    this.#retryTimer = this.#sendTimer = null;
    this.#ws?.close();
  }

  // cursor = { start, end } as id strings, or null
  setCursor(cursor) {
    this.#cursor = cursor;
    if (this.#sendTimer) return;
    this.#sendTimer = setTimeout(() => {
      this.#sendTimer = null;
      this.#sendCursor();
    }, this.#throttleMs);
  }

  #sendCursor() {
    if (!this.#ws || this.#ws.readyState !== 1) return; // not open: the open handler sends it
    const c = this.#cursor;
    this.#ws.send(JSON.stringify({ type: 'cursor', start: c?.start ?? null, end: c?.end ?? null }));
  }

  #open() {
    if (this.#ws) return;
    const ws = new this.#WS(this.#url);
    this.#ws = ws;
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'hello', ...this.#hello }));
      if (this.#cursor) this.#sendCursor();
    });
    ws.addEventListener('message', (event) => this.#onMessage(event.data));
    // like Day 8: Node fires only 'error' on a refused connection, browsers fire 'error' then 'close'
    const gone = () => {
      if (this.#ws !== ws) return;
      this.#ws = null;
      try { ws.close(); } catch { /* already dead */ }
      this.#setPeers([]); // we cannot know who is online while disconnected
      if (!this.#wantOpen) return;
      const { baseMs, maxMs, random } = this.#reconnect;
      this.#retryTimer = setTimeout(() => { this.#retryTimer = null; this.#open(); },
        backoffDelay(this.#attempt++, { baseMs, maxMs, random }));
    };
    ws.addEventListener('close', gone);
    ws.addEventListener('error', gone);
  }

  #onMessage(data) {
    let msg;
    try { msg = JSON.parse(typeof data === 'string' ? data : String(data)); } catch { return; }
    if (msg?.type !== 'peers' || !Array.isArray(msg.peers)) return;
    this.#attempt = 0; // the server accepted our hello and answered: the outage is over
    this.#setPeers(msg.peers.slice(0, 100).map(cleanPeer).filter(Boolean));
  }

  #setPeers(peers) {
    this.#peers = peers;
    for (const fn of this.#listeners) fn(peers);
  }
}