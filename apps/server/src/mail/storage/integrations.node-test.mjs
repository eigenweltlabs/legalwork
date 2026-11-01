import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openEncryptedMailDatabase} from './database.js';
import {migrateMailSchema} from './schema.js';
import {MailIntegrationAccounts} from './integrations.js';
import {MailCredentialRepository} from './credentials.js';
import {MailRepository} from './repository.js';
import {MailAccessCoordinator} from '../providers/access-coordinator.js';
const account={accountId:'mail_'+'a'.repeat(64),handle:'b'.repeat(64),connectorId:'gmail',connectionId:'connection',identity:'owner@example.test',email:'owner@example.test',displayName:'Owner',scopes:['https://www.googleapis.com/auth/gmail.modify']};
const snapshot=accounts=>({configuration:{origin:'http://127.0.0.1:12345',capability:'c'.repeat(64)},handles:accounts.map(value=>value.handle),accounts});
async function fixture(fn){const directory=await mkdtemp(join(tmpdir(),'mail-integrations-')),key=randomBytes(32),db=await openEncryptedMailDatabase({path:join(directory,'mail.sqlite'),key});try{migrateMailSchema(db);await fn(db);}finally{db.close();key.fill(0);await rm(directory,{recursive:true,force:true});}}
test('connected accounts reuse one encrypted mailbox and acquire routing references without OAuth settings or refresh tokens',async()=>fixture(async db=>{
 const links=new MailIntegrationAccounts(db,'owner'),credentials=new MailCredentialRepository(db,'owner');
 assert.deepEqual(links.reconcile(snapshot([account])).changed,[account.accountId]);
 const before=credentials.status(account.accountId);assert.deepEqual(links.reconcile(snapshot([account])).changed,[]);
 assert.deepEqual(credentials.status(account.accountId),before);
 const row=db.get('SELECT * FROM mail_account_credentials WHERE account_id=?',[account.accountId]);
 assert.equal(row.refresh_token,null);assert.equal(row.access_token,'legalwork-mail:'+account.accountId);
 const access=new MailAccessCoordinator({database:db,ownerId:'owner',loadProviderSettings:async()=>{throw Error('must not load another OAuth app');},refresh:async()=>{throw Error('must not refresh');}});
 try{assert.equal((await access.acquire(account.accountId)).accessToken,row.access_token);}finally{access.close();}
 assert.equal(new MailIntegrationAccounts(db,'other').get(account.accountId),undefined);
 assert.equal(db.get('SELECT count(*) n FROM mail_accounts').n,1);
}));
test('permission reductions fence prior generations; outages preserve archives and disconnect never deletes messages',async()=>fixture(async db=>{
 const links=new MailIntegrationAccounts(db,'owner'),credentials=new MailCredentialRepository(db,'owner');links.reconcile(snapshot([account]));
 const old=credentials.status(account.accountId);new MailRepository(db,'owner').ingestMessage(account.accountId,{locator:{provider:'gmail',messageId:'retained'},subject:'Retained',rfcMessageId:null,memberships:[]});
 const readonly={...account,scopes:['https://www.googleapis.com/auth/gmail.readonly']};links.reconcile(snapshot([readonly]));
 assert.notEqual(credentials.status(account.accountId).version.generation,old.version.generation);
 assert.deepEqual(links.reconcile({...snapshot([]),handles:[account.handle]}).disconnected,[]);
 assert.equal(credentials.status(account.accountId).state,'connected');
 assert.deepEqual(links.reconcile(snapshot([])).disconnected,[account.accountId]);assert.equal(credentials.status(account.accountId).state,'disconnected');
 assert.equal(db.get('SELECT count(*) n FROM mail_messages').n,1);assert.equal(db.get('SELECT refresh_token FROM mail_account_credentials').refresh_token,null);
 links.reconcile(snapshot([readonly]));assert.equal(credentials.status(account.accountId).state,'connected');assert.notEqual(credentials.status(account.accountId).version.generation,old.version.generation);
}));
test('different authenticated identity on the same handle gets a new archive and disables the old account',async()=>fixture(async db=>{
 const links=new MailIntegrationAccounts(db,'owner'),credentials=new MailCredentialRepository(db,'owner');links.reconcile(snapshot([account]));
 const other={...account,accountId:'mail_'+'d'.repeat(64),identity:'other@example.test',email:'other@example.test'};
 links.reconcile(snapshot([other]));assert.equal(credentials.status(account.accountId).state,'disconnected');assert.equal(credentials.status(other.accountId).state,'connected');
 assert.equal(db.get('SELECT count(*) n FROM mail_accounts').n,2);assert.deepEqual(db.all('PRAGMA foreign_key_check'),[]);
}));
