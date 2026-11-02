import { randomUUID } from 'node:crypto';
import type { MailDatabase } from './database-interface.js';
import { MailReadStore } from './read-store.js';
import { MailProjectAssociations } from './project-associations.js';
import { classifyMailProject } from '../classifier.js';
import { MailProjectError } from '../project-association-view.js';
import { emptyMailClassifier, mailClassifierConfigSchema, mailClassifierDefinitionSchema, mailClassifierSaveSchema, mailClassifierPreviewInputSchema, mailClassifierPreviewSchema, MailClassifierError, type MailClassifierSave } from '../classifier-view.js';
import type { ProviderMessageLocator } from '../model.js';
import { MailCredentialRepository } from './credentials.js';
import { z } from 'zod';

export class MailClassifierStore {
  constructor(private db: MailDatabase, private ownerId: string, private now: () => number = Date.now,private canAutomate:()=>boolean=()=>true) {}
  private account(accountId: string) {
    const row=this.db.get('SELECT provider FROM mail_accounts WHERE id=? AND owner_id=?', [accountId, this.ownerId]);
    if (!row) throw new MailClassifierError('not_found');
    return z.enum(['gmail','graph','imap','archive']).parse(row.provider);
  }
  private eligible(accountId:string,provider:ReturnType<MailClassifierStore['account']>){
    if(provider==='archive'||this.db.get('SELECT 1 FROM mail_integration_accounts WHERE account_id=? AND read_only=1',[accountId]))return false;
    const credential=new MailCredentialRepository(this.db,this.ownerId).status(accountId);
    return credential.state==='connected'&&!credential.archiveLocked;
  }
  private automaticStatus(accountId:string,provider:ReturnType<MailClassifierStore['account']>,generation:unknown):import('../classifier-view.js').MailClassifierConfig['automaticStatus']{
    if(provider==='archive'||this.db.get('SELECT 1 FROM mail_integration_accounts WHERE account_id=? AND read_only=1',[accountId]))return 'unavailable';
    const credential=new MailCredentialRepository(this.db,this.ownerId).status(accountId);
    if(credential.state!=='connected'||credential.archiveLocked)return 'unavailable';
    if(credential.version.generation!==generation)return 'connection_changed';
    if(!this.canAutomate())return 'paused';
    const run=this.db.get(provider==='gmail'?'SELECT state,phase FROM mail_gmail_runs WHERE account_id=?':provider==='graph'?'SELECT state FROM mail_graph_runs WHERE account_id=?':'SELECT state FROM mail_imap_runs WHERE account_id=?',[accountId]);
    if(run?.state==='paused')return 'paused';if(run?.state==='attention')return 'unavailable';
    const ready=provider==='gmail'?run?.phase==='history':provider==='graph'?!!this.db.get('SELECT 1 FROM mail_graph_delta WHERE account_id=? AND baseline=0 LIMIT 1',[accountId]):!!this.db.get('SELECT 1 FROM mail_imap_folders WHERE account_id=? AND rules_uid_floor IS NOT NULL LIMIT 1',[accountId]);
    return ready?'ready':'waiting_sync';
  }
  read(accountId: string) {
    const provider=this.account(accountId);
    const row = this.db.get('SELECT * FROM mail_project_classifiers WHERE account_id=?', [accountId]);
    const definition=mailClassifierDefinitionSchema.parse(row?JSON.parse(String(row.definition_json)):emptyMailClassifier);
    return mailClassifierConfigSchema.parse({ accountId, version: row ? { generation: row.generation, revision: row.revision } : null, definition,automaticEligible:this.eligible(accountId,provider),automaticStatus:definition.mode==='automatic'?this.automaticStatus(accountId,provider,row?.credential_generation):'off' });
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
      let credentialGeneration:string|null=null;
      if(definition.data.mode==='automatic'){
        if(this.account(accountId)==='archive'||this.db.get('SELECT 1 FROM mail_integration_accounts WHERE account_id=? AND read_only=1',[accountId]))throw new MailClassifierError('unavailable');
        const credential=new MailCredentialRepository(this.db,this.ownerId).status(accountId);
        if(credential.state!=='connected'||credential.archiveLocked)throw new MailClassifierError('unavailable');
        credentialGeneration=credential.version.generation;
      }
      this.db.run('INSERT INTO mail_project_classifiers(account_id,generation,revision,definition_json,updated_at,credential_generation,activated_at) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET revision=excluded.revision,definition_json=excluded.definition_json,updated_at=excluded.updated_at,credential_generation=excluded.credential_generation,activated_at=excluded.activated_at', [accountId, version?.generation ?? randomUUID(), (version?.revision ?? 0) + 1, JSON.stringify(definition.data), this.now(),credentialGeneration,this.now()]);
      return this.read(accountId);
    });
  }
  preview(accountId: string, supplied: { locator: ProviderMessageLocator }) {
    const input = mailClassifierPreviewInputSchema.parse(supplied), config = this.read(accountId);
    try {
      const assignment = new MailProjectAssociations(this.db, this.ownerId, this.now).read(accountId, input.locator);
      const base = { accountId, locator: input.locator, version: config.version };
      if (config.definition.mode === 'off' || assignment.version !== null&&assignment.source!=='automatic') return mailClassifierPreviewSchema.parse({ ...base, status: config.definition.mode === 'off' ? 'off' : 'manual', candidates: [] });
      const message = new MailReadStore(this.db, this.ownerId, this.now).read(accountId, input.locator);
      return mailClassifierPreviewSchema.parse({ ...base, ...(message.metadata ? classifyMailProject(config.definition, {from:message.metadata.from,subject:message.metadata.subject}) : { status: 'unavailable', candidates: [] }) });
    } catch (error) { if (error instanceof MailProjectError) throw new MailClassifierError(error.code === 'not_found' ? 'not_found' : 'unavailable'); throw error; }
  }
}
