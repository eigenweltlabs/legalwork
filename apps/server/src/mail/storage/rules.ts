import { randomUUID } from 'node:crypto';
import { addressParser } from 'postal-mime';
import { z } from 'zod';
import type { MailDatabase } from './database-interface.js';
import { MailCredentialRepository } from './credentials.js';
import { GraphMailboxRepository } from './graph-mailboxes.js';
import { MailLocalApiStore } from './local-api.js';
import { MailReadStore } from './read-store.js';
import { MailSnoozeStore } from './snoozes.js';
import { MAIL_LIVE_INBOX_SQL } from './snooze-sql.js';
import { providerMessageKey, providerMessageLocatorSchema, type ProviderMessageLocator } from '../model.js';
import { mailRuleDefinitionSchema, mailRuleSaveSchema, mailRuleDeleteSchema, mailRulesSchema, MailRulesError,
  type MailRuleDefinition, type MailRuleSave, type MailRuleDelete, type MailRule } from '../rules-view.js';

const rowSchema = z.object({ account_id: z.string(), id: z.string().uuid(), generation: z.string().uuid(), revision: z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  definition_json: z.string(), credential_generation: z.string().nullable(), activated_at: z.number(), after_arrival: z.number(), deleted: z.number() });
const arrivalSchema = z.object({ id: z.number().int().positive(), account_id: z.string(), message_key: z.string(), credential_generation: z.string(), observed_at: z.number() });

export function mailRuleMatches(rule: MailRuleDefinition, metadata: { from: string | null; subject: string | null }) {
  if (rule.sender) {
    if (!metadata.from || metadata.from.length > 65536) return false;
    const senders = addressParser(metadata.from);
    if (senders.length !== 1 || !senders[0].address || senders[0].address.toLowerCase() !== rule.sender.toLowerCase()) return false;
  }
  return !rule.subject || (metadata.subject ?? '').toLowerCase().includes(rule.subject.toLowerCase());
}

/** Called only inside a fenced incremental provider page, before inserting a new message. */
export function captureMailRuleArrival(db: MailDatabase, ownerId: string, accountId: string, locator: ProviderMessageLocator, now = Date.now()) {
  if (locator.provider === 'archive' || !db.get("SELECT 1 FROM mail_local_rules WHERE account_id=? AND deleted=0 AND json_extract(definition_json,'$.enabled')=1 LIMIT 1", [accountId])) return;
  const key = providerMessageKey(locator);
  if (db.get('SELECT 1 FROM mail_messages WHERE account_id=? AND message_key=?', [accountId, key])) return;
  if (!db.get('SELECT 1 FROM mail_accounts WHERE id=? AND owner_id=? AND provider=?', [accountId, ownerId, locator.provider])) return;
  const credentials = new MailCredentialRepository(db, ownerId).status(accountId);
  if (credentials.state !== 'connected' || credentials.archiveLocked || db.get('SELECT 1 FROM mail_integration_accounts WHERE account_id=? AND read_only=1', [accountId])) return;
  db.run('INSERT OR IGNORE INTO mail_rule_arrivals(account_id,message_key,credential_generation,observed_at,available_at) VALUES(?,?,?,?,?)', [accountId, key, credentials.version.generation, now, now]);
}

export class MailRulesStore {
  constructor(private db: MailDatabase, private ownerId: string, private now: () => number = Date.now) {}
  private account(accountId: string) {
    const row = this.db.get('SELECT provider FROM mail_accounts WHERE id=? AND owner_id=?', [accountId, this.ownerId]);
    if (!row) throw new MailRulesError('not_found');
    if (row.provider === 'archive' || this.db.get('SELECT 1 FROM mail_integration_accounts WHERE account_id=? AND read_only=1', [accountId])) throw new MailRulesError('unavailable');
    return z.enum(['gmail', 'graph', 'imap']).parse(row.provider);
  }
  private rules(accountId: string) {
    return this.db.all('SELECT * FROM mail_local_rules WHERE account_id=? AND deleted=0 ORDER BY CAST(json_extract(definition_json,\'$.order\') AS INTEGER),id', [accountId]).map(row => {
      const stored = rowSchema.parse(row);
      return { ...stored, definition: mailRuleDefinitionSchema.parse(JSON.parse(stored.definition_json)) };
    });
  }
  private writeAllowed(accountId: string, provider: ReturnType<MailRulesStore['account']>) {
    if (provider === 'imap') return true;
    const shared = provider === 'graph' ? new GraphMailboxRepository(this.db, this.ownerId).read(accountId) : null;
    const row = this.db.get('SELECT granted_scopes_json FROM mail_account_credentials WHERE account_id=?', [shared?.credential_account_id ?? accountId]);
    const scopes = typeof row?.granted_scopes_json === 'string' ? z.array(z.string()).parse(JSON.parse(row.granted_scopes_json)) : [];
    if (shared) { try { new GraphMailboxRepository(this.db, this.ownerId).assertWrite(accountId); } catch { return false; } }
    return provider === 'gmail' ? scopes.some(scope => ['https://www.googleapis.com/auth/gmail.modify', 'https://mail.google.com/'].includes(scope))
      : scopes.some(scope => scope === (shared ? 'Mail.ReadWrite.Shared' : 'Mail.ReadWrite') || scope === 'https://graph.microsoft.com/' + (shared ? 'Mail.ReadWrite.Shared' : 'Mail.ReadWrite'));
  }
  private status(accountId: string, rule: ReturnType<MailRulesStore['rules']>[number]): MailRule['status'] {
    if (!rule.definition.enabled) return 'disabled';
    const provider = this.account(accountId), credentials = new MailCredentialRepository(this.db, this.ownerId).status(accountId);
    if (credentials.state !== 'connected' || credentials.archiveLocked) return 'unavailable';
    if (credentials.version.generation !== rule.credential_generation) return 'connection_changed';
    if (rule.definition.action.kind !== 'snooze' && !this.writeAllowed(accountId, provider)) return 'write_permission';
    const run = this.db.get(provider === 'gmail' ? 'SELECT state,phase FROM mail_gmail_runs WHERE account_id=?'
      : provider === 'graph' ? 'SELECT state FROM mail_graph_runs WHERE account_id=?' : 'SELECT state FROM mail_imap_runs WHERE account_id=?', [accountId]);
    if (run?.state === 'paused') return 'paused';
    if (run?.state === 'attention') return 'unavailable';
    const ready = provider === 'gmail' ? run?.phase === 'history' : provider === 'graph'
      ? !!this.db.get('SELECT 1 FROM mail_graph_delta WHERE account_id=? AND baseline=0 LIMIT 1', [accountId])
      : !!this.db.get('SELECT 1 FROM mail_imap_folders WHERE account_id=? AND rules_uid_floor IS NOT NULL LIMIT 1', [accountId]);
    return ready ? 'ready' : 'waiting_sync';
  }
  read(accountId: string) {
    this.account(accountId);
    const items = this.rules(accountId).map(rule => ({ id: rule.id, version: { generation: rule.generation, revision: rule.revision }, definition: rule.definition, status: this.status(accountId, rule) }));
    const activity = this.db.all(`SELECT r.id,r.rule_name,r.observed_at,r.action,r.outcome,j.state FROM mail_rule_arrivals r LEFT JOIN mail_action_jobs j ON j.account_id=r.account_id AND j.id=r.action_id WHERE r.account_id=? AND r.rule_name IS NOT NULL ORDER BY r.id DESC LIMIT 25`, [accountId]).map(row => ({
      id: row.id, ruleName: row.rule_name, at: row.observed_at, action: row.action, outcome: row.state ?? row.outcome,
    }));
    return mailRulesSchema.parse({ accountId, items, activity });
  }
  save(accountId: string, supplied: MailRuleSave) {
    const input = mailRuleSaveSchema.parse(supplied);
    return this.db.transaction(() => {
      this.account(accountId);
      const oldRow = this.db.get('SELECT * FROM mail_local_rules WHERE account_id=? AND id=?', [accountId, input.id]), old = oldRow ? rowSchema.parse(oldRow) : null;
      if (old ? old.deleted || !input.expected || input.expected.generation !== old.generation || input.expected.revision !== old.revision || old.revision >= Number.MAX_SAFE_INTEGER : input.expected !== null) throw new MailRulesError('conflict');
      if (!old && this.rules(accountId).length >= 20) throw new MailRulesError('limit');
      const credentials = new MailCredentialRepository(this.db, this.ownerId).status(accountId);
      if (input.definition.enabled && (credentials.state !== 'connected' || credentials.archiveLocked)) throw new MailRulesError('unavailable');
      const after = z.number().parse(this.db.get('SELECT coalesce(max(id),0) AS n FROM mail_rule_arrivals WHERE account_id=?', [accountId])?.n);
      this.db.run(`INSERT INTO mail_local_rules(account_id,id,generation,revision,definition_json,credential_generation,activated_at,after_arrival) VALUES(?,?,?,?,?,?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET revision=excluded.revision,definition_json=excluded.definition_json,credential_generation=excluded.credential_generation,activated_at=excluded.activated_at,after_arrival=excluded.after_arrival`,
        [accountId, input.id, old?.generation ?? randomUUID(), (old?.revision ?? 0) + 1, JSON.stringify(input.definition), credentials.version?.generation ?? null, this.now(), after]);
      return this.read(accountId);
    });
  }
  delete(accountId: string, supplied: MailRuleDelete) {
    const input = mailRuleDeleteSchema.parse(supplied);
    return this.db.transaction(() => {
      this.account(accountId);
      const result = this.db.run('UPDATE mail_local_rules SET deleted=1,revision=revision+1 WHERE account_id=? AND id=? AND deleted=0 AND generation=? AND revision=? AND revision<?', [accountId, input.id, input.expected.generation, input.expected.revision, Number.MAX_SAFE_INTEGER]);
      if (result.changes !== 1) throw new MailRulesError('conflict');
      return this.read(accountId);
    });
  }
  /** Only trusted arrival candidates can enter this path. Local changes never create candidates. */
  run(): string[] {
    const wake = new Set<string>();
    const candidates = this.db.all(`SELECT r.* FROM mail_rule_arrivals r JOIN mail_accounts a ON a.id=r.account_id WHERE a.owner_id=? AND r.state='pending' AND r.available_at<=? ORDER BY r.available_at,r.id LIMIT 25`, [this.ownerId, this.now()]);
    for (const supplied of candidates) this.db.transaction(() => {
      const arrival = arrivalSchema.parse(supplied), accountId = arrival.account_id;
      const finish = (rule?: MailRuleDefinition, outcome?: string, actionId?: string) => this.db.run("UPDATE mail_rule_arrivals SET state='done',rule_name=?,action=?,outcome=?,action_id=? WHERE id=? AND state='pending'", [rule?.name ?? null, rule?.action.kind ?? null, outcome ?? null, actionId ?? null, arrival.id]);
      if (this.now() - arrival.observed_at > 7 * 86400000) { finish(); return; }
      const credentials = new MailCredentialRepository(this.db, this.ownerId).status(accountId);
      if (credentials.state !== 'connected' || credentials.archiveLocked || credentials.version.generation !== arrival.credential_generation || this.db.get('SELECT 1 FROM mail_integration_accounts WHERE account_id=? AND read_only=1', [accountId])) { finish(); return; }
      const rules = this.rules(accountId).filter(rule => rule.definition.enabled && rule.after_arrival < arrival.id && rule.credential_generation === arrival.credential_generation);
      if (!rules.length) { finish(); return; }
      const row = this.db.get('SELECT locator_json FROM mail_messages WHERE account_id=? AND message_key=?', [accountId, arrival.message_key]);
      if (!row) { this.defer(arrival.id); return; }
      const locator = providerMessageLocatorSchema.parse(JSON.parse(z.string().parse(row.locator_json)));
      if (locator.provider !== this.account(accountId)) { finish(); return; }
      const message = new MailReadStore(this.db, this.ownerId, this.now).read(accountId, locator);
      if (message.removed) { finish(); return; }
      const metadata = message.metadata, receivedAt = message.receivedAt;
      if (!metadata) { this.defer(arrival.id); return; }
      if (!this.db.get(`SELECT 1 FROM mail_messages m WHERE m.account_id=? AND m.message_key=? AND ${MAIL_LIVE_INBOX_SQL}`, [accountId, arrival.message_key])) { finish(); return; }
      const rule = rules.find(rule => typeof receivedAt === 'number' && receivedAt >= rule.activated_at && receivedAt <= this.now() && mailRuleMatches(rule.definition, metadata));
      if (!rule) { finish(); return; }
      const status = this.status(accountId, rule);
      if (status !== 'ready') { this.defer(arrival.id); return; }
      try {
        // Roll back an action as well as its activity if either write fails.
        this.db.transaction(() => {
          if (rule.definition.action.kind === 'snooze') {
            const snoozes = new MailSnoozeStore(this.db, this.ownerId, this.now), current = snoozes.read(accountId, locator);
            // Never replace an explicit user snooze or shorten it with an automatic rule.
            if (current.time) { finish(rule.definition, 'snoozed'); return; }
            snoozes.set(accountId, { locator, expected: current.version, time: { at: this.now() + rule.definition.action.minutes * 60000, timeZone: rule.definition.action.timeZone } });
            finish(rule.definition, 'snoozed');
          } else {
            if (!message.mutationPrecondition) { this.defer(arrival.id); return; }
            const change = rule.definition.action.kind === 'read' ? { kind: 'read', read: true } satisfies import('../local-view.js').MailMutation['change']
              : rule.definition.action.kind === 'archive' ? { kind: 'special', operation: 'archive' } satisfies import('../local-view.js').MailMutation['change']
                : { kind: 'flags', add: ['\\Flagged'], remove: [] } satisfies import('../local-view.js').MailMutation['change'];
            const action = new MailLocalApiStore(this.db, this.ownerId, this.now).enqueueMutation(accountId, { replayKey: 'rule:' + arrival.id, locator, precondition: message.mutationPrecondition, change });
            finish(rule.definition, 'queued', action.id); wake.add(accountId);
          }
        });
      } catch { finish(rule.definition, 'unavailable'); }
    });
    return [...wake];
  }
  private defer(id: number) { this.db.run('UPDATE mail_rule_arrivals SET available_at=? WHERE id=?', [this.now() + 30000, id]); }
}
