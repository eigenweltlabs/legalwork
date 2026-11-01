import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MailDatabase } from './database-interface.js';
import { MailRepository } from './repository.js';
import { providerMessageLocatorSchema, type ProviderMessageLocator } from '../model.js';
import { MailProjectError, mailProjectAssociationSchema, mailProjectHistoryInputSchema, mailProjectHistorySchema, mailProjectSetSchema, type MailProjectSet } from '../project-association-view.js';

const rowSchema = z.object({ generation: z.string().uuid(), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), project_id: z.string().nullable(), project_binding: z.string().nullable(), updated_at: z.number().int().nonnegative() });
function project(row: { project_id: string | null; project_binding: string | null }) {
  if (row.project_id === null && row.project_binding === null) return null;
  if (row.project_id === null || row.project_binding === null) throw new MailProjectError('unavailable');
  return { id: row.project_id, binding: row.project_binding };
}

/** Local private metadata only. This store cannot read or publish project files. */
export class MailProjectAssociations {
  constructor(private db: MailDatabase, private ownerId: string, private now: () => number = Date.now) {}
  private target(accountId: string, supplied: ProviderMessageLocator) {
    const locator = providerMessageLocatorSchema.parse(supplied), message = new MailRepository(this.db, this.ownerId).readMessage(accountId, locator);
    if (!message || this.db.get('SELECT 1 FROM mail_tombstones WHERE account_id=? AND message_key=?', [accountId, message.message_key])) throw new MailProjectError('not_found');
    return { locator, key: message.message_key };
  }
  private existing(accountId: string, key: string) {
    const row = this.db.get('SELECT * FROM mail_project_associations WHERE account_id=? AND message_key=?', [accountId, key]);
    return row ? rowSchema.parse(row) : null;
  }
  read(accountId: string, locator: ProviderMessageLocator) {
    const target = this.target(accountId, locator), row = this.existing(accountId, target.key);
    return mailProjectAssociationSchema.parse({ accountId, locator: target.locator, version: row ? { generation: row.generation, revision: row.revision } : null, project: row ? project(row) : null, updatedAt: row?.updated_at ?? null });
  }
  set(accountId: string, supplied: MailProjectSet) {
    const input = mailProjectSetSchema.parse(supplied);
    return this.db.transaction(() => {
      const target = this.target(accountId, input.locator), current = this.existing(accountId, target.key);
      if (current ? !input.expected || current.generation !== input.expected.generation || current.revision !== input.expected.revision || current.revision >= Number.MAX_SAFE_INTEGER : input.expected !== null) throw new MailProjectError('conflict');
      if (JSON.stringify(current ? project(current) : null) === JSON.stringify(input.project)) return this.read(accountId, input.locator);
      const generation = current?.generation ?? randomUUID(), revision = (current?.revision ?? 0) + 1, at = this.now();
      this.db.run('INSERT INTO mail_project_associations(account_id,message_key,generation,revision,project_id,project_binding,updated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,message_key) DO UPDATE SET revision=excluded.revision,project_id=excluded.project_id,project_binding=excluded.project_binding,updated_at=excluded.updated_at', [accountId, target.key, generation, revision, input.project?.id ?? null, input.project?.binding ?? null, at]);
      this.db.run('INSERT INTO mail_project_changes(account_id,message_key,generation,revision,project_id,project_binding,changed_at) VALUES(?,?,?,?,?,?,?)', [accountId, target.key, generation, revision, input.project?.id ?? null, input.project?.binding ?? null, at]);
      return this.read(accountId, input.locator);
    });
  }
  history(accountId: string, supplied: z.infer<typeof mailProjectHistoryInputSchema>) {
    const input = mailProjectHistoryInputSchema.parse(supplied), target = this.target(accountId, input.locator);
    const rows = this.db.all('SELECT generation,revision,project_id,project_binding,changed_at AS updated_at FROM mail_project_changes WHERE account_id=? AND message_key=? AND (? IS NULL OR revision<?) ORDER BY revision DESC LIMIT 21', [accountId, target.key, input.beforeRevision ?? null, input.beforeRevision ?? null]);
    const selected = rows.slice(0, 20).map(value => rowSchema.parse(value));
    return mailProjectHistorySchema.parse({ accountId, locator: target.locator, items: selected.map(row => ({ version: { generation: row.generation, revision: row.revision }, project: project(row), at: row.updated_at, source: 'manual' })), nextRevision: rows.length > 20 ? selected[selected.length - 1].revision : null });
  }
}
