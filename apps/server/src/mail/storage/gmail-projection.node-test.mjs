import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
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
 async raw(bytes=mime){return f.content.writePart('a',locator,{kind:'raw',maxBytes:bytes.length},[bytes]);},
 async project(reference,options={}){const run=f.runs.startOrResume('a'),scope={accountId:'a',generation:run.generation,scopeId:options.scopeId??'project'};
  f.journal.commitPage({...scope,expectedCursor:null,expectedRevision:0,nextCursor:null,discoveryComplete:true,jobs:[{kind:'body',locator}]},()=>{});
  const project=createStoredMimeProjector({database:db,ownerId:'owner'});const runner=new MailSyncExecutor({journal:f.journal,maxJobsPerRun:1,handler:async work=>project({accountId:'a',locator,reference,work,assertCurrent:()=>{f.runs.assertCurrent('a',stamp(run));options.assertCurrent?.();},source:options.source})});runners.push(runner);return runner.run(scope);
 },async reopen(){for(const runner of runners)runner.close();db.close();db=await openEncryptedMailDatabase({path,key});}};
 try{await body(f);}finally{for(const runner of runners)runner.close();db.close();key.fill(0);await rm(dir,{recursive:true,force:true});}}
test('run generation, fixed recent boundary, retry budget, CAS and explicit completion survive reopen',async()=>fixture(async f=>{
 f.seed();const first=f.runs.startOrResume('a');assert.equal(first.recentAfter,Math.floor(f.now/1000)-30*86400);
 const paused=f.runs.setState('a',stamp(first),'paused',{failureCount:3,nextRetryAt:f.now+999,error:'rate_limited'});await f.reopen();f.advance(86400000);
 const resumed=f.runs.startOrResume('a');assert.equal(resumed.generation,first.generation);assert.equal(resumed.recentAfter,first.recentAfter);assert.equal(resumed.failureCount,3);assert.equal(resumed.nextRetryAt,paused.nextRetryAt);assert.throws(()=>f.runs.assertCurrent('a',stamp(first)),{code:'stale_run'});
 const done=f.runs.setState('a',stamp(resumed),'complete',{failureCount:0});assert.deepEqual(f.runs.startOrResume('a'),{...done,state:'active',revision:done.revision+1});
 new MailRepository(f.db,'other').createAccount({id:'foreign',provider:'gmail',displayName:'Other'});assert.throws(()=>f.runs.read('foreign'),{code:'not_found'});
}));
test('provider envelope survives malformed MIME, updates exact thread/labels and preserves raw',async()=>fixture(async f=>{
 f.seed();f.repository.putFolder('a',{id:'known',name:'Readable label',kind:'label'});
 f.runs.putGmailMetadata('a',locator,{internalDate:1234,threadId:'thread-one',labelIds:['known','new','new']});
 const malformed=Buffer.from('Content-Type: multipart/mixed; boundary=missing\r\n\r\nno closing boundary');const ref=await f.raw(malformed);
 assert.equal((await f.project(ref)).retry,1);assert.equal(f.projection.read('a',locator).state,'error');assert.equal(f.repository.readMessage('a',locator).contentState,'downloading');
 const message=f.repository.readMessage('a',locator);assert.equal(message.thread_id,'thread-one');assert.deepEqual(message.memberships,['known','new']);assert.deepEqual(f.runs.readGmailMetadata('a',locator),{internalDate:1234,threadId:'thread-one',labelIds:['known','new']});
 assert.equal(f.repository.listFoldersPage('a').items.find(x=>x.id==='known').name,'Readable label');assert.deepEqual(Buffer.concat([...f.content.read('a',ref.id)]),malformed);
}));
test('raw to MIME projection commits body/attachments/decoded headers and job success with encrypted restart',async()=>fixture(async f=>{
 f.seed();f.runs.putGmailMetadata('a',locator,{internalDate:1234,threadId:'gmail-thread',labelIds:['INBOX']});const ref=await f.raw();assert.equal((await f.project(ref)).succeeded,1);
 let projection=f.projection.read('a',locator);assert.equal(projection.state,'complete');assert.equal(projection.metadata.subject,'Grüße');assert.equal(projection.metadata.from,'Sender <sender@example.test>');assert.equal(projection.attachments[0].filename,'brief.bin');assert.equal(projection.attachments[0].contentId,'inline-reference');assert.equal(projection.attachments[0].reference.bytes,4);
 assert.deepEqual([...Buffer.concat([...f.content.read('a',projection.attachments[0].reference.id)])],[1,2,3,4]);const bodies=JSON.parse(Buffer.concat([...f.content.read('a',projection.body.id)]));assert.equal(bodies.version,1);assert.ok(bodies.bodies.some(body=>body.text.includes('Body private marker')));
 assert.equal(f.repository.readMessage('a',locator).contentState,'complete');assert.equal(f.repository.readMessage('a',locator).thread_id,'gmail-thread');
 for(const file of [f.path,f.path+'-wal'])assert.equal((await readFile(file)).includes(Buffer.from('Body private marker')),false);
 await f.reopen();projection=f.projection.read('a',locator);assert.equal(projection.metadata.subject,'Grüße');assert.deepEqual(Buffer.concat([...f.content.read('a',ref.id)]),mime);
}));
test('same raw hash preserves current projection; changed raw clears only derived completeness and retains originals',async()=>fixture(async f=>{
 f.seed();const ref=await f.raw();await f.project(ref);const projection=f.projection.read('a',locator);
 await f.raw();assert.equal(f.repository.readMessage('a',locator).contentState,'complete');assert.equal(f.projection.read('a',locator).body.id,projection.body.id);
 const changed=await f.raw(Buffer.from('Subject: Changed\r\n\r\nNew body'));assert.equal(f.repository.readMessage('a',locator).contentState,'downloading');assert.equal(f.projection.read('a',locator),null);assert.equal(f.repository.readMessage('a',locator).content.length,1);
 assert.deepEqual(Buffer.concat([...f.content.read('a',ref.id)]),mime);assert.ok(f.db.get('SELECT 1 AS found FROM mail_mime_projections WHERE raw_ref_id=?',[ref.id]));assert.notEqual(ref.id,changed.id);
}));
test('credential change during source consumption fences final projection and preserves original',async()=>fixture(async f=>{
 f.seed();const ref=await f.raw();const credentials=new MailCredentialRepository(f.db,'owner',()=>f.now),binding={provider:'gmail',clientId:'synthetic.apps.googleusercontent.com',authority:'https://accounts.google.com',providerSubject:'synthetic'};
 const version=credentials.connect('a',binding,null,{accessToken:'synthetic-token',expiresAt:f.now+10000,grantedScopes:null,refreshToken:{action:'clear'}});
 async function* source(){yield mime;credentials.disconnect('a',version);}
 const result=await f.project(ref,{source:source(),assertCurrent:()=>{const status=credentials.status('a');if(status.state!=='connected'||status.version.generation!==version.generation)throw Error('credential fence');}});
 assert.equal(result.succeeded,0);assert.notEqual(f.repository.readMessage('a',locator).contentState,'complete');assert.deepEqual(Buffer.concat([...f.content.read('a',ref.id)]),mime);
}));
test('v5 migration is atomic and idempotent, guard rejects incomplete v6',async()=>fixture(async f=>{
 for(const row of f.db.all("SELECT name FROM sqlite_schema WHERE type='trigger' AND name GLOB 'mail_local_*'"))f.db.exec('DROP TRIGGER "'+row.name+'"');f.db.exec('DROP TABLE mail_local_action_drafts; DROP TABLE mail_local_draft_parts; DROP TABLE mail_local_draft_versions; DROP TABLE mail_local_drafts; DROP TABLE mail_imap_folders; DROP TABLE mail_imap_runs; DROP TABLE mail_imap_messages; DROP TABLE mail_imap_credentials; DROP TRIGGER mail_known_inbox; DROP INDEX mail_folder_role; ALTER TABLE mail_folders DROP COLUMN role; DROP TABLE mail_graph_delta_seen; DROP TABLE mail_graph_delta; DROP TABLE mail_graph_poll; DROP TABLE mail_local_events; DROP TABLE mail_local_event_streams');f.db.exec("DROP TABLE mail_graph_attachments; DROP TABLE mail_graph_messages; DROP TABLE mail_graph_folder_queue; DROP TABLE mail_graph_runs");
 for(const row of f.db.all("SELECT name FROM sqlite_schema WHERE type='trigger' AND name GLOB 'mail_search_*'"))f.db.exec('DROP TRIGGER "'+row.name+'"');
 f.db.exec('DROP TABLE mail_search_fts; DROP TABLE mail_search_documents; DROP TABLE mail_search_dirty; ALTER TABLE mail_messages DROP COLUMN is_read');
 f.seed();f.db.exec('DROP TRIGGER mail_raw_projection_insert; DROP TRIGGER mail_raw_projection_update; DROP TABLE mail_mime_parts; DROP TABLE mail_mime_projections; DROP TABLE mail_gmail_metadata; DROP TABLE mail_gmail_presence; DROP TABLE mail_gmail_runs; UPDATE mail_schema_version SET version=5');
 const failing={...f.db,exec(sql){if(sql.includes('CREATE TABLE mail_gmail_runs')){f.db.exec(sql);throw Error('injected migration failure');}f.db.exec(sql);}};
 assert.throws(()=>migrateMailSchema(failing));assert.equal(f.db.get('SELECT version FROM mail_schema_version').version,5);assert.equal(f.db.get("SELECT name FROM sqlite_schema WHERE name='mail_gmail_runs'"),undefined);
 migrateMailSchema(f.db);migrateMailSchema(f.db);assertMailSchema(f.db);assert.equal(f.db.get('SELECT version FROM mail_schema_version').version,MAIL_SCHEMA_VERSION);assert.equal(f.repository.listAccounts().length,1);
 f.db.exec('DROP TABLE mail_gmail_runs');assert.throws(()=>assertMailSchema(f.db));
}));
test('progress deduplicates scopes and requires every current projected attachment',async()=>fixture(async f=>{
 f.seed();const run=f.runs.startOrResume('a'),ref=await f.raw();
 for(const scopeId of ['gmail:recent','gmail:all'])f.journal.commitPage({accountId:'a',generation:run.generation,scopeId,expectedCursor:null,expectedRevision:0,nextCursor:null,discoveryComplete:true,jobs:[{kind:'raw',locator}]},()=>{});
 const [raw]=f.journal.claim({accountId:'a',generation:run.generation,scopeId:'gmail:recent'},1);f.journal.succeed('a',raw.id,raw.lease_token,()=>{});await f.project(ref);
 const progress=f.runs.progress('a',run.generation);assert.equal(progress.enumerated,1);assert.equal(progress.downloaded,1);assert.equal(progress.projected,1);assert.equal(progress.pending,0);assert.equal(progress.enumerationComplete,true);
 f.db.run("DELETE FROM mail_content_manifests WHERE account_id='a' AND kind='attachment'");assert.equal(f.runs.progress('a',run.generation).projected,0);
}));
