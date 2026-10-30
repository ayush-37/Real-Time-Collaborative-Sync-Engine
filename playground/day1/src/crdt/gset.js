// G-Set: grow-only set. merge = set union (the simplest possible CRDT).
class GSet {
  constructor() { 
    this.items = new Set(); 
  }
  
  add(x) { 
    this.items.add(x); 
  }
  
  has(x) { 
    return this.items.has(x); 
  }
  
  merge(other) {
    for (const x of other.items) this.items.add(x);
    return this;
  }
  
  toSortedArray() { 
    return [...this.items].sort(); 
  }
  
}
export { GSet };
