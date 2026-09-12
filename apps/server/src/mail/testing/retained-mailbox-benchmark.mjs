/** Query/contended-write follow-up only. The retained 100k source is never opened writable. */
import assert from 'node:assert/strict';
import { readFile, mkdtemp, copyFile, chmod, rm, writeFile, stat } from 'node:fs/promises';
import { constants } from 'node:fs';
import { join, resolve, sep } from 'node:path';
import { tmpdir, cpus, totalmem, release } from 'node:os';
import { createHash } from 'node:crypto';
import { openEncryptedMailDatabase } from '../storage/database.js';
import { migrateMailSchema, MAIL_SCHEMA_VERSION } from '../storage/schema.js';
import { MailSearchStore } from '../storage/search.js';
import { MailReadStore } from '../storage/read-store.js';
import { MailRepository } from '../storage/repository.js';
import { MailContentStore } from '../storage/content-store.js';
import { createStoredMimeProjector } from '../storage/mime-projection.js';
import { GmailRunStore } from '../storage/gmail-state.js';
import { MailSyncJournal } from '../storage/sync-journal.js';
import { MailSyncExecutor } from '../runtime/sync-executor.js';
import { benchmarkMessage, qualityQueries } from './large-mailbox-corpus.mjs';
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const distribution = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return { count: sorted.length, p50: sorted[Math.floor((sorted.length - 1) * .5)] ?? 0,
    p95: sorted[Math.floor((sorted.length - 1) * .95)] ?? 0, max: sorted.at(-1) ?? 0 };
};
const source = resolve(process.argv[2]), output = resolve(process.argv[3]);
assert(!output.startsWith(source + sep), 'Report must be outside retained profile');
globalThis.fetch = () => { throw Error('No network in retained benchmark'); };
const metadata = JSON.parse(await readFile(join(source, 'benchmark-profile.json'), 'utf8'));
assert.equal(metadata.kind, 'legalwork-synthetic-benchmark'); assert.equal(metadata.count, 100000);
const originalReportBytes = await readFile(metadata.report), originalReport = JSON.parse(originalReportBytes);
const sourceState = await stat(join(source, 'mail.sqlite'));
const key = Buffer.from(metadata.key, 'base64'); assert.equal(key.length, 32);
const root = await mkdtemp(join(tmpdir(), 'mail-retained-copy-')), path = join(root, 'mail.sqlite');
let db, executor, timer;
try {
  await copyFile(join(source, 'mail.sqlite'), path, constants.COPYFILE_FICLONE); await chmod(path, 0o600);
  db = await openEncryptedMailDatabase({ path, key });
  const sourceSchema = db.get('SELECT version FROM mail_schema_version').version;
  const migrationStart = performance.now(); migrateMailSchema(db); const migrationMs = performance.now() - migrationStart;
  assert.equal(db.get('SELECT count(*) n FROM mail_messages').n, 100000);
  assert.equal(db.get("SELECT count(*) n FROM mail_accounts WHERE owner_id!='benchmark'").n, 0);
  let phase = 'query'; const timings = [];
  const measured = { ...db };
  for (const method of ['get', 'all', 'run', 'exec']) measured[method] = (sql, ...args) => {
    const start = performance.now();
    try { return db[method](sql, ...args); }
    finally { const ms = performance.now() - start; if (ms > 2) timings.push({ phase, method, sql, ms }); }
  };
  const search = new MailSearchStore(measured, 'benchmark'), quality = [], warm = [];
  for (const query of qualityQueries(100000)) {
    phase = query.name;
    const firstStart = performance.now(); let result = search.search(query.input);
    const firstCallMs = performance.now() - firstStart, samples = [];
    for (let iteration = 0; iteration < 10; iteration++) {
      const start = performance.now(); result = search.search(query.input); samples.push(performance.now() - start);
      assert.equal(result.total, query.expected, query.name); assert.equal(result.pending, 0);
      if (query.attachment) assert(result.items[0].attachmentMatches.length);
      await delay(0);
    }
    quality.push({ name: query.name, input: query.input, expected: query.expected, actual: result.total,
      incomplete: result.incomplete, firstCallMs, samples, warmMs: distribution(samples) }); warm.push(...samples);
  }
  const reads = new MailReadStore(measured, 'benchmark'), listSamples = [];
  phase = 'list';
  for (let i = 0; i < 10; i++) { const start = performance.now(); assert.equal(reads.list('benchmark-a', { order: 'received', limit: 25 }).items.length, 25); listSamples.push(performance.now() - start); await delay(0); }
  // Verify retained bytes through the production hash-verifying reader before any probe writes.
  const content = new MailContentStore(measured, 'benchmark'); let hashesVerified = 0;
  phase = 'quality-hashes';
  for (let i = 0; i < 100000; i += 1000) {
    const item = benchmarkMessage(i), row = db.get("SELECT ref_id FROM mail_content_manifests WHERE account_id=? AND message_key=? AND kind='raw' AND state='stored'", [item.accountId, JSON.stringify(['gmail', item.locator.messageId])]);
    const hash = createHash('sha256'); for (const bytes of content.read(item.accountId, row.ref_id)) hash.update(bytes);
    assert.equal(hash.digest('hex'), item.hash); hashesVerified++;
  }
  const repo = new MailRepository(measured, 'benchmark'), runs = new GmailRunStore(measured, 'benchmark'), journal = new MailSyncJournal(measured, 'benchmark');
  const projector = createStoredMimeProjector({ database: measured, ownerId: 'benchmark' }), references = new Map();
  const run = runs.startOrResume('benchmark-a');
  executor = new MailSyncExecutor({ journal, maxConcurrentAccounts: 1, maxJobsPerRun: 100, handler: work => {
    if (work.job.kind === 'raw') return Promise.resolve(work.complete(() => {}));
    const item = references.get(work.job.message_key);
    return projector({ accountId: 'benchmark-a', locator: item.locator, reference: item.reference, work, assertCurrent() {} });
  } });
  const probes = [];
  for (const [probe, base, rawParents] of [['body-only', 100004, false], ['raw-and-body', 100104, true]]) {
    const scope = { accountId: 'benchmark-a', generation: run.generation, scopeId: 'retained-' + probe }, jobs = [], foreground = [];
    phase = probe; let previous = performance.now();
    timer = setInterval(() => { const now = performance.now(), began = performance.now();
      assert.equal(reads.list('benchmark-a', { order: 'received', limit: 25 }).items.length, 25);
      foreground.push({ intervalMs: now - previous, readMs: performance.now() - began }); previous = now;
    }, 50);
    const rawStart = performance.now();
    for (let index = base; index < base + 30; index++) {
      const item = benchmarkMessage(index); assert.equal(item.malformed, false);
      repo.ingestMessage('benchmark-a', { locator: item.locator, rfcMessageId: null, subject: '', memberships: item.memberships });
      runs.putGmailMetadata('benchmark-a', item.locator, { internalDate: Date.parse(item.date), threadId: 'probe-' + index, labelIds: item.memberships });
      const reference = await content.writePart('benchmark-a', item.locator, { kind: 'raw', maxBytes: item.raw.length, expectedBytes: item.raw.length },
        Array.from({ length: Math.ceil(item.raw.length / 65536) }, (_, i) => item.raw.subarray(i * 65536, (i + 1) * 65536)));
      assert.equal(reference.sha256, item.hash); references.set(JSON.stringify(['gmail', item.locator.messageId]), { ...item, reference });
      if (rawParents) jobs.push({ kind: 'raw', locator: item.locator }); jobs.push({ kind: 'body', locator: item.locator });
    }
    const rawMs = performance.now() - rawStart, pageStart = performance.now();
    journal.commitPage({ ...scope, expectedCursor: null, expectedRevision: 0, nextCursor: '30', discoveryComplete: true, jobs }, () => {});
    const pageMs = performance.now() - pageStart, projectionStart = performance.now(), result = await executor.run(scope);
    const projectionMs = performance.now() - projectionStart; assert.equal(result.succeeded, jobs.length);
    await delay(60); clearInterval(timer); timer = undefined;
    probes.push({ probe, messages: 30, jobs: jobs.length, rawMs, pageMs, projectionMs, foreground,
      timerIntervalMs: distribution(foreground.map(x => x.intervalMs)), readMs: distribution(foreground.map(x => x.readMs)) });
  }
  executor.close(); phase = 'accounting';
  const reverseIndexBytes = db.get("SELECT sum(pgsize) n FROM dbstat WHERE name='mail_sync_scope_job_lookup'").n;
  const report = { kind: 'retained-100k-follow-up', measuredAt: new Date().toISOString(), sourceSchema, schema: MAIL_SCHEMA_VERSION,
    sourceSha256: process.env.LEGALWORK_MAIL_BENCH_SOURCE_SHA256, originalReportSha256: createHash('sha256').update(originalReportBytes).digest('hex'),
    originalSourceSha256: originalReport.sourceSha256, migrationMs, hashesVerified, queryWarmup: 'One unmeasured-for-warm first call per query, separately reported; ten measured repetitions',
    quality, warmMs: distribution(warm), listSamples, listMs: distribution(listSamples), probes, reverseIndexBytes,
    slowStatements: timings.sort((a, b) => b.ms - a.ms).slice(0, 30),
    host: { cpu: cpus()[0]?.model, logicalCpus: cpus().length, totalMemoryBytes: totalmem(), os: release(), node: process.versions.node },
    limits: 'Disposable clone only; no full ingestion/extraction/indexing repeat, no IPC or UI timing, no OS-cache flush or hardware-reference certification. Timer intervals include synchronous foreground reads. Raw-parent probe uses already stored synthetic raw and does not download.' };
  db.close(); db = undefined;
  const finalState = await stat(join(source, 'mail.sqlite')); assert.equal(finalState.size, sourceState.size); assert.equal(finalState.mtimeMs, sourceState.mtimeMs);
  await writeFile(output, JSON.stringify(report, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
  console.log(JSON.stringify({ output, schema: report.schema, warmMs: report.warmMs, probes: probes.map(({ foreground, ...rest }) => rest), hashesVerified }));
} finally { clearInterval(timer); executor?.close(); db?.close(); key.fill(0); await rm(root, { recursive: true, force: true }); }
