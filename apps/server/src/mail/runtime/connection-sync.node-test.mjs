import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp, rm, writeFile, readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {LocalMailService} from '../service.js';
import {GMAIL_MAIL_SCOPES, GRAPH_MAIL_SCOPES} from '../provider-config.js';
import {openEncryptedMailDatabase} from '../storage/database.js';
const gmail={provider:'gmail',applicationType:'desktop',pkceMethod:'S256',clientId:'synthetic.apps.googleusercontent.com',clientSecret:'synthetic-secret',scopes:GMAIL_MAIL_SCOPES};
const graph={provider:'graph',applicationType:'desktop',pkceMethod:'S256',clientId:'11111111-2222-3333-4444-555555555555',tenantId:'consumers',registeredRedirectUri:'http://localhost/mail/callback',scopes:GRAPH_MAIL_SCOPES};
async function until(fn){for(let n=0;n<600;n++){const value=await fn();if(value)return value;await new Promise(r=>setTimeout(r,10));}throw Error('connection sync deadline');}
async function connect(service, provider, subject, reconnect){
 const begun=await service.beginConnection(provider,reconnect,provider==='graph');const url=new URL(begun.authorizationUrl),callback=new URL(url.searchParams.get('redirect_uri'));callback.search=new URLSearchParams({state:url.searchParams.get('state'),code:subject}).toString();
 assert.equal((await fetch(callback)).status,200);
 const status=await until(async()=>{const s=await service.connectionStatus(begun.connectionId);return !['pending','verifying'].includes(s.state)&&s;});assert.equal(status.state,'connected',JSON.stringify(status));return {...status,callback,begun};
}
test('real OAuth callback → encrypted account → account-owned worker, duplicate announcements, offline restart and deliberate pause',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mail-auto-sync-')),path=join(dir,'mail.sqlite'),key=randomBytes(32),entry=join(dir,'worker.mjs'),mode=join(dir,'mode.json'),log=join(dir,'calls.jsonl');let service;
 await writeFile(mode,JSON.stringify({offline:false}));await writeFile(log,'');
 await writeFile(entry,`
 import {readFile,appendFile} from 'node:fs/promises';
 const mime=Buffer.from('From: Sender <sender@example.test>\\r\\nTo: owner@example.test\\r\\nSubject: Automatic arrival\\r\\n\\r\\nStored offline body');
 globalThis.fetch=async(input,init={})=>{
  const url=new URL(input),flags=JSON.parse(await readFile(${JSON.stringify(mode)},'utf8'));
  if(url.pathname.endsWith('/token')){const params=new URLSearchParams(init.body);return Response.json({access_token:params.get('code')||'first',refresh_token:'synthetic-renewal',token_type:'Bearer',expires_in:3600,scope:url.hostname==='oauth2.googleapis.com'?${JSON.stringify(GMAIL_MAIL_SCOPES.join(' '))}:${JSON.stringify(GRAPH_MAIL_SCOPES.join(' '))}});}
  const subject=init.headers?.Authorization?.replace('Bearer ','')||'first';
  if(url.pathname.includes('userinfo'))return Response.json({sub:subject,email:subject+'@example.test',email_verified:true,name:subject});
  if(url.pathname==='/v1.0/me')return Response.json({id:subject,mail:subject+'@example.test',displayName:subject});
  if(url.pathname.endsWith('/profile'))return Response.json({emailAddress:subject+'@example.test',historyId:'1',messagesTotal:1,threadsTotal:1});
  await appendFile(${JSON.stringify(log)},JSON.stringify({subject,path:url.pathname})+'\\n');
  if(flags.offline)throw Error('synthetic offline');
  if(url.hostname==='gmail.googleapis.com'){
   if(url.pathname.endsWith('/labels'))return Response.json({labels:[{id:'INBOX',name:'Inbox',type:'system'}]});
   if(url.pathname.endsWith('/history'))return Response.json({historyId:'1'});
   if(url.pathname.endsWith('/messages'))return Response.json({messages:[{id:'one',threadId:'thread'}],resultSizeEstimate:1});
   if(url.pathname.endsWith('/messages/one'))return Response.json({id:'one',threadId:'thread',labelIds:['INBOX'],historyId:'1',internalDate:'1000',sizeEstimate:mime.length,raw:mime.toString('base64url')});
  }
  if(url.hostname==='graph.microsoft.com'){
   if(url.pathname==='/v1.0/me/mailFolders')return Response.json({value:[{id:'inbox',displayName:'Inbox',parentFolderId:'root',childFolderCount:0}]});
   if(url.pathname==='/v1.0/me/mailFolders/msgfolderroot')return Response.json({id:'root',displayName:'Root',parentFolderId:'root',childFolderCount:1});
   if(url.pathname==='/v1.0/me/mailFolders/inbox')return Response.json({id:'inbox',displayName:'Inbox',parentFolderId:'root',childFolderCount:0});
   if(url.pathname.endsWith('/messages/delta'))return Response.json({value:[], '@odata.deltaLink':'https://graph.microsoft.com'+url.pathname+'?$deltatoken=fixture'});
   if(url.pathname.endsWith('/messages'))return Response.json({value:[]});
  }
  throw Error('unexpected synthetic path '+url.pathname);
 };
 await import(${JSON.stringify(new URL('./worker.js',import.meta.url).href)});
 `);
 const make=()=>new LocalMailService({ownerId:'owner',databasePath:path,loadKey:async()=>Buffer.from(key),loadProviderSettings:async provider=>provider==='gmail'?gmail:graph,executable:{kind:'node',path:process.execPath},entryPoint:entry});
 try{
  service=make();await service.unlock();const first=await connect(service,'gmail','first');
  await until(async()=> (await service.syncStatus(first.accountId)).state==='complete');
  assert.equal((await service.listMessages(first.accountId,{})).items[0].subject,'Automatic arrival');
  const db=await openEncryptedMailDatabase({path,key});
  try {assert.equal(db.get('SELECT count(*) AS n FROM mail_account_credentials').n,1);assert.equal(db.get('SELECT count(*) AS n FROM mail_gmail_runs').n,1);}finally{db.close();}
  for(let n=0;n<3;n++)assert.equal((await service.connectionStatus(first.begun.connectionId)).accountId,first.accountId);
  await Promise.all([service.startSync(first.accountId),service.startSync(first.accountId)]);
  const second=await connect(service,'gmail','second');await until(async()=> (await service.syncStatus(second.accountId)).state==='complete');
  const microsoft=await connect(service,'graph','personal');await until(async()=> (await service.syncStatus(microsoft.accountId)).state==='complete');
  await service.pauseSync(first.accountId);await connect(service,'gmail','first',first.accountId);assert.equal((await service.syncStatus(first.accountId)).state,'paused');
  await service.pauseSync(microsoft.accountId);await connect(service,'graph','personal',microsoft.accountId);assert.equal((await service.syncStatus(microsoft.accountId)).state,'paused');
  await writeFile(mode,JSON.stringify({offline:true}));const offline=await connect(service,'gmail','offline');await until(async()=> (await service.syncStatus(offline.accountId)).state==='waiting');
  const before=await service.syncStatus(offline.accountId);assert.equal(before.error,'provider_unavailable');
  await service.stop();service=make();await service.unlock();assert.equal((await service.syncStatus(first.accountId)).state,'paused');assert.equal((await service.syncStatus(microsoft.accountId)).state,'paused');assert.equal((await service.syncStatus(offline.accountId)).state,'waiting');
  await writeFile(mode,JSON.stringify({offline:false}));
  // The normal explicit retry path preserves checkpoints, including its provider retry floor.
  const recovery=await openEncryptedMailDatabase({path,key});try{recovery.run('UPDATE mail_gmail_runs SET next_retry_at=NULL WHERE account_id=?',[offline.accountId]);}finally{recovery.close();}
  await connect(service,'gmail','offline',offline.accountId);await until(async()=> (await service.syncStatus(offline.accountId)).state==='complete');
  assert.equal((await service.listMessages(offline.accountId,{})).items.length,1);
  const calls=(await readFile(log,'utf8')).trim().split('\n').map(JSON.parse);assert.equal(calls.filter(c=>c.subject==='first'&&c.path.endsWith('/messages/one')).length,1);
 }finally{await service?.stop();key.fill(0);await rm(dir,{recursive:true,force:true});}
});
