// Unique, totally ordered identity for every character: (clock, site).
//   clock = Lamport counter at the moment the char was created
//   site  = id of the client that created it (breaks ties)
// Two different clients can never create the same (clock, site) pair,
// so every character in the document has a globally unique ID.

export const ROOT_ID = Object.freeze({clock: 0, site: 'ROOT'});
export function makeId(clock, site){
    return Object.freeze({clock, site});
}

export function compareIds(a, b){
    if(a.clock !== b.clock)return a.clock - b.clock;
    if(a.site === b.site)return 0;
    return a.site < b.site ? -1: 1;
}

export function isEqual(a,b){
    return compareIds(a,b) === 0;
}

export function idToString(id){
    return `${id.clock}@${id.site}`;
}

export function parseId(str){
    const at = str.indexOf('@');
    return makeId(Number(str.slice(0,at)), str.slice(at+1));
}
