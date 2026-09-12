import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MailSyncExecutor,MailSyncExecutionFailure} from './sync-executor.js';
import {MailSyncJournal} from '../storage/sync-journal.js';
import {MailContentStore} from '../storage/content-store.js';
import {MailRepository} from '../storage/repository.js';
import {openEncryptedMailDatabase} from '../storage/database.js';
import {migrateMailSchema} from '../storage/schema.js';
const locator=id=>({provider:'gmail',messageId:id});
const scope=(accountId='a',generation='g',scopeId='all')=>({accountId,generation,scopeId});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
const settle=()=>new Promise(resolve=>setImmediate(resolve));
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));
async function fixture(body){
 const dir=await mkdtemp(join(tmpdir(),'mail-executor-node-')),path=join(dir,'mail.sqlite'),key=randomBytes(32);let db=await openEncryptedMailDatabase({path,key}),now=1000;
 migrateMailSchema(db);const runners=[];
 const f={get db(){return db;},get now(){return now;},advance(ms){now+=ms;},get journal(){return new MailSyncJournal(db,'owner',()=>now,{retryBaseMs:10,retryMaxMs:100,maxAttempts:3});},
  get store(){return new MailContentStore(db,'owner');},get repository(){return new MailRepository(db,'owner');},
  seed(account='a',jobs=['one'],generation='g',owner='owner'){
   const repo=new MailRepository(db,owner);if(!repo.listAccounts().some(a=>a.id===account))repo.createAccount({id:account,provider:'gmail',displayName:'Synthetic'});
   const journal=new MailSyncJournal(db,owner,()=>now,{retryBaseMs:10,retryMaxMs:100,maxAttempts:3});
   journal.commitPage({...scope(account,generation),expectedCursor:null,expectedRevision:0,nextCursor:null,discoveryComplete:true,jobs:jobs.map(id=>({kind:'raw',locator:locator(id)}))},writer=>{for(const id of jobs)writer.ingestMessage({rfcMessageId:null,locator:locator(id),subject:'Synthetic',memberships:[]});});
  },
  make(options={}){const runner=new MailSyncExecutor({journal:f.journal,handler:async work=>work.complete(()=>{}),...options});runners.push(runner);return runner;},
  async reopen(){for(const runner of runners)runner.close();db.close();db=await openEncryptedMailDatabase({path,key});}
 };
 try{await body(f);}finally{for(const runner of runners)runner.close();db.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
}
test('bounds each run, selects explicit generation and isolates accounts',async()=>fixture(async f=>{
 f.seed('a',['one','two','three']);f.seed('a',['other-generation'],'other');f.seed('b');f.seed('foreign',['private'],'g','other-owner');
 const runner=f.make({maxJobsPerRun:2});const first=await runner.run(scope());assert.equal(first.attempted,2);assert.equal(first.succeeded,2);assert.equal(first.stopped,'limit');
 assert.equal(f.journal.status(scope('a','other')).jobs.queued,1);assert.equal(f.journal.status(scope('b')).jobs.queued,1);
 assert.equal((await runner.run(scope())).succeeded,1);await assert.rejects(runner.run(scope('foreign')),{code:'not_found'});
 assert.equal((await runner.run(scope('b'))).succeeded,1);
}));
test('global admission and one job per account persist across scopes',async()=>fixture(async f=>{
 f.seed();f.seed('b');const entered=deferred(),gate=deferred();let active=0,max=0;
 const runner=f.make({handler:async work=>{active++;max=Math.max(max,active);entered.resolve();await gate.promise;work.complete(()=>{});active--;}});
 const pending=runner.run(scope());await entered.promise;await assert.rejects(runner.run(scope('a','other')),{code:'busy'});await assert.rejects(runner.run(scope('b')),{code:'capacity'});
 gate.resolve();await pending;assert.equal(max,1);
}));
test('explicit bounded parallel accounts remain isolated',async()=>fixture(async f=>{
 f.seed();f.seed('b');const gates=new Map([['a',deferred()],['b',deferred()]]),entered=deferred();let active=0;
 const runner=f.make({maxConcurrentAccounts:2,handler:async work=>{active++;if(active===2)entered.resolve();await gates.get(work.job.account_id).promise;work.complete(writer=>writer.ingestMessage({rfcMessageId:null,locator:locator('one'),subject:work.job.account_id,memberships:[]}));active--;}});
 const a=runner.run(scope()),b=runner.run(scope('b'));await entered.promise;gates.get('a').resolve();gates.get('b').resolve();await Promise.all([a,b]);
 assert.equal(f.repository.readMessage('a',locator('one')).subject,'a');assert.equal(f.repository.readMessage('b',locator('one')).subject,'b');
}));
test('active leases renew and completion remains fenced',async()=>fixture(async f=>{
 f.seed();let before,after;const runner=f.make({leaseMs:100,renewEveryMs:5,handler:async work=>{before=work.job.lease_until;f.advance(50);await delay(20);after=f.journal.readJob('a',work.job.id).lease_until;work.assertCurrent();work.complete(()=>{});}});
 assert.equal((await runner.run(scope())).succeeded,1);assert.ok(after>before);
}));
for(const action of ['expired','stolen'])test(`${action} lease prevents late completion or retirement of another owner`,async()=>fixture(async f=>{
 f.seed();let saved,token;const runner=f.make({leaseMs:20,renewEveryMs:10,handler:async work=>{
  saved=work.job.id;f.advance(21);
  if(action==='stolen'){f.journal.reclaimExpired('a');f.advance(11);[token]=f.journal.claim(scope(),1,100);}
  work.complete(()=>{});
 }});
 const result=await runner.run(scope());assert.equal(result.leaseLost,1);assert.equal(result.succeeded,0);
 if(token)assert.equal(f.journal.readJob('a',saved).lease_token,token.lease_token);else assert.equal(f.journal.readJob('a',saved).state,'running');
}));
test('pause fences late completion and quarantines ignored abort until settlement',async()=>fixture(async f=>{
 f.seed();f.seed('b');const gate=deferred(),entered=deferred();let work;
 const runner=f.make({handler:async input=>{work=input;entered.resolve();await gate.promise;input.complete(()=>{});}});
 const pending=runner.run(scope());await entered.promise;runner.pause('a');const result=await pending;
 assert.equal(result.stopped,'paused');assert.equal(result.retry,1);assert.equal(work.signal.aborted,true);
 assert.throws(()=>work.complete(()=>{}),/inactive/);await assert.rejects(runner.run(scope('b')),{code:'capacity'});await assert.rejects(runner.run(scope()),{code:'busy'});
 gate.resolve();await settle();f.advance(11);assert.equal(f.journal.status(scope()).jobs.succeeded,0);
 assert.equal((await f.make().run(scope())).succeeded,1);
}));
test('close immediately returns paused result, rejects new runs, and never erases durable jobs',async()=>fixture(async f=>{
 f.seed();const gate=deferred(),entered=deferred();let work;
 const runner=f.make({handler:async input=>{work=input;entered.resolve();await gate.promise;input.complete(()=>{});}});
 const pending=runner.run(scope());await entered.promise;runner.close();assert.equal((await pending).stopped,'paused');await assert.rejects(runner.run(scope()),{code:'closed'});
 assert.throws(()=>work.complete(()=>{}),/inactive/);gate.resolve();await settle();assert.equal(f.journal.status(scope()).jobs.retry,1);
}));
test('monotonic deadline catches synchronous work before completion and rolls callback overrun back',async()=>fixture(async f=>{
 f.seed();let late;
 const runner=f.make({jobTimeoutMs:10,handler:async work=>{late=work;const until=performance.now()+25;while(performance.now()<until){}work.complete(()=>{});}});
 const result=await runner.run(scope());assert.equal(result.stopped,'timeout');assert.equal(result.retry,1);assert.throws(()=>late.complete(()=>{}),/inactive/);
 f.advance(11);const callback=f.make({jobTimeoutMs:10,handler:async work=>work.complete(writer=>{writer.ingestMessage({rfcMessageId:null,locator:locator('one'),subject:'must roll back',memberships:[]});const until=performance.now()+25;while(performance.now()<until){} })});
 assert.equal((await callback.run(scope())).retry,1);assert.equal(f.repository.readMessage('a',locator('one')).subject,'Synthetic');
}));
test('provider minimum retry delay and attempts survive reopen; permanent and missing-completion failures are bounded',async()=>fixture(async f=>{
 f.seed();const failing=f.make({handler:async()=>{throw new MailSyncExecutionFailure('retryable',7200000);}});
 assert.equal((await failing.run(scope())).retry,1);await f.reopen();f.advance(100);assert.equal((await f.make().run(scope())).attempted,0);
 f.advance(7200000);assert.equal((await f.make({handler:async()=>{throw new MailSyncExecutionFailure('permanent');}}).run(scope())).failed,1);
 f.seed('b');const missing=f.make({handler:async()=>{}});for(let n=0;n<3;n++){const result=await missing.run(scope('b'));assert.equal(result.succeeded,0);f.advance(101);}assert.equal(f.journal.status(scope('b')).jobs.failed,1);
}));
test('raw publication, metadata and followups commit atomically; rolled-back success is retried',async()=>fixture(async f=>{
 f.seed();let first=true;
 const runner=f.make({handler:async work=>{
  await f.store.writePart('a',locator('one'),{kind:'raw',maxBytes:1},[new Uint8Array([1])],()=>{
   work.complete(writer=>writer.setAttachmentsEnumerated(locator('one'),true),[{kind:'body',locator:locator('one')}]);
   if(first){first=false;throw new Error('synthetic private provider error');}
  });
 }});
 assert.equal((await runner.run(scope())).retry,1);assert.equal(f.db.get('SELECT count(*) AS n FROM mail_blob_publications').n,0);assert.equal(f.journal.status(scope()).jobs.succeeded,0);assert.equal(f.journal.status(scope()).jobs.queued,0);
 f.advance(11);const success=f.make({maxJobsPerRun:1,handler:async work=>f.store.writePart('a',locator('one'),{kind:'raw',maxBytes:1},[new Uint8Array([2])],()=>work.complete(()=>{},[{kind:'body',locator:locator('one')}]))});
 assert.equal((await success.run(scope())).succeeded,1);assert.equal(f.db.get('SELECT count(*) AS n FROM mail_blob_publications').n,1);assert.equal(f.journal.status(scope()).jobs.queued,1);
}));
test('committed completion followed by handler error never replays and async metadata writer cannot escape',async()=>fixture(async f=>{
 f.seed();const runner=f.make({handler:async work=>{work.complete(()=>{});throw new Error('private diagnostic');}});assert.equal((await runner.run(scope())).succeeded,1);assert.equal((await runner.run(scope())).attempted,0);
 f.seed('b');let escaped;
 const asyncWriter=f.make({handler:async work=>work.complete(writer=>{escaped=writer;return Promise.resolve().then(()=>writer.ingestMessage({rfcMessageId:null,locator:locator('one'),subject:'late',memberships:[]}));})});
 assert.equal((await asyncWriter.run(scope('b'))).retry,1);await settle();assert.throws(()=>escaped.ingestMessage({rfcMessageId:null,locator:locator('one'),subject:'late',memberships:[]}),/expired/);assert.equal(f.repository.readMessage('b',locator('one')).subject,'Synthetic');
}));
test('deadline retains physical admission for uncooperative work and late capability stays revoked',async()=>fixture(async f=>{
 f.seed();f.seed('b');const gate=deferred(),entered=deferred();let saved;
 const runner=f.make({jobTimeoutMs:10,handler:async work=>{saved=work;entered.resolve();await gate.promise;work.complete(()=>{});}});
 const pending=runner.run(scope());await entered.promise;const result=await pending;assert.equal(result.stopped,'timeout');assert.equal(result.retry,1);
 await assert.rejects(runner.run(scope('b')),{code:'capacity'});assert.throws(()=>saved.assertCurrent(),/inactive/);
 gate.resolve();await settle();assert.equal(f.journal.status(scope()).jobs.succeeded,0);
}));
test('pause inside metadata callback rolls back publication and job success together',async()=>fixture(async f=>{
 f.seed();let runner;runner=f.make({handler:async work=>f.store.writePart('a',locator('one'),{kind:'raw',maxBytes:1},[new Uint8Array([1])],()=>work.complete(writer=>{writer.ingestMessage({rfcMessageId:null,locator:locator('one'),subject:'rollback',memberships:[]});runner.pause('a');}))});
 const result=await runner.run(scope());assert.equal(result.stopped,'paused');assert.equal(result.retry,1);assert.equal(f.db.get('SELECT count(*) AS n FROM mail_blob_publications').n,0);assert.equal(f.repository.readMessage('a',locator('one')).subject,'Synthetic');
}));
