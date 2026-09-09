import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, rm, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { openEncryptedMailDatabase } from './database.js';
import { migrateMailSchema, MAIL_SCHEMA_VERSION } from './schema.js';
import { assertMailSchema } from './consistency.js';
import { MailRepository } from './repository.js';
import { MailActionJournal } from './action-journal.js';
const input = (extra={})=>({kind:'submission',replayKey:'request-one',payloadJson:'{"draftId":"synthetic-private-payload-marker"}',precondition:null,conflictPolicy:'manual',retry:{maxAttempts:2,retryBaseMs:10,retryMaxMs:20},...extra});
const fails = code=>({message:`mail_action_${code}`});
async function fixture(body){
 const directory=await mkdtemp(join(tmpdir(),'legalwork-actions-')),path=join(directory,'mail.sqlite'),key=randomBytes(32);
 let db=await openEncryptedMailDatabase({path,key}),now=1000,open=true;
 migrateMailSchema(db);const accounts=new MailRepository(db,'owner');
 for(const id of ['a','b'])accounts.createAccount({id,provider:'gmail',displayName:'Synthetic'});
 new MailRepository(db,'other').createAccount({id:'foreign',provider:'gmail',displayName:'Foreign'});
 const close=()=>{if(open){db.close();open=false;}};
 try{await body({get db(){return db},path,key,clock:()=>now,journal:()=>new MailActionJournal(db,'owner',()=>now),setTime:n=>{now=n},close,
  async reopen(){close();db=await openEncryptedMailDatabase({path,key});open=true;}});}
 finally{close();key.fill(0);await rm(directory,{recursive:true,force:true});}
}
test('account-local replay keys preserve intent, duplicates do not reset success or conflate accounts',async()=>fixture(async f=>{
 let journal=f.journal();const one=journal.enqueue('a',input());
 assert.deepEqual(journal.enqueue('a',input()),one);
 assert.notEqual(journal.enqueue('b',input()).id,one.id);
 for(const changed of [{payloadJson:'{"draftId":"other"}'},{kind:'mutation'},{precondition:'etag'},{retry:{maxAttempts:1,retryBaseMs:10,retryMaxMs:20}},{conflictPolicy:'refresh_then_reapply',kind:'mutation'}])assert.throws(()=>journal.enqueue('a',input(changed)),fails('replay_conflict'));
 const work=journal.claim('a');journal.markDispatched(work.lease);journal.recordOutcome(work.lease,'succeeded');
 await f.reopen();journal=f.journal();assert.equal(journal.enqueue('a',input()).state,'succeeded');assert.equal(journal.claim('a'),null);
 for(const file of [f.path,`${f.path}-wal`]){const bytes=await readFile(file);assert.equal(bytes.includes(Buffer.from('synthetic-private-payload-marker')),false);}
}));
test('owner/account lease boundaries and fixed redaction reject foreign or malformed work',async()=>fixture(f=>{
 const journal=f.journal(),job=journal.enqueue('a',input()),work=journal.claim('a');
 const other=new MailActionJournal(f.db,'other',f.clock);
 for(const run of [()=>other.read('a',job.id),()=>other.claim('a'),()=>other.enqueue('a',input()),()=>other.legacyStatus('a'),()=>other.recoverExpired('a'),()=>other.markDispatched(work.lease),()=>journal.enqueue('foreign',input())])assert.throws(run,fails('account_not_found'));
 assert.throws(()=>journal.markDispatched({...work.lease,accountId:'b'}),fails('not_found'));
 assert.throws(()=>journal.markDispatched({...work.lease,token:'00000000-0000-4000-8000-000000000000'}),fails('stale_lease'));
 for(const change of [{payloadJson:'[]'},{payloadJson:'null'},{payloadJson:'{'},{payloadJson:JSON.stringify({x:'ü'.repeat(20000)})},{replayKey:'x\n'},{kind:'submission',conflictPolicy:'refresh_then_reapply'}])assert.throws(()=>journal.enqueue('a',input(change)),fails('invalid_input'));
 assert.throws(()=>new MailActionJournal({...f.db,get(){throw Error('synthetic-secret')}},'owner'),fails('storage_unavailable'));
 assert.equal(JSON.stringify(journal.list('a')).includes('synthetic-private'),false);
}));
test('only safe pre-dispatch failures retry; backoff and exhausted attempts survive reopen',async()=>fixture(async f=>{
 let journal=f.journal();const job=journal.enqueue('a',input());let work=journal.claim('a',10);
 assert.equal(journal.failBeforeDispatch(work.lease,true).availableAt,1010);assert.equal(journal.claim('a'),null);
 await f.reopen();journal=f.journal();f.setTime(1009);assert.equal(journal.claim('a'),null);f.setTime(1010);work=journal.claim('a');
 assert.equal(work.status.attempts,2);assert.equal(journal.failBeforeDispatch(work.lease,true).state,'failed');
 f.setTime(100000);assert.equal(journal.claim('a'),null);assert.equal(journal.read('a',job.id).lastError,'preflight_retryable');
 const retry=journal.enqueue('a',input({replayKey:'expiring',retry:{maxAttempts:3,retryBaseMs:10,retryMaxMs:15}}));
 work=journal.claim('a',1);f.setTime(100001);assert.equal(journal.recoverExpired('a'),1);assert.equal(journal.read('a',retry.id).availableAt,100011);
 assert.throws(()=>journal.markDispatched(work.lease),fails('stale_lease'));f.setTime(100011);work=journal.claim('a');assert.equal(journal.failBeforeDispatch(work.lease,true).availableAt,100026);
}));
test('dispatch commit fences unsafe retry and recovery never automatically resends',async()=>fixture(async f=>{
 let journal=f.journal();const job=journal.enqueue('a',input());const work=journal.claim('a',10);
 assert.throws(()=>journal.recordOutcome(work.lease,'succeeded'),fails('invalid_state'));
 journal.markDispatched(work.lease);
 assert.throws(()=>journal.failBeforeDispatch(work.lease,true),fails('invalid_state'));
 assert.throws(()=>journal.markDispatched(work.lease),fails('invalid_state'));
 await f.reopen();journal=f.journal();f.setTime(1010);assert.equal(journal.recoverExpired('a'),1);
 const uncertain=journal.read('a',job.id);assert.equal(uncertain.state,'uncertain');assert.equal(uncertain.lastError,'outcome_unknown');assert.equal(journal.claim('a'),null);
 assert.throws(()=>journal.recordOutcome(work.lease,'succeeded'),fails('stale_lease'));
 assert.equal(journal.enqueue('a',input()).state,'uncertain');assert.throws(()=>journal.reconcile('a',job.id,job.version,'failed'),fails('stale_version'));
 assert.equal(journal.reconcile('a',job.id,uncertain.version,'succeeded').state,'succeeded');assert.equal(journal.claim('a'),null);
}));
test('cancellation fences active lease; post-dispatch cancellation is uncertain rather than remote cancellation',async()=>fixture(f=>{
 const journal=f.journal();
 for(const stage of ['queued','running','dispatching']){
  const job=journal.enqueue('a',input({replayKey:stage}));let work;
  if(stage!=='queued')work=journal.claim('a');if(stage==='dispatching')journal.markDispatched(work.lease);
  const previous=journal.read('a',job.id),cancelled=journal.cancel('a',job.id,previous.version);
  assert.equal(cancelled.state,stage==='dispatching'?'uncertain':'cancelled');assert.equal(cancelled.cancelRequested,true);assert.notEqual(cancelled.version.generation,previous.version.generation);
  if(work)assert.throws(()=>journal.recordOutcome(work.lease,'succeeded'),fails('stale_lease'));
  assert.throws(()=>journal.cancel('a',job.id,previous.version),fails('stale_version'));
 }
 assert.equal(journal.claim('a'),null);
}));
test('known rejection/conflict are terminal; refresh policy is explicit and never blindly reapplied',async()=>fixture(f=>{
 const journal=f.journal();
 for(const policy of ['manual','refresh_then_reapply']){
  const job=journal.enqueue('a',input({kind:'mutation',replayKey:policy,precondition:'opaque-version',conflictPolicy:policy}));const work=journal.claim('a');
  assert.equal(work.precondition,'opaque-version');assert.equal(work.status.conflictPolicy,policy);journal.markDispatched(work.lease);
  assert.equal(journal.recordOutcome(work.lease,'conflict').state,'failed');assert.equal(journal.enqueue('a',input({kind:'mutation',replayKey:policy,precondition:'opaque-version',conflictPolicy:policy})).id,job.id);
 }
 const job=journal.enqueue('a',input({replayKey:'rejection'})),work=journal.claim('a');journal.markDispatched(work.lease);journal.recordOutcome(work.lease,'rejected');
 assert.equal(journal.read('a',job.id).lastError,'rejected');assert.equal(journal.claim('a'),null);
}));
test('bounded recovery, pagination and lease renewal preserve ordering and fences',async()=>fixture(f=>{
 const journal=f.journal();for(let i=0;i<4;i++)journal.enqueue('a',input({replayKey:`key-${i}`}));
 const first=journal.list('a',{limit:2}),second=journal.list('a',{after:first[1].id,limit:2});assert.equal(new Set([...first,...second].map(x=>x.id)).size,4);
 const works=Array.from({length:4},()=>journal.claim('a',10));assert.equal(journal.claim('a'),null);f.setTime(1005);assert.equal(journal.renew(works[0].lease,20),1025);
 f.setTime(1010);assert.equal(journal.recoverExpired('a',2),2);assert.equal(journal.recoverExpired('a',2),1);assert.equal(journal.read('a',works[0].lease.id).state,'running');
 assert.throws(()=>journal.recoverExpired('a',101),fails('invalid_input'));assert.throws(()=>journal.list('a',{limit:101}),fails('invalid_input'));
}));
test('write failure after SQL mutation rolls back the dispatch marker with fixed error',async()=>fixture(f=>{
 const journal=f.journal(),job=journal.enqueue('a',input()),work=journal.claim('a');
 const faulty=new MailActionJournal({...f.db,run(sql,args){f.db.run(sql,args);throw Error('private provider payload');}},'owner',f.clock);
 assert.throws(()=>faulty.markDispatched(work.lease),fails('storage_unavailable'));assert.equal(journal.read('a',job.id).state,'running');
 journal.markDispatched(work.lease);assert.throws(()=>faulty.recordOutcome(work.lease,'succeeded'),fails('storage_unavailable'));assert.equal(journal.read('a',job.id).state,'dispatching');
}));
test('v4 migration is atomic, preserves unmanaged legacy actions and requires v5 guard',async()=>fixture(f=>{
 db.exec("DROP TABLE mail_saved_searches; DROP TRIGGER mail_extraction_manifest_insert; DROP TRIGGER mail_extraction_manifest_update; DROP TRIGGER mail_extraction_changed; DROP TABLE mail_attachment_extractions");for(const row of f.db.all("SELECT name FROM sqlite_schema WHERE type='trigger' AND name GLOB 'mail_local_*'"))f.db.exec('DROP TRIGGER "'+row.name+'"');f.db.exec('DROP TABLE mail_local_action_drafts; DROP TABLE mail_local_draft_parts; DROP TABLE mail_local_draft_versions; DROP TABLE mail_local_drafts; DROP TABLE mail_imap_folders; DROP TABLE mail_imap_runs; DROP TABLE mail_imap_messages; DROP TABLE mail_imap_credentials; DROP TRIGGER mail_known_inbox; DROP INDEX mail_folder_role; ALTER TABLE mail_folders DROP COLUMN role; DROP TABLE mail_graph_delta_seen; DROP TABLE mail_graph_delta; DROP TABLE mail_graph_poll; DROP TABLE mail_local_events; DROP TABLE mail_local_event_streams');f.db.exec("DROP TABLE mail_graph_attachments; DROP TABLE mail_graph_messages; DROP TABLE mail_graph_folder_queue; DROP TABLE mail_graph_runs");
 for(const row of f.db.all("SELECT name FROM sqlite_schema WHERE type='trigger' AND name GLOB 'mail_search_*'"))f.db.exec('DROP TRIGGER "'+row.name+'"');
 f.db.exec('DROP TABLE mail_search_fts; DROP TABLE mail_search_documents; DROP TABLE mail_search_dirty; ALTER TABLE mail_messages DROP COLUMN is_read');
 f.db.exec("DROP TRIGGER mail_raw_projection_insert; DROP TRIGGER mail_raw_projection_update; DROP TABLE mail_mime_parts; DROP TABLE mail_mime_projections; DROP TABLE mail_gmail_metadata; DROP TABLE mail_gmail_presence; DROP TABLE mail_gmail_runs; DROP TABLE mail_action_jobs; UPDATE mail_schema_version SET version=4");
 for(const state of ['queued','running','uncertain','succeeded'])f.db.run('INSERT INTO mail_actions VALUES(?,?,?,?,?)',['a',state,'legacy','{"opaque":"unchanged"}',state]);
 const before=f.db.all('SELECT * FROM mail_actions ORDER BY id');assert.throws(()=>assertMailSchema(f.db));
 const faulty={...f.db,exec(sql){f.db.exec(sql);if(sql.includes('CREATE TABLE mail_action_jobs'))throw Error('migration interrupted');}};
 assert.throws(()=>migrateMailSchema(faulty));assert.equal(f.db.get('SELECT version FROM mail_schema_version').version,4);assert.equal(f.db.get("SELECT name FROM sqlite_schema WHERE name='mail_action_jobs'"),undefined);
 migrateMailSchema(f.db);migrateMailSchema(f.db);assertMailSchema(f.db);assert.equal(f.db.get('SELECT version FROM mail_schema_version').version,MAIL_SCHEMA_VERSION);assert.deepEqual(f.db.all('SELECT * FROM mail_actions ORDER BY id'),before);
 assert.deepEqual(f.journal().legacyStatus('a'),{unmanaged:4,unresolved:3});assert.equal(f.journal().claim('a'),null);assert.equal(f.journal().recoverExpired('a'),0);
 f.db.exec('ALTER TABLE mail_action_jobs DROP COLUMN precondition');assert.throws(()=>assertMailSchema(f.db));
}));
async function crashAfter(path,key,stage){
 const script=`import{readFileSync}from'node:fs';import{openEncryptedMailDatabase}from ${JSON.stringify(new URL('./database.js',import.meta.url).href)};import{MailActionJournal}from ${JSON.stringify(new URL('./action-journal.js',import.meta.url).href)};
 const input=JSON.parse(readFileSync(0,'utf8'));const key=Buffer.from(input.key,'base64');const db=await openEncryptedMailDatabase({path:input.path,key});key.fill(0);const journal=new MailActionJournal(db,'owner',()=>1000);const work=journal.claim('a',10);if(input.stage==='dispatching')journal.markDispatched(work.lease);process.stdout.write('durable');setInterval(()=>{},1000);`;
 await new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--input-type=module','--eval',script],{env:process.platform==='win32'?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR}:{},stdio:['pipe','pipe','pipe']});let ready=false;
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('crash test timed out'));},10000);
  child.on('error',reject);child.stdout.once('data',()=>{ready=true;child.kill('SIGKILL');});child.on('close',()=>{clearTimeout(timer);ready?resolve():reject(Error('child failed before durable boundary'));});
  child.stdin.end(JSON.stringify({path,key:key.toString('base64'),stage}));
 });
}
for(const stage of ['running','dispatching'])test(`SIGKILL after durable ${stage} boundary preserves safe recovery`,async()=>fixture(async f=>{
 const job=f.journal().enqueue('a',input());f.close();await crashAfter(f.path,f.key,stage);await f.reopen();f.setTime(1010);
 const journal=f.journal();assert.equal(journal.read('a',job.id).state,stage);journal.recoverExpired('a');
 assert.equal(journal.read('a',job.id).state,stage==='running'?'retry':'uncertain');f.setTime(1020);assert.equal(journal.claim('a')===null,stage==='dispatching');
}));

test('competing Node writers deduplicate replay keys and grant only one lease',async()=>fixture(async f=>{
 f.close();
 const script=`import{readFileSync}from'node:fs';import{openEncryptedMailDatabase}from ${JSON.stringify(new URL('./database.js',import.meta.url).href)};import{MailActionJournal}from ${JSON.stringify(new URL('./action-journal.js',import.meta.url).href)};
 const input=JSON.parse(readFileSync(0,'utf8'));const key=Buffer.from(input.key,'base64');const db=await openEncryptedMailDatabase({path:input.path,key});key.fill(0);try{const journal=new MailActionJournal(db,'owner',()=>1000);const job=journal.enqueue('a',input.action);process.stdout.write(JSON.stringify({id:job.id,claimed:journal.claim('a')!==null}));}finally{db.close();}`;
 const run=()=>new Promise((resolve,reject)=>{
  const child=spawn(process.execPath,['--input-type=module','--eval',script],{env:process.platform==='win32'?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR}:{},stdio:['pipe','pipe','pipe']});let output='';
  const timer=setTimeout(()=>{child.kill('SIGKILL');reject(Error('competing writer timed out'));},10000);
  child.on('error',reject);child.stdout.on('data',chunk=>output+=chunk);child.on('close',code=>{clearTimeout(timer);code===0?resolve(JSON.parse(output)):reject(Error('competing writer failed'));});
  child.stdin.end(JSON.stringify({path:f.path,key:f.key.toString('base64'),action:input()}));
 });
 const [a,b]=await Promise.all([run(),run()]);assert.equal(a.id,b.id);assert.equal(Number(a.claimed)+Number(b.claimed),1);await f.reopen();assert.equal(f.journal().list('a').length,1);
}));


test('preflight throttling persists provider minimum delay without permitting post-dispatch retry',async()=>fixture(async f=>{
 let journal=f.journal();const job=journal.enqueue('a',input());let work=journal.claim('a');
 assert.throws(()=>journal.failBeforeDispatch(work.lease,true,-1),fails('invalid_input'));
 const retry=journal.failBeforeDispatch(work.lease,true,7200000);
 assert.equal(retry.availableAt,7201000);
 await f.reopen();journal=f.journal();f.setTime(7200999);assert.equal(journal.claim('a'),null);
 f.setTime(7201000);work=journal.claim('a');assert.equal(work.lease.id,job.id);
 journal.markDispatched(work.lease);
 assert.throws(()=>journal.failBeforeDispatch(work.lease,true,7200000),fails('invalid_state'));
 assert.equal(journal.recordOutcome(work.lease,'unknown').state,'uncertain');
 assert.equal(journal.claim('a'),null);
}));
