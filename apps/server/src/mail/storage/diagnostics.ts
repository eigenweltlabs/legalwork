import { z } from 'zod';
import { mailDiagnosticSnapshotSchema, type MailDiagnosticSnapshot } from '../diagnostics-view.js';
import type { MailDatabase, MailSqlValue } from './database-interface.js';

/** Local observations only. Never enumerate messages, read MIME, refresh credentials or call a provider. */
export function collectMailDiagnostics(database: MailDatabase, ownerId: string, suspended: boolean, now = Date.now()): MailDiagnosticSnapshot {
  z.string().min(1).max(4096).parse(ownerId);
  z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).parse(now);
  const select = (sql: string, extra: MailSqlValue[] = []) => database.get(sql, [ownerId, ...extra]);
  const actions = (kind: 'mutation' | 'submission') => select(`SELECT
    COUNT(*) FILTER(WHERE j.state='queued') AS queued, COUNT(*) FILTER(WHERE j.state='running') AS running,
    COUNT(*) FILTER(WHERE j.state='dispatching') AS dispatching, COUNT(*) FILTER(WHERE j.state='retry') AS retry,
    COUNT(*) FILTER(WHERE j.state='succeeded') AS succeeded, COUNT(*) FILTER(WHERE j.state='failed') AS failed,
    COUNT(*) FILTER(WHERE j.state='cancelled') AS cancelled, COUNT(*) FILTER(WHERE j.state='uncertain') AS uncertain
    FROM mail_action_jobs j JOIN mail_accounts a ON a.id=j.account_id WHERE a.owner_id=? AND j.kind=?`, [kind]);
  return database.transaction(() => mailDiagnosticSnapshotSchema.parse({
    schemaVersion: database.get('SELECT version FROM mail_schema_version')?.version,
    lifecycle: suspended ? 'suspended' : 'running',
    accounts: select(`SELECT COUNT(*) FILTER(WHERE a.provider='gmail') AS gmail,
      COUNT(*) FILTER(WHERE a.provider='graph') AS graph, COUNT(*) FILTER(WHERE a.provider='imap') AS imap,
      COUNT(*) FILTER(WHERE a.provider='archive') AS archive,
      COUNT(*) FILTER(WHERE i.read_only=1) AS retainedCopies
      FROM mail_accounts a LEFT JOIN mail_integration_accounts i ON i.account_id=a.id WHERE a.owner_id=?`),
    messages: select(`SELECT COUNT(*) AS total, COUNT(*) FILTER(WHERE m.attachments_enumerated=1) AS attachmentsEnumerated
      FROM mail_messages m JOIN mail_accounts a ON a.id=m.account_id WHERE a.owner_id=?`),
    originals: select(`SELECT COUNT(*) FILTER(WHERE c.state IS NULL OR c.state='pending') AS pending,
      COUNT(*) FILTER(WHERE c.state='stored') AS stored, COUNT(*) FILTER(WHERE c.state='unavailable') AS unavailable
      FROM mail_messages m JOIN mail_accounts a ON a.id=m.account_id
      LEFT JOIN mail_content_manifests c ON c.account_id=m.account_id AND c.message_key=m.message_key AND c.kind='raw'
      WHERE a.owner_id=?`),
    attachments: select(`SELECT COUNT(*) FILTER(WHERE c.state='pending') AS pending,
      COUNT(*) FILTER(WHERE c.state='stored') AS stored, COUNT(*) FILTER(WHERE c.state='unavailable') AS unavailable
      FROM mail_content_manifests c JOIN mail_accounts a ON a.id=c.account_id WHERE a.owner_id=? AND c.kind='attachment'`),
    syncJobs: select(`SELECT COUNT(*) FILTER(WHERE j.state='queued') AS queued,
      COUNT(*) FILTER(WHERE j.state='running') AS running, COUNT(*) FILTER(WHERE j.state='retry') AS retry,
      COUNT(*) FILTER(WHERE j.state='succeeded') AS succeeded, COUNT(*) FILTER(WHERE j.state='failed') AS failed
      FROM mail_sync_jobs j JOIN mail_accounts a ON a.id=j.account_id WHERE a.owner_id=?`),
    mutations: actions('mutation'),
    submissions: actions('submission'),
    drafts: select(`SELECT COUNT(*) FILTER(WHERE d.deleted=0) AS active, COUNT(*) FILTER(WHERE d.deleted=1) AS deleted
      FROM mail_local_drafts d JOIN mail_accounts a ON a.id=d.account_id WHERE a.owner_id=?`),
    schedules: database.get(`SELECT COUNT(*) AS queued, COUNT(*) FILTER(WHERE s.scheduled_at<=?) AS due
      FROM mail_accounts a JOIN mail_outbox_schedules s ON s.account_id=a.id
      JOIN mail_action_jobs j ON j.account_id=s.account_id AND j.id=s.action_id
      WHERE a.owner_id=? AND j.state IN ('queued','retry')`, [now, ownerId]),
    search: {
      indexed: select(`SELECT COUNT(*) AS value FROM mail_search_documents s JOIN mail_accounts a ON a.id=s.account_id WHERE a.owner_id=?`)?.value,
      pending: select(`SELECT COUNT(*) AS value FROM mail_search_dirty s JOIN mail_accounts a ON a.id=s.account_id WHERE a.owner_id=?`)?.value,
    },
    invitationReplies: select(`SELECT COUNT(*) FILTER(WHERE state='confirmed') AS confirmed,
      COUNT(*) FILTER(WHERE state='rejected') AS rejected, COUNT(*) FILTER(WHERE state='uncertain') AS uncertain
      FROM mail_invitation_replies WHERE owner_id=?`),
  }));
}
