import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm,readFile,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes} from 'node:crypto';
import {openEncryptedMailDatabase} from '../storage/database.js';
import {migrateMailSchema} from '../storage/schema.js';
import {MailCredentialRepository} from '../storage/credentials.js';
import {MailConnectionController} from './connection-controller.js';
import {MailAccessCoordinator} from './access-coordinator.js';
import {startMailOAuth} from './oauth.js';
import {discoverMailIdentity} from './identity.js';
import {refreshMailOAuth} from './refresh.js';
import {GRAPH_MAIL_SCOPES} from '../provider-config.js';
import {MailRepository} from '../storage/repository.js';
import {LocalMailService} from '../service.js';
import {fileURLToPath} from 'node:url';
const settings={provider:'graph',clientId:'f7ae407e-0e9f-442d-a7e5-60cf8740992a',tenantId:'consumers',applicationType:'desktop',pkceMethod:'S256',scopes:GRAPH_MAIL_SCOPES,registeredRedirectUri:'http://localhost/mail/callback'};
test('personal OAuth callback, encrypted immutable identity, restart refresh and account-kind binding',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mail-personal-')),path=join(dir,'mail.sqlite'),key=randomBytes(32);let db=await openEncryptedMailDatabase({path,key}),controller,access,service;
 try {migrateMailSchema(db);controller=new MailConnectionController({database:db,ownerId:'owner',oauth:(selected,options)=>startMailOAuth(selected,{...options,fetch:async(url,init)=>{assert.equal(url,'https://login.microsoftonline.com/consumers/oauth2/v2.0/token');assert.equal(new URLSearchParams(init.body).get('grant_type'),'authorization_code');return Response.json({access_token:'synthetic-personal-private',refresh_token:'synthetic-renew',token_type:'Bearer',expires_in:1,scope:'User.Read Mail.ReadWrite Mail.Send'});}}),identity:input=>discoverMailIdentity({...input,fetch:async url=>{assert.ok(url.includes('/me?'));return Response.json({id:'A1B2C3D4',mail:'demo@outlook.com',displayName:'Personal'});}})});
 const flow=await controller.begin(settings),url=new URL(flow.authorizationUrl);assert.equal(url.pathname,'/consumers/oauth2/v2.0/authorize');const callback=new URL(url.searchParams.get('redirect_uri'));callback.search=new URLSearchParams({code:'synthetic-code',state:url.searchParams.get('state')}).toString();assert.equal((await fetch(callback)).status,200);
 let status;for(let i=0;i<100;i++){status=controller.poll(flow.connectionId);if(status.state==='connected'||status.state==='failed')break;await new Promise(r=>setTimeout(r,5));}assert.equal(status.state,'connected');const accountId=status.accountId,credentials=new MailCredentialRepository(db,'owner'),binding=credentials.getBinding(accountId);assert.equal(binding.providerSubject,'A1B2C3D4');assert.equal(binding.authority,'https://login.microsoftonline.com/consumers/v2.0');assert.ok(!(await readFile(path+'-wal')).includes(Buffer.from('synthetic-personal-private')));
 await controller.close();controller=undefined;db.close();db=await openEncryptedMailDatabase({path,key});
 access=new MailAccessCoordinator({database:db,ownerId:'owner',loadProviderSettings:async selected=>{assert.deepEqual(selected,binding);return settings;},refresh:input=>refreshMailOAuth({...input,fetch:async(url)=>{assert.equal(url,'https://login.microsoftonline.com/consumers/oauth2/v2.0/token');return Response.json({access_token:'synthetic-refreshed',refresh_token:'synthetic-rotated',token_type:'Bearer',expires_in:3600,scope:'User.Read Mail.ReadWrite Mail.Send'});}})});
 assert.equal((await access.acquire(accountId)).accessToken,'synthetic-refreshed');access.close();access=new MailAccessCoordinator({database:db,ownerId:'owner',loadProviderSettings:async()=>({...settings,tenantId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'})});await assert.rejects(access.acquire(accountId),{code:'binding_mismatch'});access.close();access=undefined;
 // Same client, other authority remains a distinct canonical binding.
 const repo=new MailRepository(db,'owner');repo.createAccount({id:'org',provider:'graph',displayName:'Org'});new MailCredentialRepository(db,'owner').connect('org',{...binding,authority:'https://login.microsoftonline.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/v2.0',providerSubject:'11111111-2222-3333-4444-555555555555'},null,{accessToken:'synthetic-org',expiresAt:Date.now()+3600000,grantedScopes:GRAPH_MAIL_SCOPES,refreshToken:{action:'clear'}});
 db.close();db=undefined;
 const worker=join(dir,'offline-worker.mjs');await writeFile(worker,`globalThis.fetch=async()=>{throw Error('Synthetic worker forbids provider network')};await import(${JSON.stringify(new URL('../runtime/worker.js',import.meta.url).href)});`);
 const kinds=[];service=new LocalMailService({ownerId:'owner',databasePath:path,loadKey:async()=>Buffer.from(key),loadProviderSettings:async(provider,personal)=>{kinds.push(personal);return {...settings,tenantId:personal?'consumers':'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'};},executable:{kind:'node',path:process.execPath},entryPoint:worker});await service.unlock();
 // Real worker discovers persisted authority before loading trusted connection configuration.
 await service.pauseSync(accountId);await service.pauseSync('org');assert.deepEqual(kinds,[true,false]);
 const listed=(await service.listAccounts({limit:10})).items;assert.equal(listed.find(item=>item.id===accountId).personal,true);assert.equal(listed.find(item=>item.id==='org').personal,false);
 await service.disconnectAccount('org');
 const orgReconnect=await service.beginConnection('graph','org',true);assert.equal(new URL(orgReconnect.authorizationUrl).pathname,'/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/oauth2/v2.0/authorize');await service.cancelConnection(orgReconnect.connectionId);
 await service.disconnectAccount(accountId);
 const consumerReconnect=await service.beginConnection('graph',accountId,false);assert.equal(new URL(consumerReconnect.authorizationUrl).pathname,'/consumers/oauth2/v2.0/authorize');await service.cancelConnection(consumerReconnect.connectionId);
 assert.deepEqual(kinds,[true,false,false,true]);assert.equal((await service.listAccounts({limit:10})).items.find(item=>item.id==='org').personal,false);
 }finally {await service?.stop();access?.close();await controller?.close();db?.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
});
test('onboarding cancellation before HTTP start and during IMAP discovery cannot publish a late account',async()=>{
 const {ImapBackfill}=await import('./imap-backfill.js');
 const dir=await mkdtemp(join(tmpdir(),'mail-onboarding-cancel-')),path=join(dir,'mail.sqlite'),key=randomBytes(32);let db=await openEncryptedMailDatabase({path,key}),service,engine;
 try{migrateMailSchema(db);let release,closed=0;const gate=new Promise(resolve=>{release=resolve;});engine=new ImapBackfill({database:db,ownerId:'owner',transport:()=>({connect:async()=>gate,discover:async()=>({folders:[],capabilities:[]}),close:()=>{closed++;}})});
 const input={host:'imap.example.test',port:993,username:'synthetic',password:'synthetic-password'},pending=engine.connect(input);engine.cancelConnect();await assert.rejects(engine.connect(input),{code:'busy'});release();await assert.rejects(pending,{code:'cancelled'});assert.ok(closed>=1);assert.equal(db.get('SELECT count(*) AS n FROM mail_accounts').n,0);engine.close();engine=undefined;db.close();db=undefined;
 service=new LocalMailService({ownerId:'owner',databasePath:path,loadKey:async()=>Buffer.from(key),executable:{kind:'node',path:process.execPath},entryPoint:fileURLToPath(new URL('../runtime/worker.js',import.meta.url))});await service.unlock();const requestId='11111111-2222-4333-8444-555555555555';await service.cancelImapConnection(requestId);assert.deepEqual(await service.connectImap(input,requestId),{error:'cancelled'});assert.equal((await service.listAccounts({limit:10})).items.length,0);
 }finally{await service?.stop();engine?.close();db?.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
});
