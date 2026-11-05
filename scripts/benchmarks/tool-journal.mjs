// Explicit benchmark instrumentation. Hooks observe values without changing
// them. Capture failures never escape into the engine's tool lifecycle.
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";

const digest = value => createHash("sha256").update(value).digest("hex");
export function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.keys(value).sort().map(key=>`${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  return JSON.stringify(value);
}
function snapshot(value) {
  return JSON.parse(JSON.stringify(value, (_key, item) => item instanceof Error
    ? { ...item, name: item.name, message: item.message, stack: item.stack, ...(item.cause === undefined ? {} : { cause: item.cause }) }
    : item));
}

export async function createToolJournal({ directory, location, runtimeKind }) {
  const observerInstance=randomUUID();
  const eventsName=`events.${observerInstance}.jsonl`, healthName=`health.${observerInstance}.json`;
  const health={observerInstance,location,runtimeKind,eventsName,sequence:0,lastSha256:null,pendingWrites:0,pendingCalls:0,errors:[],appendMs:0,healthWriteMs:0,bytes:0,outputCaps:false,mutatesEngine:false};
  let queue=Promise.resolve(), file;
  const pending=new Map();
  const key=event=>canonical([event.sessionID,event.messageID,event.id,event.tool,event.input]);
  async function publishHealth() {
    const started=performance.now();
    try { const temporary=join(directory,`${healthName}.${randomUUID()}.tmp`);await writeFile(temporary,JSON.stringify({...health,updatedAt:new Date().toISOString()}),{mode:0o600,flag:"wx"});await rename(temporary,join(directory,healthName)); }
    catch(error) { health.errors.push({operation:"health",error:String(error)}); }
    health.healthWriteMs+=performance.now()-started;
  }
  try { await mkdir(directory,{recursive:true,mode:0o700});file=await open(join(directory,eventsName),"ax",0o600);await publishHealth(); }
  catch(error) { health.errors.push({operation:"initialize",error:String(error)}); }
  async function append(value) {
    health.pendingWrites++;
    const operation=queue.then(async()=>{
      const started=performance.now();
      try {
        if(!file)throw new Error("Journal did not initialize");
        const payload={observerInstance,sequence:health.sequence+1,previousSha256:health.lastSha256,location,runtimeKind,...snapshot(value)};
        const serialized=JSON.stringify(payload), recordSha256=digest(serialized);
        const line=`${JSON.stringify({...payload,recordSha256})}\n`;
        await file.writeFile(line);
        health.sequence=payload.sequence;health.lastSha256=recordSha256;health.bytes+=Buffer.byteLength(line);
      } catch(error) { health.errors.push({operation:"append",error:String(error)}); }
      finally { health.appendMs+=performance.now()-started;health.pendingWrites--;await publishHealth(); }
    });
    queue=operation.catch(error=>{health.errors.push({operation:"queue",error:String(error)});});
    await queue;
  }
  return {
    async before(event) {
      try {
        const group=pending.get(key(event))??{starts:[],ambiguous:false};
        if(group.starts.length)group.ambiguous=true;
        group.starts.push({at:new Date().toISOString(),monotonic:performance.now()});pending.set(key(event),group);health.pendingCalls++;
        await append({phase:"before",at:group.starts.at(-1).at,...event});
      } catch(error) { health.errors.push({operation:"before",error:String(error)});await publishHealth(); }
    },
    async after(event) {
      try {
        const group=pending.get(key(event));const start=group?.starts.shift();
        const ambiguous=group?.ambiguous===true;
        if(start)health.pendingCalls--;
        if(group && !group.starts.length)pending.delete(key(event));
        const completedAt=new Date().toISOString();
        await append({phase:"after",at:completedAt,...event,toolID:event.tool,callID:event.id,completedAt,startedAt:start?.at??null,elapsedMs:start&&!ambiguous?performance.now()-start.monotonic:null,pairing:!start?"before-unavailable":ambiguous?"duplicate-concurrent-key-duration-unknown":"exact-session-message-call-tool-input"});
      } catch(error) { health.errors.push({operation:"after",error:String(error)});await publishHealth(); }
    },
    async flush() { await queue;await publishHealth();return snapshot(health); },
    async close() { await queue;await publishHealth();await file?.close().catch(error=>{health.errors.push({operation:"close",error:String(error)});}); },
  };
}

export function verifyToolJournal(raw, health) {
  const records=[];let previous=null,sequence=0;
  if(!raw.endsWith("\n")&&raw.length)throw new Error("Torn observer journal tail");
  for(const line of raw.split("\n").filter(Boolean)) {
    const record=JSON.parse(line);const{recordSha256,...payload}=record;
    if(record.observerInstance!==health.observerInstance||record.sequence!==++sequence||record.previousSha256!==previous||digest(JSON.stringify(payload))!==recordSha256)throw new Error("Observer journal identity/sequence/hash-chain mismatch");
    previous=recordSha256;records.push(record);
  }
  if(health.errors?.length||health.pendingWrites!==0||sequence!==health.sequence||previous!==health.lastSha256)throw new Error("Observer capture or flush health is incomplete");
  const lifecycle=toolJournalLifecycle(records);
  if(health.pendingCalls!==lifecycle.pendingBefore.length)throw new Error("Observer health pending-call count differs from complete journal lifecycle");
  return {records,captureIntegrityVerified:true,pendingCalls:health.pendingCalls,...lifecycle,complete:lifecycle.pendingBefore.length===0&&lifecycle.afterWithoutBefore.length===0,overhead:{appendMs:health.appendMs,healthWriteMs:health.healthWriteMs,bytes:health.bytes,note:"Observed instrumentation overhead retained in task wall time; no hypothetical subtraction."}};
}

export function toolJournalLifecycle(records) {
  const pending=new Map(),afterWithoutBefore=[];
  for(const record of records) {
    const key=canonical([record.observerInstance,record.sessionID,record.messageID,record.id,record.tool,record.input]);
    if(record.phase==="before") {const group=pending.get(key)??[];group.push(record);pending.set(key,group);}
    else if(record.phase==="after") {const group=pending.get(key);if(group?.length)group.shift();else afterWithoutBefore.push(record);}
    else throw new Error("Unknown observer lifecycle phase");
  }
  return {pendingBefore:[...pending.values()].flat(),afterWithoutBefore};
}

export function scopeToolJournals(journals, ownedSessionIDs) {
  if(!Array.isArray(ownedSessionIDs)||!ownedSessionIDs.length||ownedSessionIDs.some(id=>typeof id!=="string"||!id))throw new Error("Exact owned session IDs required for trace coverage");
  const owned=new Set(ownedSessionIDs),all=journals.flatMap(item=>item.records);
  const captureIntegrityVerified=journals.length>0&&journals.every(item=>item.captureIntegrityVerified===true);
  const records=all.filter(record=>owned.has(record.sessionID)),lifecycle=toolJournalLifecycle(records);
  const excluded=toolJournalLifecycle(all.filter(record=>!owned.has(record.sessionID)));
  return {records,captureIntegrityVerified,...lifecycle,complete:captureIntegrityVerified&&lifecycle.pendingBefore.length===0&&lifecycle.afterWithoutBefore.length===0,
    scope:{ownedSessionIDs:[...owned],excludedSessionIDs:[...new Set(all.filter(record=>!owned.has(record.sessionID)).map(record=>record.sessionID))],excludedPendingBefore:excluded.pendingBefore,excludedAfterWithoutBefore:excluded.afterWithoutBefore,note:"Complete journals and IO health are verified before exact-session scoping. Other sessions remain explicitly disclosed; they are not used as this task's evidence."}};
}
