import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {LocalMailService} from '../service.js';
import {openEncryptedMailDatabase} from '../storage/database.js';

async function until(fn){for(let n=0;n<600;n++){const value=await fn();if(value)return value;await new Promise(resolve=>setTimeout(resolve,10));}throw Error('integration sync deadline');}
test('real encrypted worker syncs connector accounts through the private host gateway and preserves pauses across restart',async()=>{
 const directory=await mkdtemp(join(tmpdir(),'mail-integrated-worker-')),path=join(directory,'mail.sqlite'),key=randomBytes(32),capability='c'.repeat(64);
 const account={accountId:'mail_'+'a'.repeat(64),handle:'b'.repeat(64),connectorId:'gmail',connectionId:'shared-connection',identity:'owner@example.test',email:'owner@example.test',displayName:'Owner',scopes:['https://www.googleapis.com/auth/gmail.readonly']};
 const calls=[],mime=Buffer.from('From: sender@example.test\r\nTo: owner@example.test\r\nSubject: Shared account\r\n\r\nOffline mail from the shared connector.\r\n');
 const gateway=createServer((request,response)=>{
  assert.equal(request.url,'/mail/internal/integrations/request');assert.equal(request.headers.authorization,undefined);assert.equal(request.headers['x-legalwork-mail-capability'],capability);assert.equal(request.headers['x-legalwork-mail-account'],account.accountId);
  const endpoint=new URL(request.headers['x-legalwork-mail-endpoint']);calls.push(endpoint.pathname);
  response.setHeader('content-type','application/json');
  const value=endpoint.pathname.endsWith('/profile')?{emailAddress:account.email,historyId:'1',messagesTotal:1,threadsTotal:1}
   :endpoint.pathname.endsWith('/labels')?{labels:[{id:'INBOX',name:'Inbox',type:'system'}]}
   :endpoint.pathname.endsWith('/messages')?{messages:[{id:'one',threadId:'thread'}],resultSizeEstimate:1}
   :endpoint.pathname.endsWith('/messages/one')?{id:'one',threadId:'thread',labelIds:['INBOX'],historyId:'1',internalDate:'1000',sizeEstimate:mime.length,raw:mime.toString('base64url')}
   :endpoint.pathname.endsWith('/history')?{historyId:'1'}:null;
  if(!value){response.statusCode=404;response.end('{}');return;}response.end(JSON.stringify(value));
 });
 await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));const address=gateway.address();assert.equal(typeof address,'object');
 let accounts=[account],service;
 const make=()=>{const next=new LocalMailService({ownerId:'owner',databasePath:path,loadKey:async()=>Buffer.from(key),loadProviderSettings:async()=>{throw Error('duplicate OAuth settings must not load');},executable:{kind:'node',path:process.execPath},entryPoint:new URL('./worker.js',import.meta.url).pathname});next.configureIntegrations(async()=>({configuration:{origin:'http://127.0.0.1:'+address.port,capability},handles:accounts.map(value=>value.handle),accounts}));return next;};
 try{
  service=make();await service.unlock();
  await assert.rejects(service.beginConnection('gmail'),{message:'mail_unsupported'});
  await until(async()=> (await service.syncStatus(account.accountId)).state==='complete');
  assert.equal((await service.listAccounts({})).items[0].integration,'gmail');
  assert.equal((await service.listMessages(account.accountId,{})).items[0].subject,'Shared account');
  await service.pauseSync(account.accountId);await service.stop();
  // Provider discovery can be offline indefinitely without delaying local unlock.
  service=new LocalMailService({ownerId:'owner',databasePath:path,loadKey:async()=>Buffer.from(key),executable:{kind:'node',path:process.execPath},entryPoint:new URL('./worker.js',import.meta.url).pathname});
  service.configureIntegrations(()=>new Promise(()=>{}));
  let timer;try{await Promise.race([service.unlock(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('offline unlock delayed by provider')),2000);})]);}finally{clearTimeout(timer);}
  assert.equal((await service.listMessages(account.accountId,{})).items[0].subject,'Shared account');await service.stop();
  service=make();await service.unlock();assert.equal((await service.syncStatus(account.accountId)).state,'paused');
  assert.equal((await service.listMessages(account.accountId,{})).items[0].subject,'Shared account');
  accounts=[];await service.refreshIntegrations(true);assert.equal((await service.listAccounts({})).items.length,1);
  await assert.rejects(service.listMessages(account.accountId,{}),{message:'mail_locked'});
  await service.stop();service=undefined;
  const db=await openEncryptedMailDatabase({path,key});try{assert.equal(db.get('SELECT refresh_token FROM mail_account_credentials').refresh_token,null);assert.equal(db.get('SELECT access_token FROM mail_account_credentials').access_token,null);assert.equal(db.get('SELECT count(*) n FROM mail_messages').n,1);assert.deepEqual(db.all('PRAGMA foreign_key_check'),[]);}finally{db.close();}
  assert.ok(calls.some(path=>path.endsWith('/messages/one')));
 }finally{await service?.stop();await new Promise(resolve=>gateway.close(resolve));key.fill(0);await rm(directory,{recursive:true,force:true});}
});
