/** Bounded synthetic probes for final Windows failures; never opens a user profile. */
import {mkdtemp,mkdir,open,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join,toNamespacedPath} from 'node:path';
import {createRequire} from 'node:module';
import {randomBytes} from 'node:crypto';
if(process.platform!=='win32')throw Error('Windows diagnostic only');
const root=await mkdtemp(join(tmpdir(),'mail-storage-diagnostic-'));
const Database=createRequire(new URL('../../apps/server/package.json',import.meta.url))('better-sqlite3-multiple-ciphers');
const key=randomBytes(32);
try {
 for(const mode of ['r','r+']) {
  const path=join(root,`flush-${mode==='r'?'read':'write'}.bin`);await writeFile(path,'synthetic');let handle;
  try{handle=await open(path,mode);await handle.sync();console.log(JSON.stringify({probe:'flush',mode,ok:true}));}
  catch(error){console.log(JSON.stringify({probe:'flush',mode,ok:false,code:error.code??null}));}
  finally{await handle?.close();}
 }
 for(const long of [false,true]) {
  const directory=long?join(root,'x'.repeat(100),'y'.repeat(100),'z'.repeat(60)):root;await mkdir(directory,{recursive:true});
  for(const namespace of [false,true]) {
   const path=join(directory,namespace?'namespace.sqlite':'ordinary.sqlite');await writeFile(path,'');let database;
   try{database=new Database(namespace?toNamespacedPath(path):path,{fileMustExist:true});database.pragma("cipher='sqlcipher'");database.pragma('legacy=0');database.key(key);database.pragma('journal_mode=WAL');database.exec('CREATE TABLE proof(value TEXT); INSERT INTO proof VALUES(\'synthetic\')');console.log(JSON.stringify({probe:'sqlite-path',long,namespace,characters:path.length,ok:database.prepare('SELECT value FROM proof').get().value==='synthetic'}));}
   catch(error){console.log(JSON.stringify({probe:'sqlite-path',long,namespace,characters:path.length,ok:false,code:error.code??null}));}
   finally{database?.close();}
  }
 }
} finally{key.fill(0);await rm(root,{recursive:true,force:true,maxRetries:5,retryDelay:200});}
