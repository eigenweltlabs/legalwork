import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openEncryptedMailDatabase} from './database.js';
import {migrateMailSchema} from './schema.js';
import {MailRepository} from './repository.js';
import {MailCredentialRepository} from './credentials.js';
import {SenderIdentityRepository} from './sender-identities.js';
import {GraphMailboxRepository} from './graph-mailboxes.js';
import {GmailReadTransport} from '../providers/gmail.js';
const binding={provider:'gmail',clientId:'synthetic.apps.googleusercontent.com',authority:'https://accounts.google.com',providerSubject:'subject'};
const tokens=()=>({accessToken:'synthetic',expiresAt:Date.now()+3600000,grantedScopes:['openid','email','https://www.googleapis.com/auth/gmail.modify'],refreshToken:{action:'replace',value:'synthetic-refresh'}});
async function fixture(body){const dir=await mkdtemp(join(tmpdir(),'mail-senders-')),key=randomBytes(32),db=await openEncryptedMailDatabase({path:join(dir,'mail.sqlite'),key});try{migrateMailSchema(db);const accounts=new MailRepository(db,'owner');accounts.createAccount({id:'gmail',provider:'gmail',displayName:'Not an email'});const credentials=new MailCredentialRepository(db,'owner');credentials.connect('gmail',binding,null,tokens());await body({db,accounts,credentials,senders:new SenderIdentityRepository(db,'owner')});}finally{db.close();key.fill(0);await rm(dir,{recursive:true,force:true});}}
const discovered=[{address:'self@example.com',displayName:'Self',primary:true,default:true},{address:'alias@example.com',displayName:'Alias',primary:false,default:false}];
test('Gmail discovery excludes pending/unverified aliases and validates complete provider response',async()=>{
 const response={sendAs:[{sendAsEmail:'self@example.com',isPrimary:true,isDefault:true},{sendAsEmail:'alias@example.com',verificationStatus:'accepted'},{sendAsEmail:'pending@example.com',verificationStatus:'pending'},{sendAsEmail:'unknown@example.com'}]};
 const urls=[];const transport=new GmailReadTransport({accessToken:'synthetic',fetch:async(url,init)=>{urls.push(String(url));assert.equal(init.headers.Authorization,'Bearer synthetic');return Response.json(response);}});
 assert.deepEqual((await transport.listSendAs()).map(value=>value.address),['self@example.com','alias@example.com']);assert.equal(urls[0],'https://gmail.googleapis.com/gmail/v1/users/me/settings/sendAs');
 for(const sendAs of [[{sendAsEmail:'injected\r\n@example.com',isPrimary:true}], [{sendAsEmail:'self@example.com',isPrimary:true},{sendAsEmail:'SELF@example.com',verificationStatus:'accepted'}],[],[{sendAsEmail:'alias@example.com',verificationStatus:'accepted'}]]){response.sendAs=sendAs;await assert.rejects(transport.listSendAs());}
});
test('identity defaults/signatures persist; aliases removed by refresh and stale generations fail closed',async()=>fixture(async({db,credentials,senders})=>{
 let values=senders.replace('gmail',credentials.status('gmail').version.generation,discovered);const alias=values.find(value=>value.address==='alias@example.com');
 senders.settings('gmail',{identityId:alias.id,signature:'Best,\nAlice',defaultNew:false,defaultReply:true});
 assert.equal(senders.list('gmail').find(value=>value.id===alias.id).signature,'Best,\nAlice');assert.equal(senders.assertSender('gmail',{senderIdentityId:alias.id,from:alias.address}).address,alias.address);
 assert.throws(()=>senders.assertSender('gmail',{senderIdentityId:alias.id,from:'forged@example.com'}));assert.throws(()=>senders.assertSender('gmail',{from:alias.address}));assert.throws(()=>new SenderIdentityRepository(db,'foreign').list('gmail'));
 senders.replace('gmail',credentials.status('gmail').version.generation,[discovered[0]]);assert.throws(()=>senders.assertSender('gmail',{senderIdentityId:alias.id,from:alias.address}));assert.equal(senders.list('gmail').find(value=>value.id===alias.id).signature,'Best,\nAlice');
 credentials.disconnect('gmail',credentials.status('gmail').version);assert(senders.list('gmail').every(value=>!value.available));credentials.connect('gmail',binding,credentials.status('gmail').version,tokens());assert(senders.list('gmail').every(value=>!value.available));
 values=senders.replace('gmail',credentials.status('gmail').version.generation,discovered);assert(values.every(value=>value.available));
}));
test('Microsoft shared sender requires declared permission and follows parent lock/revocation',async()=>fixture(async({db,accounts,credentials,senders})=>{
 accounts.createAccount({id:'graph',provider:'graph',displayName:'Microsoft'});credentials.connect('graph',{provider:'graph',clientId:'11111111-2222-3333-4444-555555555555',authority:'https://login.microsoftonline.com/aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee/v2.0',providerSubject:'bbbbbbbb-cccc-dddd-eeee-ffffffffffff'},null,{...tokens(),grantedScopes:['User.Read','Mail.ReadWrite','Mail.Send','Mail.ReadWrite.Shared','Mail.Send.Shared']});
 const boxes=new GraphMailboxRepository(db,'owner');const input={credentialAccountId:'graph',address:'shared@example.com',kind:'shared',writeConfirmed:true,sendMode:'none'};const shared=boxes.configure(input);assert.equal(senders.list(shared.accountId)[0].available,false);
 boxes.configure({...input,sendMode:'send_on_behalf'});const sender=senders.list(shared.accountId)[0];assert.equal(sender.source,'administrator_confirmed');assert.equal(sender.sendMode,'send_on_behalf');senders.assertSender(shared.accountId,{senderIdentityId:sender.id,from:sender.address});
 db.exec('PRAGMA ignore_check_constraints=ON');db.run('UPDATE mail_account_credentials SET archive_locked=1 WHERE account_id=?',['graph']);assert.equal(senders.list(shared.accountId)[0].available,false);db.run('UPDATE mail_account_credentials SET archive_locked=0 WHERE account_id=?',['graph']);db.exec('PRAGMA ignore_check_constraints=OFF');boxes.revoke(shared.accountId);assert.equal(senders.list(shared.accountId)[0].available,false);
}));

test('IMAP requires explicit configuration, supports removal, and never inherits a username as From',async()=>fixture(async({db,accounts,senders})=>{
 accounts.createAccount({id:'imap',provider:'imap',displayName:'login@example.com'});db.run("INSERT INTO mail_imap_credentials(account_id,generation,revision,state,archive_locked,settings_json,password) VALUES('imap','11111111-1111-4111-8111-111111111111',1,'connected',0,'{}','synthetic')");
 assert.deepEqual(senders.list('imap'),[]);assert.throws(()=>senders.configure('imap',{address:'alias@example.com',confirmed:false}));const values=senders.configure('imap',{address:'alias@example.com',confirmed:true});assert.equal(values[0].source,'user_confirmed');assert.equal(values[0].available,true);senders.assertSender('imap',{senderIdentityId:values[0].id,from:values[0].address});senders.configure('imap',{address:'alias@example.com',confirmed:true,remove:true});assert.equal(senders.list('imap')[0].available,false);assert.throws(()=>senders.configure('gmail',{address:'arbitrary@example.com',confirmed:true}));
}));

test('schema 19 upgrades atomically to sender identities without changing connected accounts',async()=>fixture(async({db,credentials})=>{
 const before=credentials.status('gmail');db.exec('DROP TABLE mail_sender_identities');db.run('UPDATE mail_schema_version SET version=19');
 const failing={...db,exec(sql){if(sql.includes('CREATE TABLE mail_sender_identities'))throw Error('synthetic migration failure');db.exec(sql);}};
 assert.throws(()=>migrateMailSchema(failing));assert.equal(db.get('SELECT version FROM mail_schema_version').version,19);assert.equal(db.get("SELECT name FROM sqlite_master WHERE name='mail_sender_identities'"),undefined);
 migrateMailSchema(db);assert.equal(db.get('SELECT version FROM mail_schema_version').version,20);assert.deepEqual(credentials.status('gmail'),before);migrateMailSchema(db);
}));

test('worker refreshes authenticated aliases and preserves sender preferences across relaunch',async()=>{
 const {writeFile}=await import('node:fs/promises'),{LocalMailService}=await import('../service.js');const dir=await mkdtemp(join(tmpdir(),'mail-sender-worker-')),path=join(dir,'mail.sqlite'),key=randomBytes(32);const db=await openEncryptedMailDatabase({path,key});
 migrateMailSchema(db);new MailRepository(db,'owner').createAccount({id:'gmail',provider:'gmail',displayName:'Mailbox'});new MailCredentialRepository(db,'owner').connect('gmail',binding,null,tokens());db.close();
 const worker=join(dir,'worker.mjs');await writeFile(worker,`const{existsSync}=await import('node:fs');globalThis.fetch=async(input)=>{const url=new URL(String(input));if(url.hostname==='openidconnect.googleapis.com')return Response.json({sub:'subject',email:'self@example.com',email_verified:true});if(url.pathname.endsWith('/profile'))return Response.json({emailAddress:'self@example.com',historyId:'1'});if(url.pathname.endsWith('/settings/sendAs')&&existsSync(${JSON.stringify(join(dir,'denied'))}))return Response.json({error:{errors:[{reason:'forbidden'}]}},{status:403});if(url.pathname.endsWith('/settings/sendAs'))return Response.json({sendAs:[{sendAsEmail:'self@example.com',isPrimary:true,isDefault:true},{sendAsEmail:'alias@example.com',verificationStatus:'accepted'},{sendAsEmail:'pending@example.com',verificationStatus:'pending'}]});if(url.pathname.endsWith('/labels'))return Response.json({labels:[]});if(url.pathname.endsWith('/messages'))return Response.json({messages:[]});throw Error('Unexpected synthetic request');};await import(${JSON.stringify(new URL('../runtime/worker.js',import.meta.url).href)});`);
 const service=new LocalMailService({executable:{kind:'node',path:process.execPath},entryPoint:worker,databasePath:path,ownerId:'owner',loadKey:async()=>Buffer.from(key),loadProviderSettings:async()=>({provider:'gmail',applicationType:'desktop',pkceMethod:'S256',clientId:binding.clientId,clientSecret:'synthetic',scopes:tokens().grantedScopes})});
 try{await service.unlock();const values=await service.senders('gmail');assert.deepEqual(values.map(value=>value.address),['alias@example.com','self@example.com']);const alias=values[0];await service.senderSettings('gmail',{identityId:alias.id,signature:'Local signature',defaultNew:false,defaultReply:true});await writeFile(join(dir,'denied'),'synthetic');await assert.rejects(service.refreshSenders('gmail'));assert((await service.senders('gmail')).every(value=>!value.available));await rm(join(dir,'denied'));await service.refreshSenders('gmail');await service.lock();await service.unlock();assert.equal((await service.senders('gmail'))[0].signature,'Local signature');await assert.rejects(service.configureSender('gmail',{address:'forged@example.com',confirmed:true}));await service.disconnectAccount('gmail');assert((await service.senders('gmail')).every(value=>!value.available));}finally{await service.stop();key.fill(0);await rm(dir,{recursive:true,force:true});}
});

test('legacy and forged From drafts remain recoverable but cannot enter the outbox',async()=>fixture(async({db,credentials,senders})=>{
 const {MailLocalApiStore}=await import('./local-api.js'),{randomUUID}=await import('node:crypto');const local=new MailLocalApiStore(db,'owner');const identity=senders.replace('gmail',credentials.status('gmail').version.generation,discovered).find(value=>value.address==='self@example.com');
 const legacy=local.saveDraft('gmail',{draftId:randomUUID(),expected:null,content:{subject:'Recovery',from:'self@example.com',to:['recipient@example.com'],text:'Retain this body'}});assert.throws(()=>local.enqueueSubmission('gmail',{draftId:legacy.id,version:legacy.version,replayKey:'legacy'}));assert.equal(local.readDraft('gmail',{draftId:legacy.id}).content.text,'Retain this body');
 const forged=local.saveDraft('gmail',{draftId:legacy.id,expected:legacy.version,content:{...legacy.content,senderIdentityId:identity.id,from:'forged@example.com'}});assert.throws(()=>local.enqueueSubmission('gmail',{draftId:forged.id,version:forged.version,replayKey:'forged'}));
 const recovered=local.saveDraft('gmail',{draftId:legacy.id,expected:forged.version,content:{...forged.content,from:identity.address}});assert.equal(local.enqueueSubmission('gmail',{draftId:recovered.id,version:recovered.version,replayKey:'recovered'}).state,'queued');
}));
