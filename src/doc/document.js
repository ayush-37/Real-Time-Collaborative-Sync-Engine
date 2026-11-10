// Document: the layer an editor / WebSocket client talks to.
// It wraps the RGA (pure CRDT) and adds:
//   - op envelopes:   every local op is stamped with { site, seq }
//   - an append-only op log (immutable ops, in the order THIS replica applied them)
//   - text-level editing: insertText, deleteRange, setText (diff a textarea change into ops)
//   - change events so a UI can re-render without polling
//   - (Day 5) a pending buffer: ops that arrive before their dependency are parked
//   - (Day 5) a version vector + merge(): anti-entropy between two replicas
//
// Local edits are applied immediately (optimistic, zero latency) and returned as ops
// for the caller to broadcast. Remote ops go through applyRemote().
//
// NOTE: one "character" = one UTF-16 code unit, so indexes match textarea.selectionStart.
// Known limitation: emoji (surrogate pairs) are stored as two nodes.

import {RGA} from '../crdt/rga.js';
import {idToString} from '../crdt/charId.js';

const opKey = (op) => `${op.site}:${op.seq}`;
// The one thing an op needs to exist before it can be applied:
//   insert -> its parent char, delete -> the char it deletes
const dependencyOf = (op) => (op.type === 'insert' ? op.afterId: op.targetId);


export class Document{
    #site;
    #rga;
    #seq = 0;            // per-site sequence number of the last LOCAL op
    #log = [];           // every op applied here, in application order
    #listeners = new Set();

    // --- Day 5 state ---
    #pending = new Map();     // missing char id (string) -> ops waiting for it
    #bufferedKeys = new Set();// opKeys currently parked, to avoid parking duplicates
    #versions = new Map();    // site -> { contig, ahead:Set }  (basis of the version vector)

    constructor(site){
        this.#site = site;
        this.#rga = new RGA(site);
    }

    get site(){return this.#site;}
    get text(){return this.#rga.toString();}
    get length(){return this.#rga.length;}
    get tombstoneCount(){return this.#rga.tombstoneCount;}
    get pendingCount() { return this.#bufferedKeys.size; }

    // cursor helpers (see RGA): a cursor = id of the char before it
    anchorAt(index) {return this.#rga.anchorAt(index);}
    indexOfAnchor(anchor) {
        return this.#rga.indexOfAnchor(anchor);
    }
    //  return a copy of the log, so callers cannot mutate our history
    get log(){return [...this.#log];}

    // ---------- local editing ----------
    insertText(index, text) {
        const ops = [];
        text.split('').forEach((ch, i) => {
            ops.push(this.#commitLocal(this.#rga.insertAt(index + i, ch)));
        });
        return ops;
    }

    // delete `count` chars starting at `index`.
    // Each deletion shifts the rest left, so we delete at the SAME index repeatedly.
    deleteRange(index, count){
        const ops = [];
        for(let i = 0; i < count; i++){
            ops.push(this.#commitLocal(this.#rga.deleteAt(index)));
        }
        return ops;
    }

    // Replace the whole text; works out the smallest edit using common prefix/suffix.
    // This is how a plain <textarea> 'input' event becomes CRDT ops.
    setText(newText){
        const old = this.text;
        let start = 0;
        while(start < old.length && start < newText.length && old[start] === newText[start])start++;

        let endOld = old.length;
        let endNew = newText.length;
        while(endOld > start && endNew > start && old[endOld - 1] === newText[endNew - 1]){
            endOld--;
            endNew--;
        }

        return [
            ...this.deleteRange(start, endOld - start),
            ...this.insertText(start, newText.slice(start, endNew)),
        ];
    }

    // ---------- remote ops (the merge entry point) ----------
    // Returns 'applied' | 'duplicate' | 'buffered'
    //   duplicate: we already have this exact op (same site+seq)  -> idempotent
    //   buffered : its dependency has not arrived yet             -> parked, applied later
    //   applied  : integrated now (and may have released parked ops)
    applyRemote(op){
        if(typeof op.site !== 'string' || !Number.isInteger(op.seq)){
            throw new TypeError('applyRemote: op must carry {site, seq}');
        }

        if(this.#hasOp(op.site, op.seq)) return 'duplicate';

        const dep = dependencyOf(op);
        if(!this.#rga.has(dep)){
            const key = opKey(op);
            if(this.#bufferedKeys.has(key)) return 'duplicate';
            this.#bufferedKeys.add(key);

            const depKey = idToString(dep);
            if(!this.#pending.has(depKey)) this.#pending.set(depKey, []);
            this.#pending.get(depKey).push(op);
            return 'buffered';
        }

        this.#integrateRemote(op);
        this.#drainPending(op);
        return 'applied';
    }

    // ---------- version vector + merge (anti-entropy) ----------
    // { alice: 12, bob: 7 } = "I have every op from alice up to seq 12 and from bob up to 7"
    version(){
        const out = {};
        for(const [site, v] of this.#versions) out[site] = v.contig;
        return out;
    }

    // every op in our log that a peer with 'vector' is missing
    opsSince(vector){
        return this.#log.filter((op) => op.seq > (vector[op.site] ?? 0));
    }
    // Pull everything `other` has that we lack. Returns how many ops were newly applied.
    // (Over a real network this becomes: send my version(), receive opsSince(it).)
    merge(other){
        let applied = 0;
        for(const op of other.opsSince(this.version())){
            if(this.applyRemote(op) === 'applied') applied++;
        }
        return applied;
    }

    // ---------- events ----------
    // fn({ source: 'local' | 'remote', op }); returns an unsubscribe function
    onChange(fn){
        this.#listeners.add(fn);
        return () => this.#listeners.delete(fn);
    }

    // ---------- replay ----------
    // Rebuild a document purely from a log (or a prefix of one).
    static replay(site, ops){
        const doc = new Document(site);
        for(const op of ops)doc.applyRemote(op);
        return doc;
    }

    // Rebuild a replica that CONTINUES as `site` from a saved log (e.g. after a page reload).
    // Unlike replay() it also restores the local seq counter, so new ops never reuse an old seq.
    // (The Lamport clock is restored automatically: replaying our own inserts advances it.)
    static restore(site, ops) {
        const doc = new Document(site);
        for (const op of ops) doc.applyRemote(op);
        doc.#seq = ops.reduce((max, op) => (op.site === site ? Math.max(max, op.seq) : max), 0);
        return doc;
    }

    // ---------- internals ----------
    #commitLocal(rgaOp){
        const op = Object.freeze({ ...rgaOp, site: this.#site, seq: ++this.#seq});
        this.#log.push(op);
        this.#markSeen(op);
        this.#emit({source: 'local', op});
        return op;
    }

    #integrateRemote(op){
        this.#rga.applyRemote(op);      // its boolean is NOT our duplicate test: identity is (site, seq)
        this.#log.push(op);
        this.#markSeen(op);
        this.#emit({source: 'remote', op});
    }

    // After an insert lands, ops waiting on that char can go; they may unblock more.
    #drainPending(firstOp){
        const work = firstOp.type === 'insert'? [idToString(firstOp.id)]:[];
        while(work.length){
            const waiting = this.#pending.get(work.pop());
            if(!waiting) continue;
            this.#pending.delete(idToString(dependencyOf(waiting[0])));
            for(const op of waiting){
                this.#bufferedKeys.delete(opKey(op));
                if(this.#hasOp(op.site, op.seq)) continue;
                this.#integrateRemote(op);
                if(op.type === 'insert') work.push(idToString(op.id));
            }
        }
    }

    // ----- version-vector bookkeeping -----
    #hasOp(site, seq){
        const v = this.#versions.get(site);
        return Boolean(v) && (seq <= v.contig || v.ahead.has(seq));
    }

    #markSeen({site, seq}){
        let v = this.#versions.get(site);
        if(!v){
            v = {contig: 0, ahead: new Set()};
            this.#versions.set(site, v)
        }

        if(seq === v.contig+1){
            v.contig = seq;
            while(v.ahead.has(v.contig+1)){
                v.ahead.delete(v.contig+1);
                v.contig++;
            }
        } else if(seq > v.contig+1){
            v.ahead.add(seq);
        }
    }

    #emit(event){
        for(const fn of this.#listeners) fn(event);
    }
}