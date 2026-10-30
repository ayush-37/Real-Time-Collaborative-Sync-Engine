// Lamport logical clock.
// Rule 1 (local event):   time = time + 1
// Rule 2 (receive event): time = max(time, remoteTime) + 1
// Guarantee: if event A "happened before" event B, then L(A) < L(B).
// (The reverse is NOT true: a smaller number does not prove "happened before".)
export class LamportClock{
    #time;

    constructor(start = 0){
        this.#time = start;
    }

    get time(){
        return this.#time;
    }

    tick(){
        this.#time += 1;
        return this.#time;
    }

    receive(remoteTime){
        this.#time = Math.max(this.#time, remoteTime) + 1;
        return this.#time;
    }
}