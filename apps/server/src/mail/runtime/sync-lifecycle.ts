import type { MailDatabase } from '../storage/database-interface.js';
import { MailCredentialRepository } from '../storage/credentials.js';
import { GmailBackfill } from '../providers/gmail-backfill.js';
import { GraphBackfill } from '../providers/graph-backfill.js';
import { ImapBackfill } from '../providers/imap-backfill.js';
import type { MailAccessCoordinator } from '../providers/access-coordinator.js';
import { createStoredMimeProjector } from '../storage/mime-projection.js';

/** Each connected account owns one idempotent session; durable run state owns pause intent. */
export class MailSyncLifecycle {
  private closed = false;
  private readonly engines = new Map<string, GmailBackfill | GraphBackfill | ImapBackfill>();
  constructor(private readonly database: MailDatabase, private readonly ownerId: string, private readonly access: MailAccessCoordinator) {}
  engine(accountId: string) {
    if (this.closed) throw new Error("mail_worker_locked");
    const existing = this.engines.get(accountId);
    if (existing) return existing;
    const provider = this.database.get('SELECT provider FROM mail_accounts WHERE id=? AND owner_id=?', [accountId, this.ownerId])?.provider;
    const options = { database: this.database, ownerId: this.ownerId, access: this.access };
    const engine = provider === 'gmail' ? new GmailBackfill({ ...options, projectRaw: createStoredMimeProjector(options) })
      : provider === 'graph' ? new GraphBackfill(options) : provider === 'imap' ? new ImapBackfill(options) : undefined;
    if (!engine) throw new Error('mail_worker_not_found');
    this.engines.set(accountId, engine);
    return engine;
  }
  async suspend(accountId: string) {
    const old = this.engines.get(accountId);
    if (old) { this.engines.delete(accountId); await old.close(); }
  }
  async connected(accountId: string) { await this.suspend(accountId); return this.resume(accountId); }
  resume(accountId: string) {
    const provider = this.database.get('SELECT provider FROM mail_accounts WHERE id=? AND owner_id=?', [accountId, this.ownerId])?.provider;
    const table = provider === 'gmail' ? 'mail_gmail_runs' : provider === 'graph' ? 'mail_graph_runs' : provider === 'imap' ? 'mail_imap_runs' : undefined;
    if (!table) throw new Error('mail_worker_not_found');
    const run = this.database.get(`SELECT state FROM ${table} WHERE account_id=?`, [accountId]);
    const engine = this.engine(accountId);
    if (run?.state === 'paused' || new MailCredentialRepository(this.database, this.ownerId).status(accountId).state !== 'connected') return engine.status(accountId);
    return engine.start(accountId);
  }
  async close() { this.closed = true; await Promise.all([...this.engines.values()].map(engine => engine.close())); this.engines.clear(); }
}
