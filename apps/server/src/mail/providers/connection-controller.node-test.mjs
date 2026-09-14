import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp,rm,readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MailConnectionController } from './connection-controller.js';
import { MailOAuthError } from './oauth.js';
import { GMAIL_MAIL_SCOPES,GRAPH_MAIL_SCOPES } from '../provider-config.js';
import { openEncryptedMailDatabase } from '../storage/database.js';
import { migrateMailSchema } from '../storage/schema.js';
import { MailCredentialRepository } from '../storage/credentials.js';
import { MailRepository } from '../storage/repository.js';
const gmail={provider:'gmail',applicationType:'desktop',pkceMethod:'S256',clientId:'synthetic.apps.googleusercontent.com',clientSecret:'synthetic-secret',scopes:GMAIL_MAIL_SCOPES};
const graph={provider:'graph',applicationType:'desktop',pkceMethod:'S256',clientId:'11111111-2222-3333-4444-555555555555',tenantId:'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',registeredRedirectUri:'http://localhost/mail/callback',scopes:GRAPH_MAIL_SCOPES};
const identity={provider:'gmail',authority:'https://accounts.google.com',providerSubject:'stable-google-subject',tenantId:null,email:'a@example.test',displayName:'Person'};
const graphIdentity={provider:'graph',authority:`https://login.microsoftonline.com/${graph.tenantId}/v2.0`,providerSubject:graph.clientId,tenantId:graph.tenantId,email:'a@example.test',displayName:null};
const binding={provider:'gmail',clientId:gmail.clientId,authority:identity.authority,providerSubject:identity.providerSubject};
const ACCESS='synthetic-access-private-marker',REFRESH='synthetic-refresh-private-marker';
const tokens=(extra={})=>({accessToken:ACCESS,refreshToken:REFRESH,tokenType:'Bearer',expiresAt:Date.now()+60000,grantedScopes:GMAIL_MAIL_SCOPES,unverifiedIdToken:null,...extra});
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function flow(result){return {authorizationUrl:'https://accounts.google.com/o/oauth2/v2/auth?state=synthetic',redirectUri:'http://127.0.0.1:43123/',expiresAt:Date.now()+60000,loopbackFamilies:['ipv4'],result,cancel:async()=>{}};}
async function settle(controller,id){for(let i=0;i<100;i++){const status=controller.poll(id);if(!['pending','verifying'].includes(status.state))return status;await new Promise(r=>setTimeout(r,1));}throw new Error('not settled');}
async function fixture(body){
 const directory=await mkdtemp(join(tmpdir(),'legalwork-mail-connections-')),path=join(directory,'mail.sqlite'),key=randomBytes(32);
 const db=await openEncryptedMailDatabase({path,key});migrateMailSchema(db);const controllers=[];
 const make=(extra={})=>{const c=new MailConnectionController({database:db,ownerId:'owner',oauth:async()=>flow(Promise.resolve(tokens())),identity:async()=>identity,...extra});controllers.push(c);return c;};
 try{await body({db,path,key,make,accounts:new MailRepository(db,'owner'),credentials:new MailCredentialRepository(db,'owner')});}
 finally{await Promise.all(controllers.map(c=>c.close()));db.close();key.fill(0);await rm(directory,{recursive:true,force:true});}
}
test('new connection atomically persists encrypted credentials and secret-free renewable status',async()=>fixture(async({make,accounts,credentials,path})=>{
 const c=make();const started=await c.begin(gmail);const status=await settle(c,started.connectionId);
 assert.equal(status.state,'connected');assert.equal(status.renewable,true);assert.equal(accounts.listAccounts().length,1);assert.equal(credentials.readForRefresh(status.accountId,binding).refreshToken,REFRESH);
 assert.ok(!JSON.stringify(status).includes(ACCESS));assert.ok(!JSON.stringify(status).includes(REFRESH));
 for(const filename of [path,`${path}-wal`]){const bytes=await readFile(filename);assert.ok(!bytes.includes(Buffer.from(ACCESS)));assert.ok(!bytes.includes(Buffer.from(REFRESH)));}
}));
test('repeat stable identity requires explicit reconnect and preserves original credentials',async()=>fixture(async({make,accounts,credentials})=>{
 const c=make();const first=await settle(c,(await c.begin(gmail)).connectionId);const version=credentials.status(first.accountId).version;
 const again=await settle(c,(await c.begin(gmail)).connectionId);assert.equal(again.state,'failed');assert.equal(again.error,'reconnect_required');assert.equal(accounts.listAccounts().length,1);assert.deepEqual(credentials.status(first.accountId).version,version);
 const reconnected=await settle(c,(await c.begin(gmail,{reconnectAccountId:first.accountId})).connectionId);assert.equal(reconnected.state,'connected');assert.equal(reconnected.accountId,first.accountId);assert.notDeepEqual(credentials.status(first.accountId).version,version);
}));
test('reconnect wrong identity cannot replace original binding or tokens',async()=>fixture(async({make,credentials})=>{
 const c=make();const first=await settle(c,(await c.begin(gmail)).connectionId);const version=credentials.status(first.accountId).version;
 const wrong=make({identity:async()=>({...identity,providerSubject:'different'})});const result=await settle(wrong,(await wrong.begin(gmail,{reconnectAccountId:first.accountId})).connectionId);
 assert.equal(result.error,'binding_mismatch');assert.deepEqual(credentials.status(first.accountId).version,version);assert.equal(credentials.readAccess(first.accountId,binding).accessToken,ACCESS);
}));
test('reconnect stamp fences disconnect during consent',async()=>fixture(async({make,credentials})=>{
 const c=make();const first=await settle(c,(await c.begin(gmail)).connectionId);const version=credentials.status(first.accountId).version;
 const pending=deferred();const reconnect=make({oauth:async()=>flow(pending.promise)});const begun=await reconnect.begin(gmail,{reconnectAccountId:first.accountId});credentials.disconnect(first.accountId,version);pending.resolve(tokens());
 const status=await settle(reconnect,begun.connectionId);assert.equal(status.error,'stale_credentials');assert.equal(credentials.status(first.accountId).state,'disconnected');
}));
test('foreign and unconfigured archives reject reconnect before OAuth',async()=>fixture(async({db,make,accounts})=>{
 new MailRepository(db,'other').createAccount({id:'foreign',provider:'gmail',displayName:'Other'});accounts.createAccount({id:'legacy',provider:'gmail',displayName:'Legacy'});
 let calls=0;const c=make({oauth:async()=>{calls++;return flow(Promise.resolve(tokens()));}});
 for(const id of ['foreign','legacy','missing'])await assert.rejects(c.begin(gmail,{reconnectAccountId:id}),/account_not_found/);assert.equal(calls,0);
}));
test('persistence failure after account insert rolls back both account and credentials',async()=>fixture(async({db,make,accounts})=>{
 db.exec("CREATE TRIGGER fail_credentials BEFORE INSERT ON mail_account_credentials BEGIN SELECT RAISE(ABORT, 'synthetic-private-storage-error'); END");
 const c=make();const result=await settle(c,(await c.begin(gmail)).connectionId);assert.equal(result.error,'persistence_failed');assert.equal(accounts.listAccounts().length,0);assert.equal(db.get('SELECT count(*) AS n FROM mail_account_credentials').n,0);assert.ok(!JSON.stringify(result).includes('synthetic-private'));
}));
test('cancel during consent and verification fences late tokens and identity',async()=>fixture(async({make,accounts})=>{
 for(const stage of ['consent','identity']){
  const pending=deferred();const c=make(stage==='consent'?{oauth:async()=>flow(pending.promise)}:{identity:async()=>pending.promise});
  const started=await c.begin(gmail);await new Promise(r=>setTimeout(r,0));assert.equal(c.poll(started.connectionId).state,stage==='consent'?'pending':'verifying');
  await c.cancel(started.connectionId);pending.resolve(stage==='consent'?tokens():identity);await new Promise(r=>setTimeout(r,0));assert.equal(c.poll(started.connectionId).state,'cancelled');assert.equal(accounts.listAccounts().length,0);
 }
}));
test('close is idempotent, blocks new flows and fences late listener startup',async()=>fixture(async({make,accounts})=>{
 const startup=deferred();let cancelled=0;const c=make({oauth:async()=>startup.promise});const begin=c.begin(gmail);const rejected=assert.rejects(begin,/closed/);
 await c.close();await c.close();await rejected;startup.resolve({...flow(Promise.resolve(tokens())),cancel:async()=>{cancelled++;}});await new Promise(r=>setTimeout(r,0));assert.ok(cancelled>=1);assert.equal(accounts.listAccounts().length,0);await assert.rejects(c.begin(gmail),/closed/);
}));
test('expiry is distinct, provider count is bounded and terminal statuses expire',async()=>fixture(async({make})=>{
 const c=make({oauth:async()=>flow(new Promise(()=>{})),lifetimeMs:10,retentionMs:10,maxRetained:1});const begun=await c.begin(gmail);
 await assert.rejects(c.begin(gmail),/provider_busy/);await new Promise(r=>setTimeout(r,15));assert.equal(c.poll(begun.connectionId).state,'expired');await assert.rejects(c.begin(gmail),/capacity/);
 await new Promise(r=>setTimeout(r,15));assert.throws(()=>c.poll(begun.connectionId),/not_found/);const next=await c.begin(gmail);await c.cancel(next.connectionId);assert.equal(c.poll(next.connectionId).state,'cancelled');
}));
test('resource grants gate connections while missing refresh remains explicit nonrenewable',async()=>fixture(async({make,accounts})=>{
 const denied=make({oauth:async()=>flow(Promise.resolve(tokens({grantedScopes:null})))});const rejected=await settle(denied,(await denied.begin(gmail)).connectionId);assert.equal(rejected.error,'permissions_missing');assert.equal(accounts.listAccounts().length,0);
 const c=make({oauth:async()=>flow(Promise.resolve(tokens({refreshToken:null,grantedScopes:['User.Read','https://graph.microsoft.com/Mail.ReadWrite','Mail.Send']}))),identity:async()=>graphIdentity});
 const result=await settle(c,(await c.begin(graph)).connectionId);assert.equal(result.state,'connected');assert.equal(result.renewable,false);
}));
test('provider denial/identity error redacted and options strictly bounded',async()=>fixture(async({make,accounts})=>{
 const denied=make({oauth:async()=>flow(Promise.reject(new MailOAuthError('denied')))});const result=await settle(denied,(await denied.begin(gmail)).connectionId);assert.equal(result.error,'authorization_failed');
 const broken=make({identity:async()=>{throw new Error('synthetic-private-identity-error');}});const bad=await settle(broken,(await broken.begin(gmail)).connectionId);assert.equal(bad.error,'identity_failed');assert.ok(!JSON.stringify(bad).includes('synthetic-private'));assert.equal(accounts.listAccounts().length,0);
 for(const option of [{maxRetained:0},{maxRetained:129},{lifetimeMs:0},{retentionMs:Infinity}])assert.throws(()=>make(option),/configuration_invalid/);
}));

test('startup timeout and provider cancellation have distinct terminal semantics',async()=>fixture(async({make})=>{
 const hanging=make({oauth:async()=>new Promise(()=>{}),lifetimeMs:10});await assert.rejects(hanging.begin(gmail),/expired/);
 for(const code of ['cancelled','expired']){
  const c=make({oauth:async()=>flow(Promise.reject(new MailOAuthError(code)))});const result=await settle(c,(await c.begin(gmail)).connectionId);assert.equal(result.state,code);
 }
}));
test('explicit reconnect cannot inherit an absent refresh credential or change client registration',async()=>fixture(async({make,credentials})=>{
 const c=make();const first=await settle(c,(await c.begin(gmail)).connectionId);
 const changed=await settle(c,(await c.begin({...gmail,clientId:'other.apps.googleusercontent.com'},{reconnectAccountId:first.accountId})).connectionId);assert.equal(changed.error,'binding_mismatch');
 const fresh=make({oauth:async()=>flow(Promise.resolve(tokens({refreshToken:null})))});const result=await settle(fresh,(await fresh.begin(gmail,{reconnectAccountId:first.accountId})).connectionId);
 assert.equal(result.state,'connected');assert.equal(result.renewable,false);assert.throws(()=>credentials.readForRefresh(first.accountId,binding),/refresh_missing/);
}));

test('controller disconnect persists before cleanup and cancels consent/identity reconnect races',async()=>fixture(async({make,credentials,accounts})=>{
 for(const stage of ['consent','identity']){
  const subject={...identity,providerSubject:`subject-${stage}`};const c=make({identity:async()=>subject});const first=await settle(c,(await c.begin(gmail)).connectionId);
  const pending=deferred(),cleaned=deferred();let cleanupStarted=false;
  const reconnect=make({oauth:async()=>({...flow(stage==='consent'?pending.promise:Promise.resolve(tokens())),cancel:async()=>{cleanupStarted=true;await cleaned.promise;}}),identity:async()=>stage==='identity'?pending.promise:subject});
  const begun=await reconnect.begin(gmail,{reconnectAccountId:first.accountId});await new Promise(r=>setTimeout(r,0));
  const disconnected=reconnect.disconnect(first.accountId);
  assert.equal(credentials.status(first.accountId).state,'disconnected');assert.equal(reconnect.poll(begun.connectionId).state,'cancelled');
  await new Promise(r=>setTimeout(r,0));assert.equal(cleanupStarted,true);pending.resolve(stage==='consent'?tokens():subject);cleaned.resolve();await disconnected;
  await new Promise(r=>setTimeout(r,0));assert.equal(credentials.status(first.accountId).state,'disconnected');
  const version=credentials.status(first.accountId).version;await reconnect.disconnect(first.accountId);assert.notDeepEqual(credentials.status(first.accountId).version,version);
 }
 assert.equal(accounts.listAccounts().length,2);
}));
test('disconnect retains archive and rejects foreign/unconfigured accounts with fixed errors',async()=>fixture(async({make,accounts,db,credentials})=>{
 const c=make();const first=await settle(c,(await c.begin(gmail)).connectionId);
 accounts.putFolder(first.accountId,{id:'inbox',name:'Inbox',kind:'folder'});await c.disconnect(first.accountId);assert.equal(accounts.listFolders(first.accountId).length,1);assert.equal(credentials.status(first.accountId).state,'disconnected');
 accounts.createAccount({id:'unconfigured',provider:'gmail',displayName:'Legacy'});new MailRepository(db,'other').createAccount({id:'foreign',provider:'gmail',displayName:'Foreign'});
 for(const id of ['unconfigured','foreign','missing'])await assert.rejects(c.disconnect(id),/account_not_found/);
 await c.close();await assert.rejects(c.disconnect(first.accountId),/closed/);
}));

test('repeated disconnect fences a reconnect in another controller even while already disconnected',async()=>fixture(async({make,credentials})=>{
 const firstController=make();const first=await settle(firstController,(await firstController.begin(gmail)).connectionId);
 await firstController.disconnect(first.accountId);const captured=credentials.status(first.accountId).version;
 const pending=deferred();const secondController=make({oauth:async()=>flow(pending.promise)});
 const reconnect=await secondController.begin(gmail,{reconnectAccountId:first.accountId});
 await firstController.disconnect(first.accountId);assert.notDeepEqual(credentials.status(first.accountId).version,captured);
 pending.resolve(tokens());const result=await settle(secondController,reconnect.connectionId);
 assert.equal(result.state,'failed');assert.equal(result.error,'stale_credentials');assert.equal(credentials.status(first.accountId).state,'disconnected');
 assert.throws(()=>credentials.readAccess(first.accountId,binding),/disconnected/);
}));
