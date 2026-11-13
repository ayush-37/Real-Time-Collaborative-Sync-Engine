// Turn a remote peer's cursor (character ids as strings) into something we can show on OUR replica.
// States:
//   'none'    the peer has not placed a cursor yet
//   'pending' the anchor character has not arrived on this replica yet (presence and sync are two
//             independent channels, so the cursor can arrive BEFORE the op that creates its character)
//   'ready'   resolved: index, line, col
import { parseId } from '../crdt/charId.js';

function resolveAnchor(doc, text) {
  if (typeof text !== 'string') return null;
  try {
    const index = doc.indexOfAnchor(parseId(text));
    return Number.isInteger(index) && index >= 0 ? index : null;
  } catch {
    return null; // unknown or malformed anchor: never crash the UI on remote input
  }
}

export function resolvePeer(doc, peer) {
  if (peer.start == null || peer.end == null) return { ...peer, state: 'none' };
  const start = resolveAnchor(doc, peer.start);
  const end = resolveAnchor(doc, peer.end);
  if (start === null || end === null) return { ...peer, state: 'pending' };
  const lines = doc.text.slice(0, start).split('\n');
  return { ...peer, state: 'ready', start, end, line: lines.length, col: lines.at(-1).length + 1 };
}