import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {openEncryptedMailDatabase} from './database.js';
import {migrateMailSchema} from './schema.js';
import {MailRepository} from './repository.js';
import {MailReadStore} from './read-store.js';
import {MailContentStore} from './content-store.js';
import {MimeProjectionStore} from './mime-projection-store.js';
import {MailSearchStore} from './search.js';

test('list preview is bounded Unicode text from the current indexed source, never a replaced or foreign body',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mail-preview-')),key=randomBytes(32);let db;
 try{
  db=await openEncryptedMailDatabase({path:join(directory,'mail.sqlite'),key});migrateMailSchema(db);
  const repository=new MailRepository(db,'owner'),locator={provider:'gmail',messageId:'message'};
  repository.createAccount({id:'account',provider:'gmail',displayName:'Synthetic'});
  repository.ingestMessage('account',{locator,subject:'Synthetic',rfcMessageId:null,memberships:[]});
  const content=new MailContentStore(db,'owner'),projections=new MimeProjectionStore(db,'owner'),search=new MailSearchStore(db,'owner'),reader=new MailReadStore(db,'owner');
  const publish=async text=>{
   const raw=await content.writePart('account',locator,{kind:'raw',maxBytes:10000},[Buffer.from('Subject: Synthetic\r\n\r\n'+text)]);
   assert.equal(reader.read('account',locator).preview,undefined,'raw replacement hides prior index immediately');
   const body=await content.writePart('account',locator,{kind:'body',maxBytes:10000},[Buffer.from(JSON.stringify({version:1,bodies:[{partId:'1',contentType:'text/plain',text}]}))]);
   projections.complete('account',locator,raw.id,{metadata:{subject:'Synthetic',from:'sender@example.test',to:'reader@example.test',cc:null,bcc:null,replyTo:null,date:null,messageId:null},bodies:[{partId:'1',contentType:'text/plain'}],body,attachments:[]});
   assert.equal(reader.read('account',locator).preview,undefined,'projection replacement remains hidden until rebuild');
   search.rebuild({accountId:'account',limit:25});
  };
  await publish('😀'.repeat(300));
  assert.equal(reader.read('account',locator).preview,'😀'.repeat(240));
  assert.throws(()=>new MailReadStore(db,'foreign').read('account',locator));
  await publish('Current\n\t source only');
  assert.equal(reader.read('account',locator).preview,'Current source only');
  assert.equal(reader.list('account',{limit:25}).items[0].preview,'Current source only');
 }finally{db?.close();key.fill(0);await rm(directory,{recursive:true,force:true});}
});
