import { test } from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { digest, initial, openSpike, origin, type Transport } from './store.js';

const page2 = `${initial}?$skiptoken=opaque%2Btwo`;
const delta = `${initial}?$deltatoken=opaque%2Bdone`;
const attachment = new Uint8Array([0, 255, 42, 13, 10]);
const mime = Buffer.from('Message-ID: <duplicate@example.invalid>\r\nSubject: Synthetic\r\n\r\nUnmodified bytes\r\n');
const message = (id: string) => ({ id, subject: `Vertrag ${id}`, body: { contentType: 'text', content: 'Müller diligence confidentiality' } });
const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { 'Content-Type': 'application/json' } });
function fixture(failAttachment = false, calls: string[] = []): Transport {
  return async request => {
    calls.push(request.url);
    assert.equal(request.headers.get('Prefer'), 'IdType="ImmutableId"');
    if (request.url === initial) return json({ value: [message('one')], '@odata.nextLink': page2 });
    if (request.url === page2) return json({ value: [message('two')], '@odata.deltaLink': delta });
    if (request.url === delta) return json({ value: [], '@odata.deltaLink': delta });
    if (/\/attachments\?page=2$/.test(request.url)) return json({ value: [{ id: 'inline', name: 'inline.bin', '@odata.type': '#microsoft.graph.fileAttachment' }] });
    if (/\/attachments$/.test(request.url)) return json({ value: [{ id: 'file', name: '../../contract.bin', '@odata.type': '#microsoft.graph.fileAttachment' }], '@odata.nextLink': `${request.url}?page=2` });
    if (/\/attachments\/[^/]+\/\$value$/.test(request.url)) return failAttachment ? new Response('', { status: 503 }) : new Response(attachment);
    if (/\/messages\/[^/]+\/\$value$/.test(request.url)) return new Response(mime);
    throw new Error(`Unexpected fixture request ${request.url}`);
  };
}
async function temporary(run: (path: string) => Promise<void>) {
  const dir = await mkdtemp(join(tmpdir(), 'legalwork-mail-spike-'));
  try { await run(join(dir, 'synthetic.sqlite')); } finally { await rm(dir, { recursive: true, force: true }); }
}

test('Graph-shaped pages resume after close/reopen; raw MIME and all attachment pages searchable offline', async () => temporary(async path => {
  let store = await openSpike(path);
  assert.deepEqual(await store.syncPage('account/inbox', fixture()), { count: 1, complete: false });
  assert.equal(store.checkpoint('account/inbox'), page2);
  store.close();
  store = await openSpike(path);
  try {
    const calls: string[] = [];
    assert.deepEqual(await store.syncPage('account/inbox', fixture(false,calls)), { count: 1, complete: true });
    assert.equal(calls[0], page2);
    assert.equal(store.checkpoint('account/inbox'), delta);
    assert.equal((await store.syncPage('account/inbox', fixture())).count, 0);
    store.close();
    store = await openSpike(path);
    // These APIs have no transport; contents must come from local SQLite.
    assert.deepEqual(store.search('account/inbox', 'Müller').map(row => { assert.ok(row && typeof row === 'object'); return Object.values(row); }), [['one','Vertrag one'],['two','Vertrag two']]);
    assert.deepEqual(store.search('other/inbox', 'Müller'), []);
    const row = store.read('account/inbox','one');
    assert.ok(row && typeof row === 'object' && 'mime' in row && 'hash' in row);
    assert.deepEqual(Buffer.from(row.mime instanceof Uint8Array ? row.mime : []), mime);
    assert.equal(row.hash, digest(mime));
    const attachments = store.attachments('account/inbox','two');
    assert.equal(attachments.length, 2);
    for (const item of attachments) {
      assert.ok(item && typeof item === 'object' && 'bytes' in item && 'hash' in item);
      assert.deepEqual(Buffer.from(item.bytes instanceof Uint8Array ? item.bytes : []), Buffer.from(attachment));
      assert.equal(item.hash, digest(attachment));
    }
  } finally { store.close(); }
}));

test('HTTP failure and pre-commit interruption never advance checkpoint or expose partial content', async () => temporary(async path => {
  let store = await openSpike(path);
  await assert.rejects(store.syncPage('a', fixture(true)), /HTTP 503/);
  assert.equal(store.checkpoint('a'), initial);
  await assert.rejects(store.syncPage('a', fixture(), () => { throw new Error('injected interruption'); }), /injected interruption/);
  store.close();
  store = await openSpike(path);
  try {
    assert.equal(store.checkpoint('a'), initial);
    assert.deepEqual(store.search('a', 'Vertrag'), []);
    assert.equal(store.attachments('a','one').length, 0);
    await store.syncPage('a', fixture());
    assert.equal(store.search('a', 'Vertrag').length, 1);
  } finally { store.close(); }
}));

test('stock runtime store is plaintext; SQLCipher is not silently assumed', async () => temporary(async path => {
  const store = await openSpike(path);
  try {
    assert.ok(!store.cipherVersion());
    await store.syncPage('a', fixture());
  } finally { store.close(); }
  const bytes = await readFile(path);
  assert.equal(bytes.subarray(0,16).toString(), 'SQLite format 3\0');
  let wal = Buffer.alloc(0);
  try { wal = await readFile(`${path}-wal`); } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error;
  }
  assert.ok(Buffer.concat([bytes,wal]).includes(Buffer.from('Unmodified bytes')));
}));

test('untrusted continuation fails closed', async () => temporary(async path => {
  const store = await openSpike(path);
  try {
    await assert.rejects(store.syncPage('a', async () => json({ value: [], '@odata.nextLink': `${origin}.evil.invalid/steal` })), /Untrusted continuation/);
    assert.equal(store.checkpoint('a'), initial);
  } finally { store.close(); }
}));

// SIGKILL verifies SQLite recovery rather than only JavaScript rollback.
test('process death before COMMIT rolls back the checkpoint on a fresh open', async () => temporary(async path => {
  const helper = fileURLToPath(new URL(process.versions.bun ? './crash.ts' : './crash.js', import.meta.url));
  const child = spawnSync(process.execPath, [helper,path], { timeout: 10_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.signal, 'SIGKILL');
  const store = await openSpike(path);
  try { assert.equal(store.checkpoint('crash'), initial); } finally { store.close(); }
}));
