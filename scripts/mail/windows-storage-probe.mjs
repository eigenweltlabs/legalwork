/** Temporary synthetic Node-only probe; do not merge into product branch. */
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,open,rm,writeFile,readFile,realpath} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,toNamespacedPath} from 'node:path';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
assert.equal(process.platform,'win32');
const root=await realpath(await mkdtemp(join(tmpdir(),'mail-storage-probe-')));
const Database=createRequire(join(process.argv[2],'package.json'))('better-sqlite3-multiple-ciphers');
const key=randomBytes(32),results=[];
try {
 for(const mode of ['r','r+']) {
  const path=join(root,mode==='r'?'read.bin':'write.bin');await writeFile(path,'synthetic');let handle;
  try{handle=await open(path,mode);await handle.sync();results.push({probe:'flush',mode,ok:true});}
  catch(error){results.push({probe:'flush',mode,ok:false,code:error.code??null});}
  finally{await handle?.close();}
 }
 for(const long of [false,true]) {
  const directory=long?join(root,"space ü $ apostrophe'",'x'.repeat(100),'y'.repeat(100),'z'.repeat(60)):root;await mkdir(directory,{recursive:true});
  for(const namespace of [false,true]) {
   const path=join(directory,namespace?'namespace.sqlite':'ordinary.sqlite');await writeFile(path,'');let database;
   const nativePath=namespace?toNamespacedPath(path):path;
   try{
    const connect=()=>{const db=new Database(nativePath,{fileMustExist:true});db.pragma("cipher='sqlcipher'");db.pragma('legacy=0');db.key(key);return db;};
    database=connect();assert.equal(database.pragma('journal_mode=WAL',{simple:true}),'wal');
    database.exec("CREATE VIRTUAL TABLE proof USING fts5(value); INSERT INTO proof VALUES('syntheticmailpathmarker')");
    assert.equal(database.prepare('SELECT value FROM proof').get().value,'syntheticmailpathmarker');
    for(const file of [path,path+'-wal'])assert.equal((await readFile(file)).includes(Buffer.from('syntheticmailpathmarker')),false);
    database.close();database=connect();assert.equal(database.prepare("SELECT value FROM proof WHERE proof MATCH 'syntheticmailpathmarker'").get().value,'syntheticmailpathmarker');
    results.push({probe:'sqlite-path',long,namespace,characters:path.length,ok:true});
   }catch(error){results.push({probe:'sqlite-path',long,namespace,characters:path.length,ok:false,code:error.code??null});}
   finally{database?.close();}
  }
 }
 console.log(JSON.stringify({node:process.versions.node,results},null,2));
 assert.equal(results.find(r=>r.probe==='flush'&&r.mode==='r+').ok,true);
 for(const result of results.filter(r=>r.probe==='sqlite-path'&&(!r.long||r.namespace)))assert.equal(result.ok,true,JSON.stringify(result));
}finally{key.fill(0);await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
