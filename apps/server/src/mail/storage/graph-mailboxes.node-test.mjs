import {removeLaterMailSchema} from '../testing/legacy-schema.mjs';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openEncryptedMailDatabase} from './database.js';
import {migrateMailSchema,MAIL_SCHEMA_VERSION} from './schema.js';
import {MailRepository} from './repository.js';
import {MailCredentialRepository} from './credentials.js';
import {GraphMailboxRepository} from './graph-mailboxes.js';
import {GraphReadTransport} from '../providers/graph.js';
import {MailAccessCoordinator} from '../providers/access-coordinator.js';
import {GraphBackfill} from '../providers/graph-backfill.js';
import {MailReadStore} from './read-store.js';
import {MailLocalApiStore} from './local-api.js';
import {LocalMailService} from '../service.js';
const binding={provider:'graph',clientId:'11111111-2222-3333-4444-555555555555',authority:'https://login.microsoftonline.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/v2.0',providerSubject:'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'};
const scopes=['openid','profile','offline_access','User.Read','Mail.ReadWrite','Mail.Send','Mail.ReadWrite.Shared','Mail.Send.Shared'];
const settings={provider:'graph',applicationType:'desktop',pkceMethod:'S256',clientId:binding.clientId,tenantId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',registeredRedirectUri:'http://localhost/mail/callback',scopes};
const tokens=()=>({accessToken:'synthetic',expiresAt:Date.now()+3600000,grantedScopes:scopes,refreshToken:{action:'replace',value:'synthetic-refresh'}});
async function fixture(body){const dir=await mkdtemp(join(tmpdir(),'mail-shared-')),path=join(dir,'mail.sqlite'),key=randomBytes(32);let db=await openEncryptedMailDatabase({path,key});try{migrateMailSchema(db);const repo=new MailRepository(db,'owner');repo.createAccount({id:'parent',provider:'graph',displayName:'Signed in'});const credentials=new MailCredentialRepository(db,'owner');credentials.connect('parent',binding,null,tokens());await body({db,dir,path,key,repo,credentials,mailboxes:new GraphMailboxRepository(db,'owner'),close(){db.close();db=undefined;}});}finally{db?.close();key.fill(0);await rm(dir,{recursive:true,force:true});}}
const config=(address,extra={})=>({credentialAccountId:'parent',address,kind:'shared',writeConfirmed:false,sendMode:'none',...extra});
async function until(fn){for(let i=0;i<500;i++){if(await fn())return;await new Promise(r=>setTimeout(r,10));}throw Error('timeout');}

test('separate scopes, explicit sender declarations, inherited custody, parent and child revocation fences',async()=>fixture(async({db,repo,credentials,mailboxes})=>{
 const a=mailboxes.configure(config('team@example.com')),b=mailboxes.configure(config('other@example.com',{kind:'delegated',writeConfirmed:true,sendMode:'send_on_behalf'}));
 assert.notEqual(a.accountId,b.accountId);assert.equal(db.get('SELECT count(*) AS n FROM mail_account_credentials').n,1);assert.equal(mailboxes.identity(a.accountId).read,true);assert.equal(mailboxes.identity(a.accountId).sendAllowed,false);assert.equal(mailboxes.identity(b.accountId).sendOnBehalf,true);assert.equal(mailboxes.identity(b.accountId).sentItems,'signed_in_mailbox');assert.throws(()=>mailboxes.assertSender(a.accountId,'team@example.com'));assert.throws(()=>mailboxes.assertSender(b.accountId,'other-wrong@example.com'));mailboxes.assertSender(b.accountId,'other@example.com');assert.deepEqual(mailboxes.submission(b.accountId,'other@example.com'),{credentialAccountId:'parent',basePath:'/me',from:'other@example.com',saveToSentItems:true,sendMode:'send_on_behalf'});assert.throws(()=>mailboxes.assertWrite(a.accountId));
 for(const accountId of [a.accountId,b.accountId]){repo.putFolder(accountId,{id:'inbox',name:'Inbox',kind:'folder'});db.run("UPDATE mail_folders SET role='inbox' WHERE account_id=?",[accountId]);repo.ingestMessage(accountId,{locator:{provider:'graph',messageId:'same-id'},subject:'synthetic',rfcMessageId:null,memberships:['inbox']});db.run('UPDATE mail_messages SET is_read=0 WHERE account_id=?',[accountId]);}
 const reads=new MailReadStore(db,'owner');assert.equal(reads.unreadInboxCount(),2);assert.equal(reads.list(a.accountId,{}).items.length,1);
 const access=new MailAccessCoordinator({database:db,ownerId:'owner',loadProviderSettings:async()=>settings});
 try{const granted=await access.acquire(a.accountId);assert.deepEqual(granted.version,credentials.status(a.accountId).version);assert.equal(credentials.getBinding(a.accountId).providerSubject,binding.providerSubject);
 const old=credentials.status(a.accountId).version;mailboxes.revoke(a.accountId);assert.equal(credentials.status(a.accountId).state,'disconnected');assert.equal(credentials.status(b.accountId).state,'connected');assert.equal(reads.unreadInboxCount(),1);await assert.rejects(access.acquire(a.accountId));assert.throws(()=>credentials.readAccess(a.accountId,binding));
 mailboxes.configure(config('team@example.com',{writeConfirmed:true,sendMode:'send_as'}));assert.notEqual(credentials.status(a.accountId).version.generation,old.generation);assert.equal(mailboxes.identity(a.accountId).sendAs,true);
 const before=credentials.status(b.accountId).version;credentials.disconnect('parent',credentials.status('parent').version);assert.equal(credentials.status(b.accountId).state,'disconnected');assert.equal(reads.unreadInboxCount(),0);credentials.connect('parent',binding,credentials.status('parent').version,tokens());assert.notEqual(credentials.status(b.accountId).version.generation,before.generation);
 credentials.rotate('parent',binding,credentials.status('parent').version,{...tokens(),grantedScopes:scopes.filter(scope=>!scope.endsWith('.Shared'))});assert.equal(mailboxes.identity(b.accountId).read,false);assert.equal(credentials.status(b.accountId).state,'disconnected');assert.equal(reads.unreadInboxCount(),0);await assert.rejects(access.acquire(b.accountId));credentials.rotate('parent',binding,credentials.status('parent').version,tokens());
 const local=new MailLocalApiStore(db,'owner');const draftId=randomUUID();const draft=local.saveDraft(a.accountId,{draftId,expected:null,content:{subject:'Test',to:['recipient@example.com'],from:'forged@example.com',text:'hello'}});assert.throws(()=>local.enqueueSubmission(a.accountId,{draftId,version:draft.version,replayKey:'bad-sender'}));
 assert.throws(()=>new GraphMailboxRepository(db,'foreign').target(a.accountId));
 }finally{await access.close();}
}));

test('shared transport binds every collection and continuation to the selected mailbox',async()=>{
 const urls=[];const fetch=async(url,init)=>{urls.push(String(url));assert.equal(init.headers.Prefer,'IdType="ImmutableId"');return Response.json({value:[],'@odata.deltaLink':String(url).split('?')[0]+'?$deltatoken=ok'});};
 const transport=new GraphReadTransport({accessToken:'synthetic',mailboxAddress:'team@example.com',fetch});
 await transport.messageDelta('inbox');assert.match(urls[0],/\/users\/team%40example.com\/mailFolders\/inbox\/messages\/delta/);
 const before=urls.length;for(const continuation of ['https://graph.microsoft.com/v1.0/me/mailFolders/inbox/messages/delta?$deltatoken=x','https://graph.microsoft.com/v1.0/users/other%40example.com/mailFolders/inbox/messages/delta?$deltatoken=x'])await assert.rejects(transport.messageDelta('inbox',continuation));assert.equal(urls.length,before);
});

test('mailbox-level 403 revokes shared access without touching the signed-in credential',async()=>fixture(async({db,mailboxes,credentials})=>{
 const shared=mailboxes.configure(config('revoked@example.com'));const access=new MailAccessCoordinator({database:db,ownerId:'owner',loadProviderSettings:async()=>settings});
 const engine=new GraphBackfill({database:db,ownerId:'owner',access,pollIntervalMs:20,transport:()=>new GraphReadTransport({accessToken:'synthetic',mailboxAddress:'revoked@example.com',fetch:async()=>new Response('',{status:403})})});
 try{engine.start(shared.accountId);await until(()=>mailboxes.read(shared.accountId).state==='revoked');assert.equal(credentials.status('parent').state,'connected');assert.equal(engine.status(shared.accountId).state,'attention');}finally{await engine.close();await access.close();}
}));

test('schema17 migration is atomic and idempotent',async()=>fixture(async({db})=>{
 removeLaterMailSchema(db,16);db.exec('DROP VIEW mail_account_access;DROP TABLE mail_graph_mailboxes;UPDATE mail_schema_version SET version=16');const broken={...db,exec(sql){db.exec(sql);if(sql.includes('CREATE VIEW mail_account_access'))throw Error('fault');}};assert.throws(()=>migrateMailSchema(broken));assert.equal(db.get('SELECT version FROM mail_schema_version').version,16);assert.equal(db.get("SELECT name FROM sqlite_schema WHERE name='mail_graph_mailboxes'"),undefined);migrateMailSchema(db);migrateMailSchema(db);assert.equal(db.get('SELECT version FROM mail_schema_version').version,MAIL_SCHEMA_VERSION);
}));

test('worker configures two shared mailboxes with independent sync and restores identity from storage',async()=>fixture(async({db,dir,path,key,close})=>{
 const worker=join(dir,'worker.mjs');
 await writeFile(worker,`const {existsSync}=await import('node:fs');globalThis.fetch=async(input,init)=>{
 const url=new URL(String(input));if(url.hostname!=='graph.microsoft.com')throw Error('Unexpected synthetic host');
 if(url.pathname.includes('/two%40example.com/')&&existsSync(${JSON.stringify(join(dir,'revoke'))}))return new Response('',{status:403});
 const mailbox=url.pathname.startsWith('/v1.0/me/')?'/v1.0/me':url.pathname.split('/').slice(0,4).join('/');
 if(url.pathname.endsWith('/mailFolders/msgfolderroot'))return Response.json({id:'root',displayName:'Root',parentFolderId:'root',childFolderCount:1});
 if(url.pathname.endsWith('/mailFolders/inbox'))return Response.json({id:'inbox',displayName:'Inbox',parentFolderId:'root',childFolderCount:0});
 if(url.pathname.endsWith('/mailFolders'))return Response.json({value:[{id:'inbox',displayName:'Inbox',parentFolderId:'root',childFolderCount:0}]});
 if(url.pathname.endsWith('/messages/delta'))return Response.json({value:[],'@odata.deltaLink':'https://graph.microsoft.com'+url.pathname+'?$deltatoken=synthetic'});
 if(url.pathname.endsWith('/messages'))return Response.json({value:[]});throw Error('Unexpected synthetic collection');};
 await import(${JSON.stringify(new URL('../runtime/worker.js',import.meta.url).href)});`);
 close();const service=new LocalMailService({executable:{kind:'node',path:process.execPath},entryPoint:worker,databasePath:path,ownerId:'owner',loadKey:async()=>Buffer.from(key),loadProviderSettings:async()=>settings});
 try{await service.unlock();
 const a=await service.configureGraphMailbox(config('one@example.com'));
 const b=await service.configureGraphMailbox(config('two@example.com',{kind:'delegated',sendMode:'send_as',writeConfirmed:true}));
 assert.notEqual(a.accountId,b.accountId);await until(async()=>{const rows=await service.listFolders(a.accountId);return rows.items.length===1;});
 assert.equal((await service.listAccounts()).items.filter(row=>row.identity).length,2);
 await service.pauseSync(a.accountId);assert.equal((await service.syncStatus(a.accountId)).state,'paused');assert.notEqual((await service.syncStatus(b.accountId)).state,'paused');
 await service.lock();await service.unlock();assert.equal((await service.syncStatus(a.accountId)).state,'paused');assert.equal((await service.listAccounts()).items.find(row=>row.id===b.accountId).identity.sendAs,true);
 await writeFile(join(dir,'revoke'),'synthetic');await assert.rejects(service.configureGraphMailbox(config('two@example.com')));assert.equal((await service.listAccounts()).items.find(row=>row.id===b.accountId).identity.state,'revoked');await rm(join(dir,'revoke'));assert.equal((await service.configureGraphMailbox(config('two@example.com'))).accountId,b.accountId);
 await service.disconnectAccount('parent');assert.equal((await service.listAccounts()).items.find(row=>row.id===b.accountId).identity.read,false);await assert.rejects(service.listMessages(b.accountId,{}));
 }finally{await service.stop();}
}));

test('shared list and delta continuations accept canonical mailbox encodings without changing opaque tokens',async()=>{
 const origin='https://graph.microsoft.com';
 for(const address of ['team@example.com','TEAM%40EXAMPLE.COM','%74eam%40example%2ecom','team%40example%2Ecom']){
  const visited=[];const collection='/v1.0/users/'+address+'/messages';
  const next=origin+collection+'?$skiptoken=A%2BB%2F%3D';
  const delta=origin+'/v1.0/users/'+address+'/mailFolders/inbox/messages/delta?$deltatoken=A%2BB%2F%3D';
  const transport=new GraphReadTransport({accessToken:'synthetic',mailboxAddress:'team@example.com',fetch:async url=>{
   visited.push(String(url));return Response.json(String(url).includes('/messages/delta')?{value:[],'@odata.deltaLink':delta}:String(url)===next?{value:[]}:{value:[],'@odata.nextLink':next});
  }});
  assert.equal((await transport.listMessages()).nextLink,next);await transport.listMessages(next);assert.equal(visited.at(-1),next);
  assert.equal((await transport.messageDelta('inbox')).deltaLink,delta);await transport.messageDelta('inbox',delta);assert.equal(visited.at(-1),delta);
 }
 const visited=[];const transport=new GraphReadTransport({accessToken:'synthetic',mailboxAddress:'team@example.com',fetch:async url=>{visited.push(String(url));return Response.json({value:[]});}});
 for(const scope of ['/v1.0/me','/v1.0/users/foreign@example.com','/v1.0/users/team%2540example.com','/v1.0/users/team@example.com%2f..','/v1.0/users/team@example.com%5c..','/v1.0/users/team@example.com/../foreign@example.com','/v1.0/users/team@example.com/%2e%2e/foreign@example.com','/v1.0/users/team%00@example.com']){
  await assert.rejects(transport.listMessages(origin+scope+'/messages?$skiptoken=x'));
  await assert.rejects(transport.messageDelta('inbox',origin+scope+'/mailFolders/inbox/messages/delta?$deltatoken=x'));
 }
 await assert.rejects(transport.listMessages(origin+'/v1.0/users/team@example.com/mailFolders?$skiptoken=x'));
 assert.equal(visited.length,0);
});

test('a parent archive lock fails shared access closed even with connected state and scopes',async()=>fixture(async({db,credentials,mailboxes})=>{
 const shared=mailboxes.configure(config('locked@example.com',{writeConfirmed:true,sendMode:'send_as'}));
 assert.equal(mailboxes.identity(shared.accountId).sendAllowed,true);
 // Deliberately inject inconsistent custody; normal SQL constraints disallow this state.
 db.exec("PRAGMA ignore_check_constraints=ON;UPDATE mail_account_credentials SET archive_locked=1 WHERE account_id='parent';PRAGMA ignore_check_constraints=OFF");
 const identity=mailboxes.identity(shared.accountId);assert.equal(identity.state,'disconnected');for(const field of ['read','write','sendAs','sendOnBehalf','sendAllowed'])assert.equal(identity[field],false);
 assert.equal(credentials.status(shared.accountId).state,'disconnected');assert.equal(credentials.status(shared.accountId).archiveLocked,true);
 assert.deepEqual(db.get('SELECT state,archive_locked FROM mail_account_access WHERE account_id=?',[shared.accountId]),{state:'disconnected',archive_locked:1});
 assert.throws(()=>mailboxes.configure(config('another@example.com')));assert.throws(()=>credentials.readAccess(shared.accountId,binding));assert.throws(()=>mailboxes.assertWrite(shared.accountId));assert.throws(()=>mailboxes.assertSender(shared.accountId,'locked@example.com'));
 const access=new MailAccessCoordinator({database:db,ownerId:'owner',loadProviderSettings:async()=>settings});try{await assert.rejects(access.acquire(shared.accountId));}finally{await access.close();}
 db.run("UPDATE mail_account_credentials SET archive_locked=0 WHERE account_id='parent'");assert.equal(mailboxes.identity(shared.accountId).read,true);
}));
