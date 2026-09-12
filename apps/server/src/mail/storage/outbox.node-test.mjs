import {test} from 'node:test';
import assert from 'node:assert/strict';
import {randomBytes} from 'node:crypto';
import {mkdtemp,rm} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {openEncryptedMailDatabase} from './database.js';
import {migrateMailSchema,MAIL_SCHEMA_VERSION} from './schema.js';
import {removeLaterMailSchema} from '../testing/legacy-schema.mjs';
test('schema21 outbox and SMTP custody upgrade atomically and reopen encrypted',async()=>{
 const dir=await mkdtemp(join(tmpdir(),'mail-outbox-schema-')),key=randomBytes(32),path=join(dir,'mail.sqlite');let db=await openEncryptedMailDatabase({path,key});
 try{migrateMailSchema(db);removeLaterMailSchema(db,20);db.run('UPDATE mail_schema_version SET version=20');const fail={...db,exec(sql){db.exec(sql);if(sql.includes('CREATE TABLE mail_outbox('))throw Error('synthetic migration failure');}};assert.throws(()=>migrateMailSchema(fail));assert.equal(db.get('SELECT version FROM mail_schema_version').version,20);assert.equal(db.get("SELECT name FROM sqlite_master WHERE name='mail_smtp_credentials'"),undefined);migrateMailSchema(db);db.close();db=await openEncryptedMailDatabase({path,key});migrateMailSchema(db);assert.equal(db.get('SELECT version FROM mail_schema_version').version,MAIL_SCHEMA_VERSION);for(const name of ['mail_outbox','mail_outbox_attempts','mail_smtp_credentials'])assert.equal(db.get('SELECT name FROM sqlite_master WHERE name=?',[name]).name,name);
 }finally{db.close();key.fill(0);await rm(dir,{recursive:true,force:true});}
});
