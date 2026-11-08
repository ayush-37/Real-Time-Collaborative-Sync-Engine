// Wire protocol shared by the server (Day 6) and the client (Day 7).
// Pure functions only: no sockets, no Node-specific APIs, so a browser can import it too.
//
// Messages are JSON text frames:
//   client -> server   { type: 'join', docId, site, version }     version = { site: contigSeq }
//   client -> server   { type: 'ops',  ops: [op, ...] }
//   server -> client   { type: 'sync', ops: [op, ...], version }  catch-up right after join
//   server -> client   { type: 'ops',  ops: [op, ...] }           live broadcast
//   server -> client   { type: 'error', message }
//
// Everything that arrives from the network is UNTRUSTED. parseMessage / parseOp validate
// it and return a fresh, frozen object built only from known fields.
import { makeId } from '../crdt/charId.js';

export const MAX_OPS_PER_MESSAGE = 5000;
const NAME = /^[A-Za-z0-9_-]{1,64}$/;
const RESERVED_SITES = new Set(['ROOT', 'server']);

export class ProtocolError extends Error {
  // fatal = the peer broke the rules (not just a typo): the server closes the socket
  constructor(message, { fatal = false } = {}) {
    super(message);
    this.name = 'ProtocolError';
    this.fatal = fatal;
  }
}
// Custom error classes allow us to implement different error-handling policies based on the error type.

const fail = (msg) => { throw new ProtocolError(msg); };
const isInt = (n) => Number.isSafeInteger(n);

function parseName(value, label) {
  if (typeof value !== 'string' || !NAME.test(value)) fail(`invalid ${label}`);
  return value;
}

function parseCharId(raw, label, { minClock }) {
  if (!raw || typeof raw !== 'object') fail(`invalid ${label}`);
  if (!isInt(raw.clock) || raw.clock < minClock) fail(`invalid ${label}.clock`);
  if (typeof raw.site !== 'string' || raw.site.length === 0 || raw.site.length > 64) {
    fail(`invalid ${label}.site`);
  }
  return makeId(raw.clock, raw.site);
}

export function parseOp(raw) {
  if (!raw || typeof raw !== 'object') fail('op must be an object');
  const site = parseName(raw.site, 'op.site');
  if (RESERVED_SITES.has(site)) fail('reserved site name');
  if (!isInt(raw.seq) || raw.seq < 1) fail('invalid op.seq');

  if (raw.type === 'insert') {
    if (typeof raw.ch !== 'string' || raw.ch.length !== 1) fail('insert.ch must be exactly one character');
    return Object.freeze({
      type: 'insert',
      id: parseCharId(raw.id, 'insert.id', { minClock: 1 }),
      afterId: parseCharId(raw.afterId, 'insert.afterId', { minClock: 0 }),
      ch: raw.ch,
      site,
      seq: raw.seq,
    });
  }
  if (raw.type === 'delete') {
    // minClock 1: nobody may delete the ROOT sentinel (clock 0)
    return Object.freeze({
      type: 'delete',
      targetId: parseCharId(raw.targetId, 'delete.targetId', { minClock: 1 }),
      site,
      seq: raw.seq,
    });
  }
  return fail('unknown op type');
}

function parseOps(raw) {
  if (!Array.isArray(raw)) fail('ops must be an array');
  if (raw.length > MAX_OPS_PER_MESSAGE) fail('too many ops in one message');
  return raw.map(parseOp);
}

function parseVersion(raw) {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) fail('invalid version');
  const out = {};
  for (const [site, n] of Object.entries(raw)) {
    if (!isInt(n) || n < 0) fail('invalid version entry');
    out[site] = n;
  }
  return out;
}

// text -> validated message object. Throws ProtocolError on anything suspicious.
export function parseMessage(text) {
  let raw;
  try {
    raw = JSON.parse(text);
  } catch {
    return fail('message is not valid JSON');
  }
  if (!raw || typeof raw !== 'object') fail('message must be an object');

  switch (raw.type) {
    case 'join':
      return {
        type: 'join',
        docId: parseName(raw.docId, 'docId'),
        site: (() => {
          const s = parseName(raw.site, 'site');
          if (RESERVED_SITES.has(s)) fail('reserved site name');
          return s;
        })(),
        version: parseVersion(raw.version),
      };
    case 'ops':
      return { type: 'ops', ops: parseOps(raw.ops) };
    case 'sync':
      return { type: 'sync', ops: parseOps(raw.ops), version: parseVersion(raw.version) };
    case 'error':
      return { type: 'error', message: String(raw.message ?? '') };
    default:
      return fail('unknown message type');
  }
}

export const encode = (msg) => JSON.stringify(msg);