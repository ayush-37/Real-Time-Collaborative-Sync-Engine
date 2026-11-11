// History for a replica: every past state is a replay of a PREFIX of the op log.
//
// Why a prefix is always a valid past: the log is in the order ops were APPLIED, and an op is only
// applied once its parent is present. So a prefix never contains an op whose parent is missing.
//
// Two ways to name a moment:
//   index n          "the first n ops of THIS replica's log" (only meaningful on this replica!)
//   version vector   { site: highestSeq } = "everything up to these ops" (same meaning on EVERY replica)
//
// Revert never rewrites the log. It is a NEW edit (setText diffs and issues ops), so it syncs
// like any other change and concurrent work by others survives.
import { Document } from './document.js';

const VIEWER = 'history-viewer'; // a throwaway replica used only to look at the past

function checkIndex(log, n) {
  if (!Number.isInteger(n) || n < 0 || n > log.length) {
    throw new RangeError(`history index must be an integer between 0 and ${log.length}`);
  }
}

// text of the document after the first n ops of `log`
export function textAt(log, n) {
  checkIndex(log, n);
  return Document.replay(VIEWER, log.slice(0, n)).text;
}

// the ops "up to" a version vector: for each site, everything with seq <= version[site]
export function opsAtVersion(log, version) {
  return log.filter((op) => op.seq <= (version[op.site] ?? 0));
}

export function textAtVersion(log, version) {
  return Document.replay(VIEWER, opsAtVersion(log, version)).text;
}

// Group consecutive ops by the same author and kind, so "alice typed hello" is ONE step in the UI.
// run.end = how many ops are applied after this run (the n to pass to textAt / revertTo).
export function timeline(log) {
  const runs = [];
  for (let i = 0; i < log.length; i++) {
    const { site, type } = log[i];
    const last = runs.at(-1);
    if (last && last.site === site && last.type === type) {
      last.count++;
      last.end = i + 1;
    } else {
      runs.push({ site, type, count: 1, start: i, end: i + 1 });
    }
  }
  return runs;
}

// Make the document look like it did after n ops, as a NEW edit. Returns the target text.
// History only grows: you can even go back to the moment before the revert.
export function revertTo(doc, n) {
  const target = textAt(doc.log, n);
  doc.setText(target);
  return target;
}