import { fork, execFile } from 'node:child_process';
import { promisify } from 'node:util';
const execute = promisify(execFile);
function sampleFamily(pid) {
    let busy = false, stopped = false;
    const result = { sampleIntervalMs: 250, samples: 0, workerPeakRssBytes: 0, descendantPeakRssBytes: 0, combinedPeakRssBytes: 0, available: process.platform !== 'win32' };
    const timer = setInterval(async () => {
        if (busy || stopped || !result.available)
            return;
        busy = true;
        try {
            const { stdout } = await execute('ps', ['-axo', 'pid=,ppid=,rss='], { maxBuffer: 1024 * 1024 });
            const rows = stdout.trim().split('\n').map(line => line.trim().split(/\s+/).map(Number)), family = new Set([pid]);
            for (let pass = 0; pass < 4; pass++)
                for (const [id, parent] of rows)
                    if (family.has(parent))
                        family.add(id);
            let worker = 0, descendants = 0;
            for (const [id, , rss] of rows)
                if (family.has(id)) {
                    if (id === pid)
                        worker = rss * 1024;
                    else
                        descendants += rss * 1024;
                }
            result.samples++;
            result.workerPeakRssBytes = Math.max(result.workerPeakRssBytes, worker);
            result.descendantPeakRssBytes = Math.max(result.descendantPeakRssBytes, descendants);
            result.combinedPeakRssBytes = Math.max(result.combinedPeakRssBytes, worker + descendants);
        }
        catch {
            result.available = false;
        }
        finally {
            busy = false;
        }
    }, 250);
    timer.unref();
    return { result, stop() { stopped = true; clearInterval(timer); } };
}
import { mkdtemp, rm, writeFile, stat, mkdir } from 'node:fs/promises';
import { tmpdir, cpus, totalmem, platform, release } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes, createHash } from 'node:crypto';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import assert from 'node:assert/strict';
import { openEncryptedMailDatabase } from '../storage/database.js';
import { migrateMailSchema, MAIL_SCHEMA_VERSION } from '../storage/schema.js';
import { MailRepository } from '../storage/repository.js';
import { MailContentStore } from '../storage/content-store.js';
import { createStoredMimeProjector } from '../storage/mime-projection.js';
import { GmailRunStore } from '../storage/gmail-state.js';
import { MailSyncJournal } from '../storage/sync-journal.js';
import { MailSyncExecutor, MailSyncExecutionFailure } from '../runtime/sync-executor.js';
import { MailSearchIndexer } from '../runtime/search-indexer.js';
import { MailExtractionRunner } from '../runtime/extraction-runner.js';
import { MailSearchStore } from '../storage/search.js';
import { MailReadStore } from '../storage/read-store.js';
import { LocalMailService } from '../service.js';
import { benchmarkMessage, qualityQueries, CORPUS_VERSION } from './large-mailbox-corpus.mjs';
const delay = ms => new Promise(r => setTimeout(r, ms));
const distribution = values => { const sorted = [...values].sort((a, b) => a - b); return { count: values.length, p50: sorted[Math.floor((sorted.length - 1) * .5)] ?? 0, p95: sorted[Math.floor((sorted.length - 1) * .95)] ?? 0, max: sorted.at(-1) ?? 0 }; };
const size = async (path) => {
    try {
        return (await stat(path)).size;
    }
    catch {
        return 0;
    }
};
async function benchmark({ count, path, key }) {
    globalThis.fetch = () => { throw Error('Benchmark forbids provider network'); };
    let db = await openEncryptedMailDatabase({ path, key: Buffer.from(key, 'base64') });
    migrateMailSchema(db);
    const repo = new MailRepository(db, 'benchmark'), content = new MailContentStore(db, 'benchmark'), runs = new GmailRunStore(db, 'benchmark'), journal = new MailSyncJournal(db, 'benchmark');
    const projector = createStoredMimeProjector({ database: db, ownerId: 'benchmark' }), references = new Map(), scopes = new Map(), pageState = new Map();
    const executor = new MailSyncExecutor({ journal, maxConcurrentAccounts: 1, maxJobsPerRun: 100, handler: async (work) => {
            const item = references.get(work.job.message_key);
            try {
                return await projector({ accountId: work.job.account_id, locator: item.locator, reference: item.reference, work, assertCurrent: () => { } });
            }
            catch (error) {
                if (item.malformed && error.code === 'malformed')
                    throw new MailSyncExecutionFailure('permanent');
                throw error;
            }
        } });
    for (const accountId of ['benchmark-a', 'benchmark-b', 'benchmark-c']) {
        repo.createAccount({ id: accountId, provider: 'gmail', displayName: accountId });
        for (const folder of ['INBOX', 'UNREAD', 'Contracts', 'Archive/2001/Mandate/Verträge'])
            repo.putFolder(accountId, { id: folder, name: folder, kind: 'label' });
        db.run("UPDATE mail_folders SET role='inbox' WHERE account_id=? AND id='INBOX'", [accountId]);
        const run = runs.startOrResume(accountId);
        scopes.set(accountId, { accountId, generation: run.generation, scopeId: 'benchmark' });
        pageState.set(accountId, { cursor: null, revision: 0 });
    }
    let phase = 'ingest', completed = 0;
    const started = performance.now(), cpu = process.cpuUsage(), loop = monitorEventLoopDelay({ resolution: 10 });
    loop.enable();
    const ticks = setInterval(() => process.send?.({ kind: 'progress', phase, completed, rss: process.memoryUsage().rss, seconds: (performance.now() - started) / 1000 }), 10000);
    ticks.unref();
    process.on('message', message => {
        if (message.kind === 'ping') {
            if (phase === 'restart') {
                process.send?.({ kind: 'pong', id: message.id, phase, skipped: true });
                return;
            }
            const begin = performance.now();
            try {
                new MailReadStore(db, 'benchmark').list('benchmark-a', { limit: 25, order: 'received' });
                process.send?.({ kind: 'pong', id: message.id, phase, queryMs: performance.now() - begin });
            }
            catch {
                process.send?.({ kind: 'pong', id: message.id, phase, error: true });
            }
        }
    });
    let rawBytes = 0, attachmentBytes = 0, attachmentCount = 0, malformedCount = 0;
    const formats = {};
    const rawSizes = [], attachmentSizes = [], corpusHash = createHash('sha256');
    for (let base = 0; base < count; base += 30) {
        references.clear();
        const grouped = new Map();
        for (let index = base; index < Math.min(base + 30, count); index++) {
            const item = benchmarkMessage(index);
            repo.ingestMessage(item.accountId, { locator: item.locator, rfcMessageId: null, subject: '', memberships: item.memberships });
            runs.putGmailMetadata(item.accountId, item.locator, { internalDate: Date.parse(item.date), threadId: 'thread-' + Math.floor(index / 3), labelIds: item.memberships });
            const reference = await content.writePart(item.accountId, item.locator, { kind: 'raw', maxBytes: item.raw.length, expectedBytes: item.raw.length }, Array.from({ length: Math.ceil(item.raw.length / 65536) }, (_, index) => item.raw.subarray(index * 65536, (index + 1) * 65536)));
            assert.equal(reference.sha256, item.hash);
            if (item.malformed)
                malformedCount++;
            if (item.format)
                formats[item.format] = (formats[item.format] ?? 0) + 1;
            rawBytes += item.raw.length;
            rawSizes.push(item.raw.length);
            corpusHash.update(item.hash);
            if (item.attached) {
                attachmentBytes += item.attached.length;
                attachmentSizes.push(item.attached.length);
                attachmentCount++;
            }
            references.set(JSON.stringify(['gmail', item.locator.messageId]), { locator: item.locator, reference, malformed: item.malformed });
            if (!grouped.has(item.accountId))
                grouped.set(item.accountId, []);
            grouped.get(item.accountId).push({ kind: 'body', locator: item.locator });
        }
        for (const [accountId, jobs] of grouped) {
            const page = pageState.get(accountId), scope = scopes.get(accountId);
            journal.commitPage({ ...scope, expectedCursor: page.cursor, expectedRevision: page.revision, nextCursor: String(base + 30), discoveryComplete: false, jobs }, () => { });
            page.cursor = String(base + 30);
            page.revision++;
            const result = await executor.run(scope);
            assert.equal(result.succeeded + result.failed, jobs.length, JSON.stringify(result));
            assert.equal(result.failed, jobs.filter(job => references.get(JSON.stringify(['gmail', job.locator.messageId])).malformed).length);
        }
        completed = Math.min(base + 30, count);
        await delay(0);
    }
    const ingestionMs = performance.now() - started;
    executor.close();
    const coverage = () => ({ messages: db.get('SELECT count(*) n FROM mail_messages').n, enumerated: db.get('SELECT count(*) n FROM mail_messages WHERE attachments_enumerated=1').n, raw: db.get("SELECT count(*) n FROM mail_content_manifests WHERE kind='raw' AND state='stored'").n, body: db.get("SELECT count(*) n FROM mail_content_manifests WHERE kind='body' AND state='stored'").n, attachments: db.get("SELECT count(*) n FROM mail_content_manifests WHERE kind='attachment' AND state='stored'").n, pendingParts: db.get("SELECT count(*) n FROM mail_content_manifests WHERE state!='stored'").n, projected: db.get("SELECT count(*) n FROM mail_mime_projections WHERE state='complete'").n, indexed: db.get('SELECT count(*) n FROM mail_search_documents').n, dirty: db.get('SELECT count(*) n FROM mail_search_dirty').n, projectionErrors: db.all("SELECT state,error,count(*) n FROM mail_mime_projections WHERE state!='complete' GROUP BY state,error"), syncJobs: db.all('SELECT state,count(*) n FROM mail_sync_jobs GROUP BY state'), extraction: db.all('SELECT state,error,count(*) n FROM mail_attachment_extractions GROUP BY state,error') });
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const beforeExtractionBytes = await size(path);
    phase = 'extract';
    completed = 0;
    const extractionStart = performance.now(), extractor = new MailExtractionRunner(db, 'benchmark');
    extractor.start();
    while (db.get("SELECT count(*) n FROM mail_attachment_extractions WHERE state IN ('queued','running')").n) {
        completed = db.get("SELECT count(*) n FROM mail_attachment_extractions WHERE state IN ('complete','failed')").n;
        await delay(100);
    }
    await extractor.close();
    const extractionMs = performance.now() - extractionStart;
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const beforeIndexBytes = await size(path);
    phase = 'index';
    completed = 0;
    const indexingStart = performance.now(), indexer = new MailSearchIndexer(db, 'benchmark');
    indexer.start();
    while (db.get('SELECT count(*) n FROM mail_search_dirty').n) {
        completed = db.get('SELECT count(*) n FROM mail_search_documents').n;
        await delay(100);
    }
    indexer.close();
    const indexingMs = performance.now() - indexingStart;
    const complete = coverage();
    assert.equal(complete.messages, count);
    assert.equal(complete.enumerated, count - malformedCount);
    assert.equal(complete.raw, count);
    assert.equal(complete.body, count - malformedCount);
    assert.equal(complete.attachments, attachmentCount);
    assert.equal(complete.projected, count - malformedCount);
    assert.equal(complete.pendingParts, 0);
    assert.equal(complete.indexed, count);
    assert.equal(complete.dirty, 0);
    const hashSamples = [];
    for (let sample = 0; sample < Math.min(count, 100); sample++) {
        const index = (sample * 997) % count;
        const item = benchmarkMessage(index), message = repo.readMessage(item.accountId, item.locator), raw = message.content.find(part => part.kind === 'raw');
        assert.equal(createHash('sha256').update(Buffer.concat([...content.read(item.accountId, raw.ref_id)])).digest('hex'), item.hash);
        hashSamples.push(index);
    }
    const neverOpened = benchmarkMessage(1), part = repo.readMessage(neverOpened.accountId, neverOpened.locator).content.find(part => part.kind === 'attachment');
    assert.deepEqual(Buffer.concat([...content.read(neverOpened.accountId, part.ref_id)]), neverOpened.attached);
    phase = 'query';
    const plans = [], observed = new Set(), measuredDb = { ...db, get(sql, params) {
            if (sql.startsWith('SELECT count(*) AS n FROM mail_search_documents') && !observed.has(sql)) {
                observed.add(sql);
                plans.push({ sql, plan: db.all('EXPLAIN QUERY PLAN ' + sql, params) });
            }
            return db.get(sql, params);
        } };
    const warm = [], quality = [], search = new MailSearchStore(measuredDb, 'benchmark');
    for (const query of qualityQueries(count)) {
        const samples = [];
        let result;
        for (let n = 0; n < 10; n++) {
            const began = performance.now();
            result = search.search(query.input);
            samples.push(performance.now() - began);
            await delay(0);
        }
        assert.equal(result.total, query.expected, query.name);
        assert.equal(result.pending, 0);
        if (query.attachment)
            assert.ok(result.items[0].attachmentMatches.length);
        quality.push({ name: query.name, input: query.input, expected: query.expected, actual: result.total, pending: result.pending, incomplete: result.incomplete, latencyMs: distribution(samples) });
        warm.push(...samples);
    }
    // Full dbstat walks the entire encrypted file synchronously. Keep this
    // accounting overhead visible under its own phase, never label it a query.
    phase = 'accounting';
    let tableBytes = null;
    try {
        tableBytes = db.all('SELECT name,sum(pgsize) bytes FROM dbstat GROUP BY name ORDER BY bytes DESC');
    }
    catch { }
    db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
    const databaseBytes = await size(path), walBytes = await size(path + '-wal');
    db.close();
    phase = 'restart';
    const cold = [], startups = [];
    for (const query of qualityQueries(count)) {
        const service = new LocalMailService({ ownerId: 'benchmark', databasePath: path, loadKey: async () => Buffer.from(key, 'base64'), executable: { kind: 'node', path: process.execPath }, entryPoint: fileURLToPath(new URL('../runtime/worker.js', import.meta.url)) });
        const begin = performance.now();
        await service.unlock();
        startups.push(performance.now() - begin);
        const queryStart = performance.now();
        const result = await service.search(query.input);
        cold.push({ name: query.name, ms: performance.now() - queryStart, total: result.total, pending: result.pending, incomplete: result.incomplete });
        assert.equal(result.total, query.expected);
        await service.stop();
    }
    db = await openEncryptedMailDatabase({ path, key: Buffer.from(key, 'base64') });
    clearInterval(ticks);
    loop.disable();
    const cpuUsed = process.cpuUsage(cpu), rss = process.resourceUsage().maxRSS * 1024;
    return { schemaVersion: MAIL_SCHEMA_VERSION, sourceSha256: process.env.LEGALWORK_MAIL_BENCH_SOURCE_SHA256, concurrency: { mime: 1, extractionProcesses: 1, indexDocumentsPerTurn: 1 }, corpus: { version: CORPUS_VERSION, count, sha256: corpusHash.digest('hex'), rawBytes, attachmentBytes, attachmentCount, malformedCount, formats, rawSizeBytes: distribution(rawSizes), attachmentSizeBytes: distribution(attachmentSizes), coverage: complete, verifiedRawSamples: hashSamples.length, neverOpenedAttachmentVerified: true }, ingestion: { ms: ingestionMs, messagesPerSecond: count / (ingestionMs / 1000) }, extraction: { ms: extractionMs, partsPerSecond: attachmentCount / (extractionMs / 1000) }, indexing: { ms: indexingMs, messagesPerSecond: count / (indexingMs / 1000) }, warmQueryMs: distribution(warm), quality, queryPlans: plans, coldProcessQueries: cold, startupMs: distribution(startups), memory: { workerPeakRssBytes: rss }, storage: { beforeExtractionBytes, beforeIndexBytes, indexAddedBytes: databaseBytes - beforeIndexBytes, databaseBytes, walBytes, databaseToRawRatio: databaseBytes / rawBytes, databaseToRawAndDecodedAttachmentRatio: databaseBytes / (rawBytes + attachmentBytes), tableBytes }, workerEventLoopMs: { p95: loop.percentile(95) / 1e6, max: loop.max / 1e6 }, cpuSeconds: { user: cpuUsed.user / 1e6, system: cpuUsed.system / 1e6 }, elapsedMs: performance.now() - started, coldDefinition: 'fresh service/Node worker and SQLite connection for each first query; OS filesystem cache was not flushed', energy: 'Benchmark worker CPU time only; extractor CPU and hardware joules/power not measured' };
}
if (process.env.LEGALWORK_MAIL_BENCH_CHILD === '1') {
    process.once('message', async (config) => {
        try {
            const result = await benchmark(config);
            process.send({ kind: 'result', result }, () => process.exit(0));
        }
        catch (error) {
            process.send({ kind: 'failure', error: error.stack }, () => process.exit(1));
        }
    });
}
else {
    const count = Number(process.argv[2]), output = process.argv[3], root = await mkdtemp(join(tmpdir(), 'legalwork-mail-benchmark-')), key = randomBytes(32), foreground = [], mainLoop = monitorEventLoopDelay({ resolution: 10 });
    mainLoop.enable();
    const begun = performance.now();
    let timer, sampler, retained = false;
        if (process.env.LEGALWORK_MAIL_BENCH_KEEP_PROFILE === '1') {
            await writeFile(join(root, 'benchmark-profile.json'), JSON.stringify({ kind: 'legalwork-synthetic-benchmark', count, key: key.toString('base64'), report: output }), { mode: 0o600 });
            retained = true;
            console.log('Retained isolated synthetic profile: ' + root);
        }
    try {
        const result = await new Promise((resolve, reject) => {
            const child = fork(fileURLToPath(import.meta.url), [], { env: { ...process.env, LEGALWORK_MAIL_BENCH_CHILD: '1' }, stdio: ['ignore', 'inherit', 'inherit', 'ipc'] });
            sampler = sampleFamily(child.pid);
            let pending = null, id = 0, finished = false;
            timer = setInterval(() => {
                if (pending === null && child.connected) {
                    pending = { id: ++id, start: performance.now() };
                    child.send({ kind: 'ping', id });
                }
            }, 500);
            child.on('message', message => {
                if (message.kind === 'progress')
                    console.log(JSON.stringify(message));
                if (message.kind === 'pong' && pending?.id === message.id) {
                    if (!message.skipped)
                        foreground.push({ phase: message.phase, ms: performance.now() - pending.start, queryMs: message.queryMs, error: message.error });
                    pending = null;
                }
                if (message.kind === 'failure')
                    reject(Error(message.error));
                if (message.kind === 'result') {
                    finished = true;
                    resolve(message.result);
                }
            });
            child.on('error', reject);
            child.on('exit', code => {
                if (!finished)
                    reject(Error('benchmark worker exited ' + code));
            });
            child.send({ count, path: join(root, 'mail.sqlite'), key: key.toString('base64') });
        });
        sampler.stop();
        mainLoop.disable();
        result.memory.processFamilySampled = sampler.result;
        result.foreground = { ipcReadMs: distribution(foreground.filter(x => !x.error).map(x => x.ms)), byPhase: Object.fromEntries([...new Set(foreground.map(x => x.phase))].map(phase => [phase, distribution(foreground.filter(x => x.phase === phase && !x.error).map(x => x.ms))])), errors: foreground.filter(x => x.error).length, coordinatorEventLoopP95Ms: mainLoop.percentile(95) / 1e6, coordinatorEventLoopMaxMs: mainLoop.max / 1e6 };
        result.hardware = { cpu: cpus()[0].model, logicalCpus: cpus().length, ramBytes: totalmem(), platform: platform(), osRelease: release(), node: process.versions.node };
        result.measuredAt = new Date().toISOString();
        result.wallMs = performance.now() - begun;
        await mkdir(dirname(output), { recursive: true });
        await writeFile(output, JSON.stringify(result, null, 2) + '\n');
        console.log('Benchmark report: ' + output);
        console.log(JSON.stringify({ count, warm: result.warmQueryMs, indexing: result.indexing, memory: result.memory, storageRatio: result.storage.databaseToRawRatio }));
    }
    finally {
        clearInterval(timer);
        sampler?.stop();
        mainLoop.disable();
        key.fill(0);
        if (!retained)
            await rm(root, { recursive: true, force: true, maxRetries: 3 });
    }
}
