import {registerMailStorageSaveRoutes} from '../../routes/mail-storage-save.js';
import {mailBackupInventory} from './backup-inventory.js';
import {MailFilingCoordinator,filingBackendKey} from '../filing-coordinator.js';
import {canonicalFilingJson} from '../filing-view.js';
import {quarantineRestoredMail} from './recovery-quarantine.js';
import {MailStorageSaveStore} from './storage-save-store.js';
import {MailStorageSaveCoordinator} from '../storage-save-coordinator.js';
import {createServer} from 'node:http';
import {createHash,randomUUID} from 'node:crypto';
import {MailFilingStore} from './filing-store.js';
import {removeLaterMailSchema} from '../testing/legacy-schema.mjs';
import {MailSearchIndexer} from '../runtime/search-indexer.js';
import {setTimeout as delay} from 'node:timers/promises';
import {MailSearchStore} from './search.js';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {GmailRunStore} from './gmail-state.js';
import {MimeProjectionStore} from './mime-projection-store.js';
import {createStoredMimeProjector} from './mime-projection.js';
import {MailContentStore} from './content-store.js';
import {MailRepository} from './repository.js';
import {MailCredentialRepository} from './credentials.js';
import {MailSyncJournal} from './sync-journal.js';
import {MailSyncExecutor} from '../runtime/sync-executor.js';
import {openEncryptedMailDatabase} from './database.js';
import {migrateMailSchema,MAIL_SCHEMA_VERSION} from './schema.js';
import {assertMailSchema} from './consistency.js';
const locator={provider:'gmail',messageId:'one'},stamp=run=>({generation:run.generation,revision:run.revision});
const mime=Buffer.from('From: Sender <sender@example.test>\r\nTo: Receiver <receiver@example.test>\r\nSubject: =?UTF-8?B?R3LDvMOfZQ==?=\r\nDate: Wed, 09 Sep 2026 10:00:00 +0000\r\nMessage-ID: <original@example.test>\r\nMIME-Version: 1.0\r\nContent-Type: multipart/mixed; boundary="parts"\r\n\r\n--parts\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nBody private marker\r\n--parts\r\nContent-Type: application/octet-stream; name="brief.bin"\r\nContent-Disposition: attachment; filename="brief.bin"\r\nContent-ID: <inline-reference>\r\nContent-Transfer-Encoding: base64\r\n\r\nAQIDBA==\r\n--parts--\r\n');
async function fixture(body){const dir=await mkdtemp(join(tmpdir(),'mail-gmail-projection-')),path=join(dir,'mail.sqlite'),key=randomBytes(32);let db=await openEncryptedMailDatabase({path,key}),now=1800000000000;const runners=[];
 migrateMailSchema(db);const f={get db(){return db;},path,get now(){return now;},advance(ms){now+=ms;},get runs(){return new GmailRunStore(db,'owner',()=>now);},get repository(){return new MailRepository(db,'owner');},get content(){return new MailContentStore(db,'owner');},get projection(){return new MimeProjectionStore(db,'owner');},get journal(){return new MailSyncJournal(db,'owner',()=>now,{retryBaseMs:10,retryMaxMs:100});},
 seed(){f.repository.createAccount({id:'a',provider:'gmail',displayName:'Synthetic'});f.repository.ingestMessage('a',{locator,rfcMessageId:null,subject:'',memberships:[]});},
 async raw(bytes=mime){return f.content.writePart('a',locator,{kind:'raw',maxBytes:bytes.length},Array.from({length:Math.ceil(bytes.length/65536)},(_,i)=>bytes.subarray(i*65536,(i+1)*65536)));},
 async project(reference,options={}){const run=f.runs.startOrResume('a'),scope={accountId:'a',generation:run.generation,scopeId:options.scopeId??'project'};
  f.journal.commitPage({...scope,expectedCursor:null,expectedRevision:0,nextCursor:null,discoveryComplete:true,jobs:[{kind:'body',locator}]},()=>{});
  const project=createStoredMimeProjector({database:db,ownerId:'owner'});const runner=new MailSyncExecutor({journal:f.journal,maxJobsPerRun:1,handler:async work=>project({accountId:'a',locator,reference,work,assertCurrent:()=>{f.runs.assertCurrent('a',stamp(run));options.assertCurrent?.();},source:options.source})});runners.push(runner);return runner.run(scope);
 },async reopen(){for(const runner of runners)runner.close();db.close();db=await openEncryptedMailDatabase({path,key});}};
 try{await body(f);}finally{for(const runner of runners)runner.close();db.close();key.fill(0);await rm(dir,{recursive:true,force:true});}}

test('retained original and attachments are verified, deduplicated and survive source removal/reopen',async()=>fixture(async f=>{
 f.seed();const credentials=new MailCredentialRepository(f.db,'owner',()=>f.now);credentials.connect('a',{provider:'gmail',clientId:'test.apps.googleusercontent.com',authority:'https://accounts.google.com',providerSubject:'subject'},null,{accessToken:'synthetic',expiresAt:f.now+1000,grantedScopes:null,refreshToken:{action:'clear'}});
 await f.project(await f.raw());const store=new MailFilingStore(f.db,'owner'),captured=store.execute({action:'capture',accountId:'a',locator});
 assert.equal(captured.snapshot.manifest.parts.length,2);assert.equal(captured.snapshot.manifest.parts[0].kind,'original');assert.equal(captured.snapshot.manifest.parts[1].content_id,'inline-reference');
 assert.equal(store.execute({action:'capture',accountId:'a',locator}).snapshot.id,captured.snapshot.id);
 const original=store.execute({action:'chunk',accountId:'a',snapshotId:captured.snapshot.id,part:0,offset:0,limit:24576});assert.deepEqual(Buffer.from(original.data,'base64'),mime);
 assert.throws(()=>new MailFilingStore(f.db,'other').execute({action:'snapshot',accountId:'a',snapshotId:captured.snapshot.id}));
 f.db.run("DELETE FROM mail_content_manifests WHERE account_id='a'");
 await f.reopen();const reopened=new MailFilingStore(f.db,'owner');assert.equal(reopened.execute({action:'snapshot',accountId:'a',snapshotId:captured.snapshot.id}).snapshot.id,captured.snapshot.id);assert.deepEqual(Buffer.from(reopened.execute({action:'chunk',accountId:'a',snapshotId:captured.snapshot.id,part:1,offset:0,limit:24576}).data,'base64'),Buffer.from([1,2,3,4]));
 assert.throws(()=>f.db.run("DELETE FROM mail_content_refs WHERE account_id='a'"));
}));

async function connectedFixture(f,body){
 const files=new Map(),writes=[],roots=['smb','webdav','s3','azure','gcs','sftp','ftp','dropbox','google-drive','microsoft'].map((kind,index)=>({id:kind,name:kind,kind:index>6?'oauth':kind,writable:true,revision:'one'}));let lose=false,holdAt=0,release;
 const server=createServer(async(req,res)=>{if(req.headers.authorization!=='Bearer server-owned'){res.writeHead(401).end();return;}const url=new URL(req.url,'http://fixture');if(url.pathname.endsWith('/roots')){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({roots}));return;}if(req.method!=='POST'||!url.pathname.endsWith('/content')){res.writeHead(404).end();return;}try{const chunks=[];for await(const chunk of req)chunks.push(chunk);const bytes=Buffer.concat(chunks),path=url.pathname+url.searchParams.get('path');writes.push(path);if(files.has(path)){res.writeHead(409).end();return;}files.set(path,bytes);if(holdAt===writes.length)await new Promise(resolve=>{release=resolve;});if(lose){lose=false;req.socket.destroy();return;}res.setHeader('Content-Type','application/json');res.end(JSON.stringify({ok:true,version:'sha256:'+createHash('sha256').update(bytes).digest('hex')}));}catch{res.destroy();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const origin='http://127.0.0.1:'+server.address().port;
 const lockListeners=[];const mail={onLock(listener){lockListeners.push(listener);return()=>{};},filing:async input=>new MailFilingStore(f.db,'owner').execute(input),storageSave:async input=>new MailStorageSaveStore(f.db,'owner').execute(input)};
 const coordinator=new MailStorageSaveCoordinator(mail,(path,input)=>fetch(origin+path,{method:input?.method??'GET',headers:{Authorization:'Bearer server-owned',...(input?.contentType?{'Content-Type':input.contentType}:{})},body:input?.body,duplex:'half',signal:input?.signal}));
 try{await body({files,writes,roots,mail,coordinator,lock(){for(const listener of lockListeners)listener();},loseResponse(){lose=true;},holdAfter(count){holdAt=count;},release(){release?.();}});}finally{release?.();await coordinator.close();server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
async function prepared(f){f.seed();new MailCredentialRepository(f.db,'owner',()=>f.now).connect('a',{provider:'gmail',clientId:'test.apps.googleusercontent.com',authority:'https://accounts.google.com',providerSubject:'subject'},null,{accessToken:'synthetic',expiresAt:f.now+1000,grantedScopes:null,refreshToken:{action:'clear'}});await f.project(await f.raw());return new MailFilingStore(f.db,'owner').execute({action:'capture',accountId:'a',locator}).snapshot;}
async function untilSave(mail,id,state){for(let i=0;i<300;i++){const current=(await mail.storageSave({action:'read',accountId:'a',id})).save;if(current.state===state)return current;await delay(10);}throw Error('save did not reach '+state);}
test('generic stream contract saves all writable storage roots with exact originals and verified receipts',async()=>fixture(async f=>{
 const snapshot=await prepared(f);await connectedFixture(f,async c=>{
  for(const root of c.roots){const input={accountId:'a',snapshotId:snapshot.id,workspaceId:'workspace',storageId:root.id,rootRevision:root.revision,folderPath:'matter/files',selection:[0,1]};const started=await c.coordinator.save(input),saved=await untilSave(c.mail,started.id,'complete');assert.equal(saved.parts.length,3);assert(saved.parts.every(part=>part.version?.startsWith('sha256:')));assert.deepEqual(c.files.get('/workspace/workspace/storage/'+root.id+'/content'+saved.folderPath+'/'+saved.parts[0].path),mime);const count=c.writes.length;assert.equal((await c.coordinator.save(input)).id,started.id);await delay(15);assert.equal(c.writes.length,count);}
  assert.equal(c.files.size,30);c.roots[0].writable=false;await assert.rejects(c.coordinator.save({accountId:'a',snapshotId:snapshot.id,workspaceId:'workspace',storageId:'smb',rootRevision:'one',folderPath:'other',selection:[0]}));assert.equal(c.files.size,30);
 });
}));
test('lost create response stays uncertain; retry never overwrites existing destination and restore blocks replay',async()=>fixture(async f=>{
 const snapshot=await prepared(f);await connectedFixture(f,async c=>{
  const input={accountId:'a',snapshotId:snapshot.id,workspaceId:'workspace',storageId:'webdav',rootRevision:'one',folderPath:'',selection:[0]};c.loseResponse();const started=await c.coordinator.save(input);await untilSave(c.mail,started.id,'uncertain');assert.equal(c.files.size,1);await c.coordinator.save(input);await untilSave(c.mail,started.id,'uncertain');assert.equal(c.files.size,1);
  f.db.run("INSERT INTO mail_recovery_quarantine(account_id,kind,entity_id,restored_at) VALUES('a','filing',?,0)",['storage-save:'+started.id]);await assert.rejects(c.coordinator.save(input));
  const fresh=new MailFilingStore(f.db,'owner').execute({action:'capture',accountId:'a',locator}).snapshot;assert.notEqual(fresh.id,snapshot.id);
 });
}));

test('cancel after remote staging preserves saved evidence and stops remaining files; explicit new copy uses fresh names',async()=>fixture(async f=>{
 const snapshot=await prepared(f);await connectedFixture(f,async c=>{
  const input={accountId:'a',snapshotId:snapshot.id,workspaceId:'workspace',storageId:'webdav',rootRevision:'one',folderPath:'same',selection:[0,1]};c.holdAfter(2);
  const started=await c.coordinator.save(input);for(let i=0;i<300&&c.files.size<2;i++)await delay(10);assert.equal(c.files.size,2);
  const cancelled=await c.coordinator.cancel('workspace','a',started.id);assert.equal(cancelled.state,'cancelled');assert.equal(cancelled.parts[0].state,'saved');assert.ok(cancelled.parts[0].version);assert.equal(cancelled.parts[1].state,'uncertain');assert.equal(cancelled.parts[2].state,'queued');
  c.release();await delay(40);assert.equal(c.writes.length,2);assert.equal((await c.mail.storageSave({action:'read',accountId:'a',id:started.id})).save.state,'cancelled');
  const fresh=await c.coordinator.save({...input,fresh:true});assert.notEqual(fresh.id,started.id);assert.notEqual(fresh.snapshotId,snapshot.id);const saved=await untilSave(c.mail,fresh.id,'complete');assert.equal(saved.folderPath,cancelled.folderPath);assert.notEqual(saved.parts[0].path,cancelled.parts[0].path);assert.equal(c.files.size,5);
 });
}));
test('shutdown aborts an ambiguous upload without scheduling more; restored same-folder save is deliberate fresh intent',async()=>fixture(async f=>{
 const snapshot=await prepared(f);await connectedFixture(f,async c=>{
  const input={accountId:'a',snapshotId:snapshot.id,workspaceId:'workspace',storageId:'webdav',rootRevision:'one',folderPath:'same',selection:[0,1]};c.holdAfter(1);const started=await c.coordinator.save(input);for(let i=0;i<300&&c.files.size<1;i++)await delay(10);
  await c.coordinator.close();assert.equal(c.writes.length,1);assert.equal((await c.mail.storageSave({action:'read',accountId:'a',id:started.id})).save.state,'uncertain');await assert.rejects(c.coordinator.save(input));c.release();
  f.db.run("INSERT INTO mail_recovery_quarantine(account_id,kind,entity_id,restored_at) VALUES('a','filing',?,0)",['storage-save:'+started.id]);const store=new MailStorageSaveStore(f.db,'owner');assert.throws(()=>store.execute({action:'create',...input}));const fresh=store.execute({action:'create',...input,fresh:true}).save;assert.equal(fresh.quarantined,false);assert.notEqual(fresh.id,started.id);assert.equal(fresh.folderPath,'same');assert.equal(f.db.get('SELECT count(*) n FROM mail_filing_parts WHERE snapshot_id=?',[fresh.snapshotId]).n,2);
 });
}));

async function matterFixture(f,body){
 let readable=true,changed=false,loseCommit=false;const receipts=new Map(),uploads=new Map(),calls=[];
 const server=createServer(async(req,res)=>{try{if(req.headers.authorization!=='Bearer synthetic-user'){res.writeHead(401).end();return;}let text='';for await(const chunk of req)text+=chunk;const rpc=JSON.parse(text);if(rpc.method!=='tools/call'){res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{}}));return;}const {name,arguments:a}=rpc.params;calls.push({name,args:a});let value;
  if(name==='list_mail_filing_destinations')value={version:1,principal_key:'d'.repeat(64),results:[{id:'matter',title:'Authorized matter',project_id:'project'}],next_offset:null};
  else if(name==='authorized_mail_filings'){assert.ok(a.filing_ids.length<=200);value={receipts:readable?a.filing_ids.map(id=>receipts.get(id)).filter(Boolean).map(r=>({id:r.id,matter_id:r.matter_id,project_id:r.project_id,manifest_hash:r.manifest_hash})):[]};}
  else if(name==='begin_mail_filing'){let job=[...uploads.values()].find(job=>job.key===a.replay_key);if(!job){job={id:randomUUID(),key:a.replay_key,manifest:a.manifest,bytes:a.manifest.parts.map(()=>Buffer.alloc(0))};uploads.set(job.id,job);}value={id:job.id,state:'uploading',offsets:job.bytes.map(b=>b.length)};}
  else if(name==='upload_mail_filing_chunk'){const job=uploads.get(a.filing_id);assert.equal(a.offset,job.bytes[a.part].length);job.bytes[a.part]=Buffer.concat([job.bytes[a.part],Buffer.from(a.data,'base64')]);value={id:job.id,state:'uploading',offsets:job.bytes.map(b=>b.length)};}
  else if(name==='commit_mail_filing'){const job=uploads.get(a.filing_id);for(const [i,bytes] of job.bytes.entries()){assert.equal(bytes.length,job.manifest.parts[i].size);assert.equal(createHash('sha256').update(bytes).digest('hex'),job.manifest.parts[i].sha256);}value=receipt(job.id,job.manifest);receipts.set(value.id,value);if(loseCommit){loseCommit=false;req.socket.destroy();return;}}
  else throw Error('Unexpected RPC');res.setHeader('Content-Type','application/json');res.end(JSON.stringify({jsonrpc:'2.0',id:rpc.id,result:{structuredContent:value}}));
 }catch(error){res.writeHead(500).end();}});
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));const binding={server:{name:'Synthetic matter backend',url:'http://127.0.0.1:'+server.address().port},bearer:'synthetic-user'},mail={filing:async input=>new MailFilingStore(f.db,'owner').execute(input)},coordinator=new MailFilingCoordinator(mail);
 try{await body({binding,mail,coordinator,receipts,uploads,calls,resolve:async()=>changed?{...binding,bearer:'changed'}:binding,revoke(){readable=false;},change(){changed=true;},lose(){loseCommit=true;}});}finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
}
function receipt(id,manifest){return{id,state:'committed',matter_id:'matter',project_id:'project',manifest_hash:createHash('sha256').update(canonicalFilingJson(manifest)).digest('hex'),filed_at:new Date().toISOString(),parts:manifest.parts.map((part,ordinal)=>({ordinal,document_id:randomUUID(),version_id:randomUUID(),source_object_id:randomUUID(),sha256:part.sha256,size:part.size})),ingestion:'queued'};}
function seedReceipt(f,c,snapshot){const id=randomUUID(),remote=receipt(randomUUID(),snapshot.manifest);c.receipts.set(remote.id,remote);f.db.run("INSERT INTO mail_matter_filings(id,snapshot_id,workspace_id,backend_key,principal_key,matter_id,state,remote_id,receipt_json,generation,created_at,updated_at) VALUES(?,?,?,?,?,?,'filed',?,?,?,0,0)",[id,snapshot.id,'workspace',filingBackendKey(c.binding),createHash('sha256').update(id).digest('hex'),'matter',remote.id,JSON.stringify(remote),new MailCredentialRepository(f.db,'owner').status('a').version.generation]);return id;}
test('authorized matter scope gathers all 501 receipts in bounded RPCs before count/snippets and denies revoked reads',async()=>fixture(async f=>{
 const snapshot=await prepared(f);new MailSearchStore(f.db,'owner').rebuild({accountId:'a',limit:25});await matterFixture(f,async c=>{
  for(let i=0;i<501;i++)seedReceipt(f,c,snapshot);const search=await c.coordinator.search('workspace',['a'],'matter',{keywords:['private']},c.resolve);assert.equal(search.total,1);assert.match(search.items[0].snippet,/private/i);assert.deepEqual(c.calls.filter(call=>call.name==='authorized_mail_filings').map(call=>call.args.filing_ids.length),[200,200,101]);
  const version=await c.coordinator.authorizeSource('workspace','a',locator,'matter',c.resolve);await c.coordinator.assertSourceVersion('a',locator,version);
  c.revoke();const denied=await c.coordinator.search('workspace',['a'],'matter',{keywords:['private']},c.resolve);assert.equal(denied.total,0);assert.deepEqual(denied.items,[]);assert.equal(denied.pending,0);assert.equal(denied.incomplete,0);await assert.rejects(c.coordinator.authorizeSource('workspace','a',locator,'matter',c.resolve));
 });
}));
test('V1 receipt never grants V2 body/attachment count, snippet, source read or export after same-key projection changes',async()=>fixture(async f=>{
 const snapshot=await prepared(f);new MailSearchStore(f.db,'owner').rebuild({accountId:'a',limit:25});await matterFixture(f,async c=>{
  seedReceipt(f,c,snapshot);const version=await c.coordinator.authorizeSource('workspace','a',locator,'matter',c.resolve);
  const v2=Buffer.from(mime.toString().replace('Body private marker','Unfiledsecret body').replace('AQIDBA==','BQYHCA=='));
  f.db.run("DELETE FROM mail_sync_jobs WHERE account_id='a'");await f.project(await f.raw(v2),{scopeId:'v2'});new MailSearchStore(f.db,'owner').rebuild({accountId:'a',limit:25});
  assert.equal(new MailSearchStore(f.db,'owner').search({accountIds:['a'],keywords:['Unfiledsecret']}).total,1);
  const denied=await c.coordinator.search('workspace',['a'],'matter',{keywords:['Unfiledsecret']},c.resolve);assert.equal(denied.total,0);assert.deepEqual(denied.items,[]);assert.equal(denied.pending,0);await assert.rejects(c.coordinator.authorizeSource('workspace','a',locator,'matter',c.resolve));await assert.rejects(c.coordinator.assertSourceVersion('a',locator,version));
  const retained=await c.mail.filing({action:'chunk',accountId:'a',snapshotId:snapshot.id,part:0,offset:0,limit:24576});assert.deepEqual(Buffer.from(retained.data,'base64'),mime);
 });
}));
test('matter upload uses exact pinned bytes, durable lost-commit replay key and current binding fence',async()=>fixture(async f=>{
 const snapshot=await prepared(f);await matterFixture(f,async c=>{
  c.lose();const item=await c.coordinator.file('workspace','a',snapshot.id,'matter',c.resolve);for(let i=0;i<300;i++){if(f.db.get('SELECT state FROM mail_matter_filings WHERE id=?',[item.id]).state==='uncertain')break;await delay(10);}assert.equal(f.db.get('SELECT state FROM mail_matter_filings WHERE id=?',[item.id]).state,'uncertain');assert.equal(c.uploads.size,1);
  await c.coordinator.file('workspace','a',snapshot.id,'matter',c.resolve);for(let i=0;i<300;i++){if(f.db.get('SELECT state FROM mail_matter_filings WHERE id=?',[item.id]).state==='filed')break;await delay(10);}assert.equal(f.db.get('SELECT state FROM mail_matter_filings WHERE id=?',[item.id]).state,'filed');assert.equal(c.uploads.size,1);assert.deepEqual([...c.uploads.values()][0].bytes[0],mime);
  let resolutions=0;await assert.rejects(c.coordinator.search('workspace',['a'],'matter',{keywords:['private']},async()=>{resolutions++;return resolutions===1?c.binding:{...c.binding,bearer:'changed'};}));
 });
}));
test('restore quarantines complete and in-flight saves while preserving accepted file versions and pins',async()=>fixture(async f=>{
 const snapshot=await prepared(f),store=new MailStorageSaveStore(f.db,'owner'),input={action:'create',accountId:'a',snapshotId:snapshot.id,workspaceId:'workspace',storageId:'webdav',rootRevision:'one',folderPath:'same',selection:[0]};let save=store.execute(input).save;
 for(const part of save.parts){save=store.execute({action:'part',accountId:'a',id:save.id,revision:save.revision,generation:save.generation,ordinal:part.ordinal,state:'saved',version:'verified',error:null}).save;}const pending=store.execute({...input,fresh:true}).save;
 quarantineRestoredMail(f.db);const complete=store.execute({action:'read',accountId:'a',id:save.id}).save,restored=store.execute({action:'read',accountId:'a',id:pending.id}).save;assert.equal(complete.state,'complete');assert.equal(complete.quarantined,true);assert.ok(complete.parts.every(p=>p.version==='verified'));assert.equal(restored.state,'uncertain');assert.equal(restored.quarantined,true);assert.equal(f.db.get('SELECT count(*) n FROM mail_filing_parts').n,4);assert.throws(()=>store.execute(input));const fresh=store.execute({...input,fresh:true}).save;assert.equal(fresh.quarantined,false);assert.notEqual(fresh.id,save.id);
}));

test('custody lock synchronously aborts active shared requests and permits only explicit new work after reopen',async()=>fixture(async f=>{
 const snapshot=await prepared(f);await connectedFixture(f,async c=>{const input={accountId:'a',snapshotId:snapshot.id,workspaceId:'workspace',storageId:'webdav',rootRevision:'one',folderPath:'locked',selection:[0,1]};c.holdAfter(1);const started=await c.coordinator.save(input);for(let i=0;i<300&&c.files.size<1;i++)await delay(10);c.lock();await untilSave(c.mail,started.id,'uncertain');c.release();await delay(30);assert.equal(c.writes.length,1);const copy=await c.coordinator.save({...input,fresh:true});await untilSave(c.mail,copy.id,'complete');assert.equal(c.files.size,4);});
}));

test('shutdown aborts stalled root lookups and fences an already pending create before scheduling',async()=>fixture(async f=>{
 const snapshot=await prepared(f),store=new MailStorageSaveStore(f.db,'owner'),input={accountId:'a',snapshotId:snapshot.id,workspaceId:'workspace',storageId:'webdav',rootRevision:'one',folderPath:'',selection:[0]};let roots=0,posts=0,removed=false;
 const mail={onLock(){return()=>{removed=true;};},filing:async input=>new MailFilingStore(f.db,'owner').execute(input),storageSave:async input=>store.execute(input)};
 const coordinator=new MailStorageSaveCoordinator(mail,async(path,request)=>{if(request?.method==='POST'){posts++;throw Error('Unexpected upload');}if(++roots===1)return Response.json({roots:[{id:'webdav',name:'WebDAV',kind:'webdav',writable:true,revision:'one'}]});return new Promise((_resolve,reject)=>{if(request.signal.aborted)reject(Error('aborted'));else request.signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true});});});
 const started=await coordinator.save(input);for(let i=0;i<100&&roots<2;i++)await delay(5);await Promise.race([coordinator.close(),delay(1000).then(()=>{throw Error('stalled close');})]);assert.equal(removed,true);assert.equal(posts,0);assert.equal(store.execute({action:'read',accountId:'a',id:started.id}).save.state,'uncertain');
 let release,created;const second=new MailStorageSaveCoordinator({...mail,storageSave:async input=>{const result=store.execute(input);if(input.action==='create'){created=result.save;await new Promise(resolve=>{release=resolve;});}return result;}},async()=>Response.json({roots:[{id:'webdav',name:'WebDAV',kind:'webdav',writable:true,revision:'one'}]}));
 const pending=second.save({...input,folderPath:'pending'});const rejected=assert.rejects(pending);for(let i=0;i<100&&!release;i++)await delay(5);await second.close();release();await rejected;assert.equal(store.execute({action:'read',accountId:'a',id:created.id}).save.state,'cancelled');assert.equal(posts,0);
}));
test('backup verification rejects a storage receipt with mismatched retained content evidence',async()=>fixture(async f=>{
 const snapshot=await prepared(f),store=new MailStorageSaveStore(f.db,'owner'),save=store.execute({action:'create',accountId:'a',snapshotId:snapshot.id,workspaceId:'workspace',storageId:'webdav',rootRevision:'one',folderPath:'',selection:[0]}).save;
 assert.equal(mailBackupInventory(f.db,'owner').retainedRecords,1);f.db.run('UPDATE mail_storage_save_parts SET sha256=? WHERE save_id=? AND ordinal=0',['0'.repeat(64),save.id]);assert.throws(()=>mailBackupInventory(f.db,'owner'));
}));

test('host route authorizes workspace before shared credentials and forwards a real save intent',async()=>fixture(async f=>{
 const snapshot=await prepared(f),routes=[],mail={filing:async input=>new MailFilingStore(f.db,'owner').execute(input),storageSave:async input=>new MailStorageSaveStore(f.db,'owner').execute(input)};let remoteCalls=0;
 const coordinator=registerMailStorageSaveRoutes({routes,host:'127.0.0.1',mail,workspaces:()=>[{id:'workspace',name:'Workspace'}],resolveWorkspace:async id=>{if(id!=='workspace')throw Error('unauthorized workspace');},request:async(path,input)=>{remoteCalls++;if(input?.method==='POST'){const bytes=Buffer.from(await new Response(input.body).arrayBuffer());return Response.json({ok:true,version:createHash('sha256').update(bytes).digest('hex')});}return Response.json({roots:[{id:'root',name:'Root',kind:'oauth',writable:true,revision:'one'}]});}});
 const invoke=(body,actor={type:'host'})=>routes[0].handler({actor,request:new Request('http://127.0.0.1/mail/v1/storage-save',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(body)})});
 try{assert.equal(routes[0].auth,'host-token');await assert.rejects(invoke({action:'roots',workspaceId:'workspace'},{type:'client'}));await assert.rejects(invoke({action:'roots',workspaceId:'other'}));assert.equal(remoteCalls,0);await assert.rejects(invoke({action:'roots',workspaceId:'workspace',token:'caller-token'}));assert.equal(remoteCalls,0);
  const response=await invoke({action:'save',accountId:'a',snapshotId:snapshot.id,workspaceId:'workspace',storageId:'root',rootRevision:'one',folderPath:'',selection:[0]});const started=(await response.json()).save;await untilSave(mail,started.id,'complete');assert.ok(remoteCalls>=3);
 }finally{await coordinator.close();}
}));

test('provider-native attachment publication invalidates old source scope and is included in a fresh retained snapshot',async()=>fixture(async f=>{
 const snapshot=await prepared(f);await matterFixture(f,async c=>{seedReceipt(f,c,snapshot);const version=await c.coordinator.authorizeSource('workspace','a',locator,'matter',c.resolve);const secret=Buffer.from('Unfiled native attachment');await f.content.writePart('a',locator,{kind:'attachment',partId:'provider-extra',maxBytes:secret.length},[secret]);await assert.rejects(c.coordinator.assertSourceVersion('a',locator,version));await assert.rejects(c.coordinator.authorizeSource('workspace','a',locator,'matter',c.resolve));const fresh=(await c.mail.filing({action:'capture',accountId:'a',locator})).snapshot;assert.equal(fresh.manifest.parts.length,3);assert.ok(fresh.manifest.parts.some(part=>part.sha256===createHash('sha256').update(secret).digest('hex')));});
}));

test('cancel between authorization batches drops its one-shot scope and never starts a mail query',async()=>fixture(async f=>{
 const snapshot=await prepared(f);await matterFixture(f,async c=>{for(let i=0;i<201;i++)seedReceipt(f,c,snapshot);const original=c.mail.filing;let queries=0,drops=0,controller;
  c.mail.filing=async input=>{const result=await original(input);if(input.action==='scope-add')controller?.abort();if(input.action==='scope-drop')drops++;if(input.action==='search')queries++;return result;};
  for(let i=0;i<5;i++){controller=new AbortController();await assert.rejects(c.coordinator.search('workspace',['a'],'matter',{keywords:['private']},c.resolve,controller.signal));}
  assert.equal(drops,5);assert.equal(queries,0);assert.equal(c.calls.filter(call=>call.name==='authorized_mail_filings').length,5);
  const aborted=new AbortController();aborted.abort();await assert.rejects(c.coordinator.authorizeSource('workspace','a',locator,'matter',c.resolve,aborted.signal));
  controller=undefined;new MailSearchStore(f.db,'owner').rebuild({accountId:'a',limit:25});assert.equal((await c.coordinator.search('workspace',['a'],'matter',{keywords:['private']},c.resolve)).total,1);
 });
}));

test('long Unicode attachment names fit portable filename byte limits on a real temporary filesystem',async()=>fixture(async f=>{
 const snapshot=await prepared(f);snapshot.manifest.parts[1].filename='秘密😀'.repeat(100)+'.pdf';const json=JSON.stringify(snapshot.manifest);f.db.run('UPDATE mail_filing_snapshots SET manifest_json=?,manifest_hash=? WHERE id=?',[json,createHash('sha256').update(json).digest('hex'),snapshot.id]);const save=new MailStorageSaveStore(f.db,'owner').execute({action:'create',accountId:'a',snapshotId:snapshot.id,workspaceId:'workspace',storageId:'sftp',rootRevision:'one',folderPath:'',selection:[1]}).save;
 const directory=await mkdtemp(join(tmpdir(),'mail-unicode-filename-'));try{const path=save.parts[0].path;assert.ok(Buffer.byteLength(path)<=255);assert.ok(path.length<=240);assert.equal(path.endsWith('.pdf'),true);assert.equal(path.includes('�'),false);await writeFile(join(directory,path),Buffer.from([1,2,3,4]));assert.deepEqual(await readFile(join(directory,path)),Buffer.from([1,2,3,4]));}finally{await rm(directory,{recursive:true,force:true});}
}));
