import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { JmapContractProbe, JMAP_CORE, JMAP_MAIL, JMAP_SUBMISSION } from '../testing/jmap-evaluation.mjs';
import { providerMessageLocatorSchema } from '../model.js';
import { openEncryptedMailDatabase } from '../storage/database.js';
import { migrateMailSchema } from '../storage/schema.js';
import { MailRepository } from '../storage/repository.js';
import { MailContentStore } from '../storage/content-store.js';
import { MailActionJournal } from '../storage/action-journal.js';

const raw = Buffer.from('From: sender@example.invalid\r\nTo: recipient@example.invalid\r\nMessage-ID: <same@example.invalid>\r\nSubject: Synthetic JMAP original\r\nContent-Type: application/octet-stream\r\n\r\n\x00\xff\x01', 'latin1');
const session = () => ({ apiUrl: 'https://api.fastmail.com/jmap/api/',
  downloadUrl: 'https://api.fastmail.com/jmap/download/{accountId}/{blobId}/{name}?type={type}',
  capabilities: { [JMAP_CORE]: { maxObjectsInGet: 100 }, [JMAP_MAIL]: {}, [JMAP_SUBMISSION]: {} },
  accounts: { owner: { isReadOnly: false, accountCapabilities: { [JMAP_MAIL]: {}, [JMAP_SUBMISSION]: {} } },
    shared: { isReadOnly: true, accountCapabilities: { [JMAP_MAIL]: {} } } } });
const message = n => ({ id: 'm' + n, blobId: 'b' + n, threadId: 't' + n, mailboxIds: { inbox: true, legal: true }, keywords: {}, size: raw.length });
function transport({ size = 205, sessionValue = session(), answer } = {}) {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push({ url, init });
    assert.equal(init.redirect, 'error');
    assert.equal(init.credentials, 'omit');
    assert.equal(new URL(url).origin, 'https://api.fastmail.com');
    if (url.endsWith('/session')) return Response.json(sessionValue);
    if (url.includes('/download/')) return new Response(raw);
    const request = JSON.parse(init.body);
    assert.deepEqual(request.using, [JMAP_CORE, JMAP_MAIL]);
    assert.equal(request.methodCalls.length, 1);
    const [name, args, tag] = request.methodCalls[0];
    assert.equal(args.accountId, 'owner');
    let result = answer?.(name, args, calls.length);
    if (!result && name === 'Email/query') result = { queryState: 'query-state-not-email-state', position: args.position,
      ids: Array.from({ length: Math.min(args.limit, size - args.position) }, (_, index) => 'm' + (args.position + index)), total: size };
    if (!result && name === 'Email/get') result = { state: 'email-state', list: args.ids.map(value => message(Number(value.slice(1)))), notFound: [] };
    assert.ok(result, 'Every synthetic method requires an explicit response');
    const method = result.error ? 'error' : name;
    return Response.json({ methodResponses: [[method, result.error ?? { accountId: 'owner', ...result }, tag]] });
  };
  return { fetch, calls, probe: new JmapContractProbe({ fetch, accountId: 'owner' }) };
}
const fails = code => ({ message: 'jmap_probe_' + code });

test('JMAP capability selection binds the remote account and keeps submission separate', async () => {
  const readOnly = session(); readOnly.accounts.owner = readOnly.accounts.shared;
  const fixture = transport({ sessionValue: readOnly });
  assert.deepEqual(await fixture.probe.connect(), { readOnly: true, submission: false });
  await assert.rejects(fixture.probe.setRead('m0', 'email-state', true), fails('read_only'));
  assert.equal(fixture.calls.length, 1);
  const missing = session(); delete missing.accounts.owner;
  await assert.rejects(transport({ sessionValue: missing }).probe.connect(), fails('capability'));
  delete readOnly.accounts.owner;
  await assert.rejects(fixture.probe.connect(), fails('capability'));
  await assert.rejects(fixture.probe.setRead('m0', 'email-state', true), fails('not_connected'));
  assert.throws(() => new JmapContractProbe({ accountId: 'owner' }), fails('transport_required'));
});

test('205 records use three bounded query/get pages and retain separate query and Email cursors', async t => {
  const fixture = transport(); await fixture.probe.connect();
  const started = performance.now(), result = await fixture.probe.baseline();
  assert.equal(result.records.length, 205);
  assert.equal(new Set(result.records.map(value => value.id)).size, 205);
  assert.equal(result.queryState, 'query-state-not-email-state');
  assert.equal(result.emailState, 'email-state');
  assert.deepEqual(result.records[0].mailboxIds, { inbox: true, legal: true });
  assert.equal(fixture.probe.metrics.requests, 7);
  const originals = await fixture.probe.raw(result.records[0].blobId);
  assert.deepEqual(originals, raw);
  assert.equal(fixture.probe.metrics.requests, 8);
  t.diagnostic(JSON.stringify({ fixture: '205 synthetic messages; one original', ...fixture.probe.metrics,
    wallMs: Number((performance.now() - started).toFixed(2)) }));
});

test('empty baseline obtains Email state instead of substituting queryState', async () => {
  const fixture = transport({ size: 0 }); await fixture.probe.connect();
  assert.deepEqual(await fixture.probe.baseline(), { records: [], queryState: 'query-state-not-email-state', emailState: 'email-state' });
  assert.equal(fixture.probe.metrics.requests, 3);
});

test('server get limits reduce batches and changing baselines never return a checkpoint', async () => {
  const limited = session(); limited.capabilities[JMAP_CORE].maxObjectsInGet = 2;
  const fixture = transport({ size: 5, sessionValue: limited }); await fixture.probe.connect();
  assert.equal((await fixture.probe.baseline()).records.length, 5);
  for (const call of fixture.calls.filter(value => value.init.body)) {
    const [name, args] = JSON.parse(call.init.body).methodCalls[0];
    if (name === 'Email/get') assert.ok(args.ids.length <= 2);
  }
  let queries = 0;
  const changing = transport({ answer(name, args) {
    if (name === 'Email/query') return { queryState: 'q' + queries++, position: args.position, ids: [message(args.position).id], total: 2 };
  } });
  await changing.probe.connect();
  await assert.rejects(changing.probe.baseline(), fails('baseline_changed'));
  const tiny = session(); tiny.capabilities[JMAP_CORE].maxObjectsInGet = 1;
  const bounded = transport({ size: 11, sessionValue: tiny }); await bounded.probe.connect();
  await assert.rejects(bounded.probe.baseline(), fails('page_limit'));
  assert.equal(bounded.calls.length, 21);
});

test('delta pagination uses returned opaque states and does not order them numerically', async () => {
  const fixture = transport({ answer(name, args) {
    assert.equal(name, 'Email/changes');
    if (args.sinceState === 'z') return { oldState: 'z', newState: 'a', hasMoreChanges: true, created: ['m7'], updated: [], destroyed: [] };
    assert.equal(args.sinceState, 'a');
    return { oldState: 'a', newState: '00', hasMoreChanges: false, created: [], updated: ['m8'], destroyed: ['m9'] };
  } });
  await fixture.probe.connect();
  const result = await fixture.probe.changes('z');
  assert.equal(result.emailState, '00'); assert.equal(result.pages.length, 2);
  assert.deepEqual(result.pages[1].destroyed, ['m9']);
});

test('expired delta state discards partial pages and requires a new baseline', async () => {
  const fixture = transport({ answer(name, args) {
    assert.equal(name, 'Email/changes');
    return args.sinceState === 'old' ? { oldState: 'old', newState: 'partial', hasMoreChanges: true, created: [], updated: [], destroyed: ['m1'] }
      : { error: { type: 'cannotCalculateChanges' } };
  } });
  await fixture.probe.connect();
  assert.deepEqual(await fixture.probe.changes('old'), { resetRequired: true, pages: [] });
});

test('state mismatch and per-object rejection differ from a confirmed read patch', async () => {
  for (const outcome of ['conflict', 'rejected', 'succeeded']) {
    const fixture = transport({ answer(name, args) {
      assert.equal(name, 'Email/set'); assert.equal(args.ifInState, 'reviewed-email-state');
      assert.deepEqual(args.update, { m1: { 'keywords/$seen': true } });
      if (outcome === 'conflict') return { error: { type: 'stateMismatch' } };
      return { oldState: args.ifInState, newState: 'new-state', updated: outcome === 'succeeded' ? { m1: null } : null,
        notUpdated: outcome === 'rejected' ? { m1: { type: 'forbidden' } } : null };
    } });
    await fixture.probe.connect();
    assert.equal(await fixture.probe.setRead('m1', 'reviewed-email-state', true), outcome);
  }
});

test('untrusted endpoints and oversized responses stop before accepting observations', async () => {
  for (const url of ['https://attacker.invalid/api', 'http://api.fastmail.com/api', 'https://user:secret@api.fastmail.com/api']) {
    const value = session(); value.apiUrl = url;
    const fixture = transport({ sessionValue: value });
    await assert.rejects(fixture.probe.connect(), fails('endpoint'));
    assert.equal(fixture.calls.length, 1);
  }
  const fixture = transport(); await fixture.probe.connect();
  fixture.probe.fetch = async () => new Response(Buffer.alloc(1024 * 1024 + 1));
  await assert.rejects(fixture.probe.raw('b1'), fails('response_limit'));
});

test('cross-account, malformed correlation and repeated delta cursors are rejected', async () => {
  const foreign = transport({ answer: () => ({ accountId: 'shared', queryState: 'q', position: 0, ids: [], total: 0 }) });
  await foreign.probe.connect(); await assert.rejects(foreign.probe.baseline(), fails('response_account'));
  const tagged = transport(); await tagged.probe.connect();
  tagged.probe.fetch = async () => Response.json({ methodResponses: [['Email/query', { accountId: 'owner' }, 'wrong-tag']] });
  await assert.rejects(tagged.probe.baseline(), fails('response_tag'));
  const repeated = transport({ answer: () => ({ oldState: 'same', newState: 'same', hasMoreChanges: true, created: [], updated: [], destroyed: [] }) });
  await repeated.probe.connect(); await assert.rejects(repeated.probe.changes('same'), fails('cursor'));
});

async function storageFixture(body) {
  const directory = await mkdtemp(join(tmpdir(), 'legalwork-jmap-evaluation-')), path = join(directory, 'mail.sqlite'), key = randomBytes(32);
  let db = await openEncryptedMailDatabase({ path, key });
  try {
    migrateMailSchema(db);
    const repository = new MailRepository(db, 'owner');
    // An explicit archive fixture exercises shared contracts. It does not impersonate a native JMAP account.
    repository.createAccount({ id: 'probe', provider: 'archive', displayName: 'Synthetic protocol fixture' });
    await body({ db, path, key, repository, reopen: async () => { db.close(); db = await openEncryptedMailDatabase({ path, key }); return db; } });
  } finally { db.close(); key.fill(0); await rm(directory, { recursive: true, force: true }); }
}

test('native JMAP identity needs an explicit schema migration, not a Gmail or IMAP alias', async () => storageFixture(async ({ repository }) => {
  assert.equal(providerMessageLocatorSchema.safeParse({ provider: 'jmap', accountId: 'owner', messageId: 'm0' }).success, false);
  assert.throws(() => repository.createAccount({ id: 'native', provider: 'jmap', displayName: 'Not implemented' }));
}));

test('downloaded original reuses encrypted content storage through an explicit archive fixture', async () => storageFixture(async ({ db, path, repository, reopen }) => {
  const fixture = transport(); await fixture.probe.connect();
  const original = await fixture.probe.raw('b0');
  const locator = { provider: 'archive', namespace: 'synthetic-jmap-evaluation', entryId: 'm0' };
  repository.ingestMessage('probe', { locator, rfcMessageId: '<same@example.invalid>', subject: 'Synthetic JMAP original', memberships: [] });
  const reference = await new MailContentStore(db, 'owner').writePart('probe', locator,
    { kind: 'raw', maxBytes: original.length, expectedBytes: original.length }, [original]);
  assert.equal(reference.sha256, createHash('sha256').update(raw).digest('hex'));
  const opened = await reopen();
  assert.deepEqual(Buffer.concat([...new MailContentStore(opened, 'owner').read('probe', reference.id)]), raw);
  for (const file of [path, path + '-wal']) assert.equal((await readFile(file)).includes(Buffer.from('Synthetic JMAP original')), false);
}));

test('shared durable journal preserves post-dispatch ambiguity across restart without replay', async () => storageFixture(async ({ db, repository, reopen }) => {
  const fixture = transport({ answer() { throw new Error('synthetic lost response after dispatch'); } });
  await fixture.probe.connect();
  const journal = new MailActionJournal(db, 'owner');
  const input = { kind: 'mutation', replayKey: 'jmap-evaluation-read', precondition: 'email-state', conflictPolicy: 'manual',
    payloadJson: JSON.stringify({ prototype: 'jmap', remoteAccountId: 'owner', emailId: 'm0', read: true }) };
  assert.throws(() => journal.enqueue('probe', input), /mail_action_storage_unavailable/);
  // The archive guard stays intact. Exercise only the provider-independent journal using a supported fixture account.
  repository.createAccount({ id: 'journal-contract', provider: 'imap', displayName: 'Journal contract only; no credentials' });
  const queued = journal.enqueue('journal-contract', input), claimed = journal.claim('journal-contract');
  journal.markDispatched(claimed.lease);
  await assert.rejects(fixture.probe.setRead('m0', claimed.precondition, true), /synthetic lost response/);
  journal.recordOutcome(claimed.lease, 'unknown');
  const restarted = new MailActionJournal(await reopen(), 'owner');
  assert.equal(restarted.read('journal-contract', queued.id).state, 'uncertain');
  assert.equal(restarted.enqueue('journal-contract', input).id, queued.id);
  assert.equal(restarted.claim('journal-contract'), null);
  assert.equal(fixture.calls.length, 2);
}));
