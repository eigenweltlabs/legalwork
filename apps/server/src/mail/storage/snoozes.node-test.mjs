import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openEncryptedMailDatabase } from './database.js';
import { migrateMailSchema, MAIL_SCHEMA_VERSION } from './schema.js';
import { removeLaterMailSchema } from '../testing/legacy-schema.mjs';
import { MailRepository } from './repository.js';
import { MailCredentialRepository } from './credentials.js';
import { MailReadStore } from './read-store.js';
import { MailSnoozeStore } from './snoozes.js';
import { MailNotificationStore } from './notifications.js';
import { LocalMailService } from '../service.js';

async function fixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'mail-snooze-')), path = join(dir, 'mail.sqlite'), key = randomBytes(32), db = await openEncryptedMailDatabase({ path, key });
  try {
    migrateMailSchema(db);
    const repo = new MailRepository(db, 'owner'), credentials = new MailCredentialRepository(db, 'owner');
    for (const id of ['a', 'b']) {
      repo.createAccount({ id, provider: 'gmail', displayName: id });
      for (const folder of ['INBOX', 'UNREAD', 'SENT', 'SPAM', 'TRASH']) repo.putFolder(id, { id: folder, name: folder, kind: 'label' });
      credentials.connect(id, { provider: 'gmail', clientId: 'fixture.apps.googleusercontent.com', authority: 'https://accounts.google.com', providerSubject: id }, null, { accessToken: 'synthetic', expiresAt: Date.now() + 3600000, grantedScopes: ['https://www.googleapis.com/auth/gmail.readonly'], refreshToken: { action: 'replace', value: 'synthetic' } });
    }
    let clock = Date.now(); const now = () => clock, advance = duration => { clock += duration; };
    const add = (account, id, threadId = 'thread', memberships = ['INBOX', 'UNREAD']) => {
      const locator = { provider: 'gmail', messageId: id };
      repo.ingestMessage(account, { locator, subject: 'Message ' + id, threadId, rfcMessageId: null, memberships });
      db.run('INSERT INTO mail_gmail_metadata(account_id,message_key,internal_date,thread_id,label_ids_json) VALUES(?,?,?,?,?)', [account, JSON.stringify(['gmail', id]), now(), threadId ?? id, JSON.stringify(memberships)]);
      return locator;
    };
    const anchor = add('a', 'one'); add('a', 'two'); add('a', 'sent', 'thread', ['SENT']); add('b', 'one');
    await run({ db, path, key, repo, credentials, add, anchor, now, advance, snoozes: new MailSnoozeStore(db, 'owner', now), reads: new MailReadStore(db, 'owner', now), time: { at: now() + 3600000, timeZone: 'Europe/Berlin' } });
  } finally { db.close(); key.fill(0); await rm(dir, { recursive: true, force: true }); }
}

test('snooze hides a whole current Inbox conversation while preserving provider truth, All mail and account scope', () => fixture(async f => {
  const before = f.db.all('SELECT * FROM mail_memberships ORDER BY account_id,message_key,folder_id');
  const state = f.snoozes.set('a', { locator: f.anchor, expected: null, time: f.time });
  assert.equal(state.scope, 'conversation'); assert.equal(state.count, 2);
  assert.deepEqual(f.db.all('SELECT * FROM mail_memberships ORDER BY account_id,message_key,folder_id'), before);
  for (const input of [{ inboxOnly: true, order: 'received', conversations: true }, { inboxOnly: true }, { folderId: 'INBOX', order: 'received' }]) assert.equal(f.reads.list('a', input).items.length, 0);
  assert.equal(f.reads.list('a', { order: 'received' }).items.length, 3);
  assert.equal(f.reads.list('b', { inboxOnly: true }).items.length, 1);
  assert.equal(f.reads.unreadInboxCount(), 1);
  assert.deepEqual(f.reads.list('a', { order: 'received', snoozedOnly: true }).items.map(item => item.locator.messageId).sort(), ['one', 'two']);
  assert.equal(f.reads.list('a', { order: 'received', snoozedOnly: true, conversations: true }).items.length, 1);
  assert.deepEqual(f.reads.read('a', f.anchor).snoozedUntil, f.time);
  assert.throws(() => new MailSnoozeStore(f.db, 'other').read('a', f.anchor));
}));

test('expiry restores Inbox and badge offline, emits changes and never resurrects removed mail', () => fixture(async f => {
  f.snoozes.set('a', { locator: f.anchor, expected: null, time: f.time });
  const head = f.db.get("SELECT max(sequence) n FROM mail_local_events WHERE account_id='a'").n;
  f.db.run("INSERT INTO mail_tombstones(account_id,message_key,reason,observed_at) VALUES(?,?,?,?)",['a',JSON.stringify(['gmail','two']),'deleted','synthetic']);
  f.advance(3600000); assert.equal(f.snoozes.refresh(), 1);
  assert.equal(f.snoozes.read('a', f.anchor).time, null);
  assert.equal(f.reads.list('a', { inboxOnly: true }).items.length, 1);
  assert.equal(f.reads.list('a', { snoozedOnly: true }).items.length, 0);
  assert.equal(f.reads.unreadInboxCount(), 2);
  assert.ok(f.db.get("SELECT max(sequence) n FROM mail_local_events WHERE account_id='a'").n > head);
  assert.equal(f.snoozes.refresh(), 0);
}));

test('a new Inbox message wakes its conversation, while Sent updates and other accounts do not', () => fixture(async f => {
  f.snoozes.set('a', { locator: f.anchor, expected: null, time: f.time });
  f.add('a', 'sent-new', 'thread', ['SENT']); f.add('b', 'inbox-new'); assert.equal(f.snoozes.refresh(), 0);
  f.add('a', 'inbox-new'); assert.equal(f.snoozes.refresh(), 1);
  assert.equal(f.snoozes.read('a', f.anchor).time, null);
  assert.equal(f.reads.list('a', { inboxOnly: true, conversations: true, order: 'received' }).items.length, 1);
}));

test('provider archive and conversation changes end the local scope without moving provider mail', () => fixture(async f => {
  f.snoozes.set('a', { locator: f.anchor, expected: null, time: f.time });
  for (const id of ['one', 'two']) f.repo.ingestMessage('a', { locator: { provider: 'gmail', messageId: id }, subject: id, threadId: 'thread', rfcMessageId: null, memberships: ['SENT'] });
  assert.equal(f.snoozes.refresh(), 1); assert.equal(f.snoozes.read('a', f.anchor).time, null);
  assert.equal(f.reads.list('a', { inboxOnly: true }).items.length, 0);
  assert.ok(f.reads.read('a', f.anchor).memberships.includes('SENT'));
  const next = f.add('a', 'rethread', 'old-thread');
  f.snoozes.set('a', { locator: next, expected: null, time: f.time });
  f.repo.ingestMessage('a',{locator:next,subject:'Rethreaded',threadId:'new-thread',rfcMessageId:null,memberships:['INBOX','UNREAD']});
  assert.equal(f.snoozes.refresh(), 1); assert.equal(f.reads.list('a', { inboxOnly: true }).items.length, 1);
  assert.equal(f.db.get('SELECT count(*) n FROM mail_action_jobs').n, 0);
}));

test('snooze versions fence stale dialogs across clear, resnooze and expiry without an ABA reset', () => fixture(async f => {
  const first = f.snoozes.set('a', { locator: f.anchor, expected: null, time: f.time });
  const cleared = f.snoozes.set('a', { locator: f.anchor, expected: first.version, time: null });
  assert.throws(() => f.snoozes.set('a', { locator: f.anchor, expected: first.version, time: f.time }), { code: 'conflict' });
  const again = f.snoozes.set('a', { locator: f.anchor, expected: cleared.version, time: f.time });
  assert.equal(first.version.generation, again.version.generation); assert.ok(again.version.revision > first.version.revision);
  f.advance(3600000); f.snoozes.refresh();
  assert.throws(() => f.snoozes.set('a', { locator: f.anchor, expected: again.version, time: { ...f.time, at: f.now() + 60000 } }), { code: 'conflict' });
}));

test('a due conversation returns at the top of Inbox without changing the original email dates', () => fixture(async f => {
  const original = f.reads.read('a', f.anchor).receivedAt;
  f.snoozes.set('a', { locator: f.anchor, expected: null, time: f.time });
  f.advance(1000); f.add('a', 'newer', null);
  f.advance(3600000); f.snoozes.refresh();
  for (const conversations of [false, true]) {
    const first = f.reads.list('a', { inboxOnly: true, order: 'received', conversations, limit: 1 });
    assert.equal(first.items[0].threadId, 'thread'); assert.equal(first.items[0].sortAt, f.now());
    assert.equal(first.items[0].receivedAt, original);
    const rest = f.reads.list('a', { inboxOnly: true, order: 'received', conversations, limit: 10, after: first.nextCursor });
    assert.ok(rest.items.some(item => item.locator.messageId === 'newer'));
    assert.ok(!rest.items.some(item => item.key === first.items[0].key));
  }
  assert.equal(f.reads.list('a', { order: 'received', limit: 1 }).items[0].locator.messageId, 'newer', 'All mail retains received order');
}));

test('Snoozed keyset pages are stable and a multi-message snooze failure rolls back every membership and event', () => fixture(async f => {
  for (let index = 0; index < 31; index++) {
    const locator = f.add('a', 'single-' + index, null);
    f.snoozes.set('a', { locator, expected: null, time: f.time });
  }
  let after; const seen = [];
  do {
    const page = f.reads.list('a', { snoozedOnly: true, conversations: true, order: 'received', limit: 7, ...(after ? { after } : {}) });
    seen.push(...page.items.map(item => item.key)); after = page.nextCursor;
  } while (after);
  assert.equal(seen.length, 31); assert.equal(new Set(seen).size, 31);
  const head = f.db.get("SELECT max(sequence) n FROM mail_local_events WHERE account_id='a'").n;
  let writes = 0;
  const failing = { ...f.db, run(sql, values) { if (sql.startsWith('INSERT INTO mail_snooze_members') && ++writes === 2) throw Error('synthetic write failure'); return f.db.run(sql, values); } };
  assert.throws(() => new MailSnoozeStore(failing, 'owner', f.now).set('a', { locator: f.anchor, expected: null, time: f.time }));
  assert.equal(f.snoozes.read('a', f.anchor).time, null);
  assert.equal(f.db.get("SELECT max(sequence) n FROM mail_local_events WHERE account_id='a'").n, head);
}));

test('spam, trash and absent Inbox scope cannot be snoozed and no unrelated provider changes are queued', () => fixture(async f => {
  const spam = f.add('a', 'spam', null, ['INBOX', 'UNREAD', 'SPAM']), trash = f.add('a', 'trash', null, ['TRASH']), sent = f.add('a', 'sent-alone', null, ['SENT']);
  for (const locator of [spam, trash, sent]) {
    assert.equal(f.snoozes.read('a', locator).available, false);
    assert.throws(() => f.snoozes.set('a', { locator, expected: null, time: f.time }), { code: 'unavailable' });
  }
  f.add('a','spam-in-conversation','thread',['INBOX','SPAM']);f.snoozes.set('a',{locator:f.anchor,expected:null,time:f.time});
  assert.equal(f.reads.list('a',{inboxOnly:true,order:'received',conversations:true}).items.length,0);
  assert.equal(f.db.get('SELECT count(*) n FROM mail_action_jobs').n, 0);
  assert.throws(() => f.snoozes.set('a', { locator: f.anchor, expected: null, time: { ...f.time, at: f.now() } }), { code: 'invalid_time' });
}));

test('Graph and IMAP use the same local snooze while a new IMAP UID validity keeps a distinct identity', () => fixture(async f => {
  for (const provider of ['graph', 'imap']) {
    f.repo.createAccount({ id: provider, provider, displayName: provider });
    f.repo.putFolder(provider, { id: 'inbox', name: 'Inbox', kind: 'folder' });
    f.db.run("UPDATE mail_folders SET role='inbox' WHERE account_id=?", [provider]);
    if (provider === 'graph') f.credentials.connect(provider, { provider, clientId: '11111111-2222-4333-8444-555555555555', authority: 'https://login.microsoftonline.com/consumers/v2.0', providerSubject: 'subject' }, null, { accessToken: 'synthetic', expiresAt: f.now() + 3600000, grantedScopes: ['User.Read', 'Mail.Read'], refreshToken: { action: 'replace', value: 'synthetic' } });
    else f.db.run("INSERT INTO mail_imap_credentials VALUES(?, ?,1,'connected',0,'{}','synthetic')", [provider, randomUUID()]);
    const locator = provider === 'graph' ? { provider, messageId: 'one' } : { provider, mailboxId: 'inbox', uidValidity: 1, uid: 1 };
    f.repo.ingestMessage(provider, { locator, subject: provider, rfcMessageId: null, memberships: ['inbox'] });
    f.db.run('UPDATE mail_messages SET is_read=0 WHERE account_id=?', [provider]);
    f.snoozes.set(provider, { locator, expected: null, time: f.time });
    assert.equal(f.reads.list(provider, { inboxOnly: true }).items.length, 0);
  }
  const next = { provider: 'imap', mailboxId: 'inbox', uidValidity: 2, uid: 1 };
  f.repo.ingestMessage('imap', { locator: next, subject: 'New epoch', rfcMessageId: null, memberships: ['inbox'] });
  assert.equal(f.reads.list('imap', { inboxOnly: true }).items[0].locator.uidValidity, 2);
  assert.equal(f.snoozes.read('imap', next).time, null);
  f.advance(3600000); f.snoozes.refresh();
  assert.equal(f.reads.list('graph', { inboxOnly: true }).items.length, 1);
  assert.equal(f.reads.list('imap', { inboxOnly: true }).items.length, 2);
}));

test('the conversation snapshot budget rejects oversized scopes without partially hiding messages', () => fixture(async f => {
  let anchor;
  for (let index = 0; index < 1001; index++) anchor = f.add('a', 'large-' + index, 'large-thread');
  assert.throws(() => f.snoozes.set('a', { locator: anchor, expected: null, time: f.time }), { code: 'limit' });
  assert.equal(f.db.get('SELECT count(*) n FROM mail_snoozes').n, 0);
  assert.equal(f.db.get('SELECT count(*) n FROM mail_snooze_members').n, 0);
}));

test('snoozed messages cannot escape through notification polling or generate repeated alerts after wake', () => fixture(async f => {
  const session = randomUUID(), generation = f.db.get("SELECT generation FROM mail_local_event_streams WHERE account_id='a'").generation;
  f.db.run('INSERT INTO mail_notification_accounts VALUES(?,?,?,?,?,?)', ['a', session, f.credentials.status('a').version.generation, generation, f.now() - 1, 0]);
  f.snoozes.set('a', { locator: f.anchor, expected: null, time: f.time });
  const notifications = new MailNotificationStore(f.db, 'owner', f.now);
  assert.equal(notifications.poll({ sessionId: session, enabled: true, preview: 'none' }).items.length, 0);
  f.advance(3600000); f.snoozes.refresh();
  assert.equal(notifications.poll({ sessionId: session, enabled: true, preview: 'none' }).items.length, 2);
  assert.equal(notifications.poll({ sessionId: session, enabled: true, preview: 'none' }).items.length, 0);
}));

test('schema36 rolls back atomically, then private worker snooze survives lock/unlock with no network', () => fixture(async f => {
  removeLaterMailSchema(f.db, 35); f.db.run('UPDATE mail_schema_version SET version=35');
  const failing = { ...f.db, exec(sql) { f.db.exec(sql); if (sql.includes('CREATE TABLE mail_snoozes')) throw Error('synthetic migration failure'); } };
  assert.throws(() => migrateMailSchema(failing)); assert.equal(f.db.get('SELECT version FROM mail_schema_version').version, 35);
  assert.equal(f.db.get("SELECT name FROM sqlite_master WHERE name='mail_snoozes'"), undefined); migrateMailSchema(f.db);
  assert.equal(f.db.get('SELECT version FROM mail_schema_version').version, MAIL_SCHEMA_VERSION);
  const service = new LocalMailService({ ownerId: 'owner', databasePath: f.path, loadKey: async () => Buffer.from(f.key), executable: { kind: 'node', path: process.execPath }, entryPoint: fileURLToPath(new URL('../runtime/worker.js', import.meta.url)) });
  try {
    await service.setLifecycleSuspended(true); await service.unlock();
    const state = await service.setSnooze('a', { locator: f.anchor, expected: null, time: f.time });
    await service.lock(); await service.unlock(); assert.deepEqual((await service.readSnooze('a', f.anchor)).time, f.time);
    assert.equal((await service.listMessages('a', { inboxOnly: true })).items.length, 0);
    await service.setSnooze('a', { locator: f.anchor, expected: state.version, time: null });
    assert.equal((await service.listMessages('a', { inboxOnly: true })).items.length, 2);
  } finally { await service.stop(); }
}));
