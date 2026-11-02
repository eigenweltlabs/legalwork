import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath, stat, symlink } from 'node:fs/promises';
import { join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { openEncryptedMailDatabase } from '../storage/database.js';
import { migrateMailSchema } from '../storage/schema.js';
import { MailRepository } from '../storage/repository.js';
import { MailContentStore } from '../storage/content-store.js';
import { MailCredentialRepository } from '../storage/credentials.js';
import { benchmarkMessage, CORPUS_VERSION } from './large-mailbox-corpus.mjs';
import { exportBenchmarkProfile, fileHash } from './export-benchmark-profile.mjs';
import { copyBenchmarkCheckpoint } from './benchmark-checkpoint-input.mjs';
import { benchmarkRetention, runBenchmarkProcess } from './benchmark-process.mjs';

async function fixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'mail-checkpoint-test-'));
  const source = join(directory, 'source'), path = join(source, 'mail.sqlite'), key = randomBytes(32);
  await mkdir(source, { mode: 0o700 });
  async function change(update) {
    const db = await openEncryptedMailDatabase({ path, key });
    try { return await update(db); } finally { db.close(); }
  }
  try {
    await change(async db => {
      migrateMailSchema(db);
      const repo = new MailRepository(db, 'desktop-local'), content = new MailContentStore(db, 'desktop-local');
      for (const id of ['benchmark-a', 'benchmark-b', 'benchmark-c']) {
        repo.createAccount({ id, provider: 'gmail', displayName: 'Synthetic benchmark' });
        for (const folder of ['INBOX', 'UNREAD', 'Contracts', 'Archive/2001/Mandate/Verträge']) repo.putFolder(id, { id: folder, name: folder, kind: 'label' });
      }
      for (let index = 0; index < 100; index++) {
        const item = benchmarkMessage(index);
        repo.ingestMessage(item.accountId, { locator: item.locator, rfcMessageId: null, subject: '', memberships: item.memberships });
        const chunks = Array.from({ length: Math.ceil(item.raw.length / 65536) }, (_, part) => item.raw.subarray(part * 65536, (part + 1) * 65536));
        await content.writePart(item.accountId, item.locator, { kind: 'raw', maxBytes: item.raw.length }, chunks);
      }
    });
    await writeFile(join(source, 'benchmark-profile.json'), JSON.stringify({ kind: 'legalwork-synthetic-benchmark', count: 100,
      ownerId: 'desktop-local', database: 'mail.sqlite', key: key.toString('base64'), report: join(directory, 'missing.json'), sourceSha256: 'a'.repeat(64) }), { mode: 0o600 });
    await run({ source, path, key, change, destination: name => join(directory, name) });
  } finally { key.fill(0); await rm(directory, { recursive: true, force: true }); }
}

test('checkpoint preserves encrypted verified originals without claiming complete indexing or a baseline result', () => fixture(async f => {
  const destination = f.destination('checkpoint');
  const result = await exportBenchmarkProfile({ source: f.source, destination, checkpoint: true });
  assert.equal(result.kind, 'legalwork-synthetic-benchmark-checkpoint');
  assert.equal(result.measurementState, 'incomplete'); assert.equal(result.report, null);
  assert.equal(result.originalsVerified, 100); assert.equal(result.coverage.indexed, 0); assert.equal(result.coverage.body, 0);
  assert.equal(result.sourceSha256, 'a'.repeat(64));
  assert.deepEqual((await readdir(destination)).sort(), ['benchmark-profile.json', 'mail.sqlite']);
  const bytes = await readFile(join(destination, 'mail.sqlite'));
  assert.notEqual(bytes.subarray(0, 16).toString(), 'SQLite format 3\u0000');
  assert.equal(createHash('sha256').update(bytes).digest('hex'), result.databaseSha256);
  const copied = await openEncryptedMailDatabase({ path: join(destination, 'mail.sqlite'), key: f.key });
  try { assert.equal(copied.get('SELECT count(*) n FROM mail_messages').n, 100); } finally { copied.close(); }
  await f.change(db => new MailRepository(db, 'desktop-local').createAccount({ id: 'later', provider: 'gmail', displayName: 'Later synthetic change' }));
  const frozen = await openEncryptedMailDatabase({ path: join(destination, 'mail.sqlite'), key: f.key });
  try { assert.equal(frozen.get('SELECT count(*) n FROM mail_accounts').n, 3); } finally { frozen.close(); }
}));

test('completed export, foreign accounts, credentials and altered originals cannot bypass the verification gate', () => fixture(async f => {
  const destination = f.destination('rejected'), capture = () => exportBenchmarkProfile({ source: f.source, destination, checkpoint: true });
  await assert.rejects(exportBenchmarkProfile({ source: f.source, destination: join(f.source, 'inside'), checkpoint: true }), /outside the source profile/);
  if (process.platform === 'win32') await assert.rejects(exportBenchmarkProfile({ source: f.source, destination: join(f.source.toUpperCase(), 'inside'), checkpoint: true }), /outside the source profile/);
  await assert.rejects(exportBenchmarkProfile({ source: f.source, destination }), /requires 100000/);
  const metadataPath = join(f.source, 'benchmark-profile.json'), originalMetadata = await readFile(metadataPath);
  const metadata = JSON.parse(originalMetadata.toString('utf8')), forgedReport = f.destination('forged-baseline.json');
  await writeFile(forgedReport, JSON.stringify({ corpus: { version: CORPUS_VERSION, count: 100000,
    sha256: '698fa2c64e3b253dd75455e748f83fc02b29fd6214988a7c6818c119f4d85425', coverage: { indexed: 100000, dirty: 0 } } }));
  await writeFile(metadataPath, JSON.stringify({ ...metadata, count: 100000, report: forgedReport }));
  await assert.rejects(exportBenchmarkProfile({ source: f.source, destination }), /Incomplete original inventory/);
  await writeFile(metadataPath, JSON.stringify({ ...metadata, database: '../mail.sqlite' }));
  await assert.rejects(capture(), /Invalid synthetic database path/);
  await writeFile(metadataPath, originalMetadata);
  await f.change(db => new MailRepository(db, 'desktop-local').createAccount({ id: 'foreign', provider: 'gmail', displayName: 'Not the generator' }));
  await assert.rejects(capture());
  await f.change(db => { db.run("DELETE FROM mail_accounts WHERE id='foreign'"); new MailCredentialRepository(db, 'desktop-local').connect('benchmark-a',
    { provider: 'gmail', clientId: 'synthetic.apps.googleusercontent.com', authority: 'https://accounts.google.com', providerSubject: 'synthetic' }, null,
    { accessToken: 'synthetic-only', expiresAt: Date.now() + 60000, grantedScopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify'], refreshToken: { action: 'replace', value: 'synthetic-only' } }); });
  await assert.rejects(capture(), /credentials must be empty/);
  await f.change(async db => { db.run('DELETE FROM mail_account_credentials'); const item = benchmarkMessage(1);
    await new MailContentStore(db, 'desktop-local').writePart(item.accountId, item.locator, { kind: 'raw', maxBytes: 64 }, [Buffer.from('Altered synthetic original')]); });
  await assert.rejects(capture(), /Synthetic original 1/);
  await assert.rejects(readFile(join(destination, 'benchmark-profile.json')), { code: 'ENOENT' });
}));

test('a live WAL reader fences checkpoint copying and existing output is never overwritten', () => fixture(async f => {
  const destination = f.destination('checkpoint'), held = await openEncryptedMailDatabase({ path: f.path, key: f.key });
  held.exec('BEGIN'); held.get('SELECT count(*) FROM mail_messages');
  try { await assert.rejects(exportBenchmarkProfile({ source: f.source, destination, checkpoint: true })); }
  finally { held.exec('ROLLBACK'); held.close(); }
  await assert.rejects(readFile(join(destination, 'mail.sqlite')), { code: 'ENOENT' });
  await exportBenchmarkProfile({ source: f.source, destination, checkpoint: true });
  const original = await readFile(join(destination, 'benchmark-profile.json'));
  await assert.rejects(exportBenchmarkProfile({ source: f.source, destination, checkpoint: true }), { code: 'EEXIST' });
  assert.deepEqual(await readFile(join(destination, 'benchmark-profile.json')), original);
}));

test('checkpoint input copying preserves the frozen source and rejects changed bytes, journals and forged metadata', () => fixture(async f => {
  const source = f.destination('checkpoint'), destination = f.destination('copy.sqlite');
  const metadata = await exportBenchmarkProfile({ source: f.source, destination: source, checkpoint: true });
  const database = join(source, 'mail.sqlite'), metadataPath = join(source, 'benchmark-profile.json');
  const before = await stat(database), originalMetadata = await readFile(metadataPath), originalDatabase = await readFile(database);
  const input = await copyBenchmarkCheckpoint({ source, destination });
  assert.equal(input.count, 100); assert.equal(input.ownerId, 'desktop-local');
  assert.equal(input.origin.databaseSha256, metadata.databaseSha256);
  assert.equal(input.origin.corpusSha256, metadata.corpusSha256);
  const copy = await openEncryptedMailDatabase({ path: destination, key: f.key });
  try { copy.run("DELETE FROM mail_search_dirty"); } finally { copy.close(); }
  assert.equal(await fileHash(database), metadata.databaseSha256); assert.equal((await stat(database)).mtimeMs, before.mtimeMs);
  assert.deepEqual(await readFile(metadataPath), originalMetadata);
  const preserved = await fileHash(destination);
  await assert.rejects(copyBenchmarkCheckpoint({ source, destination }), { code: 'EEXIST' });
  assert.equal(await fileHash(destination), preserved);
  await assert.rejects(copyBenchmarkCheckpoint({ source, destination: join(source, 'inside.sqlite') }), /outside the source profile/);
  const alias = f.destination('checkpoint-alias');
  await symlink(source, alias, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(copyBenchmarkCheckpoint({ source, destination: join(alias, 'inside.sqlite') }), /outside the source profile/);
  await writeFile(database + '-wal', 'live');
  await assert.rejects(copyBenchmarkCheckpoint({ source, destination: f.destination('rejected.sqlite') }), /without journal sidecars/);
  await rm(database + '-wal');
  await writeFile(database, Buffer.concat([originalDatabase, Buffer.from('changed')]));
  await assert.rejects(copyBenchmarkCheckpoint({ source, destination: f.destination('rejected.sqlite') }), /file hash mismatch/);
  await writeFile(database, originalDatabase);
  for (const change of [{ kind: 'legalwork-synthetic-benchmark' }, { report: 'baseline.json' }, { database: '../mail.sqlite' },
    { originalsVerified: 99 }, { disposableTestKey: false }, { sourceSha256: 'unknown' }, { key: 'bad' }]) {
    await writeFile(metadataPath, JSON.stringify({ ...metadata, ...change }));
    await assert.rejects(copyBenchmarkCheckpoint({ source, destination: f.destination('rejected.sqlite') }));
  }
  await assert.rejects(readFile(f.destination('rejected.sqlite')), { code: 'ENOENT' });
}));

test('checkpoint export executes through a real command-line path alias', () => fixture(async f => {
  const alias = f.destination('exporter-alias'), destination = f.destination('cli-checkpoint');
  await symlink(dirname(fileURLToPath(new URL('./export-benchmark-profile.mjs', import.meta.url))), alias, process.platform === 'win32' ? 'junction' : 'dir');
  let output = '';
  const code = await new Promise((done, reject) => {
    const child = spawn(process.execPath, [join(alias, 'export-benchmark-profile.mjs'), '--checkpoint', f.source, destination], { stdio: ['ignore', 'pipe', 'pipe'] });
    child.stdout.on('data', bytes => { output += bytes; }); child.stderr.on('data', bytes => { output += bytes; });
    child.once('error', reject); child.once('close', done);
  });
  assert.equal(code, 0, output);
  assert.equal(JSON.parse(output).kind, 'legalwork-synthetic-benchmark-checkpoint');
  const metadata = JSON.parse(await readFile(join(destination, 'benchmark-profile.json'), 'utf8'));
  assert.equal(metadata.originalsVerified, 100); assert.equal(metadata.report, null);
}));

test('retention budgets require an explicit destination and reject invalid or unbounded settings', () => {
  assert.equal(benchmarkRetention({}), null);
  assert.deepEqual(benchmarkRetention({ LEGALWORK_MAIL_BENCH_BUDGET_MS: '500', LEGALWORK_MAIL_BENCH_CHECKPOINT_DIR: 'synthetic' }), { budgetMs: 500, destination: 'synthetic' });
  for (const budget of ['0', '-1', 'NaN', '1.5', '86400001']) assert.throws(() => benchmarkRetention({ LEGALWORK_MAIL_BENCH_BUDGET_MS: budget, LEGALWORK_MAIL_BENCH_CHECKPOINT_DIR: 'synthetic' }));
  assert.throws(() => benchmarkRetention({ LEGALWORK_MAIL_BENCH_BUDGET_MS: '500' }));
  assert.throws(() => benchmarkRetention({ LEGALWORK_MAIL_BENCH_CHECKPOINT_DIR: 'synthetic' }));
});

async function processFixture(run) {
  const directory = await mkdtemp(join(tmpdir(), 'mail-benchmark-process-'));
  try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
}

for (const failure of [false, true]) test('worker ' + (failure ? 'failure' : 'result') + ' settles after actual process exit', () => processFixture(async directory => {
  const file = join(directory, 'child.mjs'), marker = join(directory, 'closed');
  await writeFile(file, "import{writeFileSync}from'node:fs';process.once('message',config=>{process.send({kind:'progress',phase:'synthetic',completed:1});process.send(" +
    JSON.stringify(failure ? { kind: 'failure', error: 'synthetic failure' } : { kind: 'result', result: { synthetic: true } }) + ");setTimeout(()=>{writeFileSync(config.marker,'closed');process.exit(" + (failure ? '1' : '0') + ")},60)});");
  const progress = [], pending = runBenchmarkProcess({ file, config: { marker }, budgetMs: 5000, onProgress: item => progress.push(item) });
  if (failure) await assert.rejects(pending, /synthetic failure/);
  else assert.deepEqual(await pending, { synthetic: true });
  assert.equal(await readFile(marker, 'utf8'), 'closed');
  assert.equal(progress.length, 1);
}));

test('foreground pings wait for worker readiness instead of losing the first ping during setup', () => processFixture(async directory => {
  const file = join(directory, 'child.mjs'), foreground = [];
  await writeFile(file, "process.once('message',()=>setTimeout(()=>{process.on('message',message=>{if(message.kind==='ping')process.send({kind:'pong',id:message.id,phase:'synthetic',queryMs:1})});process.send({kind:'ready'});setTimeout(()=>process.send({kind:'result',result:{}},()=>process.exit(0)),700)},700));");
  await runBenchmarkProcess({ file, config: {}, budgetMs: 10000, onForeground: item => foreground.push(item) });
  assert(foreground.length > 0); assert.equal(foreground[0].phase, 'synthetic');
  assert(Number.isFinite(foreground[0].ms) && foreground[0].ms >= 0);
}));

test('budget expiry stops the worker process family before returning an incomplete failure', () => processFixture(async directory => {
  const file = join(directory, 'child.mjs'), grandchild = join(directory, 'grandchild.mjs'), marker = join(directory, 'heartbeat'), pidFile = join(directory, 'pid');
  await writeFile(grandchild, "import{writeFileSync}from'node:fs';const tick=()=>writeFileSync(process.argv[2],String(Date.now()));tick();setInterval(tick,10);");
  await writeFile(file, "import{spawn}from'node:child_process';import{writeFileSync}from'node:fs';process.once('message',config=>{const child=spawn(process.execPath,[config.grandchild,config.marker],{stdio:'ignore'});writeFileSync(config.pidFile,String(child.pid));setInterval(()=>{},1000)});");
  try {
    await assert.rejects(runBenchmarkProcess({ file, config: { grandchild, marker, pidFile }, budgetMs: 5000 }), /deadline exceeded/);
    const before = await readFile(marker, 'utf8');
    await new Promise(done => setTimeout(done, 100));
    assert.equal(await readFile(marker, 'utf8'), before, 'Descendant must stop writing before capture');
  } finally {
    const pid = Number(await readFile(pidFile, 'utf8').catch(() => ''));
    if (Number.isSafeInteger(pid) && pid > 0) { try { process.kill(pid, 'SIGKILL'); } catch {} }
  }
}));

test('actual 100-message driver preserves a colliding report and exports an incomplete checkpoint',
  { skip: process.env.LEGALWORK_MAIL_BENCH_CHECKPOINT_SMOKE !== '1' }, () => processFixture(async directory => {
    const report = join(directory, 'baseline.json'), checkpoint = join(directory, 'checkpoint');
    let output = '', profile, planted = false;
    try {
      const code = await new Promise((done, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL('./large-mailbox-benchmark.mjs', import.meta.url)), '100', report], {
          env: { ...process.env, LEGALWORK_MAIL_BENCH_CHILD: '0', LEGALWORK_MAIL_BENCH_OWNER: 'benchmark',
            LEGALWORK_MAIL_BENCH_BUDGET_MS: '90000', LEGALWORK_MAIL_BENCH_CHECKPOINT_DIR: checkpoint },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', bytes => {
          output += bytes;
          const match = output.match(/^Retained isolated synthetic profile: ([^\r\n]+)$/m);
          if (match && !planted) {
            profile = match[1]; writeFileSync(report, 'preserved evidence', { flag: 'wx', mode: 0o600 }); planted = true;
          }
        });
        child.stderr.on('data', bytes => { output += bytes; });
        child.once('error', reject); child.once('close', done);
      });
      assert.equal(code, 1, output.slice(-6000)); assert(planted);
      assert.equal(await readFile(report, 'utf8'), 'preserved evidence');
      const metadata = JSON.parse(await readFile(join(checkpoint, 'benchmark-profile.json'), 'utf8'));
      assert.equal(metadata.kind, 'legalwork-synthetic-benchmark-checkpoint');
      assert.equal(metadata.count, 100); assert.equal(metadata.originalsVerified, 100);
      assert.equal(metadata.measurementState, 'incomplete'); assert.equal(metadata.report, null);
      assert.equal(metadata.sourceSha256, process.env.LEGALWORK_MAIL_BENCH_SOURCE_SHA256 ?? null);
      assert.match(output, /EEXIST/);
      assert.match(output, /"operations":\{"metadata":\{"count":100,/);
      assert.match(output, /"stageMs":\{"ingestion":[0-9]/);
    } finally {
      if (profile && /^legalwork-mail-benchmark-[a-zA-Z0-9]+$/.test(basename(profile)) && await realpath(dirname(profile)) === await realpath(tmpdir()))
        await rm(profile, { recursive: true, force: true });
    }
  }));

test('actual checkpoint resume completes only pending processing on a copy and reports an honest follow-up',
  { skip: process.env.LEGALWORK_MAIL_BENCH_CHECKPOINT_SMOKE !== '1' }, () => fixture(async f => {
    const source = f.destination('checkpoint'), profiles = [];
    const metadata = await exportBenchmarkProfile({ source: f.source, destination: source, checkpoint: true });
    const originalMetadata = await readFile(join(source, 'benchmark-profile.json')), originalState = await stat(join(source, 'mail.sqlite'));
    async function run(input, name) {
      const report = f.destination(name + '.json'); let output = '', profile;
      const code = await new Promise((done, reject) => {
        const child = spawn(process.execPath, [fileURLToPath(new URL('./large-mailbox-benchmark.mjs', import.meta.url)), '--resume', input, report], {
          env: { ...process.env, LEGALWORK_MAIL_BENCH_CHILD: '0', LEGALWORK_MAIL_BENCH_OWNER: 'benchmark',
            LEGALWORK_MAIL_BENCH_BUDGET_MS: '90000', LEGALWORK_MAIL_BENCH_CHECKPOINT_DIR: f.destination(name + '-failure') },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', bytes => {
          output += bytes;
          const match = output.match(/^Retained isolated synthetic profile: ([^\r\n]+)$/m);
          if (match && !profile) { profile = match[1]; profiles.push(profile); }
        });
        child.stderr.on('data', bytes => { output += bytes; });
        child.once('error', reject); child.once('close', done);
      });
      assert.equal(code, 0, output.slice(-6000));
      const result = JSON.parse(await readFile(report, 'utf8'));
      assert.equal(result.baselineKind, 'resumed-checkpoint-follow-up'); assert.equal(result.ingestion, null);
      assert.equal(result.ownerId, 'desktop-local'); assert.equal(result.recovery.originalsVerified, 100);
      assert.equal(result.recovery.operations.metadata.count, 0); assert.equal(result.recovery.operations.rawPublication.count, 0);
      assert.equal(result.corpus.count, 100); assert.equal(result.corpus.coverage.indexed, 100); assert.equal(result.corpus.coverage.dirty, 0);
      assert.equal(result.corpus.coverage.body, 99);
      for (const query of result.quality) assert.equal(query.actual, query.expected, query.name);
      return { result, profile };
    }
    try {
      const first = await run(source, 'resumed');
      assert.equal(first.result.recovery.initialCoverage.body, 0); assert.equal(first.result.recovery.projectedMessages, 100);
      assert.equal(first.result.recovery.skippedProjections, 0); assert.equal(first.result.indexing.processedMessages, 100);
      assert.equal(first.result.recovery.origin.databaseSha256, metadata.databaseSha256);
      assert.equal(first.result.recovery.origin.originalInputSourceSha256, 'a'.repeat(64));
      assert.deepEqual(await readFile(join(source, 'benchmark-profile.json')), originalMetadata);
      assert.equal(await fileHash(join(source, 'mail.sqlite')), metadata.databaseSha256);
      assert.equal((await stat(join(source, 'mail.sqlite'))).mtimeMs, originalState.mtimeMs);
      const complete = f.destination('complete-checkpoint');
      await exportBenchmarkProfile({ source: first.profile, destination: complete, checkpoint: true });
      const second = await run(complete, 'already-complete');
      assert.equal(second.result.recovery.projectedMessages, 0); assert.equal(second.result.recovery.skippedProjections, 100);
      assert.equal(second.result.extraction.processedParts, 0); assert.equal(second.result.extraction.partsPerSecond, 0);
      assert.equal(second.result.indexing.processedMessages, 0); assert.equal(second.result.indexing.messagesPerSecond, 0);
      assert.equal(second.result.recovery.origin.originalInputSourceSha256, 'a'.repeat(64));
      const profileMetadata = JSON.parse(await readFile(join(first.profile, 'benchmark-profile.json'), 'utf8'));
      const interrupted = await openEncryptedMailDatabase({ path: join(first.profile, 'mail/mail.sqlite'), key: f.key });
      try {
        assert.equal(profileMetadata.ownerId, 'desktop-local');
        const messageKey = JSON.stringify(['gmail', 'message-000011']);
        interrupted.run("UPDATE mail_attachment_extractions SET state='running',lease_token='interrupted-test',lease_until=0,attempts=1,result_json=NULL,error=NULL WHERE message_key=?", [messageKey]);
        interrupted.run('INSERT OR IGNORE INTO mail_search_dirty SELECT account_id,message_key FROM mail_messages WHERE message_key=?', [messageKey]);
      } finally { interrupted.close(); }
      const partial = f.destination('interrupted-checkpoint');
      await exportBenchmarkProfile({ source: first.profile, destination: partial, checkpoint: true });
      const third = await run(partial, 'interrupted');
      assert.equal(third.result.recovery.initialCoverage.extractionPending, 1);
      assert.equal(third.result.recovery.initialCoverage.dirty, 1);
      assert.equal(third.result.recovery.projectedMessages, 0); assert.equal(third.result.recovery.skippedProjections, 100);
      assert.equal(third.result.extraction.processedParts, 1); assert.equal(third.result.indexing.processedMessages, 1);
    } finally {
      for (const profile of profiles) if (/^legalwork-mail-benchmark-[a-zA-Z0-9]+$/.test(basename(profile)) && await realpath(dirname(profile)) === await realpath(tmpdir()))
        await rm(profile, { recursive: true, force: true });
    }
  }));
