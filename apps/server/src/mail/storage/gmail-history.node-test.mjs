import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {GmailRunStore} from './gmail-state.js';
import {MailContentStore} from './content-store.js';
import {MailRepository} from './repository.js';
import {MailSyncJournal} from './sync-journal.js';
import {openEncryptedMailDatabase} from './database.js';
import {migrateMailSchema} from './schema.js';
import {assertMailSchema} from './consistency.js';
const loc=messageId=>({provider:'gmail',messageId}),stamp=r=>({generation:r.generation,revision:r.revision});
async function fixture(body){const dir=await mkdtemp(join(tmpdir(),'mail-history-')),path=join(dir,'mail.sqlite'),key=randomBytes(32);let db=await openEncryptedMailDatabase({path,key});migrateMailSchema(db);
 const f={get db(){return db;},get runs(){return new GmailRunStore(db,'owner',()=>1800000000000);},get repo(){return new MailRepository(db,'owner');},get content(){return new MailContentStore(db,'owner');},get journal(){return new MailSyncJournal(db,'owner',()=>1800000000000);},seed(name='one'){f.repo.ingestMessage('a',{locator:loc(name),rfcMessageId:null,subject:'retained',memberships:[]});},page(run,extra={}){return{accountId:'a',generation:run.generation,scopeId:'gmail:all',expectedCursor:null,expectedRevision:0,nextCursor:null,discoveryComplete:true,jobs:[],...extra};},async reopen(){db.close();db=await openEncryptedMailDatabase({path,key});}};
 f.repo.createAccount({id:'a',provider:'gmail',displayName:'Synthetic'});try{await body(f);}finally{db.close();key.fill(0);await rm(dir,{recursive:true,force:true});}}
test('baseline must precede enumeration; legacy partial and completed runs restart a fresh preserved generation',()=>fixture(async f=>{
 f.seed();let run=f.runs.startOrResume('a');f.journal.commitPage(f.page(run,{discoveryComplete:false,nextCursor:'partial'}),()=>{});
 assert.throws(()=>f.runs.captureBaseline('a',stamp(run),'90071992547409931'),{code:'stale_run'});
 const old=run;run=f.runs.beginReconciliation('a',stamp(run),'90071992547409931');assert.notEqual(run.generation,old.generation);assert.ok(f.repo.readMessage('a',loc('one')));assert.ok(f.db.get('SELECT 1 FROM mail_sync_scopes WHERE generation=?',[old.generation]));
 await f.reopen();assert.deepEqual(f.runs.read('a'),run);const done=f.runs.setState('a',stamp(run),'complete');const resumed=f.runs.startOrResume('a');assert.equal(resumed.generation,done.generation);assert.equal(resumed.state,'active');assert.throws(()=>f.runs.assertCurrent('a',stamp(done)),{code:'stale_run'});
}));
test('large decimal message versions fence raw snapshots and history deltas in both directions; same-event replay is idempotent',()=>fixture(async f=>{
 f.seed();f.runs.startOrResume('a');const metadata=(historyId,labelIds)=>({historyId,labelIds,threadId:'thread',internalDate:1});
 f.runs.putGmailMetadata('a',loc('one'),metadata('90071992547409933',['INBOX','UNREAD']));
 f.runs.applyLabelDelta('a',loc('one'),{historyId:'90071992547409932',add:[],remove:['UNREAD']});assert.deepEqual(f.repo.readMessage('a',loc('one')).memberships,['INBOX','UNREAD']);
 const delta={historyId:'90071992547409934',add:['CUSTOM'],remove:['UNREAD']};f.runs.applyLabelDelta('a',loc('one'),delta);f.runs.applyLabelDelta('a',loc('one'),delta);
 assert.equal(f.runs.putGmailMetadata('a',loc('one'),metadata('90071992547409933',['UNREAD'])),false);assert.equal(f.runs.readMessageHistoryId('a',loc('one')),'90071992547409934');assert.deepEqual(f.repo.readMessage('a',loc('one')).memberships,['CUSTOM','INBOX']);
 f.runs.markRemoved('a',loc('one'),'90071992547409935');f.runs.putGmailMetadata('a',loc('one'),metadata('90071992547409934',['INBOX']));f.runs.markPresent('a',loc('one'),'scan','90071992547409934');assert.equal(f.runs.isPresent('a',loc('one')),false);
 f.runs.markPresent('a',loc('one'),'scan','90071992547409936');assert.equal(f.runs.isPresent('a',loc('one')),true);f.runs.markRemoved('a',loc('one'));assert.equal(f.runs.isPresent('a',loc('one')),true);
 await f.reopen();assert.equal(f.runs.readGmailMetadata('a',loc('one')).historyId,'90071992547409936');
 new MailRepository(f.db,'other').createAccount({id:'foreign',provider:'gmail',displayName:'Other'});assert.throws(()=>f.runs.markRemoved('foreign',loc('one'),'99'),{code:'not_found'});
}));
test('partial scan cannot sweep; bounded terminal reconciliation survives restart and retains encrypted originals',()=>fixture(async f=>{
 for(const name of ['kept','missing','newer']){f.seed(name);f.runs.putGmailMetadata('a',loc(name),{historyId:'10',internalDate:1,threadId:name,labelIds:['INBOX']});}
 f.db.run("INSERT INTO mail_drafts VALUES('a','draft',7,NULL)");for(const state of ['queued','uncertain'])f.db.run("INSERT INTO mail_actions VALUES('a',?,'submission','{}',?)",[state,state]);
 const bytes=Buffer.from('Synthetic retained original'),ref=await f.content.writePart('a',loc('missing'),{kind:'raw',maxBytes:bytes.length},[bytes]);
 let run=f.runs.startOrResume('a');run=f.runs.captureBaseline('a',stamp(run),'20');f.runs.markPresent('a',loc('kept'),run.generation,'20');f.runs.putGmailMetadata('a',loc('newer'),{historyId:'30',internalDate:1,threadId:'newer',labelIds:['INBOX']});
 f.journal.commitPage(f.page(run,{discoveryComplete:false,nextCursor:'next'}),()=>{});assert.throws(()=>f.runs.markMissingBatch('a',run.generation),{code:'stale_run'});assert.equal(f.runs.isPresent('a',loc('missing')),true);await f.reopen();
 f.journal.commitPage(f.page(run,{expectedRevision:1,expectedCursor:'next'}),()=>{});assert.throws(()=>f.runs.advanceHistory('a',stamp(run),{pageToken:null}),{code:'stale_run'});
 while(f.runs.markMissingBatch('a',run.generation,1).remaining){};assert.equal(f.runs.isPresent('a',loc('missing')),false);assert.equal(f.runs.isPresent('a',loc('newer')),true);assert.deepEqual(f.repo.readMessage('a',loc('missing')).memberships,[]);assert.deepEqual(Buffer.concat([...f.content.read('a',ref.id)]),bytes);
 run=f.runs.advanceHistory('a',stamp(run),{pageToken:null});assert.equal(run.historyId,'20');assert.equal(run.phase,'history');assert.equal(f.runs.progress('a',run.generation).removed,1);assert.equal(f.runs.progress('a','another-generation').retained,1);assert.equal(f.db.get('SELECT revision FROM mail_drafts').revision,7);assert.deepEqual(f.db.all('SELECT state FROM mail_actions ORDER BY state').map(x=>x.state),['queued','uncertain']);
}));
test('paged event apply, raw jobs and terminal anchor share one transaction and reject stale replay',()=>fixture(async f=>{
 f.seed();let run=f.runs.startOrResume('a');run=f.runs.captureBaseline('a',stamp(run),'100');f.runs.markPresent('a',loc('one'),run.generation,'100');f.journal.commitPage(f.page(run),()=>{});run=f.runs.advanceHistory('a',stamp(run),{pageToken:null});
 const historyPage=f.page(run,{scopeId:'gmail:history',discoveryComplete:false,nextCursor:'page2',jobs:[{kind:'raw',locator:loc('one')}]});
 assert.throws(()=>f.db.transaction(()=>{f.journal.commitPage(historyPage,()=>f.runs.applyLabelDelta('a',loc('one'),{add:['UNREAD'],remove:[],historyId:'101'}));f.runs.advanceHistory('a',stamp(run),{pageToken:'page2',historyId:'999'});}),{code:'stale_run'});assert.deepEqual(f.repo.readMessage('a',loc('one')).memberships,[]);assert.equal(f.db.get('SELECT count(*) AS n FROM mail_sync_jobs').n,0);
 run=f.db.transaction(()=>{f.journal.commitPage(historyPage,()=>f.runs.applyLabelDelta('a',loc('one'),{add:['UNREAD'],remove:[],historyId:'101'}));return f.runs.advanceHistory('a',stamp(run),{pageToken:'page2'});});await f.reopen();assert.equal(f.runs.read('a').historyId,'100');assert.equal(f.runs.read('a').historyPageToken,'page2');assert.throws(()=>f.journal.commitPage(historyPage,()=>{}));
 run=f.db.transaction(()=>{f.journal.commitPage({...historyPage,expectedRevision:1,expectedCursor:'page2',nextCursor:null,jobs:[]},()=>{});return f.runs.advanceHistory('a',stamp(run),{pageToken:null,historyId:'105',pollAt:1800000060000});});assert.equal(run.historyId,'105');assert.equal(run.pollAt,1800000060000);assert.equal(run.failureCount,0);
}));
test('v6 migration preserves legacy presence, is atomic on failure and guard requires v7 columns',()=>fixture(async f=>{
 f.seed();f.db.exec('DROP TABLE mail_gmail_presence; ALTER TABLE mail_gmail_runs DROP COLUMN phase; ALTER TABLE mail_gmail_runs DROP COLUMN history_id; ALTER TABLE mail_gmail_runs DROP COLUMN history_page_token; ALTER TABLE mail_gmail_runs DROP COLUMN poll_at; UPDATE mail_schema_version SET version=6');
 const failing={...f.db,exec(sql){f.db.exec(sql);if(sql.includes('CREATE TABLE mail_gmail_presence'))throw Error('synthetic failure');}};assert.throws(()=>migrateMailSchema(failing));assert.equal(f.db.get('SELECT version FROM mail_schema_version').version,6);assert.equal(f.db.get("SELECT 1 FROM sqlite_schema WHERE name='mail_gmail_presence'"),undefined);
 migrateMailSchema(f.db);migrateMailSchema(f.db);assertMailSchema(f.db);assert.equal(f.runs.isPresent('a',loc('one')),true);assert.equal(f.db.get('SELECT count(*) AS n FROM mail_gmail_presence').n,1);await f.reopen();assertMailSchema(f.db);
}));

test('fenced GET absence retains watermark; reappearance restarts only a missing-original terminal raw job',()=>fixture(async f=>{
 f.seed();const run=f.runs.startOrResume('a');f.runs.markPresent('a',loc('one'),run.generation,'100');f.journal.commitPage(f.page(run,{jobs:[{kind:'raw',locator:loc('one')}]}),()=>{});
 let [job]=f.journal.claim({accountId:'a',generation:run.generation,scopeId:'gmail:all'},1);f.journal.succeed('a',job.id,job.lease_token,()=>{});
 f.runs.markAbsentFromFetch('a',loc('one'));assert.equal(f.runs.isPresent('a',loc('one')),false);assert.equal(f.db.get('SELECT history_id FROM mail_gmail_presence').history_id,'100');
 f.runs.markPresent('a',loc('one'),run.generation,'101');assert.equal(f.db.get('SELECT state FROM mail_sync_jobs').state,'queued');assert.equal(f.db.get('SELECT attempts FROM mail_sync_jobs').attempts,0);
 [job]=f.journal.claim({accountId:'a',generation:run.generation,scopeId:'gmail:all'},1);f.journal.succeed('a',job.id,job.lease_token,()=>{});await f.content.writePart('a',loc('one'),{kind:'raw',maxBytes:3},[Buffer.from('raw')]);
 f.runs.markAbsentFromFetch('a',loc('one'));f.runs.markPresent('a',loc('one'),run.generation,'102');assert.equal(f.db.get('SELECT state FROM mail_sync_jobs').state,'succeeded');
}));

test('unknown-message stale snapshot is explicit until a fresh complete metadata baseline arrives',()=>fixture(f=>{
 f.seed();const run=f.runs.startOrResume('a');f.runs.markPresent('a',loc('one'),run.generation,'100');f.runs.applyLabelDelta('a',loc('one'),{historyId:'110',add:['CUSTOM'],remove:[]});
 assert.equal(f.runs.putGmailMetadata('a',loc('one'),{historyId:'100',threadId:'thread',internalDate:1,labelIds:['INBOX']}),false);assert.equal(f.runs.readGmailMetadata('a',loc('one')),null);
 assert.equal(f.runs.putGmailMetadata('a',loc('one'),{historyId:'110',threadId:'thread',internalDate:1,labelIds:['INBOX','CUSTOM']}),true);assert.deepEqual(f.repo.readMessage('a',loc('one')).memberships,['CUSTOM','INBOX']);
}));
