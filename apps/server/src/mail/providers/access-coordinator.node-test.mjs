import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm,readFile} from 'node:fs/promises';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {MailAccessCoordinator} from './access-coordinator.js';
import {MailRefreshError,refreshMailOAuth} from './refresh.js';
import {MailCredentialRepository} from '../storage/credentials.js';
import {MailRepository} from '../storage/repository.js';
import {openEncryptedMailDatabase} from '../storage/database.js';
import {migrateMailSchema} from '../storage/schema.js';
import {GMAIL_MAIL_SCOPES,GRAPH_MAIL_SCOPES} from '../provider-config.js';
const gmail={provider:'gmail',applicationType:'desktop',pkceMethod:'S256',clientId:'synthetic.apps.googleusercontent.com',clientSecret:'synthetic-client',scopes:GMAIL_MAIL_SCOPES};
const graph={provider:'graph',applicationType:'desktop',pkceMethod:'S256',clientId:'11111111-2222-4333-8444-555555555555',tenantId:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee',registeredRedirectUri:'http://localhost/mail/callback',scopes:GRAPH_MAIL_SCOPES};
const binding={provider:'gmail',clientId:gmail.clientId,authority:'https://accounts.google.com',providerSubject:'synthetic-subject'};
const graphBinding={provider:'graph',clientId:graph.clientId,authority:`https://login.microsoftonline.com/${graph.tenantId}/v2.0`,providerSubject:graph.clientId};
const ACCESS='synthetic-access-secret-marker',REFRESH='synthetic-refresh-secret-marker',ROTATED='synthetic-rotated-secret-marker';
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return{promise,resolve,reject};};
async function fixture(body){
 const dir=await mkdtemp(join(tmpdir(),'mail-access-node-')),path=join(dir,'mail.sqlite'),key=randomBytes(32);let db=await openEncryptedMailDatabase({path,key}),now=Date.now();
 migrateMailSchema(db);const coordinators=[];
 const context={path,key,get db(){return db;},get now(){return now;},advance(ms){now+=ms;},
  get credentials(){return new MailCredentialRepository(db,'owner',()=>now);},
  seed(id='a',options={}){new MailRepository(db,options.owner??'owner').createAccount({id,provider:options.binding?.provider??'gmail',displayName:'Synthetic'});
   return new MailCredentialRepository(db,options.owner??'owner',()=>now).connect(id,options.binding??binding,null,{accessToken:ACCESS,expiresAt:now+(options.ttl??1000),grantedScopes:options.grants===undefined?[...GMAIL_MAIL_SCOPES]:options.grants,refreshToken:options.noRefresh?{action:'clear'}:{action:'replace',value:REFRESH}});},
  make(options={}){const c=new MailAccessCoordinator({database:db,ownerId:'owner',now:()=>now,loadProviderSettings:async()=>gmail,...options});coordinators.push(c);return c;},
  result(extra={}){return{accessToken:ROTATED,tokenType:'Bearer',expiresAt:now+3600000,grantedScopes:null,refreshToken:{action:'preserve'},unverifiedIdToken:null,...extra};},
  async reopen(){for(const c of coordinators)c.close();db.close();db=await openEncryptedMailDatabase({path,key});}
 };
 try{await body(context);}finally{for(const c of coordinators)c.close();db.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
}
test('cached access validates binding, avoids refresh, isolates owner and reveals no secret binding fields',async()=>fixture(async f=>{
 f.seed('a',{ttl:3600000});f.seed('foreign',{owner:'other'});let calls=0;const c=f.make({refresh:async()=>{calls++;throw Error('unexpected');}});
 assert.equal((await c.acquire('a')).accessToken,ACCESS);assert.equal(calls,0);
 assert.deepEqual(f.credentials.getBinding('a'),binding);
 for(const id of ['foreign','missing'])await assert.rejects(c.acquire(id),{code:'not_found'});
 assert.throws(()=>f.credentials.getBinding('foreign'),{code:'account_not_found'});
}));
test('one in-flight refresh per account, independent accounts, durable replacement and encrypted DB/WAL',async()=>fixture(async f=>{
 f.seed();f.seed('b');const gate=deferred();let calls=0;const c=f.make({refresh:async()=>{calls++;return gate.promise;}});
 const first=c.acquire('a'),second=c.acquire('a');assert.equal(first,second);const other=c.acquire('b');
 await Promise.resolve();assert.equal(calls,2);gate.resolve(f.result({refreshToken:{action:'replace',value:ROTATED+'-refresh'}}));
 const access=await first;await other;assert.equal(access.version.revision,2);
 assert.equal(f.credentials.readForRefresh('a',binding).refreshToken,ROTATED+'-refresh');
 for(const file of [f.path,f.path+'-wal']){const bytes=await readFile(file);for(const marker of [ACCESS,REFRESH,ROTATED,'mail_account_credentials'])assert.equal(bytes.includes(Buffer.from(marker)),false);}
 await f.reopen();assert.equal((await f.make().acquire('a')).accessToken,ROTATED);
}));
test('omitted grants remain unknown even with previous actual grants; explicit scopes replace; refresh preserve is exact',async()=>fixture(async f=>{
 f.seed();f.seed('unknown',{grants:null});
 const c=f.make({refresh:async()=>f.result()});
 for(const id of ['a','unknown']){assert.equal((await c.acquire(id)).grantedScopes,null);assert.equal(f.credentials.readForRefresh(id,binding).refreshToken,REFRESH);}
 f.advance(3600000);const explicit=f.make({refresh:async()=>f.result({grantedScopes:['openid']})});assert.deepEqual((await explicit.acquire('a')).grantedScopes,['openid']);
}));
test('expiry margin triggers refresh; missing refresh requires reconsent',async()=>fixture(async f=>{
 f.seed('a',{ttl:60001});f.seed('missing',{noRefresh:true});let calls=0;const c=f.make({refresh:async()=>{calls++;return f.result();}});
 await c.acquire('a');assert.equal(calls,0);f.advance(2);await c.acquire('a');assert.equal(calls,1);
 await assert.rejects(c.acquire('missing'),{code:'reconsent_required',reconsentRequired:true,retryable:false});
}));
test('provider, client and Graph authority mismatches fail before HTTP including cached tokens',async()=>fixture(async f=>{
 f.seed('a',{ttl:3600000});f.seed('g',{binding:graphBinding});let calls=0;
 for(const [id,settings] of [['a',{...gmail,clientId:'other.apps.googleusercontent.com'}],['a',graph],['g',{...graph,tenantId:'ffffffff-bbbb-4ccc-8ddd-eeeeeeeeeeee'}]]){
  await assert.rejects(f.make({loadProviderSettings:async()=>settings,refresh:async()=>{calls++;return f.result();}}).acquire(id),{code:'binding_mismatch'});
 }assert.equal(calls,0);
 assert.equal((await f.make({loadProviderSettings:async()=>({...graph,clientId:graph.clientId.toUpperCase(),tenantId:graph.tenantId.toUpperCase()}),refresh:async()=>f.result()}).acquire('g')).accessToken,ROTATED);
}));
for(const phase of ['settings','network'])for(const action of ['disconnect','reconnect'])test(`${action} fences pending ${phase} and never returns or persists stale token`,async()=>fixture(async f=>{
 const initial=f.seed();const gate=deferred(),entered=deferred();
 const c=f.make({loadProviderSettings:async()=>{if(phase==='settings'){entered.resolve();await gate.promise;}return gmail;},refresh:async()=>{entered.resolve();if(phase==='network')await gate.promise;return f.result();}});
 const pending=c.acquire('a');const rejected=assert.rejects(pending,{code:action==='disconnect'?'locked':'stale_credentials'});await entered.promise;
 if(action==='disconnect')f.credentials.disconnect('a',initial);else f.credentials.connect('a',binding,initial,{accessToken:'winner-token',expiresAt:f.now+3600000,grantedScopes:null,refreshToken:{action:'clear'}});
 gate.resolve();await rejected;
 if(action==='disconnect')assert.equal(f.credentials.status('a').state,'disconnected');else assert.equal(f.credentials.readAccess('a',binding).accessToken,'winner-token');
}));
test('two coordinators cannot overwrite a winning rotation and loser can acquire winner later',async()=>fixture(async f=>{
 f.seed();const gate=deferred(),entered=deferred();const slow=f.make({refresh:async()=>{entered.resolve();return gate.promise;}});
 const pending=slow.acquire('a'),rejected=assert.rejects(pending,{code:'stale_credentials'});await entered.promise;
 const winner=await f.make({refresh:async()=>f.result({accessToken:'winner'})}).acquire('a');gate.resolve(f.result());await rejected;
 assert.equal((await slow.acquire('a')).accessToken,'winner');assert.deepEqual(f.credentials.readAccess('a',binding).version,winner.version);
}));
for(const phase of ['settings','network'])test(`close immediately rejects uncooperative ${phase}, late completion cannot write`,async()=>fixture(async f=>{
 f.seed();const gate=deferred(),entered=deferred();let signal;
 const c=f.make({loadProviderSettings:async()=>{if(phase==='settings'){entered.resolve();await gate.promise;}return gmail;},refresh:async input=>{signal=input.signal;entered.resolve();await gate.promise;return f.result();}});
 const pending=c.acquire('a'),rejected=assert.rejects(pending,{code:'closed'});await entered.promise;c.close();await rejected;if(signal)assert.equal(signal.aborted,true);
 await assert.rejects(c.acquire('a'),{code:'closed'});gate.resolve();await new Promise(resolve=>setImmediate(resolve));assert.equal(f.credentials.status('a').version.revision,1);
}));
test('deadline bounds ignored cancellation, late result cannot rotate, transient errors redact and clamp retries',async()=>fixture(async f=>{
 f.seed();const gate=deferred();const c=f.make({timeoutMs:10,refresh:async()=>gate.promise});await assert.rejects(c.acquire('a'),{code:'timeout',retryable:true});gate.resolve(f.result());await new Promise(resolve=>setImmediate(resolve));assert.equal(f.credentials.status('a').version.revision,1);
 await assert.rejects(f.make({refresh:async()=>{throw new MailRefreshError('rate_limited',Number.MAX_SAFE_INTEGER);}}).acquire('a'),{code:'rate_limited',retryAfterMs:3600000,retryable:true});
 for(const options of [{loadProviderSettings:async()=>{throw Error(ACCESS);}}, {refresh:async()=>{throw Error(REFRESH);}}]){
  try{await f.make(options).acquire('a');assert.fail('must reject');}catch(error){assert.equal(error.message.includes(ACCESS),false);assert.equal(error.message.includes(REFRESH),false);assert.equal('cause' in error,false);}
 }
}));
test('real refresh parser with injected HTTP preserves omitted refresh token and unknown current scopes',async()=>fixture(async f=>{
 f.seed();let calls=0;const c=f.make({refresh:input=>refreshMailOAuth({...input,fetch:async(url,options)=>{calls++;assert.equal(url,'https://oauth2.googleapis.com/token');assert.equal(new URLSearchParams(options.body).get('refresh_token'),REFRESH);return Response.json({access_token:ROTATED,token_type:'Bearer',expires_in:3600});}})});
 assert.equal((await c.acquire('a')).grantedScopes,null);assert.equal(calls,1);assert.equal(f.credentials.readForRefresh('a',binding).refreshToken,REFRESH);
}));
test('provider classifications stay bounded, do not retry or mutate stored credentials',async()=>fixture(async f=>{
 f.seed();let calls=0;
 for(const [providerCode,expected,retryable] of [['reconsent_required','reconsent_required',false],['client_rejected','provider_rejected',false],['transient','transient',true],['response_invalid','provider_rejected',false]]) {
  await assert.rejects(f.make({refresh:async()=>{calls++;throw new MailRefreshError(providerCode);}}).acquire('a'),{code:expected,retryable});
  assert.equal(f.credentials.status('a').version.revision,1);
 }
 assert.equal(calls,4);assert.equal(f.credentials.readForRefresh('a',binding).refreshToken,REFRESH);
}));
test('close fences token delivery even when configuration resolves in the same microtask turn',async()=>fixture(async f=>{
 f.seed('a',{ttl:3600000});const gate=deferred();const c=f.make({loadProviderSettings:async()=>gate.promise});
 const pending=c.acquire('a'),rejected=assert.rejects(pending,{code:'closed'});gate.resolve(gmail);queueMicrotask(()=>c.close());await rejected;
}));
