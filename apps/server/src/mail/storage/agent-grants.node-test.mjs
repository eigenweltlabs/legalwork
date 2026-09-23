import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openEncryptedMailDatabase} from './database.js';
import {migrateMailSchema} from './schema.js';
import {MailRepository} from './repository.js';
import {MailAgentGrants} from './agent-grants.js';
import {quarantineRestoredMail} from './recovery-quarantine.js';
async function fixture(run){const dir=await mkdtemp(join(tmpdir(),'mail-agent-')),key=randomBytes(32),db=await openEncryptedMailDatabase({path:join(dir,'mail.sqlite'),key});try{migrateMailSchema(db);const repo=new MailRepository(db,'owner');repo.createAccount({id:'archive',provider:'archive',displayName:'Synthetic offline archive'});await run({db,store:new MailAgentGrants(db,'owner')});}finally{db.close();key.fill(0);await rm(dir,{recursive:true,force:true});}}
const input=()=>({accountId:'archive',workspaceId:'workspace',matterId:null,permissions:['search','read','attachments','export'],expiresAt:Date.now()+86400000});
test('explicit offline archive grant resolves only its opaque capability; unknown token, missing permission and restore deny',()=>fixture(({db,store})=>{const created=store.execute({action:'create',directory:'/synthetic/workspace',input:input()});assert(created.token);assert(!JSON.stringify(store.execute({action:'list'})).includes(created.token));assert.equal(store.execute({action:'resolve',token:created.token,permission:'read'}).grant.accountId,'archive');assert.throws(()=>store.execute({action:'resolve',token:'f'.repeat(64)}));assert.throws(()=>store.execute({action:'resolve',token:created.token,permission:'draft'}));assert.throws(()=>new MailAgentGrants(db,'other').execute({action:'resolve',token:created.token}));quarantineRestoredMail(db);assert.throws(()=>store.execute({action:'resolve',token:created.token}));assert.equal(store.execute({action:'list'}).grants[0].state,'revoked');}));
test('revoked history and expired grants do not hide or consume live grants',()=>fixture(({db,store})=>{for(let i=0;i<102;i++){const grant=store.execute({action:'create',directory:'/synthetic',input:input()}).grant;store.execute({action:'revoke',id:grant.id});}const grant=store.execute({action:'create',directory:'/synthetic',input:input()}).grant;assert.equal(store.execute({action:'list'}).grants[0].id,grant.id);db.run('UPDATE mail_agent_grants SET expires_at=1 WHERE id=?',[grant.id]);assert.throws(()=>store.check(grant.id));assert(store.execute({action:'create',directory:'/synthetic',input:input()}).grant);assert.throws(()=>store.execute({action:'create',directory:'/synthetic',input:{...input(),permissions:['propose_send']}}));}));

test('account policies default safely, migrate legacy scopes without widening, reject stale/foreign writes and quarantine restores',()=>fixture(({db,store})=>{
 const defaults=store.execute({action:'account-policy',accountId:'archive'}).policy;
 assert.equal(defaults.actions.read,'allow');assert.equal(defaults.actions.propose_send,'ask');assert.equal(defaults.migrationRequired,false);
 const legacy=store.execute({action:'create',directory:'/restricted',input:{...input(),matterId:'matter',permissions:['read']}}).grant;
 const migrated=store.execute({action:'account-policy',accountId:'archive'}).policy;
 assert.equal(migrated.migrationRequired,true);assert(Object.values(migrated.actions).every(action=>action==='deny'));
 assert.throws(()=>new MailAgentGrants(db,'foreign').execute({action:'account-policy',accountId:'archive'}));
 const selected=store.execute({action:'set-account-policy',accountId:'archive',expectedRevision:0,actions:defaults.actions}).policy;
 assert.equal(selected.revision,1);assert.equal(selected.migrationRequired,false);assert.throws(()=>store.check(legacy.id));
 assert.throws(()=>store.execute({action:'set-account-policy',accountId:'archive',expectedRevision:0,actions:defaults.actions}));
 const first=store.execute({action:'account-scope',accountId:'archive'}).grant;
 const second=store.execute({action:'account-scope',accountId:'archive'}).grant;
 assert.equal(first.id,second.id);assert.equal(first.revision,second.revision);assert.equal(first.workspaceId,'__account__');
 quarantineRestoredMail(db);
 assert.throws(()=>store.check(first.id,first.revision));
 assert(Object.values(store.execute({action:'account-policy',accountId:'archive'}).policy.actions).every(action=>action==='deny'));
}));
