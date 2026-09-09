import {test} from 'node:test';
import assert from 'node:assert/strict';
import {ImapFlow} from 'imapflow';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {randomBytes} from 'node:crypto';
import {pathToFileURL,fileURLToPath} from 'node:url';
import {imapServer} from '../testing/imap-server.mjs';
import {ImapReadTransport} from './imap.js';
import {ImapBackfill} from './imap-backfill.js';
import {openEncryptedMailDatabase} from '../storage/database.js';
import {migrateMailSchema} from '../storage/schema.js';
import {MailReadStore} from '../storage/read-store.js';
import {MailLocalApiStore} from '../storage/local-api.js';
import {MailCredentialRepository} from '../storage/credentials.js';
import {LocalMailService} from '../service.js';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function until(fn){for(let i=0;i<600;i++){if(await fn())return;await delay(10);}throw Error('Incremental fixture deadline');}
async function fixture(body){const server=await imapServer(),dir=await mkdtemp(join(tmpdir(),'imap-incremental-')),key=randomBytes(32),path=join(dir,'mail.sqlite');const db=await openEncryptedMailDatabase({path,key});migrateMailSchema(db);const input={host:'localhost',port:server.port,username:'synthetic@example.test',password:'SYNTHETIC_PRIVATE_PASSWORD'};const transport=(settings,password)=>new ImapReadTransport(settings,password,options=>new ImapFlow({...options,host:'127.0.0.1',servername:'localhost',tls:{...options.tls,ca:server.cert}}));let engine;const f={server,dir,key,path,db,input,transport,make(){engine=new ImapBackfill({database:db,ownerId:'owner',transport});return engine;}};try{await body(f);}finally{await engine?.close();await server.close();db.close();key.fill(0);await rm(dir,{recursive:true,force:true});}}
const locator={provider:'imap',mailboxId:'INBOX',uidValidity:7,uid:1};
async function ready(f){const engine=f.make(),{accountId}=await engine.connect(f.input);engine.start(accountId);await until(()=>engine.status(accountId).state==='complete');return {engine,accountId,reads:new MailReadStore(f.db,'owner'),local:new MailLocalApiStore(f.db,'owner')};}
async function mutate(f,context,change,key='mutation'){const {engine,accountId,reads,local}=context;const input={replayKey:key,change,precondition:change.kind==='mailbox'?'imap-mailbox-v1':reads.read(accountId,locator).mutationPrecondition,...(change.kind==='mailbox'?{}:{locator})};const action=local.enqueueMutation(accountId,input);engine.wake(accountId);await until(()=>!['queued','running','retry','dispatching'].includes(local.readAction(accountId,action.id).state));return local.readAction(accountId,action.id);}
test('polling reconciles flags, expunges, folder removal/addition and UIDVALIDITY while preserving originals and draft/action records',()=>fixture(async f=>{
 const c=await ready(f),{engine,accountId,local}=c;local.saveDraft(accountId,{draftId:'00000000-0000-4000-8000-000000000001',expected:null,content:{subject:'retained',to:['x@example.test'],text:'draft'}});
 f.server.state.flags['INBOX:1']=[];f.server.state.messages.INBOX.push(1003);delete f.server.state.messages.Archive;f.server.state.messages.New=[2];engine.start(accountId);await until(()=>engine.status(accountId).state==='complete');assert.equal(f.db.get("SELECT is_read FROM mail_messages WHERE message_key=?",[JSON.stringify(['imap','INBOX',7,1])]).is_read,0);assert.equal(engine.status(accountId).removed,1);assert.equal(engine.status(accountId).retained,1);assert.equal(f.db.get('SELECT count(*) AS n FROM mail_local_drafts').n,1);
 f.server.state.validity=8;engine.start(accountId);await until(()=>engine.status(accountId).state==='complete');assert.ok(engine.status(accountId).removed>=4);assert.ok(f.db.get("SELECT count(*) AS n FROM mail_content_manifests WHERE kind='raw'").n>=8);
}));
test('actual TLS flags/copy/native MOVE/UIDPLUS delete and empty mailbox changes dispatch once; unknown keywords and unsafe fallback stay unsupported',()=>fixture(async f=>{
 f.server.state.capabilities=['UIDPLUS','MOVE'];const c=await ready(f);let action=await mutate(f,c,{kind:'read',read:false});assert.equal(action.state,'succeeded');assert.equal(action.providerResult,'confirmed');await until(()=>c.engine.status(c.accountId).state==='complete');
 action=await mutate(f,c,{kind:'flags',add:['UnsupportedKeyword'],remove:[]},'keyword');assert.equal(action.state,'failed');assert.equal(action.providerResult,'unsupported');
 action=await mutate(f,c,{kind:'copy',destination:'Archive'},'copy');assert.equal(action.state,'succeeded');assert.equal(f.server.state.messages.Archive.length,2);await until(()=>c.engine.status(c.accountId).state==='complete');
 action=await mutate(f,c,{kind:'mailbox',operation:'create',path:'Empty'},'create');assert.equal(action.state,'succeeded');action=await mutate(f,c,{kind:'mailbox',operation:'rename',path:'Empty',destination:'Renamed'},'rename');assert.equal(action.state,'succeeded');action=await mutate(f,c,{kind:'mailbox',operation:'delete',path:'Renamed'},'drop');assert.equal(action.state,'succeeded');
 action=await mutate(f,c,{kind:'delete'},'delete');assert.equal(action.state,'succeeded');assert.ok(!f.server.state.messages.INBOX.includes(1));assert.ok(!f.server.state.commands.includes('EXPUNGE'));assert.ok(f.server.state.writeCommands.includes('EXPUNGE'));
}));
test('connection loss after accepted copy is uncertain and never replayed; reconnect fences queued old-password work',()=>fixture(async f=>{
 f.server.state.capabilities=['UIDPLUS'];const c=await ready(f);f.server.state.dropAfterCopy=true;const action=await mutate(f,c,{kind:'move',destination:'Archive'});assert.equal(action.state,'uncertain');assert.equal(f.server.state.messages.Archive.length,2);assert.ok(f.server.state.messages.INBOX.includes(1));assert.deepEqual(f.server.state.writeCommands,['COPY']);c.engine.start(c.accountId);await delay(100);assert.equal(f.server.state.writeCommands.filter(x=>x==='COPY').length,1);
 c.engine.pause(c.accountId);await delay(30);const queued=c.local.enqueueMutation(c.accountId,{replayKey:'old-password',locator,precondition:c.reads.read(c.accountId,locator).mutationPrecondition,change:{kind:'read',read:false}});await c.engine.connect({...f.input,password:'new-synthetic',reconnectAccountId:c.accountId});c.engine.start(c.accountId);await until(()=>c.local.readAction(c.accountId,queued.id).state==='failed');assert.equal(f.server.state.writeCommands.filter(x=>x==='STORE').length,0);
}));
test('servers without UIDPLUS/MOVE reject move and permanent delete without any write; copy remains usable',()=>fixture(async f=>{
 const c=await ready(f);assert.equal((await mutate(f,c,{kind:'move',destination:'Archive'})).providerResult,'unsupported');assert.equal((await mutate(f,c,{kind:'delete'},'delete')).providerResult,'unsupported');assert.deepEqual(f.server.state.writeCommands,[]);assert.equal((await mutate(f,c,{kind:'copy',destination:'Archive'},'copy')).state,'succeeded');
}));
test('actual service worker public local action API executes IMAP intent and preserves offline reads after reconciliation',()=>fixture(async f=>{
 const entry=join(f.dir,'worker.mjs');await writeFile(entry,`import {setDefaultCACertificates,getCACertificates} from 'node:tls';setDefaultCACertificates([...getCACertificates('default'),${JSON.stringify(f.server.cert.toString())}]);await import(${JSON.stringify(pathToFileURL(fileURLToPath(new URL('../runtime/worker.js',import.meta.url))).href)});`);
 const service=new LocalMailService({ownerId:'owner',databasePath:f.path,loadKey:async()=>Buffer.from(f.key),executable:{kind:'node',path:process.execPath},entryPoint:entry});try{await service.unlock();const {accountId}=await service.connectImap(f.input);await service.startSync(accountId);await until(async()=> (await service.syncStatus(accountId)).state==='complete');const message=await service.readMessage(accountId,locator);assert.ok(message.mutationPrecondition);const result=await service.enqueueMutation(accountId,{replayKey:'public-read',locator,precondition:message.mutationPrecondition,change:{kind:'read',read:false}});await until(async()=> (await service.readAction(accountId,result.id)).state==='succeeded');assert.ok(f.server.state.writeCommands.includes('STORE'));await service.disconnectAccount(accountId);await assert.rejects(service.readMessage(accountId,locator),{code:'locked'});}finally{await service.stop();}
}));
test('CONDSTORE/QRESYNC enabled sessions use changedSince; IDLE wakes a bounded full UID/presence reconciliation',()=>fixture(async f=>{
 f.server.state.capabilities=['ENABLE','CONDSTORE','QRESYNC','IDLE'];const c=await ready(f);await until(()=>f.server.state.commands.includes('IDLE'));f.server.state.messages.INBOX.push(1003);f.server.state.modseq++;for(const socket of f.server.state.sockets)socket.write('* 3 EXISTS\r\n');await until(()=>c.engine.status(c.accountId).enumerated===4&&c.engine.status(c.accountId).state==='complete');assert.ok(f.server.state.commands.includes('ENABLE'));assert.ok(f.server.state.changedFetches>0);assert.equal(f.server.state.rawCalls,4);c.engine.pause(c.accountId);assert.equal(c.engine.status(c.accountId).state,'paused');
}));
test('UIDPLUS MOVE fallback scopes expunge, preserves unrelated Deleted messages and does not delete after an ambiguous COPY',()=>fixture(async f=>{
 f.server.state.capabilities=['UIDPLUS'];f.server.state.flags['INBOX:1002']=['\\Deleted'];const c=await ready(f);const action=await mutate(f,c,{kind:'move',destination:'Archive'});assert.equal(action.state,'succeeded');assert.deepEqual(f.server.state.messages.INBOX,[1002]);assert.ok(!f.server.state.commands.includes('EXPUNGE'));assert.deepEqual(f.server.state.writeCommands,['COPY','STORE','STORE','EXPUNGE']);
}));
test('native MOVE is one command; stale flag snapshots fail before dispatch and cancellation keeps queued intent inert',()=>fixture(async f=>{
 f.server.state.capabilities=['MOVE'];const c=await ready(f);const precondition=c.reads.read(c.accountId,locator).mutationPrecondition;f.server.state.flags['INBOX:1']=[];const stale=c.local.enqueueMutation(c.accountId,{replayKey:'stale',locator,precondition,change:{kind:'read',read:false}});c.engine.wake(c.accountId);await until(()=>c.local.readAction(c.accountId,stale.id).state==='failed');assert.equal(c.local.readAction(c.accountId,stale.id).providerResult,'conflict');assert.deepEqual(f.server.state.writeCommands,[]);await until(()=>c.engine.status(c.accountId).state==='complete');
 const cancelled=c.local.enqueueMutation(c.accountId,{replayKey:'cancel',locator,precondition:c.reads.read(c.accountId,locator).mutationPrecondition,change:{kind:'delete'}});c.local.cancelAction(c.accountId,{actionId:cancelled.id,expected:cancelled.version});assert.equal((await mutate(f,c,{kind:'move',destination:'Archive'},'native')).state,'succeeded');assert.deepEqual(f.server.state.writeCommands,['MOVE']);assert.equal(c.local.readAction(c.accountId,cancelled.id).state,'cancelled');
}));
test('a mailbox disappearing after LIST is reconciled; repeatedly unstable UIDVALIDITY stops after a bounded recovery budget',()=>fixture(async f=>{
 let discoveryCalls=0;const transport=(settings,password)=>{const actual=f.transport(settings,password);return {connect:s=>actual.connect(s),discover:async s=>{const result=await actual.discover(s);if(++discoveryCalls===2)delete f.server.state.messages.Archive;return result;},open:(...args)=>actual.open(...args),page:(...args)=>actual.page(...args),raw:(...args)=>actual.raw(...args),close:()=>actual.close()};};
 let e=new ImapBackfill({database:f.db,ownerId:'owner',transport});try{const {accountId}=await e.connect(f.input);e.start(accountId);await until(()=>e.status(accountId).state==='complete');assert.equal(e.status(accountId).enumerated,2);await e.close();
 const changing=(settings,password)=>{const actual=f.transport(settings,password);return {connect:s=>actual.connect(s),discover:s=>actual.discover(s),open:(...args)=>actual.open(...args),async page(...args){f.server.state.validity++;return actual.page(...args);},raw:(...args)=>actual.raw(...args),close:()=>actual.close()};};e=new ImapBackfill({database:f.db,ownerId:'owner',transport:changing});e.start(accountId);await until(()=>e.status(accountId).state==='attention');assert.equal(e.status(accountId).error,'uidvalidity_changed');assert.equal(f.db.get('SELECT epoch_resets FROM mail_imap_runs').epoch_resets,3);assert.equal(f.db.get("SELECT count(*) AS n FROM mail_content_manifests WHERE kind='raw' AND state='stored'").n,2);
 }finally{await e.close();}
}));
test('a superseded engine wake cannot adopt the winner run stamp or revive old dispatch',()=>fixture(async f=>{
 const c=await ready(f);await delay(20);
 const winner=new ImapBackfill({database:f.db,ownerId:'owner',transport:f.transport});
 try{
  winner.start(c.accountId);const stamp=f.db.get('SELECT generation,revision FROM mail_imap_runs WHERE account_id=?',[c.accountId]);
  const action=c.local.enqueueMutation(c.accountId,{replayKey:'takeover',locator,precondition:c.reads.read(c.accountId,locator).mutationPrecondition,change:{kind:'read',read:false}});
  c.engine.wake(c.accountId);
  assert.equal(c.engine.status(c.accountId).state,'paused');
  assert.deepEqual(f.db.get('SELECT generation,revision FROM mail_imap_runs WHERE account_id=?',[c.accountId]),stamp);
  assert.equal(c.local.readAction(c.accountId,action.id).state,'queued');assert.deepEqual(f.server.state.writeCommands,[]);
 }finally{await winner.close();}
}));
test('post-discovery refresh refuses another database connection replacing the run revision',()=>fixture(async f=>{
 const other=await openEncryptedMailDatabase({path:f.path,key:f.key});
 const winner=new ImapBackfill({database:other,ownerId:'owner',transport:f.transport});let armed=false,replaced=false,accountId;
 const wrapped={...f.db,transaction(body){const result=f.db.transaction(body);if(armed&&f.db.get('SELECT discovered FROM mail_imap_runs WHERE account_id=?',[accountId])?.discovered===1){armed=false;winner.start(accountId);replaced=true;}return result;}};
 const old=new ImapBackfill({database:wrapped,ownerId:'owner',transport:f.transport});
 try{({accountId}=await old.connect(f.input));old.start(accountId);armed=true;await until(()=>replaced);await delay(30);assert.equal(old.status(accountId).state,'paused');assert.equal(f.db.get('SELECT revision FROM mail_imap_runs WHERE account_id=?',[accountId]).revision,3);}
 finally{await old.close();await winner.close();other.close();}
}));
