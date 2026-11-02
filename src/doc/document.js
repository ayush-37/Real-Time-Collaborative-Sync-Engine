// Document: the layer an editor / WebSocket client talks to.
// It wraps the RGA (pure CRDT) and adds:
//   - op envelopes:   every local op is stamped with { site, seq }
//   - an append-only op log (immutable ops, in the order THIS replica applied them)
//   - text-level editing: insertText, deleteRange, setText (diff a textarea change into ops)
//   - change events so a UI can re-render without polling
//
// Local edits are applied immediately (optimistic, zero latency) and returned as ops
// for the caller to broadcast. Remote ops go through applyRemote().
//
// NOTE: one "character" = one UTF-16 code unit, so indexes match textarea.selectionStart.
// Known limitation: emoji (surrogate pairs) are stored as two nodes.

import {RGA} from '../crdt/rga.js';
export class Document{
    #site;
    #rga;
    #seq = 0;            // per-site sequence number of the last LOCAL op
    #log = [];           // every op applied here, in application order
    #listeners = new Set();

    constructor(site){
        this.#site = site;
        this.#rga = new RGA(site);
    }

    get site(){return this.#site;}
    get text(){return this.#rga.toString();}
    get length(){return this.#rga.length;}
    get tombstoneCount(){return this.#rga.tombstoneCount;}

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

    // ---------- remote ops ----------
    // Returns true if the op changed the document, false if it was a duplicate.

    applyRemote(op){
        const changed = this.#rga.applyRemote(op);
        if(changed){
            this.#log.push(op);
            this.#emit({source: 'remote', op});
        }
        return changed;
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

    // ---------- internals ----------
    #commitLocal(rgaOp){
        const op = Object.freeze({ ...rgaOp, site: this.#site, seq: ++this.#seq});
        this.#log.push(op);
        this.#emit({source: 'local', op});
        return op;
    }

    #emit(event){
        for(const fn of this.#listeners) fn(event);
    }
}