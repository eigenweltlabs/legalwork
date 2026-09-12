import {MailFilingStore} from './filing-store.js';
import {removeLaterMailSchema} from '../testing/legacy-schema.mjs';
import {MailSearchIndexer} from '../runtime/search-indexer.js';
import {setTimeout as delay} from 'node:timers/promises';
import {MailSearchStore} from './search.js';
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
