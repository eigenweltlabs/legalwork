import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {openEncryptedMailDatabase} from './database.js';
import {migrateMailSchema,MAIL_SCHEMA_VERSION} from './schema.js';
import {MailRepository} from './repository.js';
import {MAIL_READER_SCHEMA_SQL} from './reader-schema.js';
import {MailReadStore} from './read-store.js';
import {MailActionJournal} from './action-journal.js';
import {LocalMailService} from '../service.js';

test('provider received order, real inbox roles, unknown dates and large-frame continuations survive worker pagination',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mail-reader-')),key=randomBytes(32),path=join(dir,'mail.sqlite');let db,service;
 try{db=await openEncryptedMailDatabase({path,key});migrateMailSchema(db);const repo=new MailRepository(db,'owner');for(const id of ['a','other'])repo.createAccount({id,provider:'gmail',displayName:id});new MailRepository(db,'foreign').createAccount({id:'foreign',provider:'gmail',displayName:'private'});
 for(const id of ['INBOX','SENT','SPAM','TRASH'])repo.putFolder('a',{id,name:id==='SENT'?'Inbox':id,kind:'label'});
 const expected=[];for(let index=0;index<40;index++){const messageId=String(40-index),locator={provider:'gmail',messageId},stamp=1000+index;repo.ingestMessage('a',{locator,subject:'s'.repeat(4000),rfcMessageId:null,memberships:[index%2?'INBOX':'SENT']});db.run('INSERT INTO mail_gmail_metadata(account_id,message_key,internal_date,thread_id,label_ids_json) VALUES(?,?,?,?,?)',['a',JSON.stringify(['gmail',messageId]),stamp,'thread','[]']);expected.unshift(messageId);}
 repo.ingestMessage('a',{locator:{provider:'gmail',messageId:'unknown'},subject:'unknown',rfcMessageId:null,memberships:['INBOX']});expected.push('unknown');
 const reads=new MailReadStore(db,'owner');assert.throws(()=>reads.list('foreign',{order:'received'}));assert.equal(reads.list('a',{order:'received',limit:1}).items[0].locator.messageId,'1');const inbox=reads.list('a',{order:'received',inboxOnly:true,limit:100});assert.equal(inbox.items.length,21);assert.ok(inbox.items.every(item=>item.memberships.includes('INBOX')));assert.equal(repo.listFoldersPage('a').items.find(item=>item.id==='SENT').role,null);assert.equal(repo.listFoldersPage('a').items.find(item=>item.id==='INBOX').role,'inbox');
 repo.createAccount({id:'imap',provider:'imap',displayName:'IMAP'});
 for(const [id,special] of [['inbox',null],['Posteingang','\\Inbox'],['fake',null]]) {repo.putFolder('imap',{id,name:'Inbox',kind:'folder'});db.run('INSERT INTO mail_imap_folders(account_id,path,special_use,selectable,selected,generation) VALUES(?,?,?,1,1,?)',['imap',id,special,'synthetic']);}
 for(const [uid,stamp,folder] of [[1,9000,'Posteingang'],[2,1000,'inbox'],[3,null,'fake']]) { const locator={provider:'imap',mailboxId:folder,uidValidity:1,uid};repo.ingestMessage('imap',{locator,subject:'IMAP receipt',rfcMessageId:null,memberships:[folder]});db.run('INSERT INTO mail_imap_messages(account_id,message_key,internal_date) VALUES(?,?,?)',['imap',JSON.stringify(['imap',folder,1,uid]),stamp]); }
 // Isolated reader DDL rollback on current storage; retain later migrations and their data.
 db.exec('DROP TRIGGER mail_known_inbox; DROP INDEX mail_folder_role; ALTER TABLE mail_folders DROP COLUMN role');assert.throws(()=>db.transaction(()=>{db.exec(MAIL_READER_SCHEMA_SQL);throw Error('injected rollback');}));assert.equal(db.all('PRAGMA table_info(mail_folders)').some(row=>row.name==='role'),false);db.transaction(()=>db.exec(MAIL_READER_SCHEMA_SQL));migrateMailSchema(db);migrateMailSchema(db);assert.equal(db.get('SELECT version FROM mail_schema_version').version,MAIL_SCHEMA_VERSION);const imapPage=reads.list('imap',{order:'received',inboxOnly:true});assert.deepEqual(imapPage.items.map(item=>item.receivedAt),[9000,1000]);assert.equal(repo.listFoldersPage('imap').items.find(item=>item.id==='fake').role,null);assert.equal(db.get('SELECT count(*) AS n FROM mail_imap_messages').n,3);db.close();db=undefined;
 service=new LocalMailService({ownerId:'owner',databasePath:path,loadKey:async()=>Buffer.from(key),executable:{kind:'node',path:process.execPath},entryPoint:fileURLToPath(new URL('../runtime/worker.js',import.meta.url))});await service.unlock();let after;const seen=[];let first=true;do{const page=await service.listMessages('a',{order:'received',limit:25,...(after?{after}:{})});if(first){assert.ok(page.items.length<25);first=false;}seen.push(...page.items.map(item=>item.locator.messageId));after=page.nextCursor;if(after)assert.equal(JSON.parse(after).length,2);}while(after);assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,41);await assert.rejects(service.listMessages('foreign',{order:'received'}));
 }finally{await service?.stop();db?.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
});

test('conversation pages group the whole account thread, preserve singletons and include replies outside Inbox',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mail-conversations-')),key=randomBytes(32);let db;
 try{
  db=await openEncryptedMailDatabase({path:join(dir,'mail.sqlite'),key});migrateMailSchema(db);
  const repo=new MailRepository(db,'owner');for(const account of ['a','b']){repo.createAccount({id:account,provider:'gmail',displayName:account});for(const id of ['INBOX','SENT','UNREAD'])repo.putFolder(account,{id,name:id,kind:'label'});}
  const add=(account,id,threadId,stamp,memberships)=>{repo.ingestMessage(account,{locator:{provider:'gmail',messageId:id},subject:'Same subject',threadId,rfcMessageId:null,memberships});db.run('INSERT INTO mail_gmail_metadata(account_id,message_key,internal_date,thread_id,label_ids_json) VALUES(?,?,?,?,?)',[account,JSON.stringify(['gmail',id]),stamp,threadId??'single','[]']);};
  for(let i=0;i<31;i++)add('a','reply'+i,'shared-thread',100+i,i===30?['SENT']:['INBOX',...(i<2?['UNREAD']:[])]);
  add('b','foreign','shared-thread',999,['INBOX','UNREAD']);add('a','solo1',null,10,['INBOX']);add('a','solo2',null,9,['INBOX']);
  const store=new MailReadStore(db,'owner');const first=store.list('a',{conversations:true,order:'received',inboxOnly:true,limit:1});
  assert.equal(first.items.length,1);assert.equal(first.items[0].locator.messageId,'reply30');assert.deepEqual(first.items[0].conversation,{count:31,unreadCount:2});
  const rest=store.list('a',{conversations:true,order:'received',inboxOnly:true,limit:10,after:first.nextCursor});assert.deepEqual(rest.items.map(value=>value.locator.messageId),['solo1','solo2']);
  assert.deepEqual(store.list('b',{conversations:true,order:'received',inboxOnly:true}).items[0].conversation,{count:1,unreadCount:1});
  assert.equal(store.list('a',{threadId:'shared-thread',order:'received',limit:100}).items.length,31);
  const journal=new MailActionJournal(db,'owner');
  const queue=(id,read,replayKey)=>journal.enqueue('a',{kind:'mutation',replayKey,payloadJson:JSON.stringify({version:1,intent:{kind:'mutation',locator:{provider:'gmail',messageId:id},change:{kind:'read',read}},credentialGeneration:'00000000-0000-4000-8000-000000000001'}),precondition:'observed',conflictPolicy:'manual'});
  const count=()=>store.list('a',{conversations:true,order:'received',inboxOnly:true}).items[0].conversation.unreadCount;
  const read0=queue('reply0',true,'read0');assert.equal(count(),1);
  db.run("DELETE FROM mail_memberships WHERE account_id='a' AND message_key=? AND folder_id='UNREAD'",[JSON.stringify(['gmail','reply0'])]);assert.equal(count(),1,'provider refresh must not subtract the same read twice');
  const read1=queue('reply1',true,'read1');assert.equal(count(),0);
  db.run("UPDATE mail_action_jobs SET state='succeeded' WHERE account_id='a' AND id=?",[read0.id]);assert.equal(count(),0);
  db.run("UPDATE mail_action_jobs SET state='cancelled' WHERE account_id='a' AND id=?",[read1.id]);assert.equal(count(),1,'cancelling an optimistic read restores the remaining unread');
  queue('reply0',false,'unread0');assert.equal(count(),2,'explicit pending unread counts independently of provider state');

 }finally{db?.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
});
