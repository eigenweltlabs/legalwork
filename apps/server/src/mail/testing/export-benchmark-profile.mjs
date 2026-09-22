/** Publish only a generator-verified synthetic profile; never copy a directory tree. */
import assert from 'node:assert/strict';
import {readFile,mkdir,copyFile,writeFile} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {createHash} from 'node:crypto';
import {openEncryptedMailDatabase} from '../storage/database.js';
import {MailContentStore} from '../storage/content-store.js';
import {benchmarkMessage,CORPUS_VERSION} from './large-mailbox-corpus.mjs';
const source=resolve(process.argv[2]),destination=resolve(process.argv[3]);
const metadata=JSON.parse(await readFile(join(source,'benchmark-profile.json'),'utf8'));
assert.equal(metadata.kind,'legalwork-synthetic-benchmark');assert.equal(metadata.count,100000);
const report=JSON.parse(await readFile(resolve(source,metadata.report),'utf8'));
assert.equal(report.corpus.version,CORPUS_VERSION);
assert.equal(report.corpus.sha256,'698fa2c64e3b253dd75455e748f83fc02b29fd6214988a7c6818c119f4d85425');
const ownerId=metadata.ownerId??'benchmark';assert(['benchmark','desktop-local'].includes(ownerId));
const databasePath=join(source,metadata.database??'mail.sqlite');
const key=Buffer.from(metadata.key,'base64'),db=await openEncryptedMailDatabase({path:databasePath,key});
try{
 assert.deepEqual(db.all('SELECT id,owner_id FROM mail_accounts ORDER BY id'),['benchmark-a','benchmark-b','benchmark-c'].map(id=>({id,owner_id:ownerId})));
 assert.equal(db.get('SELECT count(*) n FROM mail_messages').n,100000);
 assert.equal(db.get('SELECT count(*) n FROM mail_search_dirty').n,0);
 for(const {name} of db.all("SELECT name FROM sqlite_master WHERE type='table' AND (name LIKE '%credentials%' OR name LIKE '%oauth%')")){
  assert.match(name,/^[a-z_]+$/);assert.equal(db.get(`SELECT count(*) n FROM ${name}`).n,0,`Credential table must be empty: ${name}`);
 }
 const content=new MailContentStore(db,ownerId),hash=createHash('sha256');
 for(let i=0;i<100000;i++){
  const expected=benchmarkMessage(i),messageKey=JSON.stringify(['gmail',expected.locator.messageId]);
  const part=db.get("SELECT ref_id FROM mail_content_manifests WHERE account_id=? AND message_key=? AND kind='raw' AND state='stored'",[expected.accountId,messageKey]);assert(part);
  const actual=createHash('sha256');for(const bytes of content.read(expected.accountId,part.ref_id))actual.update(bytes);
  assert.equal(actual.digest('hex'),expected.hash,`Synthetic original ${i}`);hash.update(expected.hash);
 }
 assert.equal(hash.digest('hex'),report.corpus.sha256);db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
}finally{db.close();key.fill(0);}
await mkdir(destination,{recursive:false});
await copyFile(databasePath,join(destination,'mail.sqlite'));
await writeFile(join(destination,'baseline.json'),JSON.stringify(report,null,2)+'\n');
await writeFile(join(destination,'benchmark-profile.json'),JSON.stringify({kind:metadata.kind,count:metadata.count,ownerId,key:metadata.key,report:'baseline.json',corpusVersion:CORPUS_VERSION,corpusSha256:report.corpus.sha256,syntheticOnly:true,originalsVerified:100000,disposableTestKey:true})+'\n',{mode:0o600});
console.log('Exported exactly one generator-verified synthetic profile; 100000 original hashes and empty credential tables verified.');
