import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createServer} from 'node:http';
import {mkdtemp,rm,writeFile,readFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import {LocalMailService} from '../service.js';
import {openEncryptedMailDatabase} from '../storage/database.js';
import {migrateMailSchema} from '../storage/schema.js';
import {MailRepository} from '../storage/repository.js';
import {MailContentStore} from '../storage/content-store.js';
import {MailCredentialRepository} from '../storage/credentials.js';
import {SenderIdentityRepository} from '../storage/sender-identities.js';
import {OutboxStore} from '../storage/outbox.js';

async function until(fn){for(let n=0;n<600;n++){try{const value=await fn();if(value)return value;}catch{}await new Promise(resolve=>setTimeout(resolve,10));}throw Error('adoption deadline');}
async function fixture(fn){
 const directory=await mkdtemp(join(tmpdir(),'mail-adoption-worker-')),path=join(directory,'mail.sqlite'),key=randomBytes(32),entry=join(directory,'worker.mjs'),proofs=join(directory,'proofs'),gate=join(directory,'gate');
 await writeFile(proofs,'');await writeFile(gate,'run');
 await writeFile(entry,`import {appendFile,readFile} from 'node:fs/promises';const network=globalThis.fetch;globalThis.fetch=async(input,init)=>{const url=new URL(input instanceof Request?input.url:input);if(url.origin==='https://gmail.googleapis.com'&&url.pathname==='/gmail/v1/users/me/profile'){if(new Headers(init.headers).get('authorization')!=='Bearer old-token')throw Error('unexpected proof credential');await appendFile(${JSON.stringify(proofs)},'proof\\n');if(await readFile(${JSON.stringify(gate)},'utf8')==='hold')return new Promise((_,reject)=>{const abort=()=>reject(Error('proof aborted'));if(init.signal.aborted)abort();else init.signal.addEventListener('abort',abort,{once:true});});return Response.json({emailAddress:'owner@example.test'});}if(url.hostname==='127.0.0.1')return network(input,init);throw Error('unexpected provider request');};await import(${JSON.stringify(new URL('./worker.js',import.meta.url).href)});`);
 const account={accountId:'mail_'+'a'.repeat(64),handle:'b'.repeat(64),connectorId:'gmail',connectionId:'connection',identity:'owner@example.test',email:'owner@example.test',displayName:'Owner',scopes:['https://www.googleapis.com/auth/gmail.modify']},capability='c'.repeat(64),calls=[];
 const gateway=createServer((request,response)=>{assert.equal(request.url,'/mail/internal/integrations/request');assert.equal(request.headers.authorization,undefined);assert.equal(request.headers['x-legalwork-mail-capability'],capability);assert.equal(request.headers['x-legalwork-mail-account'],account.accountId);assert.equal(request.headers['x-legalwork-mail-method'],'GET');const url=new URL(request.headers['x-legalwork-mail-endpoint']);calls.push(url.pathname);response.setHeader('content-type','application/json');const value=url.pathname.endsWith('/profile')?{emailAddress:account.email,historyId:'1',messagesTotal:0,threadsTotal:0}:url.pathname.endsWith('/labels')?{labels:[{id:'INBOX',name:'Inbox',type:'system'}]}:url.pathname.endsWith('/history')?{historyId:'1'}:url.pathname.endsWith('/messages')?{messages:[],resultSizeEstimate:0}:null;if(!value){response.statusCode=404;response.end('{}');return;}response.end(JSON.stringify(value));});
 await new Promise(resolve=>gateway.listen(0,'127.0.0.1',resolve));const address=gateway.address();let accounts=[account];const services=[];
 const make=async()=>{const service=new LocalMailService({ownerId:'owner',databasePath:path,loadKey:async()=>Buffer.from(key),loadProviderSettings:async()=>{throw Error('old provider settings must not be required');},executable:{kind:'node',path:process.execPath},entryPoint:entry});services.push(service);service.configureIntegrations(async()=>({configuration:{origin:'http://127.0.0.1:'+address.port,capability},handles:accounts.map(account=>account.handle),accounts}));await service.setLifecycleSuspended(true);await service.unlock();return service;};
 const seed=async()=>{const db=await openEncryptedMailDatabase({path,key});try{migrateMailSchema(db);const repository=new MailRepository(db,'owner');repository.createAccount({id:'retained',provider:'gmail',displayName:'Old account'});const binding={provider:'gmail',clientId:'old.apps.googleusercontent.com',authority:'https://accounts.google.com',providerSubject:'immutable-old-subject'},credentials=new MailCredentialRepository(db,'owner');const version=credentials.connect('retained',binding,null,{accessToken:'old-token',expiresAt:Date.now()+3600000,grantedScopes:account.scopes,refreshToken:{action:'replace',value:'old-refresh'}});const sender=new SenderIdentityRepository(db,'owner').replace('retained',version.generation,[{address:account.email,displayName:'Owner',primary:true,default:true}])[0];const locator={provider:'gmail',messageId:'old'};repository.putFolder('retained',{id:'INBOX',name:'Inbox',kind:'label'});repository.ingestMessage('retained',{locator,subject:'Original retained mail',rfcMessageId:null,memberships:['INBOX']});const reference=await new MailContentStore(db,'owner').writePart('retained',locator,{kind:'raw',maxBytes:100},[Buffer.from('Subject: Original retained mail\r\n\r\nOriginal body\r\n')]);const store=new OutboxStore(db,'owner'),draft=store.local.saveDraft('retained',{draftId:randomUUID(),expected:null,content:{senderIdentityId:sender.id,from:sender.address,to:['recipient@example.test'],subject:'Retained draft',text:'Must not send automatically'}}),item=await store.queue('retained',{draftId:draft.id,version:draft.version,replayKey:randomUUID()});return{reference,locator,draft,item};}finally{db.close();}};
 try{await fn({make,seed,path,key,calls,proofs,account,requestSnapshot:(service,selected)=>service.worker.request({operation:'mail.integrations.reconcile',snapshot:{configuration:{origin:'http://127.0.0.1:'+address.port,capability},handles:selected.map(account=>account.handle),accounts:selected}}),holdProof:()=>writeFile(gate,'hold'),disconnect:()=>{accounts=[];}});}finally{for(const service of services)await service.stop();await new Promise(resolve=>gateway.close(resolve));key.fill(0);await rm(directory,{recursive:true,force:true});}
}
test('worker adopts an existing account in place, keeps original data and routes sync through the sole shared connection',async()=>fixture(async f=>{
 f.account.scopes.push('https://www.googleapis.com/auth/contacts.readonly');
 const retained=await f.seed(),service=await f.make();await until(async()=>(await service.listAccounts({})).items.some(account=>account.id==='retained'&&account.integration==='gmail'));
 assert.equal((await service.listAccounts({})).items.length,1);assert.equal((await service.listAccounts({})).items[0].contactsAllowed,true);assert.equal((await service.readDraft('retained',{draftId:retained.draft.id})).content.subject,'Retained draft');
 const chunk=await service.readContent('retained',retained.locator,{kind:'raw',referenceId:retained.reference.id,offset:0,limit:100});assert.match(Buffer.from(chunk.data,'base64').toString(),/Original body/);
 await service.setLifecycleSuspended(false);await until(async()=>(await service.syncStatus('retained')).state==='complete');await until(async()=>(await service.outbox('retained'))[0].state==='failed');
 assert.ok(f.calls.some(path=>path.endsWith('/messages')));assert.equal(await readFile(f.proofs,'utf8'),'proof\n');
 await service.stop();const db=await openEncryptedMailDatabase({path:f.path,key:f.key});try{assert.equal(db.get('SELECT count(*) n FROM mail_accounts').n,1);assert.equal(db.get('SELECT refresh_token FROM mail_account_credentials').refresh_token,null);assert.equal(db.get('SELECT access_token FROM mail_account_credentials').access_token,'legalwork-mail:'+f.account.accountId);}finally{db.close();}
}));
test('worker retains a late-migrated duplicate as read-only while preserving drafts, local originals and cancellable outbox history',async()=>fixture(async f=>{
 const initial=await f.make();await initial.stop();const retained=await f.seed(),service=await f.make();
 await until(async()=>(await service.listAccounts({})).items.some(account=>account.id==='retained'&&account.integrationArchive));
 assert.equal((await service.listAccounts({})).items.length,2);assert.equal((await service.listAccounts({})).items.find(account=>account.id==='retained').contactsAllowed,false);assert.equal((await service.readMessage('retained',retained.locator)).subject,'Original retained mail');
 await assert.rejects(service.startSync('retained'),{message:'mail_unsupported'});await assert.rejects(service.enqueueMutation('retained',{replayKey:randomUUID(),locator:retained.locator,precondition:'old-version',change:{kind:'read',read:true}}),{message:'mail_unsupported'});await assert.rejects(service.requestDraftSync('retained',{draftId:retained.draft.id,expected:retained.draft.version,action:'sync'}),{message:'mail_unsupported'});await assert.rejects(service.queueOutbox('retained',{draftId:retained.draft.id,version:retained.draft.version,replayKey:randomUUID()}),{message:'mail_unsupported'});
 await service.setLifecycleSuspended(false);await new Promise(resolve=>setTimeout(resolve,100));assert.equal((await service.outbox('retained'))[0].attempts,0);assert.equal((await service.outbox('retained'))[0].state,'queued');
 await service.outboxAction('retained',{actionId:retained.item.id,action:'cancel'});assert.equal((await service.outbox('retained'))[0].state,'cancelled');
 f.disconnect();await service.refreshIntegrations(true);await assert.rejects(service.readMessage('retained',retained.locator),{message:'mail_locked'});assert.equal(await readFile(f.proofs,'utf8'),'proof\n');
}));
test('slow identity proof cannot delay offline unlock or survive worker shutdown',async()=>fixture(async f=>{
 const retained=await f.seed();await f.holdProof();let timer;
 let service;try{service=await Promise.race([f.make(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('identity proof blocked local unlock')),2000);})]);}finally{clearTimeout(timer);}
 assert.equal((await service.readDraft('retained',{draftId:retained.draft.id})).content.subject,'Retained draft');
 await until(async()=>(await readFile(f.proofs,'utf8')).includes('proof'));const start=Date.now();await service.stop();assert.ok(Date.now()-start<1500,'shutdown must abort the identity probe');
 const db=await openEncryptedMailDatabase({path:f.path,key:f.key});try{assert.equal(db.get('SELECT refresh_token FROM mail_account_credentials').refresh_token,'old-refresh');assert.equal(db.get('SELECT count(*) n FROM mail_integration_accounts').n,0);}finally{db.close();}
}));
test('a newer connection snapshot cancels an older identity proof before it can restore revoked access',async()=>fixture(async f=>{
 const initial=await f.make();await initial.stop();await f.seed();await f.holdProof();const service=await f.make();
 await until(async()=>(await readFile(f.proofs,'utf8')).includes('proof'));
 f.disconnect();let timer;try{await Promise.race([f.requestSnapshot(service,[]),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('new snapshot waited for stale identity proof')),1500);})]);}finally{clearTimeout(timer);}
 await assert.rejects(service.readMessage(f.account.accountId,{provider:'gmail',messageId:'missing'}),{message:'mail_locked'});
 await service.stop();const db=await openEncryptedMailDatabase({path:f.path,key:f.key});try{assert.equal(db.get('SELECT state FROM mail_account_credentials WHERE account_id=?',[f.account.accountId]).state,'disconnected');assert.equal(db.get('SELECT refresh_token FROM mail_account_credentials WHERE account_id=?',['retained']).refresh_token,'old-refresh');assert.equal(db.get('SELECT count(*) n FROM mail_integration_accounts WHERE account_id=?',['retained']).n,0);}finally{db.close();}
}));
