// RGA (Replicated Growable Array): a sequence CRDT for text.
//
// Internally a singly linked list of nodes, in document order.
// Every node has a unique immutable id (clock, site). Deleted nodes stay in the
// list as tombstones. A Map gives O(1) lookup from id -> node.
//
// Insert rule (the heart of RGA):
//   start right after the parent node (the char the user typed after), then
//   SKIP past any following nodes whose id is LARGER than the new id.
//   Those are concurrent siblings (or their descendants) with higher priority.
//
// Assumption for now: ops are delivered in causal order (a parent always arrives
// before its children). Buffering out-of-order ops comes later with the op log.


import {LamportClock} from './lamport.js';
import {ROOT_ID, makeId, compareIds, idToString} from './charId.js';

class Node{
    constructor(id, ch){
        this.id = id;
        this.ch = ch;
        this.deleted = false;
        this.next = null;
    }
}

export class RGA{
    #site
    #clock
    #head
    #index

    constructor(site){
        this.#site = site;
        this.#clock = new LamportClock();
        this.#head = new Node(ROOT_ID, null);
        this.#index = new Map([[idToString(ROOT_ID), this.#head]]);
    }

    get site(){
        return this.#site;
    }

    // ---------- local edits: the user typed / deleted something ----------
    // Both return an op that the caller should broadcast to other replicas.

    insertAt(index, ch){
        const parent = index === 0? this.#head : this.#visibleNode(index - 1);
        if(!parent) throw new RangeError(`insertAt(${index}) out of bounds`);
        const id = makeId(this.#clock.tick(), this.#site);
        const op = {type: 'insert', id, afterId: parent.id, ch};
        this.#integrateInsert(op);
        return op;
    }

    deleteAt(index){
        const node = this.#visibleNode(index);
        if(!node) throw new RangeError(`deleteAt(${index}) out of bounds`);
        const op = { type: 'delete', targetId: node.id };
        this.#integrateDelete(op);
        return op;
    }

    // ---------- remote edits: an op that another replica produced ----------
    // Returns true if the op changed anything, false if it was a duplicate.

    applyRemote(op){
        if(op.type === 'insert'){
            this.#clock.receive(op.id.clock);
            return this.#integrateInsert(op);
        }
        if(op.type === 'delete'){
            return this.#integrateDelete(op);
        }

        throw new TypeError(`unknown op type: ${op.type}`);
    }

    // ---------- reading ----------
        // ---------- cursors ----------
        // A cursor is stored as the id of the character just BEFORE it (ROOT_ID = start of text).
        // Ids never change, so the cursor survives remote edits; indexes do not.

    anchorAt(index){
        if(index <= 0) return ROOT_ID;
        const node = this.#visibleNode(index - 1);
        if(!node) throw new RangeError(`anchorAt: index (${index}) out of range`);
        return node.id;
    }
    // visible index of a cursor that sits right after `anchor`.
    // If the anchor char was deleted (tombstone) the cursor stays at that spot.
    indexOfAnchor(anchor){
        const target = this.#index.get(idToString(anchor));
        if(!target) throw new Error(`indexOfAnchor: unknown anchor ${idToString(anchor)}`);
        if(target === this.#head) return 0;
        let count = 0;
        for(let n = this.#head.next; n ; n = n.next){
            if(!n.deleted)count++;
            if(n === target) return count;
        }
        throw new Error(`indexOfAnchor: anchor not reachable`);
    }

     has(id) {
        return this.#index.has(idToString(id));
    }
    
    toString(){
        let out = '';
        for(let n = this.#head.next; n; n = n.next){
            if(!n.deleted) out += n.ch;
        }
        return out;
    }

    get length(){
        let count = 0;
        for(let n = this.#head.next; n; n = n.next){
            if(!n.deleted) count++;
        }
        return count;
    }

    get tombstoneCount(){
        let count = 0;
        for(let n = this.#head.next; n; n = n.next){
            if(n.deleted) count++;
        }
        return count;
    }

    // Debug view that includes tombstones: [{ id: '3@alice', ch: 'A', deleted: false }, ...]
    dump(){
        const out = [];
        for(let n = this.#head.next; n; n = n.next){
            out.push({id: idToString(n.id), ch: n.ch, deleted: n.deleted});
        }
        return out;
    }

    // ---------- internals ----------
    #integrateInsert({id, afterId, ch}){
        const key = idToString(afterId);
        if(this.#index.has(idToString(id))) return false; // duplicate insert
        
        const parent = this.#index.get(key);
        if (!parent) {
            throw new Error(`insert: parent ${key} not found`);
        }

        let cur = parent;
        while(cur.next && compareIds(cur.next.id, id) > 0){
            cur = cur.next;
        }

        const node = new Node(id, ch);
        node.next = cur.next;
        cur.next = node;
        this.#index.set(idToString(id), node);
        return true;
    }

    #integrateDelete({targetId}){
        const key = idToString(targetId);
        const node = this.#index.get(key);
        if(!node || node === this.#head) throw new Error(`delete unknown id: ${key}`);
        if(node.deleted) return false; // duplicate delete
        node.deleted = true;
        // this.#index.delete(key);
        return true;
    }

    // the index-th visible node or null
    #visibleNode(index){
        if(index < 0) return null;
        let i = -1;
        for(let n = this.#head.next; n; n = n.next){
            if(!n.deleted && ++i === index)return n;
        }
        return null;
    }
}