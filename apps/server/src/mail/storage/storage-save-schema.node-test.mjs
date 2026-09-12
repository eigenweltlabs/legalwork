import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openEncryptedMailDatabase} from './database.js';
import {migrateMailSchema,MAIL_SCHEMA_VERSION} from './schema.js';
import {removeLaterMailSchema} from '../testing/legacy-schema.mjs';
test('schema26 storage save upgrade atomically and reopen encrypted',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mail-outbox-schema-')),key=randomBytes(32),path=join(dir,'mail.sqlite');let db=await openEncryptedMailDatabase({path,key});
 try{migrateMailSchema(db);removeLaterMailSchema(db,25);db.run('UPDATE mail_schema_version SET version=25');const fail={...db,exec(sql){db.exec(sql);if(sql.includes('CREATE TABLE mail_storage_saves('))throw Error('synthetic migration failure');}};assert.throws(()=>migrateMailSchema(fail));assert.equal(db.get('SELECT version FROM mail_schema_version').version,25);assert.equal(db.get("SELECT name FROM sqlite_master WHERE name='mail_storage_saves'"),undefined);migrateMailSchema(db);db.close();db=await openEncryptedMailDatabase({path,key});migrateMailSchema(db);assert.equal(db.get('SELECT version FROM mail_schema_version').version,MAIL_SCHEMA_VERSION);for(const name of ['mail_storage_saves','mail_storage_save_parts'])assert.equal(db.get('SELECT name FROM sqlite_master WHERE name=?',[name]).name,name);
 db.run("INSERT INTO mail_accounts VALUES('a','owner','gmail','a'),('b','owner','gmail','b')");const digest='0'.repeat(64);for(const id of ['a','b'])db.run('INSERT INTO mail_content_refs VALUES(?,?,1,?)',[id,'ref',digest]);db.run("INSERT INTO mail_filing_snapshots VALUES('snapshot','a','provider-message','{}',?,0)",[digest]);assert.throws(()=>db.run("INSERT INTO mail_filing_parts VALUES('snapshot',0,'b','ref','original','{}',1,?)",[digest]));db.run("INSERT INTO mail_filing_parts VALUES('snapshot',0,'a','ref','original','{}',1,?)",[digest]);assert.throws(()=>db.run("DELETE FROM mail_content_refs WHERE account_id='a'"));assert.throws(()=>db.run("DELETE FROM mail_accounts WHERE id='a'"));assert.equal(db.get("SELECT count(*) n FROM mail_filing_parts").n,1);
 db.run("INSERT INTO mail_storage_saves VALUES('save','snapshot','workspace','connection','revision','','[0]','queued','generation',1,NULL,0,0)");
 db.run("INSERT INTO mail_storage_save_parts VALUES('save',0,0,'Original.eml',1,?,'message/rfc822','queued',NULL)",[digest]);
 assert.throws(()=>db.run("DELETE FROM mail_filing_snapshots WHERE id='snapshot'"));
 db.close();db=await openEncryptedMailDatabase({path,key});assert.equal(db.get("SELECT state FROM mail_storage_saves WHERE id='save'").state,'queued');
 }finally{db.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
});
