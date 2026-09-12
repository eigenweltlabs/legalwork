import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {randomBytes,randomUUID} from 'node:crypto';
import SMTPConnection from 'nodemailer/lib/smtp-connection';
import {openEncryptedMailDatabase} from '../storage/database.js';
import {migrateMailSchema} from '../storage/schema.js';
import {MailRepository} from '../storage/repository.js';
import {MailCredentialRepository} from '../storage/credentials.js';
import {SenderIdentityRepository} from '../storage/sender-identities.js';
import {SmtpCustody} from '../storage/smtp-custody.js';
import {OutboxStore} from '../storage/outbox.js';
import {OutboxRunner} from '../runtime/outbox-runner.js';
import {SmtpSubmission} from './smtp-submit.js';
import {smtpSentCopy} from './sent-copy.js';
import {smtpServerFixture} from '../testing/smtp-server.mjs';
async function fixture(provider,body){
 const directory=await mkdtemp(join(tmpdir(),'mail-outbound-cert-')),path=join(directory,'mail.sqlite'),key=randomBytes(32);let db=await openEncryptedMailDatabase({path,key});const runners=[];
 try{
  migrateMailSchema(db);new MailRepository(db,'owner').createAccount({id:'a',provider,displayName:'Synthetic outbound'});
  const binding={provider,clientId:provider==='gmail'?'synthetic.apps.googleusercontent.com':'11111111-1111-4111-8111-111111111111',authority:provider==='gmail'?'https://accounts.google.com':'https://login.microsoftonline.com/22222222-2222-4222-8222-222222222222/v2.0',providerSubject:'33333333-3333-4333-8333-333333333333'};
  if(provider==='imap')db.run("INSERT INTO mail_imap_credentials VALUES('a',?,1,'connected',0,?,'synthetic')",[randomUUID(),JSON.stringify({host:'imap.example.test',port:993,username:'synthetic'})]);
  else new MailCredentialRepository(db,'owner').connect('a',binding,null,{accessToken:'synthetic',expiresAt:Date.now()+3600000,grantedScopes:provider==='gmail'?['https://www.googleapis.com/auth/gmail.modify']:['Mail.ReadWrite','Mail.Send'],refreshToken:{action:'clear'}});
  if(provider==='imap')new SmtpCustody(db,'owner').configure('a',{host:'smtp.example.test',port:465,username:'synthetic',password:'synthetic',security:'tls',sentCopy:'append'});
  const identity=new SenderIdentityRepository(db,'owner').replace('a',new MailCredentialRepository(db,'owner').status('a').version.generation,[{address:'self@example.com',displayName:'Self',primary:true,default:true}],provider==='imap'?'user_confirmed':'provider_verified')[0];
  const state={get db(){return db;},get store(){return new OutboxStore(db,'owner');},make(extra={}){const runner=new OutboxRunner({database:db,ownerId:'owner',access:{acquire:async()=>new MailCredentialRepository(db,'owner').readAccess('a',binding)},...extra});runners.push(runner);return runner;},async reopen(){for(const runner of runners)await runner.close();db.close();db=await openEncryptedMailDatabase({path,key});migrateMailSchema(db);}};
  const draft=state.store.local.saveDraft('a',{draftId:randomUUID(),expected:null,content:{senderIdentityId:identity.id,from:identity.address,to:['recipient@example.com'],subject:'Certification only',text:'Immutable synthetic outbound'}});
  const item=await state.store.queue('a',{draftId:draft.id,version:draft.version,replayKey:'one'});await body({...state,get db(){return db;},get store(){return new OutboxStore(db,'owner');},item});
 }finally{for(const runner of runners)await runner.close();db.close();key.fill(0);await rm(directory,{recursive:true,force:true});}
}
for(const provider of ['gmail','graph'])test(`${provider} real HTTP submission adapter remains uncertain across encrypted reopen and only exact Sent evidence settles it`,()=>fixture(provider,async f=>{
 const fetchBefore=globalThis.fetch;let sends=0,mode='none';const row=f.store.row('a',f.item.id),mime=Buffer.from(row.api_mime_bytes);
 globalThis.fetch=async(input,init)=>{
  const url=new URL(String(input));assert.equal(init.redirect,'error');
  if(url.pathname.endsWith('/messages/send')||url.pathname.endsWith('/sendMail')){sends++;assert.equal(init.method,'POST');assert.deepEqual(provider==='gmail'?Buffer.from(init.body):Buffer.from(init.body,'base64'),mime);throw TypeError('Synthetic lost final response');}
  assert.equal(init.method,'GET');
  if(provider==='gmail'){
   if(url.pathname.endsWith('/messages'))return Response.json({messages:mode==='none'?[]:mode==='duplicates'?[{id:'one'},{id:'two'}]:[{id:'one'}]});
   return Response.json({labelIds:['SENT'],payload:{headers:[{name:'Message-ID',value:row.message_id},{name:'From',value:mode==='foreign'?'other@example.com':'self@example.com'}]}});
  }
  assert(url.pathname.endsWith('/mailFolders/sentitems/messages'));
  const match={id:'one',internetMessageId:row.message_id,isDraft:false,from:{emailAddress:{address:mode==='foreign'?'other@example.com':'self@example.com'}}};return Response.json({value:mode==='none'?[]:mode==='duplicates'?[match,{...match,id:'two'}]:[match]});
 };
 try{
  const initial=f.make();await initial.turn('a');assert.equal(sends,1);assert.equal(f.store.item('a',f.item.id).state,'uncertain');assert.throws(()=>f.store.retry('a',f.item.id));
  await f.reopen();assert.deepEqual(Buffer.from(f.store.row('a',f.item.id).api_mime_bytes),mime);const restarted=f.make();restarted.recover();await restarted.run();assert.equal(sends,1);
  for(mode of ['none','duplicates','foreign'])assert.equal((await restarted.reconcile('a',f.item.id)).state,'uncertain',mode);
  mode='exact';assert.equal((await restarted.reconcile('a',f.item.id)).state,'accepted');await restarted.run();assert.equal(sends,1);assert.equal(f.store.item('a',f.item.id).result.delivery,'unknown');assert.equal(f.store.item('a',f.item.id).result.reconciled,true);
 }finally{globalThis.fetch=fetchBefore;}
}));
test('verified TLS SMTP lost DATA acknowledgment survives encrypted restart; Sent reconciliation never repeats DATA or APPEND',()=>smtpServerFixture({lostAck:true},server=>fixture('imap',async f=>{
 let sends=0,appends=0,mode='none';const row=f.store.row('a',f.item.id),mime=Buffer.from(row.mime_bytes);
 const create=()=>({secureConnection:true,connect:async()=>{},list:async()=>[{path:'Sent',specialUse:'\\Sent'}],mailboxOpen:async(_,options)=>assert.equal(options.readOnly,true),search:async()=>mode==='none'?[]:mode==='duplicates'?[1,2]:[1],fetchOne:async()=>({envelope:{messageId:row.message_id,from:[{address:mode==='foreign'?'other@example.com':'self@example.com'}]}}),append:async()=>{appends++;throw Error('Uncertain submission cannot append');},close(){}});
 const connection=async(_,signal)=>{
  const smtp=new SmtpSubmission({host:'127.0.0.1',port:server.port,username:'synthetic',security:'tls',sentCopy:'append'},'synthetic',signal,options=>new SMTPConnection({...options,tls:{...options.tls,ca:server.cert,servername:'localhost'}}));
  return{prepare:()=>smtp.prepare().then(()=>null),send:async row=>{sends++;return smtp.send(f.store.envelope(row),row.mime_bytes);},reconcile:async row=>{const saved=await smtpSentCopy({settings:{host:'imap.example.test',port:993,username:'synthetic'},password:'synthetic',raw:row.api_mime_bytes,messageId:row.message_id,from:'self@example.com',signal,append:false,fence:()=>f.store.assert(row)},create);return saved==='saved'?{accepted:[],rejected:[],providerId:null,sentCopy:'saved',delivery:'unknown',reconciled:true}:null;},close:()=>smtp.close()};
 };
 const first=f.make({connection});await first.turn('a');assert.equal(server.messages,1);assert.equal(f.store.item('a',f.item.id).state,'uncertain');await f.reopen();assert.deepEqual(Buffer.from(f.store.row('a',f.item.id).mime_bytes),mime);
 const restarted=f.make({connection});restarted.recover();await restarted.run();assert.equal(sends,1);for(mode of ['none','duplicates','foreign'])assert.equal((await restarted.reconcile('a',f.item.id)).state,'uncertain');mode='exact';assert.equal((await restarted.reconcile('a',f.item.id)).state,'accepted');await restarted.run();assert.equal(sends,1);assert.equal(server.messages,1);assert.equal(appends,0);assert.equal(f.store.local.readDraft('a',{draftId:row.draft_id}).id,row.draft_id);
})));
