import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MailDatabase } from './database-interface.js';
import { MailRepository } from './repository.js';
import { MailCredentialRepository } from './credentials.js';
import { MailSnoozeError, mailSnoozeSchema, mailSnoozeSetSchema, type MailSnoozeSet } from '../snooze-view.js';
import { providerMessageLocatorSchema, type ProviderMessageLocator } from '../model.js';
import { validFutureMailTime } from '../scheduling-view.js';
import { MAIL_LIVE_INBOX_SQL } from './snooze-sql.js';

const header = z.object({ account_id: z.string(), scope_key: z.string(), anchor_key: z.string(), thread_id: z.string().nullable(), generation: z.string().uuid(), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), until_at: z.number().int().nonnegative().nullable(), time_zone: z.string().nullable(),woke_at:z.number().int().nonnegative().nullable() });
export class MailSnoozeStore {
  constructor(private db: MailDatabase, private ownerId: string, private now: () => number = Date.now) {}
  private target(accountId: string, supplied: ProviderMessageLocator) {
    const locator = providerMessageLocatorSchema.parse(supplied);
    if (locator.provider === 'archive') throw new MailSnoozeError('unavailable');
    const message = new MailRepository(this.db, this.ownerId).readMessage(accountId, locator);
    if (!message || this.db.get('SELECT 1 FROM mail_tombstones WHERE account_id=? AND message_key=?', [accountId, message.message_key])) throw new MailSnoozeError('not_found');
    const credentials = new MailCredentialRepository(this.db, this.ownerId).status(accountId);
    if (credentials.state !== 'connected' || credentials.archiveLocked || this.db.get('SELECT 1 FROM mail_integration_accounts WHERE account_id=? AND read_only=1', [accountId])) throw new MailSnoozeError('unavailable');
    const scopeKey = JSON.stringify(message.thread_id === null ? ['message', message.message_key] : ['thread', message.thread_id]);
    return { message, locator, scopeKey };
  }
  private existing(accountId: string, scopeKey: string) {
    const row = this.db.get('SELECT * FROM mail_snoozes WHERE account_id=? AND scope_key=?', [accountId, scopeKey]);
    return row ? header.parse(row) : null;
  }
  private members(accountId: string, target: ReturnType<MailSnoozeStore['target']>) {
    const rows = this.db.all(`SELECT m.message_key FROM mail_messages m WHERE m.account_id=? AND ((? IS NULL AND m.message_key=?) OR (? IS NOT NULL AND m.thread_id=?)) AND ${MAIL_LIVE_INBOX_SQL} ORDER BY m.message_key LIMIT 1001`, [accountId, target.message.thread_id, target.message.message_key, target.message.thread_id, target.message.thread_id]);
    if (rows.length > 1000) throw new MailSnoozeError('limit');
    return rows.map(row => z.string().parse(row.message_key));
  }
  read(accountId: string, locator: ProviderMessageLocator) {
    const target = this.target(accountId, locator), row = this.existing(accountId, target.scopeKey), members = this.members(accountId, target);
    return mailSnoozeSchema.parse({ accountId, locator: target.locator, version: row ? { generation: row.generation, revision: row.revision } : null, time: row?.until_at != null && row.until_at > this.now() ? { at: row.until_at, timeZone: row.time_zone } : null, scope: target.message.thread_id === null ? 'message' : 'conversation', count: members.length, available: members.length > 0 });
  }
  set(accountId: string, supplied: MailSnoozeSet) {
    const input = mailSnoozeSetSchema.parse(supplied);
    if (input.time && !validFutureMailTime(input.time, this.now())) throw new MailSnoozeError('invalid_time');
    return this.db.transaction(() => {
      const target = this.target(accountId, input.locator), current = this.existing(accountId, target.scopeKey);
      if (current ? !input.expected || current.generation !== input.expected.generation || current.revision !== input.expected.revision || current.revision >= Number.MAX_SAFE_INTEGER : input.expected !== null) throw new MailSnoozeError('conflict');
      const members = input.time ? this.members(accountId, target) : [];
      if (input.time && !members.length) throw new MailSnoozeError('unavailable');
      this.db.run('INSERT INTO mail_snoozes(account_id,scope_key,anchor_key,thread_id,generation,revision,until_at,time_zone,woke_at) VALUES(?,?,?,?,?,?,?,?,?) ON CONFLICT(account_id,scope_key) DO UPDATE SET revision=excluded.revision,until_at=excluded.until_at,time_zone=excluded.time_zone,woke_at=excluded.woke_at', [accountId, target.scopeKey, target.message.message_key, target.message.thread_id, current?.generation ?? randomUUID(), (current?.revision ?? 0) + 1, input.time?.at ?? null, input.time?.timeZone ?? null,input.time?null:this.now()]);
      this.db.run('DELETE FROM mail_snooze_members WHERE account_id=? AND scope_key=?', [accountId, target.scopeKey]);
      for (const key of members) this.db.run('INSERT INTO mail_snooze_members(account_id,message_key,scope_key) VALUES(?,?,?)', [accountId, key, target.scopeKey]);
      if(input.time&&!validFutureMailTime(input.time,this.now()))throw new MailSnoozeError('invalid_time');
      return this.read(accountId, input.locator);
    });
  }
  /** Bounded local wake-up. New Inbox members were not part of the user's snapshot. */
  refresh() {
    return this.db.transaction(() => {
      const rows = this.db.all(`SELECT s.* FROM mail_snoozes s JOIN mail_accounts a ON a.id=s.account_id WHERE a.owner_id=? AND s.until_at IS NOT NULL AND (s.until_at<=? OR NOT EXISTS(SELECT 1 FROM mail_snooze_members sm JOIN mail_messages m ON m.account_id=sm.account_id AND m.message_key=sm.message_key WHERE sm.account_id=s.account_id AND sm.scope_key=s.scope_key AND ${MAIL_LIVE_INBOX_SQL}) OR EXISTS(SELECT 1 FROM mail_snooze_members sm JOIN mail_messages m ON m.account_id=sm.account_id AND m.message_key=sm.message_key WHERE sm.account_id=s.account_id AND sm.scope_key=s.scope_key AND m.thread_id IS NOT s.thread_id) OR (s.thread_id IS NOT NULL AND EXISTS(SELECT 1 FROM mail_messages m WHERE m.account_id=s.account_id AND m.thread_id=s.thread_id AND ${MAIL_LIVE_INBOX_SQL} AND NOT EXISTS(SELECT 1 FROM mail_snooze_members sm WHERE sm.account_id=m.account_id AND sm.message_key=m.message_key AND sm.scope_key=s.scope_key)))) ORDER BY s.until_at,s.account_id,s.scope_key LIMIT 16`, [this.ownerId, this.now()]);
      for (const supplied of rows) {
        const row = header.parse(supplied);
        if (row.revision >= Number.MAX_SAFE_INTEGER) throw new MailSnoozeError('conflict');
        this.db.run('UPDATE mail_snoozes SET until_at=NULL,time_zone=NULL,woke_at=?,revision=revision+1 WHERE account_id=? AND scope_key=?', [this.now(),row.account_id, row.scope_key]);
        this.db.run('DELETE FROM mail_snooze_members WHERE account_id=? AND scope_key=?', [row.account_id, row.scope_key]);
      }
      return rows.length;
    });
  }
}
