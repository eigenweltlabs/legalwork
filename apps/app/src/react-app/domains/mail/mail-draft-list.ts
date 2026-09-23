/** Merge account pages without duplicating drafts or letting an older response replace newer metadata. */
export function mergeDraftEntries<T extends {key:string;draft:{updatedAt:number}}>(previous:T[],incoming:T[]):T[]{
 const entries=new Map(previous.map(entry=>[entry.key,entry]));
 for(const entry of incoming){const existing=entries.get(entry.key);if(!existing||entry.draft.updatedAt>=existing.draft.updatedAt)entries.set(entry.key,entry);}
 return [...entries.values()].sort((a,b)=>b.draft.updatedAt-a.draft.updatedAt||(a.key<b.key?-1:a.key>b.key?1:0));
}
