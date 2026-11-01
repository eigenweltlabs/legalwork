import { randomUUID } from 'node:crypto';
import type { MailDatabase } from './database-interface.js';
import { MailReadStore } from './read-store.js';
import { MailProjectAssociations } from './project-associations.js';
import { classifyMailProject } from '../classifier.js';
import { MailProjectError } from '../project-association-view.js';
import { emptyMailClassifier, mailClassifierConfigSchema, mailClassifierDefinitionSchema, mailClassifierSaveSchema, mailClassifierPreviewInputSchema, mailClassifierPreviewSchema, MailClassifierError, type MailClassifierSave } from '../classifier-view.js';
import type { ProviderMessageLocator } from '../model.js';

export class MailClassifierStore {
  constructor(private db: MailDatabase, private ownerId: string, private now: () => number = Date.now) {}
  private account(accountId: string) {
    if (!this.db.get('SELECT 1 FROM mail_accounts WHERE id=? AND owner_id=?', [accountId, this.ownerId])) throw new MailClassifierError('not_found');
  }
  read(accountId: string) {
    this.account(accountId);
    const row = this.db.get('SELECT * FROM mail_project_classifiers WHERE account_id=?', [accountId]);
    return mailClassifierConfigSchema.parse({ accountId, version: row ? { generation: row.generation, revision: row.revision } : null, definition: row ? JSON.parse(String(row.definition_json)) : emptyMailClassifier });
  }
  save(accountId: string, supplied: MailClassifierSave) {
    const parsed = mailClassifierSaveSchema.safeParse(supplied); if (!parsed.success) throw new MailClassifierError('invalid_input');
    const input = parsed.data;
    return this.db.transaction(() => {
      const current = this.read(accountId), version = current.version;
      if (version ? !input.expected || version.generation !== input.expected.generation || version.revision !== input.expected.revision || version.revision >= Number.MAX_SAFE_INTEGER : input.expected !== null) throw new MailClassifierError('conflict');
      const rules = input.definition.rules.map(rule => ({ ...rule, project: rule.project ?? current.definition.rules.find(old => old.id === rule.id)?.project }));
      const definition = mailClassifierDefinitionSchema.safeParse({ ...input.definition, rules });
      if (!definition.success) throw new MailClassifierError('invalid_input');
      this.db.run('INSERT INTO mail_project_classifiers(account_id,generation,revision,definition_json,updated_at) VALUES(?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,definition_json=excluded.definition_json,updated_at=excluded.updated_at', [accountId, version?.generation ?? randomUUID(), (version?.revision ?? 0) + 1, JSON.stringify(definition.data), this.now()]);
      return this.read(accountId);
    });
  }
  preview(accountId: string, supplied: { locator: ProviderMessageLocator }) {
    const input = mailClassifierPreviewInputSchema.parse(supplied), config = this.read(accountId);
    try {
      const assignment = new MailProjectAssociations(this.db, this.ownerId, this.now).read(accountId, input.locator);
      const base = { accountId, locator: input.locator, version: config.version };
      if (config.definition.mode === 'off' || assignment.version !== null) return mailClassifierPreviewSchema.parse({ ...base, status: config.definition.mode === 'off' ? 'off' : 'manual', candidates: [] });
      const message = new MailReadStore(this.db, this.ownerId, this.now).read(accountId, input.locator);
      return mailClassifierPreviewSchema.parse({ ...base, ...(message.metadata ? classifyMailProject(config.definition, {from:message.metadata.from,subject:message.metadata.subject}) : { status: 'unavailable', candidates: [] }) });
    } catch (error) { if (error instanceof MailProjectError) throw new MailClassifierError(error.code === 'not_found' ? 'not_found' : 'unavailable'); throw error; }
  }
}
