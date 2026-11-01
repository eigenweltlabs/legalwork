import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openEncryptedMailDatabase} from './database.js';
import {migrateMailSchema,MAIL_SCHEMA_VERSION} from './schema.js';
import {removeLaterMailSchema} from '../testing/legacy-schema.mjs';
import {MailRepository} from './repository.js';
import {MailCredentialRepository} from './credentials.js';
import {MailContentStore} from './content-store.js';
import {MailReadStore} from './read-store.js';
import {SenderIdentityRepository} from './sender-identities.js';
import {MailIntegrationAccounts} from './integrations.js';
import {MailAccessCoordinator} from '../providers/access-coordinator.js';
import {adoptMailIntegrations} from '../providers/integration-adoption.js';
import {configureMailIntegrationFetch} from '../providers/integration-fetch.js';
import {MailSyncLifecycle} from '../runtime/sync-lifecycle.js';
import {OutboxStore} from './outbox.js';
import {OutboxRunner} from '../runtime/outbox-runner.js';

const scope='https://www.googleapis.com/auth/gmail.modify';
const account={accountId:'mail_'+'a'.repeat(64),handle:'b'.repeat(64),connectorId:'gmail',connectionId:'connection',identity:'owner@example.test',email:'owner@example.test',displayName:'Owner',scopes:[scope]};
const configuration={origin:'http://127.0.0.1:12345',capability:'c'.repeat(64)};
const snapshot={configuration,handles:[account.handle],accounts:[account]};
const binding={provider:'gmail',clientId:'legacy.apps.googleusercontent.com',authority:'https://accounts.google.com',providerSubject:'immutable-old-google-subject'};
async function fixture(fn){const directory=await mkdtemp(join(tmpdir(),'mail-adoption-')),key=randomBytes(32),path=join(directory,'mail.sqlite'),db=await openEncryptedMailDatabase({path,key});try{migrateMailSchema(db);await fn({db,path,key});}finally{db.close();key.fill(0);await rm(directory,{recursive:true,force:true});}}
function legacy(db,id='retained',extra={}){
 new MailRepository(db,'owner').createAccount({id,provider:'gmail',displayName:'Saved name <owner@example.test>'});
 const credentials=new MailCredentialRepository(db,'owner'),version=credentials.connect(id,binding,null,{accessToken:'old-token',expiresAt:Date.now()+3600000,grantedScopes:[scope],refreshToken:{action:'replace',value:'old-refresh'},...extra});
 const sender=new SenderIdentityRepository(db,'owner').replace(id,version.generation,[{address:account.email,displayName:'Owner',primary:true,default:true}])[0];
 return {credentials,version,sender};
}
async function queue(db,id,sender,subject='Retained draft'){
 const store=new OutboxStore(db,'owner'),draft=store.local.saveDraft(id,{draftId:randomUUID(),expected:null,content:{senderIdentityId:sender.id,from:sender.address,to:['recipient@example.test'],subject,text:'Retained content'}});
 return {store,draft,item:await store.queue(id,{draftId:draft.id,version:draft.version,replayKey:randomUUID()})};
}
const proof=async()=>Response.json({emailAddress:account.email});

test('live identity proof adopts the original account ID, retaining originals, drafts and journals without a second refresh token',async()=>fixture(async({db,path,key})=>{
 const {credentials,version,sender}=legacy(db),repository=new MailRepository(db,'owner'),locator={provider:'gmail',messageId:'retained'};
 repository.ingestMessage('retained',{locator,subject:'Retained original',rfcMessageId:null,memberships:[]});
 const content=new MailContentStore(db,'owner'),raw=await content.writePart('retained',locator,{kind:'raw',maxBytes:4},[Buffer.from('mail')]);
 const queued=await queue(db,'retained',sender);
 const migrated=await adoptMailIntegrations(db,'owner',snapshot,{fetch:proof});assert.deepEqual(migrated,['retained']);
 const links=new MailIntegrationAccounts(db,'owner');links.reconcile(snapshot);
 assert.equal(links.primary(account.accountId),'retained');assert.equal(db.get('SELECT count(*) n FROM mail_accounts').n,1);
 assert.equal(links.get('retained').readOnly,false);assert.equal(links.get('retained').adopted,true);
 assert.deepEqual(Buffer.concat([...content.read('retained',raw.id)]),Buffer.from('mail'));
 assert.equal(queued.store.local.readDraft('retained',{draftId:queued.draft.id}).content.subject,'Retained draft');
 assert.equal(queued.store.item('retained',queued.item.id).state,'queued');
 assert.notEqual(credentials.status('retained').version.generation,version.generation);
 const row=db.get('SELECT * FROM mail_account_credentials WHERE account_id=?',['retained']);assert.equal(row.refresh_token,null);assert.equal(row.access_token,'legalwork-mail:'+account.accountId);assert.equal(row.authority,'legalwork-integrations');
 assert.deepEqual(JSON.parse(db.get('SELECT previous_binding_json FROM mail_integration_accounts').previous_binding_json),binding);
 assert.equal(JSON.stringify(db.all('SELECT * FROM mail_integration_accounts')).includes('old-refresh'),false);
 assert.deepEqual(await adoptMailIntegrations(db,'owner',snapshot,{fetch:async()=>{throw Error('must not repeat OAuth proof');}}),[]);
 assert.deepEqual(links.reconcile(snapshot).changed,[]);
 const reopened=await openEncryptedMailDatabase({path,key});try{migrateMailSchema(reopened);assert.equal(new MailIntegrationAccounts(reopened,'owner').primary(account.accountId),'retained');assert.equal(new MailCredentialRepository(reopened,'owner').getBinding('retained').authority,'legalwork-integrations');assert.deepEqual(reopened.all('PRAGMA foreign_key_check'),[]);}finally{reopened.close();}
}));

test('saved addresses cannot substitute for authenticated identity, and a stale proof cannot overwrite changed credentials',async()=>fixture(async({db})=>{
 const {credentials,version}=legacy(db);
 assert.deepEqual(await adoptMailIntegrations(db,'owner',snapshot,{fetch:async()=>Response.json({emailAddress:'attacker@example.test'})}),[]);
 assert.deepEqual(credentials.status('retained').version,version);
 assert.deepEqual(await adoptMailIntegrations(db,'other',snapshot,{fetch:proof}),[]);
 assert.deepEqual(await adoptMailIntegrations(db,'owner',snapshot,{fetch:async()=>{credentials.rotate('retained',binding,version,{accessToken:'new-old-token',expiresAt:Date.now()+3600000,grantedScopes:[scope],refreshToken:{action:'preserve'}});return proof();}}),[]);
 assert.equal(credentials.readForRefresh('retained',binding).refreshToken,'old-refresh');assert.equal(db.get('SELECT count(*) n FROM mail_integration_accounts').n,0);
}));

test('adoption failure rolls back credential clearing and source links together',async()=>fixture(async({db})=>{
 const {credentials,version}=legacy(db);
 const broken={...db,run(sql,parameters){if(sql.startsWith('INSERT INTO mail_integration_accounts'))throw Error('synthetic transaction failure');return db.run(sql,parameters);}};
 assert.throws(()=>new MailIntegrationAccounts(broken,'owner').adopt('retained',account,version),/transaction failure/);
 assert.deepEqual(credentials.status('retained').version,version);assert.equal(credentials.readForRefresh('retained',binding).refreshToken,'old-refresh');assert.equal(db.get('SELECT count(*) n FROM mail_integration_accounts').n,0);
}));

test('a late legacy refresh cannot reintroduce credentials after adoption',async()=>fixture(async({db})=>{
 const {credentials,version}=legacy(db,'retained',{expiresAt:Date.now()+1000});
 let release,started;const entered=new Promise(resolve=>{started=resolve;}),wait=new Promise(resolve=>{release=resolve;});
 const access=new MailAccessCoordinator({database:db,ownerId:'owner',loadProviderSettings:async()=>({provider:'gmail',applicationType:'desktop',pkceMethod:'S256',clientId:binding.clientId,clientSecret:'synthetic-secret',scopes:['openid','email',scope]}),refresh:async()=>{started();await wait;return{accessToken:'late-token',expiresAt:Date.now()+3600000,grantedScopes:[scope],refreshToken:{action:'replace',value:'late-refresh'}};}});
 try{const pending=access.acquire('retained');await entered;new MailIntegrationAccounts(db,'owner').adopt('retained',account,version);release();await assert.rejects(pending);assert.equal(db.get('SELECT refresh_token FROM mail_account_credentials').refresh_token,null);assert.equal(db.get('SELECT access_token FROM mail_account_credentials').access_token,'legalwork-mail:'+account.accountId);}finally{release();access.close();}
}));

test('an already populated integration retains the older mailbox as a read-only copy with no sync, badge duplication or automatic send',async()=>fixture(async({db})=>{
 const links=new MailIntegrationAccounts(db,'owner');links.reconcile(snapshot);
 const {sender}=legacy(db),queued=await queue(db,'retained',sender),repository=new MailRepository(db,'owner');
 repository.putFolder('retained',{id:'INBOX',name:'Inbox',kind:'label'});repository.putFolder('retained',{id:'UNREAD',name:'Unread',kind:'label'});repository.ingestMessage('retained',{locator:{provider:'gmail',messageId:'old'},subject:'Readable retained mail',rfcMessageId:null,memberships:['INBOX','UNREAD']});
 await adoptMailIntegrations(db,'owner',snapshot,{fetch:proof});links.reconcile(snapshot);
 assert.equal(links.primary(account.accountId),account.accountId);assert.equal(links.get('retained').readOnly,true);
 assert.equal(new MailReadStore(db,'owner').list('retained',{}).items[0].subject,'Readable retained mail');assert.equal(new MailReadStore(db,'owner').unreadInboxCount(),0);
 const access=new MailAccessCoordinator({database:db,ownerId:'owner',loadProviderSettings:async()=>{throw Error('must not use old OAuth app');}}),lifecycle=new MailSyncLifecycle(db,'owner',access);
 try{await assert.rejects(access.acquire('retained'),{message:'mail_access_locked'});lifecycle.resume('retained');assert.equal(db.get('SELECT count(*) n FROM mail_gmail_runs').n,0);let sent=0;const runner=new OutboxRunner({database:db,ownerId:'owner',access,connection:async()=>{sent++;throw Error('must not dispatch');}});try{await runner.turn('retained');assert.equal(sent,0);assert.equal(queued.store.item('retained',queued.item.id).attempts,0);assert.equal(queued.store.item('retained',queued.item.id).state,'queued');queued.store.cancel('retained',queued.item.id);assert.equal(queued.store.item('retained',queued.item.id).state,'cancelled');}finally{await runner.close();}}finally{await lifecycle.close();access.close();}
 links.reconcile({...snapshot,handles:[],accounts:[]});assert.equal(new MailCredentialRepository(db,'owner').status('retained').state,'disconnected');
}));

test('a migrated uncertain send can only read exact Sent evidence through its primary connection and never replays',async()=>fixture(async({db})=>{
 const {sender}=legacy(db),queued=await queue(db,'retained',sender);
 let sends=0;const first=new OutboxRunner({database:db,ownerId:'owner',access:{},connection:async()=>({prepare:async()=>null,send:async()=>{sends++;throw Error('synthetic lost acknowledgment');},reconcile:async()=>null,close(){}})});await first.turn('retained');await first.close();assert.equal(queued.store.item('retained',queued.item.id).state,'uncertain');
 const links=new MailIntegrationAccounts(db,'owner');links.reconcile(snapshot);await adoptMailIntegrations(db,'owner',snapshot,{fetch:proof});
 const row=queued.store.row('retained',queued.item.id),original=globalThis.fetch;let reads=0;
 configureMailIntegrationFetch(configuration);
 globalThis.fetch=async(input,init)=>{assert.equal(String(input),configuration.origin+'/mail/internal/integrations/request');const headers=new Headers(init.headers);assert.equal(headers.get('authorization'),null);assert.equal(headers.get('x-legalwork-mail-account'),account.accountId);assert.equal(headers.get('x-legalwork-mail-method'),'GET');reads++;const url=new URL(headers.get('x-legalwork-mail-endpoint'));return Response.json(url.pathname.endsWith('/messages')?{messages:[{id:'sent'}]}:{labelIds:['SENT'],payload:{headers:[{name:'Message-ID',value:row.message_id},{name:'From',value:account.email}]}});};
 const access=new MailAccessCoordinator({database:db,ownerId:'owner',loadProviderSettings:async()=>{throw Error('must not use old OAuth app');}}),runner=new OutboxRunner({database:db,ownerId:'owner',access});
 try{runner.recover();await runner.turn('retained');assert.equal(sends,1);await runner.reconcile('retained',queued.item.id);assert.equal(reads,2);assert.equal(sends,1);assert.equal(queued.store.item('retained',queued.item.id).state,'accepted');assert.equal(queued.store.local.readDraft('retained',{draftId:queued.draft.id}).content.subject,'Retained draft');}finally{globalThis.fetch=original;await runner.close();access.close();}
}));

test('schema32 source links upgrade atomically without changing credentials or local account IDs',async()=>fixture(async({db})=>{
 const links=new MailIntegrationAccounts(db,'owner');links.reconcile(snapshot);const before=db.get('SELECT * FROM mail_account_credentials');
 removeLaterMailSchema(db,32);db.run('UPDATE mail_schema_version SET version=32');
 const broken={...db,exec(sql){db.exec(sql);if(sql.includes('source_account_id TEXT'))throw Error('synthetic migration interruption');}};assert.throws(()=>migrateMailSchema(broken),/interruption/);assert.equal(db.get('SELECT version FROM mail_schema_version').version,32);assert.equal(db.all('PRAGMA table_info(mail_integration_accounts)').some(row=>row.name==='source_account_id'),false);
 migrateMailSchema(db);assert.equal(db.get('SELECT version FROM mail_schema_version').version,MAIL_SCHEMA_VERSION);assert.equal(new MailIntegrationAccounts(db,'owner').primary(account.accountId),account.accountId);assert.deepEqual(db.get('SELECT * FROM mail_account_credentials'),before);
}));
test('Outlook adoption proves the authenticated Graph identity rather than matching a saved address',async()=>fixture(async({db})=>{
 const microsoft={...account,accountId:'mail_'+'d'.repeat(64),handle:'e'.repeat(64),connectorId:'outlook',identity:'personal-stable-id',scopes:['User.Read','Mail.ReadWrite','Mail.Send']},view={configuration,handles:[microsoft.handle],accounts:[microsoft]};
 new MailRepository(db,'owner').createAccount({id:'retained-outlook',provider:'graph',displayName:account.email});
 const graph={provider:'graph',clientId:'11111111-1111-4111-8111-111111111111',authority:'https://login.microsoftonline.com/consumers/v2.0',providerSubject:microsoft.identity};
 const credentials=new MailCredentialRepository(db,'owner');credentials.connect('retained-outlook',graph,null,{accessToken:'old-microsoft-token',expiresAt:Date.now()+3600000,grantedScopes:microsoft.scopes,refreshToken:{action:'replace',value:'old-microsoft-refresh'}});
 assert.deepEqual(await adoptMailIntegrations(db,'owner',view,{fetch:async()=>Response.json({id:'different-id',mail:account.email})}),[]);
 assert.deepEqual(await adoptMailIntegrations(db,'owner',view,{fetch:async(input,init)=>{assert.equal(new URL(input).origin,'https://graph.microsoft.com');assert.equal(new Headers(init.headers).get('authorization'),'Bearer old-microsoft-token');return Response.json({id:microsoft.identity});}}),['retained-outlook']);
 const links=new MailIntegrationAccounts(db,'owner');links.reconcile(view);assert.equal(links.primary(microsoft.accountId),'retained-outlook');assert.equal(credentials.getBinding('retained-outlook').authority,'legalwork-integrations');assert.equal(db.get('SELECT refresh_token FROM mail_account_credentials').refresh_token,null);
}));
test('an expired retained grant refreshes only for identity proof, then relinquishes its refresh credential',async()=>fixture(async({db})=>{
 legacy(db,'retained');db.run('UPDATE mail_account_credentials SET expires_at=?',[Date.now()-1000]);let refreshed=0;
 const access=new MailAccessCoordinator({database:db,ownerId:'owner',loadProviderSettings:async()=>({provider:'gmail',applicationType:'desktop',pkceMethod:'S256',clientId:binding.clientId,clientSecret:'synthetic-secret',scopes:['openid','email',scope]}),refresh:async()=>{refreshed++;return{accessToken:'renewed-for-proof',expiresAt:Date.now()+3600000,grantedScopes:[scope],refreshToken:{action:'preserve'}};}});
 try{assert.deepEqual(await adoptMailIntegrations(db,'owner',snapshot,{access,fetch:async(_input,init)=>{assert.equal(new Headers(init.headers).get('authorization'),'Bearer renewed-for-proof');return proof();}}),['retained']);assert.equal(refreshed,1);assert.equal(db.get('SELECT refresh_token FROM mail_account_credentials').refresh_token,null);}finally{access.close();}
}));
