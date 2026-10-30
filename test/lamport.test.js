import test from 'node:test';
import assert from 'node:assert/strict';
import { LamportClock } from '../src/crdt/lamport.js';

test('tick() increases the clock by 1 each local event', () => {
  const c = new LamportClock();
  assert.equal(c.tick(), 1);
  assert.equal(c.tick(), 2);
  assert.equal(c.time, 2);
});

test('receive() jumps ahead of a faster remote clock', () => {
  const a = new LamportClock();
  const b = new LamportClock();
  for (let i = 0; i < 10; i++) a.tick();   // A is at 10
  b.tick();                                // B is at 1
  b.receive(a.time);                       // B hears from A
  assert.equal(b.time, 11);                // max(1, 10) + 1
});

test('receive() never moves the clock backwards', () => {
  const c = new LamportClock(50);
  c.receive(3);
  assert.equal(c.time, 51);
});

test('happened-before is respected: effect always has a larger timestamp than cause', () => {
  const alice = new LamportClock();
  const bob = new LamportClock();
  const sentAt = alice.tick();       // Alice makes an edit
  bob.receive(sentAt);               // Bob sees it
  const bobsReply = bob.tick();      // Bob edits after seeing Alice's edit
  assert.ok(bobsReply > sentAt);
});