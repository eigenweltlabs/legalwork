import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openEncryptedMailDatabase} from './database.js';
import {migrateMailSchema,MAIL_SCHEMA_VERSION} from './schema.js';
import {removeLaterMailSchema} from '../testing/legacy-schema.mjs';
test('schema24 retained filing upgrade atomically and reopen encrypted',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mail-outbox-schema-')),key=randomBytes(32),path=join(dir,'mail.sqlite');let db=await openEncryptedMailDatabase({path,key});
 try{migrateMailSchema(db);removeLaterMailSchema(db,23);db.run('UPDATE mail_schema_version SET version=23');const fail={...db,exec(sql){db.exec(sql);if(sql.includes('CREATE TABLE mail_filing_snapshots('))throw Error('synthetic migration failure');}};assert.throws(()=>migrateMailSchema(fail));assert.equal(db.get('SELECT version FROM mail_schema_version').version,23);assert.equal(db.get("SELECT name FROM sqlite_master WHERE name='mail_filing_snapshots'"),undefined);migrateMailSchema(db);db.close();db=await openEncryptedMailDatabase({path,key});migrateMailSchema(db);assert.equal(db.get('SELECT version FROM mail_schema_version').version,MAIL_SCHEMA_VERSION);for(const name of ['mail_filing_snapshots','mail_filing_parts','mail_matter_filings'])assert.equal(db.get('SELECT name FROM sqlite_master WHERE name=?',[name]).name,name);
 db.run("INSERT INTO mail_accounts VALUES('a','owner','gmail','a'),('b','owner','gmail','b')");const digest='0'.repeat(64);for(const id of ['a','b'])db.run('INSERT INTO mail_content_refs VALUES(?,?,1,?)',[id,'ref',digest]);db.run("INSERT INTO mail_filing_snapshots VALUES('snapshot','a','provider-message','{}',?,0)",[digest]);assert.throws(()=>db.run("INSERT INTO mail_filing_parts VALUES('snapshot',0,'b','ref','original','{}',1,?)",[digest]));db.run("INSERT INTO mail_filing_parts VALUES('snapshot',0,'a','ref','original','{}',1,?)",[digest]);assert.throws(()=>db.run("DELETE FROM mail_content_refs WHERE account_id='a'"));assert.throws(()=>db.run("DELETE FROM mail_accounts WHERE id='a'"));assert.equal(db.get("SELECT count(*) n FROM mail_filing_parts").n,1);
 }finally{db.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
});
