import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomBytes } from 'node:crypto';
import { openEncryptedMailDatabase } from './database.js';
import { migrateMailSchema, MAIL_SCHEMA_VERSION } from './schema.js';
import { installMailAutomationPrototype } from './automation-schema.js';
import { MailRepository } from './repository.js';

const tables = ['mail_outbox_schedules', 'mail_snoozes', 'mail_local_rules', 'mail_rule_accounts', 'mail_rule_claims'];

test('automation prototype is dormant and installs atomically without advancing the production version', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-automation-prototype-'));
  const key = randomBytes(32);
  const database = await openEncryptedMailDatabase({ path: join(directory, 'mail.sqlite'), key });
  try {
    migrateMailSchema(database);
    for (const name of tables) assert.equal(database.get('SELECT name FROM sqlite_schema WHERE name=?', [name]), undefined);
    const failing = {
      ...database,
      exec(sql) {
        database.exec(sql);
        throw Error('Synthetic migration interruption');
      },
    };
    assert.throws(() => installMailAutomationPrototype(failing), /Synthetic migration interruption/);
    for (const name of tables) assert.equal(database.get('SELECT name FROM sqlite_schema WHERE name=?', [name]), undefined);
    installMailAutomationPrototype(database);
    for (const name of tables) assert.equal(database.get('SELECT name FROM sqlite_schema WHERE name=?', [name]).name, name);
    assert.equal(database.get('SELECT version FROM mail_schema_version').version, MAIL_SCHEMA_VERSION);
    assert.deepEqual(database.all('PRAGMA foreign_key_check'), []);
  } finally {
    database.close();
    key.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
});

test('prototype local metadata is durable, account-bound and deduplicated without changing provider memberships', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'mail-automation-metadata-'));
  const key = randomBytes(32), path = join(directory, 'mail.sqlite');
  let database = await openEncryptedMailDatabase({ path, key });
  try {
    migrateMailSchema(database);
    installMailAutomationPrototype(database);
    const repository = new MailRepository(database, 'synthetic-owner');
    const locator = { provider: 'gmail', messageId: 'same-provider-id' };
    const messageKey = JSON.stringify(['gmail', locator.messageId]);
    for (const account of ['firm', 'other']) {
      repository.createAccount({ id: account, provider: 'gmail', displayName: account });
      repository.putFolder(account, { id: 'INBOX', name: 'Inbox', kind: 'label' });
      repository.ingestMessage(account, { locator, subject: 'Synthetic review', rfcMessageId: null, memberships: ['INBOX'] });
    }
    const at = Date.UTC(2026, 9, 25, 1, 30);
    database.run('INSERT INTO mail_snoozes VALUES(?,?,?,?,?)', ['firm', messageKey, at, 'Europe/Berlin', 1]);
    assert.equal(database.get('SELECT until_at FROM mail_snoozes WHERE account_id=?', ['firm']).until_at, at);
    assert.equal(database.get('SELECT until_at FROM mail_snoozes WHERE account_id=?', ['other']), undefined);
    assert.throws(() => database.run('INSERT INTO mail_snoozes VALUES(?,?,?,?,?)', ['missing', messageKey, at, 'UTC', 1]));
    assert.throws(() => database.run('INSERT INTO mail_outbox_schedules VALUES(?,?,?,?)', ['firm', 'missing-send', at, 'UTC']));
    const claim = ['firm', messageKey, 'rule', 'Client updates', 'Synthetic review', at, null, 'snoozed'];
    database.run('INSERT INTO mail_rule_claims VALUES(?,?,?,?,?,?,?,?)', claim);
    assert.throws(() => database.run('INSERT INTO mail_rule_claims VALUES(?,?,?,?,?,?,?,?)', claim));
    database.run('INSERT INTO mail_rule_claims VALUES(?,?,?,?,?,?,?,?)', ['other', ...claim.slice(1)]);
    assert.deepEqual(repository.readMessage('firm', locator).memberships, ['INBOX']);
    assert.ok(database.get("SELECT 1 FROM mail_local_events WHERE account_id='firm' AND kind='message.changed' AND entity_id=?", [messageKey]));
    database.close();
    database = await openEncryptedMailDatabase({ path, key });
    assert.deepEqual(database.get('SELECT until_at,time_zone,revision FROM mail_snoozes WHERE account_id=?', ['firm']), {
      until_at: at, time_zone: 'Europe/Berlin', revision: 1,
    });
    assert.equal(database.get('SELECT count(*) AS count FROM mail_rule_claims').count, 2);
    assert.deepEqual(database.all('PRAGMA foreign_key_check'), []);
  } finally {
    database.close();
    key.fill(0);
    await rm(directory, { recursive: true, force: true });
  }
});
