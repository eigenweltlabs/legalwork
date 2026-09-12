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

test('lexical, exact and structured search survive offline rebuild and encrypted reopen',async()=>fixture(async f=>{
 f.seed();f.runs.putGmailMetadata('a',locator,{internalDate:Date.parse('2026-09-09T10:00:00Z'),threadId:'thread',labelIds:['INBOX','UNREAD']});const raw=await f.raw(Buffer.from(mime.toString().replace('filename="brief.bin"',"filename*=utf-8''Pr%C3%BCfung-12.3.pdf")));await f.project(raw);
 let search=new MailSearchStore(f.db,'owner');assert.equal(search.search({}).pending,1);assert.equal(search.rebuild({accountId:'a'}).processed,1);
 for(const query of [{keywords:['Grüße']},{phrase:'Body private marker'},{sender:'SENDER@example.test'},{recipient:'receiver@example.test'},{filename:'prüfung-12.3.PDF'},{folderId:'INBOX',unread:true,hasAttachment:true},{afterDate:'2026-09-09T00:00:00.000Z',beforeDate:'2026-09-10T00:00:00.000Z'}])assert.equal(search.search(query).total,1,JSON.stringify(query));
 for(const query of [{keywords:['Grusse']},{sender:'sender@example.test.evil'},{filename:'brief'},{unread:false},{phrase:'marker private'}])assert.equal(search.search(query).total,0,JSON.stringify(query));
 new MailRepository(f.db,'other').createAccount({id:'foreign',provider:'gmail',displayName:'secret'});assert.throws(()=>search.search({accountIds:['foreign']}),{code:'not_found'});assert.throws(()=>search.rebuild({accountId:'foreign'}),{code:'not_found'});
 assert.throws(()=>search.search({matterId:'invented'}),{code:'invalid_input'});
 for(const path of [f.path,f.path+'-wal'])assert.equal((await readFile(path)).includes(Buffer.from('Body private marker')),false);
 await f.reopen();search=new MailSearchStore(f.db,'owner');assert.equal(search.search({phrase:'Body private marker'}).total,1);assert.equal(search.rebuild({accountId:'a',reset:true}).pending,0);assert.equal(search.search({sender:'sender@example.test'}).total,1);
}));
test('replaced raw invalidates snippets immediately and literal punctuation is distinct from FTS phrase tokens',async()=>fixture(async f=>{
 f.seed();const ref=await f.raw(Buffer.from('Subject: Prüfung AZ-12/34.5\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nCase AZ-12/34.5 mit München'));await f.project(ref);const search=new MailSearchStore(f.db,'owner');search.rebuild({accountId:'a'});
 assert.equal(search.search({matterIdentifier:'AZ-12/34.5'}).total,1);assert.equal(search.search({literal:'AZ 12 34 5'}).total,0);assert.equal(search.search({literal:'MÜNCHEN'}).total,1);
 await f.raw(Buffer.from('Subject: Replacement\r\n\r\nNew text'));assert.equal(search.search({literal:'AZ-12/34.5'}).total,0);assert.equal(search.search({}).pending,1);search.rebuild({accountId:'a'});assert.equal(search.search({}).incomplete,1);
}));
test('grouped addresses, HTML umlauts, unnamed attachments and generic read flags retain exact semantics',async()=>fixture(async f=>{
 f.seed();const source=Buffer.from(['From: "Not really <attacker@example.test>" <real@example.test>','To: Group: "A, B" <one@example.test>, two@example.test;','Subject: Attachment','MIME-Version: 1.0','Content-Type: multipart/mixed; boundary=x','','--x','Content-Type: text/html; charset=utf-8','','<style>hidden-secret</style><p>M&uuml;nchen &#252;ber alles</p>','--x','Content-Type: application/octet-stream','Content-Disposition: attachment','','bytes','--x--',''].join('\r\n'));await f.project(await f.raw(source));const search=new MailSearchStore(f.db,'owner');search.rebuild({accountId:'a'});
 for(const query of [{sender:'real@example.test'},{recipient:'one@example.test'},{recipient:'two@example.test'},{keywords:['München']},{hasAttachment:true}])assert.equal(search.search(query).total,1,JSON.stringify(query));
 assert.equal(search.search({sender:'attacker@example.test'}).total,0);assert.equal(search.search({keywords:['hidden-secret']}).total,0);
 f.repository.createAccount({id:'graph',provider:'graph',displayName:'Graph'});const graph={provider:'graph',messageId:'graph-one'};f.repository.ingestMessage('graph',{locator:graph,rfcMessageId:null,subject:'Graph unread',memberships:[]});f.db.run("UPDATE mail_messages SET is_read=0 WHERE account_id='graph'");search.rebuild({accountId:'graph'});assert.equal(search.search({accountIds:['graph'],unread:true}).total,1);assert.equal(search.search({accountIds:['graph'],unread:false}).total,0);
}));
test('disconnected account never contributes results, snippets, counts or rebuild access',async()=>fixture(async f=>{
 f.seed();await f.project(await f.raw());const search=new MailSearchStore(f.db,'owner');search.rebuild({accountId:'a'});const credentials=new MailCredentialRepository(f.db,'owner',()=>f.now),version=credentials.connect('a',{provider:'gmail',clientId:'test.apps.googleusercontent.com',authority:'https://accounts.google.com',providerSubject:'subject'},null,{accessToken:'synthetic',expiresAt:f.now+1000,grantedScopes:null,refreshToken:{action:'clear'}});
 credentials.disconnect('a',version);assert.deepEqual(search.search({}),{items:[],total:0,pending:0,incomplete:0,nextOffset:null});assert.throws(()=>search.search({accountIds:['a']}),{code:'locked'});assert.throws(()=>search.rebuild({accountId:'a'}),{code:'locked'});await f.reopen();assert.equal(new MailSearchStore(f.db,'owner').search({}).total,0);
}));
test('search pagination and rebuild are bounded and preserve cross-account duplicate identities',async()=>fixture(async f=>{
 f.seed();for(let n=0;n<30;n++)f.repository.ingestMessage('a',{locator:{provider:'gmail',messageId:'copy'+n},rfcMessageId:null,subject:'Common',memberships:[]});const search=new MailSearchStore(f.db,'owner');assert.equal(search.rebuild({accountId:'a',limit:25}).pending,6);assert.equal(search.search({keywords:['Common'],limit:25}).items.length,25);search.rebuild({accountId:'a'});const first=search.search({keywords:['Common'],limit:17}),second=search.search({keywords:['Common'],limit:17,offset:first.nextOffset});assert.equal(first.total,30);assert.equal(second.items.length,13);assert.equal(new Set([...first.items,...second.items].map(x=>x.locator.messageId)).size,30);
 f.repository.createAccount({id:'b',provider:'gmail',displayName:'Second'});f.repository.ingestMessage('b',{locator:{provider:'gmail',messageId:'copy0'},rfcMessageId:null,subject:'Common',memberships:[]});search.rebuild({accountId:'b'});assert.equal(search.search({keywords:['Common']}).total,31);assert.equal(search.search({accountIds:['b'],keywords:['Common']}).total,1);
 assert.throws(()=>search.rebuild({accountId:'a',limit:1000}),{code:'invalid_input'});assert.equal(search.search({keywords:['\" OR secret']}).total,0); // SQL/FTS operators are quoted user text, not syntax.
}));
test('v7 upgrade is atomic, idempotent and rebuilds existing locally stored mail',async()=>fixture(async f=>{
 removeLaterMailSchema(f.db,7);f.db.exec("DROP VIEW mail_account_access; DROP TABLE mail_graph_mailboxes; DROP TABLE mail_saved_searches; DROP TRIGGER mail_extraction_manifest_insert; DROP TRIGGER mail_extraction_manifest_update; DROP TRIGGER mail_extraction_changed; DROP TABLE mail_attachment_extractions");f.seed();for(const row of f.db.all("SELECT name FROM sqlite_schema WHERE type='trigger' AND name GLOB 'mail_local_*'"))f.db.exec('DROP TRIGGER "'+row.name+'"');f.db.exec('DROP TABLE mail_local_action_drafts; DROP TABLE mail_local_draft_parts; DROP TABLE mail_local_draft_versions; DROP TABLE mail_local_drafts; DROP TABLE mail_imap_folders; DROP TABLE mail_imap_runs; DROP TABLE mail_imap_messages; DROP TABLE mail_imap_credentials; DROP TRIGGER mail_known_inbox; DROP INDEX mail_folder_role; ALTER TABLE mail_folders DROP COLUMN role; DROP TABLE mail_graph_delta_seen; DROP TABLE mail_graph_delta; DROP TABLE mail_graph_poll; DROP TABLE mail_local_events; DROP TABLE mail_local_event_streams');f.db.exec("DROP TABLE mail_graph_attachments; DROP TABLE mail_graph_messages; DROP TABLE mail_graph_folder_queue; DROP TABLE mail_graph_runs");
 for(const row of f.db.all("SELECT name FROM sqlite_schema WHERE type='trigger' AND name GLOB 'mail_search_*'"))f.db.exec('DROP TRIGGER "'+row.name+'"');f.db.exec('DROP TABLE mail_search_fts; DROP TABLE mail_search_documents; DROP TABLE mail_search_dirty; ALTER TABLE mail_messages DROP COLUMN is_read; UPDATE mail_schema_version SET version=7');
 const broken={...f.db,exec(sql){f.db.exec(sql);if(sql.includes('CREATE VIRTUAL TABLE mail_search_fts'))throw Error('synthetic fault');}};assert.throws(()=>migrateMailSchema(broken));assert.equal(f.db.get('SELECT version FROM mail_schema_version').version,7);assert.equal(f.db.get("SELECT name FROM sqlite_schema WHERE name='mail_search_documents'"),undefined);migrateMailSchema(f.db);migrateMailSchema(f.db);assert.equal(f.db.get('SELECT version FROM mail_schema_version').version,MAIL_SCHEMA_VERSION);assertMailSchema(f.db);const search=new MailSearchStore(f.db,'owner');assert.equal(search.rebuild({accountId:'a'}).processed,1);assert.equal(search.search({}).total,1);
}));

test('incremental scheduler rotates accounts, sees later ingestion and stops before database shutdown',async()=>fixture(async f=>{
 f.seed();for(let n=0;n<40;n++)f.repository.ingestMessage('a',{locator:{provider:'gmail',messageId:'more'+n},subject:'Fair',rfcMessageId:null,memberships:[]});f.repository.createAccount({id:'b',provider:'gmail',displayName:'Second'});f.repository.ingestMessage('b',{locator:{provider:'gmail',messageId:'b'},subject:'Other',rfcMessageId:null,memberships:[]});
 const indexer=new MailSearchIndexer(f.db,'owner');try{indexer.start();const deadline=Date.now()+2000;while(!f.db.get("SELECT 1 FROM mail_search_documents WHERE account_id='b'")&&Date.now()<deadline)await delay(10);assert.ok(f.db.get("SELECT 1 FROM mail_search_documents WHERE account_id='b'"));assert.ok(f.db.get("SELECT 1 FROM mail_search_dirty WHERE account_id='a'"));
 f.repository.ingestMessage('b',{locator:{provider:'gmail',messageId:'later'},subject:'Later',rfcMessageId:null,memberships:[]});while(!new MailSearchStore(f.db,'owner').search({accountIds:['b'],keywords:['Later']}).total&&Date.now()<deadline)await delay(10);assert.equal(new MailSearchStore(f.db,'owner').search({accountIds:['b'],keywords:['Later']}).total,1);
 }finally{indexer.close();}const before=f.db.get('SELECT count(*) AS n FROM mail_search_documents').n;await delay(80);assert.equal(f.db.get('SELECT count(*) AS n FROM mail_search_documents').n,before);
}));
test('unclosed repeated script tags have bounded extraction and an invalid received date cannot poison the batch',async()=>fixture(async f=>{
 f.seed();const html='<script>'.repeat(250000),raw=Buffer.from('Subject: Adversarial\r\nContent-Type: text/html\r\n\r\n'+html);await f.project(await f.raw(raw));assert.equal(f.projection.read('a',locator).state,'complete');f.db.run("INSERT INTO mail_gmail_metadata(account_id,message_key,internal_date,thread_id,label_ids_json) SELECT account_id,message_key,9000000000000000,'thread','[]' FROM mail_messages WHERE account_id='a'");
 f.repository.ingestMessage('a',{locator:{provider:'gmail',messageId:'following'},rfcMessageId:null,subject:'Following',memberships:[]});const search=new MailSearchStore(f.db,'owner'),started=performance.now();const result=search.rebuild({accountId:'a'});assert.ok(performance.now()-started<1500,'2MiB unmatched tags must not stall the worker');assert.equal(result.pending,0);assert.equal(search.search({keywords:['Following']}).total,1);assert.equal(search.search({keywords:['script']}).total,0);assert.ok(result.incomplete>=1);
}));

test('trigram candidates preserve arbitrary literal substrings, Unicode and GLOB metacharacters',async()=>fixture(async f=>{
 f.seed();await f.project(await f.raw(Buffer.from('Subject: PrefixAZ-12/34.5Suffix\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nMünchen literal [*?] marker aßb')));const search=new MailSearchStore(f.db,'owner');search.rebuild({accountId:'a'});
 for(const literal of ['AZ-12/34.5','12/34','[','*','?','[*?]','MÜNCHEN','Mu\u0308nchen','ß','aßb'])assert.equal(search.search({literal}).total,1,literal);
 for(const literal of ['AZ 12 34 5','[??]','MUNCHEN','PrefixAZ-12/34.6'])assert.equal(search.search({literal}).total,0,literal);
 await f.reopen();assert.equal(new MailSearchStore(f.db,'owner').search({literal:'12/34'}).total,1);
}));

test('paged FTS snippets retain deterministic order and exact structured filtering',async()=>fixture(async f=>{
 f.seed();const search=new MailSearchStore(f.db,'owner');
 for(let n=0;n<75;n++){const identity={provider:'gmail',messageId:'ordered-'+String(n).padStart(2,'0')};f.repository.ingestMessage('a',{locator:identity,rfcMessageId:null,subject:'Common',memberships:[]});f.runs.putGmailMetadata('a',identity,{internalDate:Date.parse('2001-01-01T00:00:00Z')+n*86400000,threadId:'t'+n,labelIds:[]});}
 while(search.rebuild({accountId:'a',limit:25}).pending){}
 const first=search.search({keywords:['Common'],limit:20}),second=search.search({keywords:['Common'],offset:20,limit:20});assert.equal(first.total,75);assert.equal(first.items[0].locator.messageId,'ordered-74');assert.equal(second.items[0].locator.messageId,'ordered-54');assert.equal(new Set([...first.items,...second.items].map(row=>row.locator.messageId)).size,40);
 assert.equal(search.search({beforeDate:'2001-01-11T00:00:00Z'}).total,10);
}));

test('schema 19 atomically builds substring candidates for existing encrypted documents',async()=>fixture(async f=>{
 f.seed();await f.project(await f.raw(Buffer.from('Subject: Existing AZ-12/34.5\r\n\r\nRetained text')));new MailSearchStore(f.db,'owner').rebuild({accountId:'a'});
 removeLaterMailSchema(f.db,18);f.db.exec('UPDATE mail_schema_version SET version=18');
 const interrupted={...f.db,exec(sql){f.db.exec(sql);if(sql.includes('CREATE VIRTUAL TABLE mail_search_trigram'))throw Error('interrupted migration');}};
 assert.throws(()=>migrateMailSchema(interrupted));assert.equal(f.db.get('SELECT version FROM mail_schema_version').version,18);assert.equal(f.db.get("SELECT name FROM sqlite_schema WHERE name='mail_search_trigram'"),undefined);
 migrateMailSchema(f.db);migrateMailSchema(f.db);assertMailSchema(f.db);assert.equal(new MailSearchStore(f.db,'owner').search({literal:'12/34'}).total,1);
 await f.raw(Buffer.from('Subject: Replaced\r\n\r\nReplacement'));assert.equal(new MailSearchStore(f.db,'owner').search({literal:'12/34'}).total,0);
}));

test('substring candidates find text following embedded NUL',async()=>fixture(async f=>{
 f.seed();await f.project(await f.raw(Buffer.from('Subject: File\r\nContent-Type: text/plain; charset=utf-8\r\n\r\nbefore\0afterneedle')));const search=new MailSearchStore(f.db,'owner');search.rebuild({accountId:'a'});assert.equal(search.search({literal:'afterneedle'}).total,1);assert.equal(search.search({literal:'before\0after'}).total,1);
}));

test('exact filename candidates retain JavaScript Unicode case normalization',async()=>fixture(async f=>{
 f.seed();await f.project(await f.raw(Buffer.from(mime.toString().replace('filename="brief.bin"',"filename*=UTF-8''%C4%B0nvoice.pdf"))));const search=new MailSearchStore(f.db,'owner');search.rebuild({accountId:'a'});
 assert.equal(search.search({filename:'İnvoice.PDF'}).total,1);assert.equal(search.search({filename:'i\u0307nvoice.pdf'}).total,1);assert.equal(search.search({filename:'invoice.pdf'}).total,0);
}));
