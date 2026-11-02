import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openEncryptedMailDatabase } from './database.js';
import { migrateMailSchema, MAIL_SCHEMA_VERSION } from './schema.js';
import { removeLaterMailSchema } from '../testing/legacy-schema.mjs';
import { MailRepository } from './repository.js';
import { MailCredentialRepository } from './credentials.js';
import { MailContentStore } from './content-store.js';
import { MimeProjectionStore } from './mime-projection-store.js';
import { MailLocalApiStore } from './local-api.js';
import { MailRulesStore, captureMailRuleArrival } from './rules.js';
import { MailSnoozeStore } from './snoozes.js';
import { quarantineRestoredMail } from './recovery-quarantine.js';
import { MailRulesRunner } from '../runtime/rules-runner.js';
import { LocalMailService } from '../service.js';
import { fileURLToPath } from 'node:url';

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'mail-rules-')), path = join(dir, 'mail.sqlite'), key = randomBytes(32), db = await openEncryptedMailDatabase({ path, key });
  try {
    migrateMailSchema(db); let clock = Date.now(); const now = () => clock, advance = (ms = 1) => { clock += ms; };
    const repo = new MailRepository(db, 'owner'), credentials = new MailCredentialRepository(db, 'owner', now), rules = new MailRulesStore(db, 'owner', now);
    const binding = account => ({ provider: 'gmail', clientId: 'synthetic.apps.googleusercontent.com', authority: 'https://accounts.google.com', providerSubject: account });
    const tokens = scopes => ({ accessToken: 'synthetic', expiresAt: now() + 3600000, grantedScopes: scopes ?? ['https://www.googleapis.com/auth/gmail.modify'], refreshToken: { action: 'clear' } });
    for (const account of ['a', 'b']) {
      repo.createAccount({ id: account, provider: 'gmail', displayName: account });
      for (const id of ['INBOX', 'UNREAD', 'STARRED', 'SENT', 'SPAM', 'TRASH']) repo.putFolder(account, { id, name: id, kind: 'label' });
      credentials.connect(account, binding(account), null, tokens());
      db.run("INSERT INTO mail_gmail_runs(account_id,generation,revision,state,recent_after,phase,history_id) VALUES(?,?,1,'active',0,'history','1')", [account, randomUUID()]);
    }
    const save = (definition = {}, account = 'a') => rules.save(account, { id: randomUUID(), expected: null, definition: { name: 'Invoices', enabled: true, order: 1, sender: 'sender@example.test', subject: 'invoice', action: { kind: 'read' }, ...definition } }).items.at(-1);
    async function add(id, options = {}) {
      const { account = 'a', capture = true, received = now(), from = 'Sender <sender@example.test>', subject = 'Invoice', memberships = ['INBOX', 'UNREAD'], project = true, thread = null } = options;
      const locator = { provider: 'gmail', messageId: id }, messageKey = JSON.stringify(['gmail', id]);
      if (capture) captureMailRuleArrival(db, 'owner', account, locator, now());
      repo.ingestMessage(account, { locator, subject, rfcMessageId: null, threadId: thread, memberships });
      db.run('INSERT INTO mail_gmail_metadata(account_id,message_key,internal_date,thread_id,label_ids_json) VALUES(?,?,?,?,?)', [account, messageKey, received, thread ?? id, JSON.stringify(memberships)]);
      if (project) {
        const content = new MailContentStore(db, 'owner'), raw = await content.writePart(account, locator, { kind: 'raw', maxBytes: 1000 }, [Buffer.from('Subject: ' + subject + '\r\n\r\nbody')]);
        const body = await content.writePart(account, locator, { kind: 'body', maxBytes: 1000 }, [Buffer.from('{"version":1,"bodies":[]}')]);
        new MimeProjectionStore(db, 'owner').complete(account, locator, raw.id, { metadata: { subject, from, to: null, cc: null, bcc: null, replyTo: null, date: null, messageId: null }, bodies: [], body, attachments: [] });
      }
      return locator;
    }
    await run({ db, path, key, repo, credentials, rules, save, add, now, advance, binding, tokens });
  } finally { db.close(); key.fill(0); await rm(dir, { recursive: true, force: true }); }
}
const jobs = db => db.all("SELECT * FROM mail_action_jobs WHERE kind='mutation'");
test('rules act only on explicitly captured new Inbox mail, never backfill, old imports, Sent, Spam or other accounts', () => fixture(async f => {
  f.save(); f.advance();
  await f.add('new'); await f.add('backfill', { capture: false }); await f.add('historical', { received: 1000 });
  await f.add('sent', { memberships: ['SENT'] }); await f.add('spam', { memberships: ['INBOX', 'SPAM'] }); await f.add('other', { account: 'b' });
  assert.deepEqual(f.rules.run(), ['a']); assert.equal(jobs(f.db).length, 1);
  const intent = JSON.parse(jobs(f.db)[0].payload_json).intent;
  assert.equal(intent.locator.messageId, 'new'); assert.deepEqual(intent.change, { kind: 'read', read: true });
  assert.equal(f.rules.read('a').activity[0].outcome, 'queued'); assert.equal(f.rules.read('b').activity.length, 0);
}));
test('one first match and one durable journal action survive replay, local flag events and process restart', () => fixture(async f => {
  f.save({ order: 2, name: 'Second', action: { kind: 'archive' } }); f.save({ order: 1, name: 'First', action: { kind: 'flag' } }); f.advance();
  const locator = await f.add('one'); f.rules.run(); f.rules.run();
  captureMailRuleArrival(f.db, 'owner', 'a', locator, f.now());
  f.db.run("UPDATE mail_messages SET is_read=1 WHERE account_id='a'");
  new MailRulesStore(f.db, 'owner', f.now).run();
  assert.equal(jobs(f.db).length, 1); assert.equal(f.rules.read('a').activity[0].ruleName, 'First');
  assert.deepEqual(JSON.parse(jobs(f.db)[0].payload_json).intent.change, { kind: 'flags', add: ['\\Flagged'], remove: [] });
}));
test('edits, enabling and priority changes only apply to arrivals captured after the saved revision', () => fixture(async f => {
  const rule = f.save(); f.advance(); await f.add('before-edit');
  f.rules.save('a', { id: rule.id, expected: rule.version, definition: { ...rule.definition, action: { kind: 'archive' } } });
  f.rules.run(); assert.equal(jobs(f.db).length, 0); f.advance(); await f.add('after-edit'); f.rules.run();
  assert.equal(jobs(f.db).length, 1); assert.equal(JSON.parse(jobs(f.db)[0].payload_json).intent.change.operation, 'archive');
}));
test('versions, soft deletion and account boundaries fence stale edits and rule recreation', () => fixture(async f => {
  const rule = f.save(); const changed = f.rules.save('a', { id: rule.id, expected: rule.version, definition: { ...rule.definition, enabled: false } }).items[0];
  assert.throws(() => f.rules.save('a', { id: rule.id, expected: rule.version, definition: rule.definition }), { code: 'conflict' });
  assert.throws(() => f.rules.delete('b', { id: rule.id, expected: changed.version }), { code: 'conflict' });
  f.rules.delete('a', { id: rule.id, expected: changed.version });
  assert.throws(() => f.rules.save('a', { id: rule.id, expected: null, definition: rule.definition }), { code: 'conflict' });
  assert.throws(() => new MailRulesStore(f.db, 'outsider').read('a'), { code: 'not_found' });
}));
test('read-only native scopes hold actions and reconnect requires explicit rule review without historical replay', () => fixture(async f => {
  f.credentials.rotate('a', f.binding('a'), f.credentials.status('a').version, f.tokens(['https://www.googleapis.com/auth/gmail.readonly']));
  const rule = f.save(); f.advance(); await f.add('readonly');
  assert.equal(f.rules.read('a').items[0].status, 'write_permission'); f.rules.run(); assert.equal(jobs(f.db).length, 0);
  const previous = f.credentials.status('a').version; f.credentials.disconnect('a', previous);
  f.credentials.connect('a', f.binding('a'), f.credentials.status('a').version, f.tokens());
  assert.equal(f.rules.read('a').items[0].status, 'connection_changed'); f.advance(30001); f.rules.run(); assert.equal(jobs(f.db).length, 0);
  f.rules.save('a', { id: rule.id, expected: rule.version, definition: rule.definition }); f.advance(); await f.add('reviewed'); f.rules.run(); assert.equal(jobs(f.db).length, 1);
}));
test('paused and initial sync states do not execute captured arrivals', () => fixture(async f => {
  f.save(); f.advance(); await f.add('waiting'); f.db.run("UPDATE mail_gmail_runs SET phase='backfill' WHERE account_id='a'");
  assert.equal(f.rules.read('a').items[0].status, 'waiting_sync'); f.rules.run(); assert.equal(jobs(f.db).length, 0);
  f.db.run("UPDATE mail_gmail_runs SET phase='history',state='paused' WHERE account_id='a'"); f.advance(30001); f.rules.run(); assert.equal(jobs(f.db).length, 0);
  f.db.run("UPDATE mail_gmail_runs SET state='active' WHERE account_id='a'"); f.advance(30001); f.rules.run(); assert.equal(jobs(f.db).length, 1);
}));
test('snooze rules use the existing conversation snapshot and never overwrite a current user snooze', () => fixture(async f => {
  f.save({ action: { kind: 'snooze', minutes: 60, timeZone: 'Europe/Berlin' } }); f.advance();
  const locator = await f.add('one', { thread: 'thread' }); await f.add('two', { thread: 'thread' });
  const snoozes = new MailSnoozeStore(f.db, 'owner', f.now), time = { at: f.now() + 7200000, timeZone: 'Europe/Berlin' };
  snoozes.set('a', { locator, expected: null, time }); f.rules.run();
  assert.deepEqual(snoozes.read('a', locator).time, time); assert.equal(snoozes.read('a', locator).count, 2); assert.equal(jobs(f.db).length, 0);
  const other = await f.add('three'); f.rules.run(); assert.equal(snoozes.read('a', other).time.at, f.now() + 3600000);
}));
test('rule claim and journal enqueue roll back together when recording activity fails', () => fixture(async f => {
  f.save(); f.advance(); await f.add('one');
  f.db.exec("CREATE TRIGGER reject_rule_activity BEFORE UPDATE ON mail_rule_arrivals WHEN NEW.action_id IS NOT NULL BEGIN SELECT RAISE(ABORT,'synthetic'); END");
  f.rules.run(); assert.equal(jobs(f.db).length, 0); assert.equal(f.rules.read('a').activity[0].outcome, 'unavailable');
  f.db.exec('DROP TRIGGER reject_rule_activity'); f.rules.run(); assert.equal(jobs(f.db).length, 0);
}));
test('uncertain provider actions are reported from the existing journal and never automatically replayed', () => fixture(async f => {
  f.save(); f.advance(); await f.add('one'); f.rules.run();
  f.db.run("UPDATE mail_action_jobs SET state='uncertain',last_error='outcome_unknown' WHERE account_id='a'"); f.rules.run();
  assert.equal(f.rules.read('a').activity[0].outcome, 'uncertain'); assert.equal(jobs(f.db).length, 1);
}));
test('rule evaluation is bounded, retries missing MIME fairly and expires stale arrivals', () => fixture(async f => {
  f.save(); f.advance();
  for (let i = 0; i < 30; i++) await f.add('missing-' + i, { project: false });
  await f.add('ready'); f.rules.run(); assert.equal(jobs(f.db).length, 0); f.rules.run(); assert.equal(jobs(f.db).length, 1);
  f.advance(8 * 86400000); f.rules.run(); f.rules.run(); assert.equal(f.db.get("SELECT count(*) AS n FROM mail_rule_arrivals WHERE state='pending'").n, 0);
}));
test('restore disables local rules and discards pending candidates, ordinary restart does not', () => fixture(async f => {
  f.save(); f.advance(); await f.add('one'); assert.equal(new MailRulesStore(f.db, 'owner', f.now).read('a').items[0].definition.enabled, true);
  quarantineRestoredMail(f.db); assert.equal(f.rules.read('a').items[0].definition.enabled, false); f.rules.run(); assert.equal(jobs(f.db).length, 0);
}));
test('rule count and disabled capture are bounded per account', () => fixture(async f => {
  f.save({ enabled: false }); await f.add('disabled'); assert.equal(f.db.get('SELECT count(*) AS n FROM mail_rule_arrivals').n, 0);
  for (let i = 1; i < 20; i++) f.save({ name: 'Rule ' + i, order: i + 1 });
  assert.throws(() => f.save(), { code: 'limit' }); f.save({}, 'b'); assert.equal(f.rules.read('b').items.length, 1);
}));
test('runner suspension never evaluates or wakes engines until resumed, and stops synchronously', () => fixture(async f => {
  f.save(); f.advance(); await f.add('one'); const woken = [], runner = new MailRulesRunner(f.db, 'owner', account => woken.push(account));
  runner.suspend(); assert.equal(jobs(f.db).length, 0); runner.resume(); runner.suspend();
  assert.deepEqual(woken, ['a']); assert.equal(jobs(f.db).length, 1);
}));
test('latest desktop lifecycle state fences stale runner resume callbacks before local snooze or provider enqueue', () => fixture(async f => {
  f.save({ action: { kind: 'snooze', minutes: 60, timeZone: 'Europe/Berlin' } }); f.advance(); const locator = await f.add('one');
  let running = false; const runner = new MailRulesRunner(f.db, 'owner', () => assert.fail('Snooze cannot wake a provider'), () => running);
  try {
    runner.resume(); assert.equal(new MailSnoozeStore(f.db, 'owner', f.now).read('a', locator).time, null);
    assert.equal(f.db.get("SELECT state FROM mail_rule_arrivals").state, 'pending');
    runner.suspend(); running = true; runner.resume();
    assert.notEqual(new MailSnoozeStore(f.db, 'owner', f.now).read('a', locator).time, null);
  } finally { runner.suspend(); }
}));
test('schema 36 upgrades additively and current rule history survives reopen', () => fixture(async f => {
  removeLaterMailSchema(f.db, 36); f.db.run('UPDATE mail_schema_version SET version=36'); migrateMailSchema(f.db);
  assert.equal(f.db.get('SELECT version FROM mail_schema_version').version, MAIL_SCHEMA_VERSION); assert.equal(f.db.all('PRAGMA foreign_key_check').length, 0);
  f.save(); f.advance(); await f.add('one'); f.rules.run();
  const second = await openEncryptedMailDatabase({ path: f.path, key: f.key });
  try { migrateMailSchema(second); assert.equal(new MailRulesStore(second, 'owner', f.now).read('a').activity.length, 1); } finally { second.close(); }
}));

test('private worker rules remain account-bound and persist revisions across lock while suspended without network', () => fixture(async f => {
  const service = new LocalMailService({ ownerId: 'owner', databasePath: f.path, loadKey: async () => Buffer.from(f.key), executable: { kind: 'node', path: process.execPath }, entryPoint: fileURLToPath(new URL('../runtime/worker.js', import.meta.url)) });
  try {
    await service.setLifecycleSuspended(true); await service.unlock();
    const id = randomUUID(), definition = { action: { kind: 'read' }, subject: ' invoice ', sender: '', order: 1, enabled: true, name: ' Worker rule ' };
    const saved = await service.saveRule('a', { id, expected: null, definition });
    assert.equal(saved.items[0].definition.name, 'Worker rule'); assert.equal(saved.accountId, 'a');
    await assert.rejects(service.saveRule('b', { id, expected: saved.items[0].version, definition }), { code: 'conflict' });
    await service.lock(); await service.unlock(); const reopened = await service.readRules('a');
    assert.deepEqual(reopened.items, saved.items); await service.deleteRule('a', { id, expected: saved.items[0].version });
    assert.deepEqual((await service.readRules('a')).items, []); assert.equal(jobs(f.db).length, 0);
  } finally { await service.stop(); }
}));
