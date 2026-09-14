/** Isolated synthetic native-module evaluation. Install dependencies in a temporary directory. */
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const [dependencyRoot, engine, mode, existingPath] = process.argv.slice(2);
assert.ok(dependencyRoot, 'Pass isolated dependency directory');
assert.ok(['journey','multiple'].includes(engine), 'Pass journey or multiple');
const require = createRequire(join(resolve(dependencyRoot), 'package.json'));
const marker = 'syntheticconfidentialmail987654321';
const attachment = Buffer.from(`syntheticattachment987654321\0\xff`);
// Deliberately synthetic public fixture password, never a user secret.
const password = 'synthetic-evaluation-key-only';
async function open(path, key) {
  let api;
  if (engine === 'journey') {
    const sqlite = require('@journeyapps/sqlcipher');
    const db = await new Promise((resolveDb,reject) => {
      const instance = new sqlite.Database(path, error => error ? reject(error) : resolveDb(instance));
    });
    api = {
      exec: sql => new Promise((resolveRun,reject) => db.exec(sql, error => error ? reject(error) : resolveRun())),
      all: sql => new Promise((resolveRows,reject) => db.all(sql, (error,rows) => error ? reject(error) : resolveRows(rows))),
      close: () => new Promise((resolveClose,reject) => db.close(error => error ? reject(error) : resolveClose())),
    };
  } else {
    const Database = require('better-sqlite3-multiple-ciphers');
    const db = new Database(path);
    api = { exec: async sql => db.exec(sql), all: async sql => db.prepare(sql).all(), close: async () => db.close() };
    // Explicit SQLCipher algorithm in Multiple Ciphers native format; not the default sqleet cipher.
    await api.exec("PRAGMA cipher='sqlcipher'; PRAGMA legacy=0;");
    assert.deepEqual(await api.all('PRAGMA cipher'), [{ sqlcipher: 'sqlcipher' }]);
  }
  if (key !== undefined) await api.exec(`PRAGMA key='${key.replaceAll("'", "''")}';`);
  return api;
}
async function verify(path) {
  const db = await open(path,password);
  try {
    assert.deepEqual(await db.all(`SELECT body FROM mail WHERE mail MATCH '${marker}'`), [{ body: marker }]);
    const rows = await db.all('SELECT hex(bytes) AS bytes FROM attachments');
    assert.equal(rows[0].bytes, attachment.toString('hex').toUpperCase());
    assert.deepEqual(await db.all('PRAGMA integrity_check'), [{ integrity_check: 'ok' }]);
  } finally { await db.close(); }
}
if (mode === 'reopen') {
  await verify(existingPath);
  console.log('fresh-process-reopen: PASS');
} else {
  const dir = mkdtempSync(join(tmpdir(),'legalwork-encrypted-fixture-'));
  const path = join(dir,'mail.sqlite');
  try {
    const db = await open(path,password);
    let identity;
    try {
      const cipher = engine === 'journey' ? await db.all('PRAGMA cipher_version') : [];
      const sqlite = await db.all('SELECT sqlite_version() AS version');
      const options = await db.all('PRAGMA compile_options');
      if (engine === 'journey') assert.ok(typeof cipher[0]?.cipher_version === 'string' && cipher[0].cipher_version.length > 0);
      const multiple = engine === 'multiple' ? await db.all('SELECT sqlite3mc_version() AS version') : [];
      identity = { runtime: { node: process.versions.node, bun: process.versions.bun, electron: process.versions.electron, napi: process.versions.napi }, cipher, sqlite, multiple, tempCompile: options.filter(row => String(row.compile_options).includes('TEMP_STORE')) };
      await db.exec(`PRAGMA temp_store=MEMORY; PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0;
        CREATE VIRTUAL TABLE mail USING fts5(body); CREATE TABLE attachments(bytes BLOB);
        BEGIN IMMEDIATE; INSERT INTO mail VALUES ('${marker}'); INSERT INTO attachments VALUES (X'${attachment.toString('hex')}'); COMMIT;`);
      assert.deepEqual(await db.all('PRAGMA temp_store'), [{ temp_store: 2 }]);
      assert.deepEqual(await db.all(`SELECT body FROM mail WHERE mail MATCH '${marker}'`), [{ body: marker }]);
      // Scan while open so committed pages remain in the WAL.
      for (const filename of [path,`${path}-wal`]) {
        const bytes = readFileSync(filename);
        assert.ok(bytes.length > 0);
        assert.ok(!bytes.includes(Buffer.from(marker)), `${filename}: body plaintext`);
        assert.ok(!bytes.includes(attachment), `${filename}: attachment plaintext`);
        assert.notEqual(bytes.subarray(0,16).toString(), 'SQLite format 3\0');
      }
    } finally { await db.close(); }
    for (const key of [undefined,'wrong-synthetic-key']) {
      const bad = await open(path,key);
      try { await assert.rejects(bad.all('SELECT count(*) FROM sqlite_master'), /encrypted|not a database|malformed/i); }
      finally { await bad.close(); }
    }
    const child = spawnSync(process.execPath,[fileURLToPath(import.meta.url),dependencyRoot,engine,'reopen',path], { encoding: 'utf8', timeout: 30_000 });
    assert.equal(child.status,0, child.stderr || child.stdout);
    console.log(JSON.stringify({ engine, identity, tests: 'encrypted DB/WAL marker scans, FTS5, binary bytes, missing/wrong key rejection, fresh-process reopen, integrity_check: PASS' }, null, 2));
  } finally { rmSync(dir,{ recursive:true,force:true }); }
}
