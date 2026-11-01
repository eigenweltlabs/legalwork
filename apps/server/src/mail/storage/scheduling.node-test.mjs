import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { openEncryptedMailDatabase } from './database.js';
import { migrateMailSchema, MAIL_SCHEMA_VERSION } from './schema.js';
import { removeLaterMailSchema } from '../testing/legacy-schema.mjs';
import { MailRepository } from './repository.js';
import { MailCredentialRepository } from './credentials.js';
import { SenderIdentityRepository } from './sender-identities.js';
import { OutboxStore } from './outbox.js';
import { OutboxRunner } from '../runtime/outbox-runner.js';
import { LocalMailService } from '../service.js';

async function fixture(body) {
  const directory = await mkdtemp(join(tmpdir(), 'mail-scheduling-')), key = randomBytes(32), path = join(directory, 'mail.sqlite');
  const db = await openEncryptedMailDatabase({ path, key });
  try {
    migrateMailSchema(db);
    new MailRepository(db, 'owner').createAccount({ id: 'gmail', provider: 'gmail', displayName: 'Synthetic' });
    const credentials = new MailCredentialRepository(db, 'owner');
    credentials.connect('gmail', { provider: 'gmail', clientId: 'fixture.apps.googleusercontent.com', authority: 'https://accounts.google.com', providerSubject: 'fixture' }, null, {
      accessToken: 'synthetic', expiresAt: Date.now() + 3600000, grantedScopes: ['https://www.googleapis.com/auth/gmail.modify'], refreshToken: { action: 'replace', value: 'synthetic' },
    });
    const identity = new SenderIdentityRepository(db, 'owner').replace('gmail', credentials.status('gmail').version.generation, [{ address: 'self@example.test', displayName: 'Self', primary: true, default: true }])[0];
    let clock = Date.now();
    const now = () => clock, advance = duration => { clock += duration; };
    const store = new OutboxStore(db, 'owner', now);
    const draft = store.local.saveDraft('gmail', { draftId: randomUUID(), expected: null, content: { from: identity.address, senderIdentityId: identity.id, to: ['recipient@example.test'], subject: 'Scheduled', text: 'Immutable scheduled content' } });
    const input = { draftId: draft.id, version: draft.version, replayKey: randomUUID(), schedule: { at: now() + 3600000, timeZone: 'Europe/Berlin' } };
    await body({ db, path, key, store, draft, input, now, advance });
  } finally { db.close(); key.fill(0); await rm(directory, { recursive: true, force: true }); }
}
const accepted = { accepted: ['recipient@example.test'], rejected: [], providerId: 'synthetic', sentCopy: 'provider', delivery: 'unknown', reconciled: false };
const runner = (db, now, connection) => new OutboxRunner({ database: db, ownerId: 'owner', access: {}, now, connection });
const connection = send => ({ prepare: async () => null, send, reconcile: async () => null, close() {} });

test('a clock rollback during preparation rechecks the due time before sending', async () => fixture(async ({ db, store, input, now, advance }) => {
  const queued = await store.queue('gmail', input); advance(3600000); let preparations = 0, sends = 0;
  const active = runner(db, now, async () => ({ ...connection(async () => { sends++; return accepted; }), prepare: async () => { if (++preparations === 1) advance(-3600000); return null; } }));
  await active.turn('gmail'); assert.equal(sends, 0); assert.equal(store.item('gmail', queued.id).state, 'queued');
  assert.equal(db.get('SELECT available_at FROM mail_action_jobs WHERE id=?', [queued.id]).available_at, input.schedule.at);
  await active.turn('gmail'); assert.equal(preparations, 1); advance(3600000);
  await active.turn('gmail'); await active.close(); assert.equal(sends, 1);
}));

test('schema35 scheduling upgrades atomically from34 and survives encrypted reopen', async () => fixture(async ({ db, path, key }) => {
  removeLaterMailSchema(db, 34); db.run('UPDATE mail_schema_version SET version=34');
  const failing = { ...db, exec(sql) { db.exec(sql); if (sql.includes('CREATE TABLE mail_outbox_schedules')) throw Error('synthetic migration failure'); } };
  assert.throws(() => migrateMailSchema(failing));
  assert.equal(db.get('SELECT version FROM mail_schema_version').version, 34);
  assert.equal(db.get("SELECT name FROM sqlite_master WHERE name='mail_outbox_schedules'"), undefined);
  migrateMailSchema(db);
  const reopened = await openEncryptedMailDatabase({ path, key });
  try { assert.equal(reopened.get('SELECT version FROM mail_schema_version').version, MAIL_SCHEMA_VERSION); assert.equal(reopened.get('SELECT count(*) n FROM mail_outbox_schedules').n, 0); }
  finally { reopened.close(); }
}));

test('scheduled snapshots cannot dispatch early and catch up once after restart without moving their instant', async () => fixture(async ({ db, store, draft, input, now, advance }) => {
  const queued = await store.queue('gmail', input), raw = Buffer.from(store.row('gmail', queued.id).mime_bytes);
  let opened = 0, sends = 0;
  const create = () => runner(db, now, async () => { opened++; return connection(async () => { sends++; return accepted; }); });
  let active = create();
  await active.turn('gmail'); assert.equal(opened, 0); assert.deepEqual(queued.schedule, input.schedule);
  store.local.saveDraft('gmail', { draftId: draft.id, expected: draft.version, content: { ...draft.content, text: 'Edited after scheduling' } });
  await active.close(); advance(3600000); active = create(); active.recover();
  await active.turn('gmail'); await active.turn('gmail'); await active.close();
  assert.equal(sends, 1); assert.equal(store.item('gmail', queued.id).state, 'accepted');
  assert.deepEqual(store.item('gmail', queued.id).schedule, input.schedule);
  assert.deepEqual(Buffer.from(store.row('gmail', queued.id).mime_bytes), raw);
  assert.equal(store.read('gmail', queued.id).content.text, 'Immutable scheduled content');
}));

test('rescheduling is versioned and preserves the exact submission; claims and cancellation fence later changes', async () => fixture(async ({ db, store, input, now, advance }) => {
  const queued = await store.queue('gmail', input), raw = Buffer.from(store.row('gmail', queued.id).mime_bytes);
  const time = { at: now() + 7200000, timeZone: 'America/New_York' };
  const updated = store.reschedule('gmail', { actionId: queued.id, expected: queued.version, time });
  assert.equal(updated.id, queued.id); assert.equal(updated.version.revision, queued.version.revision + 1);
  assert.deepEqual(updated.schedule, time); assert.deepEqual(Buffer.from(store.row('gmail', queued.id).mime_bytes), raw);
  assert.equal(db.get('SELECT available_at FROM mail_action_jobs WHERE id=?', [queued.id]).available_at, time.at);
  assert.throws(() => store.reschedule('gmail', { actionId: queued.id, expected: queued.version, time }), { code: 'schedule_conflict' });
  assert.throws(() => new OutboxStore(db, 'other', now).reschedule('gmail', { actionId: queued.id, expected: updated.version, time }));
  advance(7200000); const claim = store.journal.claim('gmail', 30000, 'submission'); assert.ok(claim);
  assert.throws(() => store.reschedule('gmail', { actionId: queued.id, expected: claim.status.version, time: { ...time, at: now() + 60000 } }), { code: 'schedule_conflict' });
  assert.equal(store.cancel('gmail', queued.id).state, 'cancelled');
  assert.throws(() => store.reschedule('gmail', { actionId: queued.id, expected: store.item('gmail', queued.id).version, time: { ...time, at: now() + 60000 } }), { code: 'schedule_conflict' });
  assert.equal(store.journal.claim('gmail', 30000, 'submission'), null);
}));

test('repeated scheduling cannot duplicate or promote a future send through an immediate-send entry point', async () => fixture(async ({ store, input, advance }) => {
  const queued = await store.queue('gmail', input);
  assert.equal((await store.queue('gmail', { ...input, replayKey: 'second-click' })).id, queued.id);
  await assert.rejects(store.queue('gmail', { ...input, schedule: { ...input.schedule, at: input.schedule.at + 1 } }), { code: 'schedule_conflict' });
  const { schedule, ...immediate } = input;
  await assert.rejects(store.queue('gmail', immediate), { code: 'schedule_conflict' });
  advance(3600001);
  assert.equal((await store.queue('gmail', input)).id, queued.id, 'a lost response can be read again after its due time');
  await assert.rejects(store.queue('gmail', { ...input, draftId: randomUUID() }), { code: 'schedule_invalid' });
}));

test('scheduled preflight outages keep safe work due instead of exhausting retries, then send once', async () => fixture(async ({ db, store, input, now, advance }) => {
  const queued = await store.queue('gmail', input); advance(3600000);
  let online = false, sends = 0;
  const active = runner(db, now, async () => { if (!online) throw Error('synthetic offline'); return connection(async () => { sends++; return accepted; }); });
  for (let index = 0; index < 8; index++) { await active.turn('gmail'); assert.equal(store.item('gmail', queued.id).state, 'queued'); advance(61000); }
  assert.equal(sends, 0); online = true; await active.turn('gmail'); await active.turn('gmail'); await active.close();
  assert.equal(store.item('gmail', queued.id).state, 'accepted'); assert.equal(sends, 1);
}));

test('uncertain scheduled sends survive recovery and cannot be rescheduled or automatically retried', async () => fixture(async ({ db, store, input, now, advance }) => {
  const queued = await store.queue('gmail', input); advance(3600000); let sends = 0;
  const create = () => runner(db, now, async () => connection(async () => { sends++; throw Error('synthetic lost acknowledgement'); }));
  let active = create(); await active.turn('gmail'); await active.close();
  const uncertain = store.item('gmail', queued.id); assert.equal(uncertain.state, 'uncertain');
  active = create(); active.recover(); await active.turn('gmail'); await active.close(); assert.equal(sends, 1);
  assert.throws(() => store.reschedule('gmail', { actionId: queued.id, expected: uncertain.version, time: { ...input.schedule, at: now() + 60000 } }), { code: 'schedule_conflict' });
  assert.throws(() => store.retry('gmail', queued.id), { code: 'outcome_unknown' });
}));

test('private worker schedules offline, persists reschedules through lock/unlock and cancels without provider dispatch', async () => fixture(async ({ path, key, input }) => {
  const entryPoint = join(dirname(path), 'offline-worker.mjs');
  await writeFile(entryPoint, `globalThis.fetch=async()=>{throw Error('synthetic offline');};await import(${JSON.stringify(new URL('../runtime/worker.js', import.meta.url).href)});`);
  const service = new LocalMailService({ ownerId: 'owner', databasePath: path, executable: { kind: 'node', path: process.execPath }, entryPoint,
    loadKey: async () => Buffer.from(key), loadProviderSettings: async () => ({ provider: 'gmail', applicationType: 'desktop', pkceMethod: 'S256', clientId: 'fixture.apps.googleusercontent.com', clientSecret: 'synthetic', scopes: ['openid', 'email', 'https://www.googleapis.com/auth/gmail.modify'] }) });
  try {
    await service.setLifecycleSuspended(true); await service.unlock();
    const queued = await service.queueOutbox('gmail', input);
    assert.equal(queued.state, 'queued'); assert.deepEqual(queued.schedule, input.schedule);
    const time = { at: input.schedule.at + 3600000, timeZone: 'America/New_York' };
    const changed = await service.rescheduleOutbox('gmail', { actionId: queued.id, expected: queued.version, time });
    assert.deepEqual(changed.schedule, time);
    await service.lock(); await service.unlock();
    assert.deepEqual((await service.outbox('gmail'))[0].schedule, time);
    await service.setLifecycleSuspended(false);
    assert.equal((await service.outbox('gmail'))[0].attempts, 0);
    assert.equal((await service.outboxAction('gmail', { actionId: queued.id, action: 'cancel' })).state, 'cancelled');
    await service.lock(); await service.unlock();
    assert.equal((await service.outbox('gmail'))[0].state, 'cancelled');
  } finally { await service.stop(); }
}));
