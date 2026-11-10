// DocStorage: durable storage for ONE document on the server. Two files per document:
//   <docId>.snap.json : snapshot { v, log } (the whole op log at some moment)
//   <docId>.wal       : write-ahead log, ONE JSON op per line, in the order the server applied them
// Recovery = load the snapshot, then replay the WAL on top.
// Applying an op twice is harmless (idempotent), so the two files may overlap and a crash at ANY
// moment still recovers correctly.
import fs from 'node:fs/promises';
import path from 'node:path';
import { parseOp } from '../net/protocol.js';

const SNAPSHOT_VERSION = 1;
const DOC_ID = /^[A-Za-z0-9_-]{1,64}$/; // docId becomes a file name: never allow '../' tricks

export class DocStorage {
  #walPath;
  #snapPath;
  #fsync;
  #chain = Promise.resolve(); // every disk operation runs one after another, in order
  #walOps = 0;
  #compactQueued = false;

  constructor(dir, docId, { fsync = true } = {}) {
    if (!DOC_ID.test(docId)) throw new Error('unsafe document id');
    this.#walPath = path.join(dir, `${docId}.wal`);
    this.#snapPath = path.join(dir, `${docId}.snap.json`);
    this.#fsync = fsync;
  }

  // -> { ops, repaired }. Throws if the files are corrupt in a way we cannot safely repair.
  async load() {
    const ops = [];

    // 1) snapshot: written atomically, so it is complete or absent. A broken one is a real
    //    problem: refuse to start this document instead of silently dropping data.
    try {
      const data = JSON.parse(await fs.readFile(this.#snapPath, 'utf8'));
      if (data?.v !== SNAPSHOT_VERSION || !Array.isArray(data.log)) throw new Error('bad format');
      for (const raw of data.log) ops.push(parseOp(raw));
    } catch (err) {
      if (err.code !== 'ENOENT') throw new Error(`corrupt snapshot ${this.#snapPath}: ${err.message}`);
    }

    // 2) WAL: a record only counts if it ends with '\n'
    let text = '';
    try {
      text = await fs.readFile(this.#walPath, 'utf8');
    } catch (err) {
      if (err.code !== 'ENOENT') throw err;
    }
    const lines = text.split('\n');
    const tail = lines.pop(); // '' if the file ends with a newline, otherwise a TORN last record
    let goodBytes = 0;
    lines.forEach((line, i) => {
      try {
        ops.push(parseOp(JSON.parse(line)));
      } catch {
        // a bad record in the MIDDLE is not a torn write: something is really wrong
        throw new Error(`corrupt WAL ${this.#walPath} at line ${i + 1}`);
      }
      goodBytes += Buffer.byteLength(line) + 1;
    });
    const repaired = tail !== '';
    if (repaired) await fs.truncate(this.#walPath, goodBytes); // cut the torn record off
    this.#walOps = lines.length;
    return { ops, repaired };
  }

  // Append a batch of ops (one write = group commit). Resolves when they are on disk.
  append(ops) {
    if (ops.length === 0) return Promise.resolve();
    const payload = ops.map((op) => JSON.stringify(op)).join('\n') + '\n';
    return this.#enqueue(async () => {
      const fh = await fs.open(this.#walPath, 'a');
      try {
        await fh.appendFile(payload);
        if (this.#fsync) await fh.sync(); // without this the data may only be in the OS cache
      } finally {
        await fh.close();
      }
      this.#walOps += ops.length;
    });
  }

  // Write a snapshot, then empty the WAL. getLog() is called when the job RUNS, so it sees the latest log.
  compact(getLog) {
    return this.#enqueue(async () => {
      const tmp = `${this.#snapPath}.tmp`;
      const fh = await fs.open(tmp, 'w');
      try {
        await fh.writeFile(JSON.stringify({ v: SNAPSHOT_VERSION, log: getLog() }));
        if (this.#fsync) await fh.sync();
      } finally {
        await fh.close();
      }
      await fs.rename(tmp, this.#snapPath); // atomic replace
      // crash HERE = ops in both files, which is harmless (idempotent replay)
      await fs.truncate(this.#walPath, 0).catch((err) => {
        if (err.code !== 'ENOENT') throw err;
      });
      this.#walOps = 0;
    });
  }

  // compact() only when the WAL has grown past `threshold` ops (and none is already queued)
  maybeCompact(getLog, threshold) {
    if (this.#compactQueued || this.#walOps < threshold) return null;
    this.#compactQueued = true;
    return this.compact(getLog).finally(() => {
      this.#compactQueued = false;
    });
  }

  // resolves when everything queued so far has finished (used on graceful shutdown and in tests)
  flush() {
    return this.#chain;
  }

  #enqueue(task) {
    const run = this.#chain.then(task);
    this.#chain = run.catch(() => {}); // a failed job must not block the jobs after it
    return run;
  }
}