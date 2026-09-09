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
import {MailReadStore} from './read-store.js';
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
 // Genuine v12 upgrade rollback; no dropping unrelated production data.
 db.exec('DROP TRIGGER mail_known_inbox; DROP INDEX mail_folder_role; ALTER TABLE mail_folders DROP COLUMN role');db.run('UPDATE mail_schema_version SET version=12');db.exec("CREATE TRIGGER migration_fail BEFORE UPDATE ON mail_schema_version BEGIN SELECT RAISE(ABORT,'injected'); END");assert.throws(()=>migrateMailSchema(db));assert.equal(db.all('PRAGMA table_info(mail_folders)').some(row=>row.name==='role'),false);db.exec('DROP TRIGGER migration_fail');migrateMailSchema(db);migrateMailSchema(db);assert.equal(db.get('SELECT version FROM mail_schema_version').version,MAIL_SCHEMA_VERSION);const imapPage=reads.list('imap',{order:'received',inboxOnly:true});assert.deepEqual(imapPage.items.map(item=>item.receivedAt),[9000,1000]);assert.equal(repo.listFoldersPage('imap').items.find(item=>item.id==='fake').role,null);assert.equal(db.get('SELECT count(*) AS n FROM mail_imap_messages').n,3);db.close();db=undefined;
 service=new LocalMailService({ownerId:'owner',databasePath:path,loadKey:async()=>Buffer.from(key),executable:{kind:'node',path:process.execPath},entryPoint:fileURLToPath(new URL('../runtime/worker.js',import.meta.url))});await service.unlock();let after;const seen=[];let first=true;do{const page=await service.listMessages('a',{order:'received',limit:25,...(after?{after}:{})});if(first){assert.ok(page.items.length<25);first=false;}seen.push(...page.items.map(item=>item.locator.messageId));after=page.nextCursor;if(after)assert.equal(JSON.parse(after).length,2);}while(after);assert.deepEqual(seen,expected);assert.equal(new Set(seen).size,41);await assert.rejects(service.listMessages('foreign',{order:'received'}));
 }finally{await service?.stop();db?.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
});
