import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes,randomUUID,createHash} from 'node:crypto';
import {mkdtemp,readFile,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {spawnSync} from 'node:child_process';
import {openEncryptedMailDatabase} from './database.js';
import {migrateMailSchema,MAIL_SCHEMA_VERSION} from './schema.js';
import {MailRepository} from './repository.js';
import {MailContentStore} from './content-store.js';
import {MailActionJournal} from './action-journal.js';

const marker='historical-private-original-ä-§-2026';
const bytes=Buffer.from(`From: old@example.test\r\nSubject: Historical original\r\n\r\n${marker}`);
const locator={provider:'gmail',messageId:'historical-one'};
const hash=value=>createHash('sha256').update(value).digest('hex');
const schemaSnapshot=db=>db.all("SELECT type,name,tbl_name,sql FROM sqlite_schema WHERE name NOT LIKE 'sqlite_%' ORDER BY type,name");
async function createOldStore(path,key,version){
 const db=await openEncryptedMailDatabase({path,key});
 try{
  // Historical statements are checked-in snapshots, never a current schema with tables dropped.
  db.exec('PRAGMA foreign_keys=ON');assert.equal(db.get('PRAGMA foreign_keys').foreign_keys,1);
  db.transaction(()=>db.exec(v5));
  if(version===9)db.transaction(()=>db.exec(v9));
  assert.equal(db.get('SELECT version FROM mail_schema_version').version,version);
  const repo=new MailRepository(db,'owner');repo.createAccount({id:'a',provider:'gmail',displayName:'Historical synthetic account'});
  repo.putFolder('a',{id:'INBOX',name:'Inbox',kind:'label'});
  repo.ingestMessage('a',{locator,rfcMessageId:'<old@example.test>',subject:'Historical original',memberships:['INBOX']});
  const store=new MailContentStore(db,'owner');
  const raw=await store.writePart('a',locator,{kind:'raw',maxBytes:bytes.length},[bytes]);
  const attachment=await store.writePart('a',locator,{kind:'attachment',partId:'old-part',maxBytes:bytes.length},[bytes]);
  repo.setAttachmentsEnumerated('a',locator,true);
  db.run('INSERT INTO mail_drafts(account_id,id,revision,content_ref_id) VALUES(?,?,?,?)',['a','old-draft',7,raw.id]);
  db.run("INSERT INTO mail_actions(account_id,id,kind,payload_json,state) VALUES('a','legacy-uncertain','submission','{}','uncertain')");
  // Persist the old v5 action contract directly: the current journal correctly refuses old schemas.
  const uncertain={id:randomUUID()},queued={id:randomUUID()};
  for(const [action,state,attempts,error] of [[uncertain,'uncertain',1,'outcome_unknown'],[queued,'queued',0,null]])db.run(
   `INSERT INTO mail_action_jobs(account_id,id,replay_key,kind,payload_json,precondition,conflict_policy,generation,revision,state,attempts,max_attempts,retry_base_ms,retry_max_ms,available_at,lease_token,lease_until,cancel_requested,last_error)
    VALUES(?,?,?,'submission',?,NULL,'manual',?,1,?,?,5,1000,60000,1000,NULL,NULL,0,?)`,
   ['a',action.id,state+'-send',JSON.stringify({draft:'old-draft',revision:7}),randomUUID(),state,attempts,error]);
  const actions=db.all('SELECT * FROM mail_action_jobs ORDER BY id');
  return{raw,attachment,queued,uncertain,actions,schema:schemaSnapshot(db)};
 }finally{db.close();}
}
const v5=await readFile(new URL('../testing/historical-schema/v0-to-v5.sql',import.meta.url),'utf8');
const v9=await readFile(new URL('../testing/historical-schema/v5-to-v9.sql',import.meta.url),'utf8');
function assertRetained(db,old){
 const store=new MailContentStore(db,'owner');
 for(const reference of [old.raw,old.attachment])assert.equal(hash(Buffer.concat([...store.read('a',reference.id)])),hash(bytes));
 assert.deepEqual(db.get("SELECT revision,content_ref_id FROM mail_drafts WHERE id='old-draft'"),{revision:7,content_ref_id:old.raw.id});
 assert.equal(db.get("SELECT state FROM mail_actions WHERE id='legacy-uncertain'").state,'uncertain');
 assert.deepEqual(db.all('SELECT * FROM mail_action_jobs ORDER BY id'),old.actions);
 assert.equal(db.get('SELECT attachments_enumerated FROM mail_messages').attachments_enumerated,1);
 assert.deepEqual(db.all('SELECT folder_id FROM mail_memberships'),[{folder_id:'INBOX'}]);
 assert.deepEqual(db.all('PRAGMA foreign_key_check'),[]);
}
for(const version of [5,9])for(const interruption of ['ddl','version-write']){
 test(`historical v${version} persisted store survives SIGKILL after ${interruption}, reopen and upgrade`,async()=>{
  const directory=await mkdtemp(join(tmpdir(),'mail-historical-upgrade-')),path=join(directory,'mail.sqlite'),key=randomBytes(32);
  let db;
  try{
   const old=await createOldStore(path,key,version);
   // The child is killed INSIDE the actual transaction, without rollback/close/finally.
   // Key material travels only over private stdin, never argv/environment.
   const script=`import {readFileSync,writeSync} from 'node:fs';
import {openEncryptedMailDatabase} from ${JSON.stringify(new URL('./database.js',import.meta.url).href)};
import {migrateMailSchema} from ${JSON.stringify(new URL('./schema.js',import.meta.url).href)};
const input=JSON.parse(readFileSync(0,'utf8')),key=Buffer.from(input.key,'base64');
const db=await openEncryptedMailDatabase({path:input.path,key});key.fill(0);
function crash(){writeSync(2,'migration-crash-boundary');process.kill(process.pid,'SIGKILL');}
const interrupted={...db,exec(sql){db.exec(sql);if(input.interruption==='ddl'&&sql.includes('CREATE TABLE mail_local_drafts'))crash();},run(sql,parameters){const result=db.run(sql,parameters);if(input.interruption==='version-write'&&sql.startsWith('INSERT INTO mail_schema_version'))crash();return result;}};
migrateMailSchema(interrupted);process.exit(74);`;
   const child=spawnSync(process.execPath,['--input-type=module','-e',script],{input:JSON.stringify({path,key:key.toString('base64'),interruption}),encoding:'utf8',env:process.platform==='win32'?{SystemRoot:process.env.SystemRoot,WINDIR:process.env.WINDIR}:{},timeout:15000});
   assert.equal(child.error,undefined);assert.equal(process.platform==='win32'?child.status:child.signal,process.platform==='win32'?1:'SIGKILL');assert.equal(child.stdout,'');assert.equal(child.stderr,'migration-crash-boundary');
   db=await openEncryptedMailDatabase({path,key});
   assert.equal(db.get('SELECT version FROM mail_schema_version').version,version);
   assert.deepEqual(schemaSnapshot(db),old.schema);assertRetained(db,old);
   migrateMailSchema(db);assert.equal(db.get('SELECT version FROM mail_schema_version').version,MAIL_SCHEMA_VERSION);assertRetained(db,old);
   // Repeated current-version opening is a no-op, not an action replay or legacy-draft conversion.
   const upgraded=schemaSnapshot(db);db.close();db=await openEncryptedMailDatabase({path,key});migrateMailSchema(db);
   assert.deepEqual(schemaSnapshot(db),upgraded);assertRetained(db,old);
   assert.equal(db.get('SELECT count(*) AS n FROM mail_local_drafts').n,0);
   const journal=new MailActionJournal(db,'owner',()=>2000);const next=journal.claim('a');assert.equal(next.status.id,old.queued.id);assert.equal(journal.claim('a'),null);
   assert.equal(db.get('SELECT state FROM mail_action_jobs WHERE id=?',[old.uncertain.id]).state,'uncertain');
   for(const file of [path,path+'-wal'])assert.equal((await readFile(file)).includes(Buffer.from(marker)),false);
  }finally{db?.close();key.fill(0);await rm(directory,{recursive:true,force:true});}
 });
}
