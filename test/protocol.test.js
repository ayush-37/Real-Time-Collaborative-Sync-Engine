import test from 'node:test';
import assert from 'node:assert/strict';
import { parseMessage, parseOp, ProtocolError } from '../src/net/protocol.js';

const goodInsert = () => ({
  type: 'insert', id: { clock: 3, site: 'alice' }, afterId: { clock: 0, site: 'ROOT' },
  ch: 'x', site: 'alice', seq: 1,
});
const goodDelete = () => ({ type: 'delete', targetId: { clock: 3, site: 'alice' }, site: 'bob', seq: 2 });

test('a valid insert and delete are accepted and come back frozen', () => {
  const ins = parseOp(goodInsert());
  const del = parseOp(goodDelete());
  assert.equal(ins.ch, 'x');
  assert.equal(del.targetId.clock, 3);
  assert.ok(Object.isFrozen(ins) && Object.isFrozen(ins.id) && Object.isFrozen(del));
});

test('unknown extra fields are dropped (whitelist, not blacklist)', () => {
  const op = parseOp({ ...goodInsert(), evil: 'payload', __proto__: { polluted: true } });
  assert.equal('evil' in op, false);
  assert.equal(op.polluted, undefined);
});

test('bad ops are rejected', () => {
  const bad = [
    { ...goodInsert(), ch: 'xy' },                          // two characters
    { ...goodInsert(), ch: '' },                            // no character
    { ...goodInsert(), seq: 0 },                            // seq must be >= 1
    { ...goodInsert(), seq: 1.5 },                          // not an integer
    { ...goodInsert(), site: 'a b' },                       // illegal site name
    { ...goodInsert(), site: 'ROOT' },                      // reserved
    { ...goodInsert(), id: { clock: 0, site: 'alice' } },   // new char cannot have clock 0
    { ...goodInsert(), afterId: { clock: -1, site: 'x' } },
    { ...goodDelete(), targetId: { clock: 0, site: 'ROOT' } }, // cannot delete ROOT
    { type: 'rename', site: 'alice', seq: 1 },              // unknown type
    null,
    'insert',
  ];
  for (const op of bad) assert.throws(() => parseOp(op), ProtocolError, JSON.stringify(op));
});

test('parseMessage: join', () => {
  const m = parseMessage(JSON.stringify({ type: 'join', docId: 'notes-1', site: 'alice', version: { alice: 4 } }));
  assert.deepEqual(m, { type: 'join', docId: 'notes-1', site: 'alice', version: { alice: 4 } });
});

test('parseMessage: join defaults version to {}', () => {
  const m = parseMessage(JSON.stringify({ type: 'join', docId: 'd', site: 's' }));
  assert.deepEqual(m.version, {});
});

test('parseMessage rejects garbage', () => {
  const bad = [
    'not json at all',
    '42',
    '{}',
    JSON.stringify({ type: 'join', docId: '../etc/passwd', site: 'a' }),
    JSON.stringify({ type: 'join', docId: 'd', site: 'server' }),
    JSON.stringify({ type: 'join', docId: 'd', site: 'a', version: { a: -1 } }),
    JSON.stringify({ type: 'join', docId: 'd', site: 'a', version: [1, 2] }),
    JSON.stringify({ type: 'ops', ops: 'nope' }),
    JSON.stringify({ type: 'ops', ops: [{ type: 'insert' }] }),
    JSON.stringify({ type: 'teleport' }),
  ];
  for (const text of bad) assert.throws(() => parseMessage(text), ProtocolError, text);
});

test('too many ops in one message is rejected', () => {
  const ops = Array.from({ length: 5001 }, (_, i) => ({ ...goodInsert(), seq: i + 1 }));
  assert.throws(() => parseMessage(JSON.stringify({ type: 'ops', ops })), /too many/);
});