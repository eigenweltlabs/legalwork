// Run only synthetic mail through an existing build, never its normal UI/profile.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { access, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const application = process.argv[2];
if (!application || process.argv.length !== 3 || !['darwin', 'win32'].includes(process.platform)) {
  throw new Error('Usage: node scripts/mail/verify-built-application.mjs <built .app or unpacked application directory>');
}
const directory = resolve(application);
const executable = process.platform === 'darwin' ? join(directory, 'Contents/MacOS/LegalWork')
  : join(directory, 'LegalWork.exe');
const archive = join(directory, process.platform === 'darwin' ? 'Contents/Resources' : 'resources', 'app.asar');
await access(executable); await access(archive);
const root = await mkdtemp(join(tmpdir(), 'mail-built-app-'));
const moduleUrl = name => JSON.stringify(pathToFileURL(join(archive, 'server/dist/mail', name)).href);

function run(entry, input, worker = false) {
  return new Promise((resolveRun, reject) => {
    const env = { ELECTRON_RUN_AS_NODE: '1' };
    for (const name of ['SystemRoot', 'WINDIR']) if (process.env[name]) env[name] = process.env[name];
    const child = spawn(executable, [entry], { cwd: root, env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '', stderr = '', ready = false, failed = false;
    const timer = setTimeout(() => { failed = true; child.kill('SIGKILL'); }, 30_000);
    child.on('error', () => { failed = true; });
    child.stdin.on('error', () => {});
    child.stdout.on('data', bytes => {
      stdout += bytes;
      if (stdout.length > 65536) { failed = true; child.kill('SIGKILL'); return; }
      if (worker && !ready && stdout.includes('"kind":"ready"')) {
        ready = true;
        child.stdin.end([
          { kind: 'request', id: '1:1', command: { operation: 'mail.storage.status' } },
          { kind: 'request', id: '1:2', command: { operation: 'mail.search', input: {} } },
          { kind: 'shutdown' },
        ].map(value => JSON.stringify(value) + '\n').join(''));
      }
    });
    child.stderr.on('data', bytes => {
      stderr += bytes;
      if (stderr.length > 65536) { failed = true; child.kill('SIGKILL'); }
    });
    child.on('close', code => {
      clearTimeout(timer);
      const secrets = [input.encryptionKey, input.sourceKey, input.destinationKey].filter(value => typeof value === 'string');
      if (failed || secrets.some(value => stdout.includes(value) || stderr.includes(value))) {
        reject(new Error('mail_built_application_probe_failed')); return;
      }
      resolveRun({ code, stdout, stderr });
    });
    if (worker) child.stdin.write(JSON.stringify({ kind: 'initialize', protocol: 1, initialization: input }) + '\n');
    else child.stdin.end(JSON.stringify(input));
  });
}

try {
  const inspection = join(root, 'inspection.mjs');
  await writeFile(inspection, `
import { readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { createHash } from 'node:crypto';
import { openEncryptedMailDatabase } from ${moduleUrl('storage/database.js')};
import { projectMime } from ${moduleUrl('mime/project.js')};
const require = createRequire(${moduleUrl('runtime/worker.js')});
const input = JSON.parse(readFileSync(0, 'utf8')), key = Buffer.from(input.encryptionKey, 'base64');
const db = await openEncryptedMailDatabase({ path: input.databasePath, key }); key.fill(0);
try {
  db.exec('CREATE VIRTUAL TABLE IF NOT EXISTS packaging_fts USING fts5(text)');
  if (!db.get('SELECT rowid FROM packaging_fts')) db.run('INSERT INTO packaging_fts(text) VALUES (?)', ['synthetic_packaging_private_marker']);
  const bytes = Buffer.from('Subject: Packaged MIME\\r\\nContent-Type: text/plain; charset=utf-8\\r\\n\\r\\nPrivate body');
  const parsed = await projectMime({ source: [bytes], originalSha256: createHash('sha256').update(bytes).digest('hex'), onAttachment: async () => { throw Error('unexpected'); } });
  console.log(JSON.stringify({ arch: process.arch, electron: process.versions.electron, node: process.versions.node,
    engine: db.get('SELECT sqlite3mc_version() AS v').v, cipher: Object.values(db.get('PRAGMA cipher'))[0],
    count: db.get('SELECT count(*) AS n FROM packaging_fts').n, body: parsed.bodies[0].text,
    module: require.resolve('better-sqlite3-multiple-ciphers'),
    native: require(require.resolve('better-sqlite3-multiple-ciphers').replace(/index\\.js$/, 'binding.js')).getPrebuildPath() }));
} finally { db.close(); }
`);
  const original = { ownerId: 'synthetic-package-owner', databasePath: join(root, 'mail.sqlite'), encryptionKey: randomBytes(32).toString('base64') };
  const entry = join(archive, 'server/dist/mail/runtime/worker.js');
  let evidence;
  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await run(inspection, original);
    assert.equal(result.code, 0, result.stderr);
    evidence = JSON.parse(result.stdout);
    assert.equal(evidence.arch, process.env.MAIL_EXPECT_ARCH ?? process.arch);
    assert.equal(evidence.count, 1); assert.equal(evidence.body, 'Private body');
    assert.equal(evidence.engine, 'SQLite3 Multiple Ciphers 2.4.0'); assert.equal(evidence.cipher, 'sqlcipher');
    assert.ok(evidence.module.startsWith(archive));
    assert.ok(evidence.native.startsWith(archive));
    assert.ok(evidence.native.endsWith(`${process.platform}-${evidence.arch}.node`));
    const worker = await run(entry, original, true);
    assert.equal(worker.code, 0, worker.stderr);
    const frames = worker.stdout.trim().split('\n').map(value => JSON.parse(value));
    assert.equal(frames[0].kind, 'ready'); assert.equal(frames[1].result.encrypted, true);
    assert.equal(frames[2].result.search.total, 0);
  }
  const rotatedDirectory = join(root, 'rotated'); await mkdir(rotatedDirectory, { mode: 0o700 });
  const rotated = { ...original, databasePath: join(rotatedDirectory, 'mail.sqlite'), encryptionKey: randomBytes(32).toString('base64') };
  const rotation = await run(join(archive, 'server/dist/mail/runtime/maintenance-worker.js'), {
    sourcePath: original.databasePath, destinationPath: rotated.databasePath, sourceKey: original.encryptionKey,
    destinationKey: rotated.encryptionKey, ownerId: original.ownerId, restore: false, expectedSha256: null,
  });
  assert.equal(rotation.code, 0, rotation.stderr); assert.equal(JSON.parse(rotation.stdout).ok, true);
  const check = await run(inspection, rotated);
  assert.equal(check.code, 0, check.stderr); assert.equal(JSON.parse(check.stdout).count, 1);
  const wrongKey = await run(entry, { ...rotated, encryptionKey: original.encryptionKey }, true);
  assert.equal(wrongKey.code, 1);
  assert.deepEqual(JSON.parse(wrongKey.stdout), { kind: 'fatal', code: 'initialization_failed' });
  const ciphertext = await readFile(original.databasePath);
  assert.notEqual(ciphertext.subarray(0, 16).toString(), 'SQLite format 3\0');
  assert.equal(ciphertext.includes(Buffer.from('synthetic_packaging_private_marker')), false);
  console.log(JSON.stringify({ passed: true, platform: process.platform, arch: evidence.arch, electron: evidence.electron,
    checks: ['packaged-dependencies', 'MIME', 'encrypted-FTS', 'worker-status-search', 'reopen', 'rotation', 'wrong-key-refusal', 'ciphertext-marker-absence'] }));
} finally { await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); }
