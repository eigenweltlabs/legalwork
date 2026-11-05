import test from "node:test";import assert from "node:assert/strict";
import {mkdtemp,readFile,readdir,rm,writeFile}from"node:fs/promises";import{tmpdir}from"node:os";import{join}from"node:path";
import{createToolJournal,verifyToolJournal}from"./tool-journal.mjs";
async function receipt(root){const files=await readdir(root);const health=JSON.parse(await readFile(join(root,files.find(file=>file.startsWith("health."))),"utf8"));return verifyToolJournal(await readFile(join(root,health.eventsName),"utf8"),health);}
test("full observer results preserve >1MiB tails, domain failure and engine errors without changing events",async()=>{
 const root=await mkdtemp(join(tmpdir(),"lw-tool-journal-"));try{
  const journal=await createToolJournal({directory:root,location:"fixture",runtimeKind:"native-v2"});
  const call={sessionID:"owned",messageID:"message",id:"parent",tool:"read",input:{path:"source",offset:72000}};
  const result={output:{ok:false,text:"x".repeat(1200000)+"TAIL"},content:[{type:"text",text:"complete"}],metadata:{preserved:true}};
  await journal.before(call);await journal.after({...call,status:"completed",result});
  await journal.before({...call,tool:"failure"});await journal.after({...call,tool:"failure",status:"error",error:new Error("exact engine error")});
  await journal.flush();const observed=await receipt(root);assert.equal(observed.complete,true);assert.equal(observed.records[1].result.output.ok,false);assert.ok(observed.records[1].result.output.text.endsWith("TAIL"));assert.equal(observed.records[3].error.message,"exact engine error");assert.equal(result.metadata.preserved,true);assert.ok(observed.overhead.bytes>1200000);await journal.close();
 }finally{await rm(root,{recursive:true,force:true});}
});
test("identical concurrent child keys retain both outputs with ambiguous durations; unmatched denial stays incomplete",async()=>{
 const root=await mkdtemp(join(tmpdir(),"lw-tool-journal-concurrent-"));try{
  const journal=await createToolJournal({directory:root,location:"fixture",runtimeKind:"native-v2"});const call={sessionID:"owned",messageID:"m",id:"parent",tool:"child",input:{same:true}};
  await Promise.all([journal.before(call),journal.before(call)]);await Promise.all([journal.after({...call,status:"completed",result:{output:{a:1}}}),journal.after({...call,status:"completed",result:{output:{a:2}}})]);
  const after=(await receipt(root)).records.filter(record=>record.phase==="after");assert.deepEqual(after.map(record=>record.result.output.a),[1,2]);assert.ok(after.every(record=>record.elapsedMs===null&&record.pairing==="duplicate-concurrent-key-duration-unknown"));
  await journal.before({...call,tool:"denied"});assert.equal((await receipt(root)).complete,false);await journal.close();
 }finally{await rm(root,{recursive:true,force:true});}
});
test("capture IO failure stays out of tool hooks and corrupted/torn journals cannot pass",async()=>{
 const root=await mkdtemp(join(tmpdir(),"lw-tool-journal-failure-"));try{
  const path=join(root,"not-a-directory");await writeFile(path,"fixture");const journal=await createToolJournal({directory:path,location:"fixture",runtimeKind:"native-v2"});await assert.doesNotReject(()=>journal.before({tool:"read",input:{}}));assert.ok((await journal.flush()).errors.length);await journal.close();
  assert.throws(()=>verifyToolJournal('{"partial":',{}),/Torn/);
 }finally{await rm(root,{recursive:true,force:true});}
});

test("exact owned trace scoping discloses other-session pending calls and never hides capture failure",async()=>{
 const {scopeToolJournals}=await import('./tool-journal.mjs');const root=await mkdtemp(join(tmpdir(),"lw-tool-journal-scope-"));try{
  const journal=await createToolJournal({directory:root,location:"fixture",runtimeKind:"legacy-v1"});
  const old={sessionID:"old-canary",id:"denied",tool:"read",input:{path:"forbidden"}};await journal.before(old);
  const owned={sessionID:"owned",id:"call",tool:"read",input:{path:"allowed"}};await journal.before(owned);await journal.after({...owned,status:"completed",result:{output:"full"}});
  const observed=await receipt(root);assert.equal(observed.complete,false);const scoped=scopeToolJournals([observed],["owned"]);assert.equal(scoped.complete,true);assert.equal(scoped.scope.excludedPendingBefore[0].sessionID,"old-canary");assert.equal(scopeToolJournals([observed],["old-canary"]).complete,false);assert.throws(()=>scopeToolJournals([observed],[]),/owned session/);
  const files=await readdir(root);const health=JSON.parse(await readFile(join(root,files.find(f=>f.startsWith('health.'))),'utf8'));const raw=await readFile(join(root,health.eventsName),'utf8');assert.throws(()=>verifyToolJournal(raw,{...health,pendingCalls:0}),/pending-call count/);assert.throws(()=>verifyToolJournal(raw,{...health,errors:[{operation:'append',error:'disk failure'}]}),/health/);await journal.close();
 }finally{await rm(root,{recursive:true,force:true});}
});
