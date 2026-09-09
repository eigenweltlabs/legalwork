/** Run in Node, never Bun: the native module deliberately rejects Bun. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile, mkdir, copyFile, chmod, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { DatabaseSync } from 'node:sqlite';
import { openEncryptedMailDatabase } from './database.ts';
const moduleUrl = new URL('./database.ts', import.meta.url).href;
const privateKey = () => randomBytes(32);
async function fixture(body) {
  const dir = await mkdtemp(join(tmpdir(),'legalwork-mail-database-test-'));
  try { await body(join(dir,'private','mail.sqlite'),dir); }
  finally { await rm(dir,{ recursive:true, force:true }); }
}

test('requires exactly 32 bytes and an absolute filesystem path before creating files', async () => fixture(async path => {
  for (const key of [new Uint8Array(0),new Uint8Array(31),new Uint8Array(33),undefined]) {
    await assert.rejects(openEncryptedMailDatabase({ path,key }), /32-byte/);
  }
  for (const invalid of ['',':memory:','relative.sqlite','file:mail.sqlite',`${path}\0`]) {
    await assert.rejects(openEncryptedMailDatabase({ path:invalid,key:privateKey() }), /filesystem path/);
  }
  await assert.rejects(stat(path), { code:'ENOENT' });
}));

test('encrypted FTS and bytes survive a fresh process; DB/WAL are private and contain no markers', async () => fixture(async (path,dir) => {
  const key = privateKey();
  const marker = `syntheticmail${randomBytes(16).toString('hex')}`;
  const bytes = randomBytes(80);
  const db = await openEncryptedMailDatabase({ path,key });
  try {
    db.exec('PRAGMA wal_autocheckpoint=0; CREATE VIRTUAL TABLE mail USING fts5(body); CREATE TABLE blobs(bytes BLOB)');
    db.transaction(() => { db.run('INSERT INTO mail VALUES (?)',[marker]); db.run('INSERT INTO blobs VALUES (?)',[new Uint8Array(bytes)]); });
    assert.deepEqual(db.get('SELECT body FROM mail WHERE mail MATCH ?',[marker]), { body:marker });
    assert.deepEqual(Buffer.from(db.get('SELECT bytes FROM blobs').bytes),bytes);
    assert.deepEqual(db.get('PRAGMA temp_store'), { temp_store:2 });
    for (const filename of [path,`${path}-wal`,`${path}-shm`]) {
      if (process.platform !== 'win32') assert.equal((await stat(filename)).mode & 0o777,0o600);
    }
    if (process.platform !== 'win32') assert.equal((await stat(join(dir,'private'))).mode & 0o777,0o700);
    for (const filename of [path,`${path}-wal`]) {
      const file = await readFile(filename);
      assert.ok(file.length > 0);
      assert.notEqual(file.subarray(0,16).toString(),'SQLite format 3\0');
      assert.ok(!file.includes(Buffer.from(marker)));
      assert.ok(!file.includes(bytes));
    }
  } finally { db.close(); }
  // The key is only transmitted through stdin, never argv/environment or disk.
  const child = spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`
    import {readFileSync} from 'node:fs';
    import {openEncryptedMailDatabase} from ${JSON.stringify(moduleUrl)};
    const input=JSON.parse(readFileSync(0,'utf8'));
    const db=await openEncryptedMailDatabase({path:input.path,key:Buffer.from(input.key,'base64')});
    console.log(JSON.stringify(db.get('SELECT body FROM mail WHERE mail MATCH ?',[input.marker])));
    db.close();
  `], { input:JSON.stringify({path,key:key.toString('base64'),marker}),encoding:'utf8',timeout:20_000 });
  assert.equal(child.status,0,child.stderr);
  assert.deepEqual(JSON.parse(child.stdout),{body:marker});
}));

test('wrong key leaves an existing encrypted database byte-identical and readable', async () => fixture(async path => {
  const key=privateKey();
  const db=await openEncryptedMailDatabase({path,key});
  db.exec('CREATE TABLE durable(v); INSERT INTO durable VALUES (42)');
  db.close();
  const before=await readFile(path);
  await assert.rejects(openEncryptedMailDatabase({path,key:privateKey()}));
  assert.deepEqual(await readFile(path),before);
  const reopened=await openEncryptedMailDatabase({path,key});
  try { assert.deepEqual(reopened.get('SELECT v FROM durable'),{v:42}); } finally { reopened.close(); }
}));

test('plaintext database is rejected without encrypting, truncating or migrating it', async () => fixture(async path => {
  await mkdir(join(path,'..'),{recursive:true,mode:0o700});
  const plain=new DatabaseSync(path);
  plain.exec('CREATE TABLE source(v); INSERT INTO source VALUES (123)');
  plain.close();
  await chmod(path,0o600);
  const before=await readFile(path);
  await assert.rejects(openEncryptedMailDatabase({path,key:privateKey()}));
  assert.deepEqual(await readFile(path),before);
}));

test('rollback, nested savepoints, synchronous return values and thenable rejection', async () => fixture(async path => {
  const db=await openEncryptedMailDatabase({path,key:privateKey()});
  try {
    db.exec('CREATE TABLE tx(v INTEGER)');
    assert.throws(() => db.transaction(() => { db.run('INSERT INTO tx VALUES (?)',[1]); throw new Error('injected'); }),/injected/);
    assert.deepEqual(db.all('SELECT * FROM tx'),[]);
    assert.equal(db.transaction(() => {
      db.run('INSERT INTO tx VALUES (?)',[2]);
      assert.throws(() => db.transaction(() => { db.run('INSERT INTO tx VALUES (?)',[3]); throw new Error('nested'); }),/nested/);
      return 42;
    }),42);
    assert.throws(() => db.transaction(() => { db.run('INSERT INTO tx VALUES (?)',[4]); return {then() {}}; }),/thenable/);
    assert.throws(() => db.transaction(() => { db.run('INSERT INTO tx VALUES (?)',[6]); return Promise.reject(new Error('async misuse')); }),/thenable/);
    let invoked=false;
    assert.throws(() => db.transaction(async () => { invoked=true; db.run('INSERT INTO tx VALUES (?)',[5]); }),/synchronous/);
    assert.equal(invoked,false);
    assert.deepEqual(db.all('SELECT * FROM tx'),[{v:2}]);
    assert.equal(db.get('SELECT * FROM tx WHERE v=99'),undefined);
    assert.deepEqual(db.get('SELECT NULL AS nil, ? AS text, ? AS real',["ä",1.5]),{nil:null,text:'ä',real:1.5});
    assert.throws(() => db.get('SELECT 9223372036854775807 AS huge'),/safe numeric range/);
  } finally { db.close(); }
}));

test('rejects symlinks and insecure existing file permissions', async () => fixture(async (path,dir) => {
  await mkdir(join(dir,'private'),{mode:0o700});
  const target=join(dir,'target');
  await writeFile(target,'unchanged',{mode:0o600});
  await symlink(target,path);
  await assert.rejects(openEncryptedMailDatabase({path,key:privateKey()}),/regular/);
  assert.equal(await readFile(target,'utf8'),'unchanged');
  await rm(path);
  await writeFile(path,'',{mode:0o600});
  if(process.platform !== 'win32') {
    await chmod(path,0o644);
    await assert.rejects(openEncryptedMailDatabase({path,key:privateKey()}),/privately owned/);
  }
}));

test('rejects Bun before native loading or filesystem changes', async () => fixture(async path => {
  const child=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`
    Object.defineProperty(process.versions,'bun',{value:'simulated'});
    const {openEncryptedMailDatabase}=await import(${JSON.stringify(moduleUrl)});
    try { await openEncryptedMailDatabase({path:process.argv[1],key:new Uint8Array(32)});process.exitCode=1; }
    catch(error) { if(!error.message.includes('Node/Electron worker')) throw error; }
  `,path],{encoding:'utf8',timeout:10_000});
  assert.equal(child.status,0,child.stderr);
  await assert.rejects(stat(path),{code:'ENOENT'});
}));

test('actual Bun runtime refuses the adapter without loading the native addon', async () => fixture(async path => {
  const child=spawnSync('bun',['-e',`
    const {openEncryptedMailDatabase}=await import(${JSON.stringify(moduleUrl)});
    try {await openEncryptedMailDatabase({path:process.argv[1],key:new Uint8Array(32)});process.exitCode=1;}
    catch(error){if(!error.message.includes('Node/Electron worker'))throw error;}
  `,path],{encoding:'utf8',timeout:10_000});
  assert.equal(child.status,0,child.stderr);
  await assert.rejects(stat(path),{code:'ENOENT'});
}));

test('rejects unknown/plaintext native modules before creating a target file', async () => fixture(async (path,dir) => {
  const moduleDir=join(dir,'node_modules','better-sqlite3-multiple-ciphers');
  await mkdir(moduleDir,{recursive:true});
  await writeFile(join(dir,'package.json'),'{"type":"module"}');
  await copyFile(fileURLToPath(new URL('./database.ts',import.meta.url)),join(dir,'database.ts'));
  await writeFile(join(moduleDir,'package.json'),'{"main":"index.cjs"}');
  for(const implementation of [
    `module.exports={};`,
    `module.exports=class { prepare(){return {get(){return {engine:'stock SQLite',sqlite:'3.53.4'}}}} close(){} };`,
  ]) {
    await writeFile(join(moduleDir,'index.cjs'),implementation);
    const child=spawnSync(process.execPath,['--experimental-strip-types','--input-type=module','-e',`
      import {openEncryptedMailDatabase} from ${JSON.stringify(pathToFileURL(join(dir,'database.ts')).href)};
      try {await openEncryptedMailDatabase({path:process.argv[1],key:new Uint8Array(32)});process.exitCode=1;}
      catch(error){if(!/Invalid encrypted|Unsupported encrypted/.test(error.message))throw error;}
    `,path],{encoding:'utf8',timeout:10_000});
    assert.equal(child.status,0,child.stderr);
    await assert.rejects(stat(path),{code:'ENOENT'});
  }
}));
