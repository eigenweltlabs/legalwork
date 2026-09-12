import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {openEncryptedMailDatabase} from './database.js';
import {migrateMailSchema} from './schema.js';
import {MailRepository} from './repository.js';
import {MailReadStore} from './read-store.js';
import {LocalMailService} from '../service.js';

test('aggregate deduplicates Inbox memberships, tracks unread/move/delete/disconnect and reopens through worker',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mail-badge-')),key=randomBytes(32),path=join(dir,'mail.sqlite');let db,service;
 try{
 db=await openEncryptedMailDatabase({path,key});migrateMailSchema(db);
 const repo=new MailRepository(db,'owner');
 const connect=(id,provider='gmail')=>db.run("INSERT INTO mail_account_credentials(account_id,provider,client_id,authority,provider_subject,generation,revision,state,archive_locked,access_token,expires_at) VALUES(?,?, '11111111-2222-3333-4444-555555555555','https://login.microsoftonline.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/v2.0','bbbbbbbb-cccc-dddd-eeee-ffffffffffff','11111111-1111-4111-8111-111111111111',1,'connected',0,'synthetic',9007199254740991)",[id,provider]);
 for(const id of ['a','b']) {repo.createAccount({id,provider:'gmail',displayName:id});for(const folder of ['INBOX','UNREAD','SPAM','TRASH','extra'])repo.putFolder(id,{id:folder,name:folder,kind:'label'});}
 new MailRepository(db,'foreign').createAccount({id:'foreign',provider:'gmail',displayName:'private'});
 const put=(id,messageId,memberships)=>repo.ingestMessage(id,{locator:{provider:'gmail',messageId},subject:'fixture',rfcMessageId:null,memberships});
 put('a','1',['INBOX','UNREAD','extra']);put('a','2',['INBOX','UNREAD','SPAM']);put('a','3',['INBOX','UNREAD','TRASH']);put('a','4',['extra','UNREAD']);put('b','1',['INBOX','UNREAD']);
 connect('a');connect('b');
 const reads=new MailReadStore(db,'owner');assert.equal(reads.unreadInboxCount(),2);assert.equal(new MailReadStore(db,'foreign').unreadInboxCount(),0);
 db.run("UPDATE mail_folders SET role='inbox' WHERE account_id='a' AND id='extra'");assert.equal(reads.unreadInboxCount(),3); // message 1 still counted once
 db.run("DELETE FROM mail_memberships WHERE account_id='a' AND message_key=? AND folder_id='UNREAD'",[JSON.stringify(['gmail','1'])]);assert.equal(reads.unreadInboxCount(),2);
 db.run("DELETE FROM mail_memberships WHERE account_id='b' AND folder_id='INBOX'");assert.equal(reads.unreadInboxCount(),1);
 db.run("UPDATE mail_account_credentials SET state='disconnected',archive_locked=1,access_token=NULL,expires_at=NULL WHERE account_id='a'");assert.equal(reads.unreadInboxCount(),0);
 db.run("DELETE FROM mail_account_credentials WHERE account_id='a'");assert.equal(reads.unreadInboxCount(),0);connect('a');assert.equal(reads.unreadInboxCount(),1);

 for(const provider of ['graph','imap']) {
   repo.createAccount({id:provider,provider,displayName:provider});
   if(provider==='graph')connect(provider,provider);else db.run("INSERT INTO mail_imap_credentials VALUES('imap','test',1,'connected',0,'{}','synthetic')");
   repo.putFolder(provider,{id:'inbox',name:'Inbox',kind:'folder'});
   db.run("UPDATE mail_folders SET role='inbox' WHERE account_id=?",[provider]);
   const locator=provider==='graph'?{provider,messageId:'1'}:{provider,mailboxId:'inbox',uidValidity:1,uid:1};
   repo.ingestMessage(provider,{locator,subject:'fixture',rfcMessageId:null,memberships:['inbox']});
   db.run('UPDATE mail_messages SET is_read=0 WHERE account_id=?',[provider]);
 }
 assert.equal(reads.unreadInboxCount(),3);
 db.run("UPDATE mail_messages SET is_read=1 WHERE account_id='graph'");assert.equal(reads.unreadInboxCount(),2);
 db.run("UPDATE mail_messages SET is_read=0 WHERE account_id='graph'");assert.equal(reads.unreadInboxCount(),3);
 db.run("DELETE FROM mail_memberships WHERE account_id='imap'");assert.equal(reads.unreadInboxCount(),2);
 db.run("INSERT INTO mail_tombstones(account_id,message_key,reason,observed_at) SELECT account_id,message_key,'deleted','fixture' FROM mail_messages WHERE account_id='graph'");assert.equal(reads.unreadInboxCount(),1);
 db.close();db=undefined;
 service=new LocalMailService({executable:{kind:'node',path:process.execPath},entryPoint:fileURLToPath(new URL('../runtime/worker.js',import.meta.url)),databasePath:path,ownerId:'owner',loadKey:async()=>Buffer.from(key)});
 await service.unlock();assert.equal(await service.unreadInboxCount(),1);await service.lock();await service.unlock();assert.equal(await service.unreadInboxCount(),1);
 }finally{await service?.stop();db?.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
});
