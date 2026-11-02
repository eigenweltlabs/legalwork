import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { openEncryptedMailDatabase } from './database.js';
import { migrateMailSchema } from './schema.js';
import { MailRepository } from './repository.js';
import { MailCredentialRepository } from './credentials.js';
import { MailLocalApiStore } from './local-api.js';
import { removeLaterMailSchema } from '../testing/legacy-schema.mjs';

for (const previousVersion of [0, 22]) {
  test(`accounts added after schema ${previousVersion} upgrade retain resumable event streams`, async () => {
    const root = await mkdtemp(join(tmpdir(), 'mail-archive-events-'));
    const key = randomBytes(32);
    const db = await openEncryptedMailDatabase({ path: join(root, 'mail.sqlite'), key });
    try {
      if (previousVersion) {
        migrateMailSchema(db);
        removeLaterMailSchema(db, previousVersion);
        db.run('UPDATE mail_schema_version SET version=?', [previousVersion]);
      }
      migrateMailSchema(db);
      const repository = new MailRepository(db, 'owner');
      repository.createAccount({ id: 'online', provider: 'gmail', displayName: 'Synthetic' });
      repository.createAccount({ id: 'offline', provider: 'archive', displayName: 'Imported' });
      const streams = db.all('SELECT generation FROM mail_local_event_streams ORDER BY account_id');
      assert.equal(streams.length, 2);
      assert.match(streams[0].generation, /^[a-f0-9]{32}$/);
      assert.notEqual(streams[0].generation, streams[1].generation);
      new MailCredentialRepository(db, 'owner').connect('online', {
        provider: 'gmail', clientId: 'test.apps.googleusercontent.com',
        authority: 'https://accounts.google.com', providerSubject: 'synthetic-owner',
      }, null, { accessToken: 'synthetic', expiresAt: Date.now() + 60000,
        grantedScopes: [], refreshToken: { action: 'clear' } });
      const api = new MailLocalApiStore(db, 'owner');
      const initial = api.events('online', {});
      repository.ingestMessage('online', {
        locator: { provider: 'gmail', messageId: 'one' }, subject: 'Synthetic',
        rfcMessageId: null, memberships: [],
      });
      const changes = api.events('online', { stream: initial.stream, after: initial.nextCursor });
      assert.equal(changes.stream, initial.stream);
      assert.equal(changes.resetRequired, false);
      assert.ok(changes.items.some(item => item.kind === 'message.changed'));
      assert.deepEqual(db.all('PRAGMA foreign_key_check'), []);
    } finally {
      db.close(); key.fill(0);
      await rm(root, { recursive: true, force: true });
    }
  });
}
