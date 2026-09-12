import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { MailDatabase } from './database-interface.js';
import { MailCredentialRepository } from './credentials.js';
import { MailReadStore } from './read-store.js';
import { mailNotificationBatchSchema, mailNotificationPollSchema, type MailNotificationPoll } from '../notification-view.js';
import { providerMessageLocatorSchema } from '../model.js';
const number = z.number().int().nonnegative(), text = z.string();
const clean = (value: string, limit: number) => value.replace(/[\x00-\x1f\x7f\u202a-\u202e\u2066-\u2069]/g, ' ').slice(0, limit);
/** At-most-once claims; no notification for pre-epoch mail or historical update events. */
export class MailNotificationStore {
    constructor(private db: MailDatabase, private ownerId: string, private now: () => number = Date.now) { }
    poll(supplied: MailNotificationPoll) {
        const input = mailNotificationPollSchema.parse(supplied), now = this.now(), items: z.infer<typeof mailNotificationBatchSchema>['items'] = [];
        let suppressed = 0, remainingEvents = 1000;
        return this.db.transaction(() => {
            const credentials = new MailCredentialRepository(this.db, this.ownerId), reads = new MailReadStore(this.db, this.ownerId);
            const accounts = this.db.all("SELECT id,provider FROM mail_accounts WHERE owner_id=? AND provider IN ('gmail','graph','imap') ORDER BY id LIMIT 200", [this.ownerId]).map(account => ({ account, status: credentials.status(text.parse(account.id)) })).filter(({ status }) => status.state === 'connected' && !status.archiveLocked);
            const perAccount = Math.max(1, Math.floor(1000 / Math.max(1, accounts.length)));
            for (const { account, status } of accounts) {
                if (!status.version)
                    continue;
                const accountId = text.parse(account.id);
                const eventGeneration = text.parse(this.db.get('SELECT generation FROM mail_local_event_streams WHERE account_id=?', [accountId])?.generation), head = number.parse(this.db.get('SELECT coalesce(max(sequence),0) n FROM mail_local_events WHERE account_id=?', [accountId])?.n);
                const previous = this.db.get('SELECT * FROM mail_notification_accounts WHERE account_id=?', [accountId]);
                // Arm only after the account's first discovery finishes. Arrival timestamps alone
                // cannot distinguish a historical import whose server date was rewritten.
                if (!previous) {
                    const ready = account.provider === 'gmail' ? this.db.get("SELECT 1 FROM mail_gmail_runs WHERE account_id=? AND phase='history'", [accountId]) : account.provider === 'graph' ? this.db.get("SELECT 1 FROM mail_graph_runs WHERE account_id=? AND state='complete'", [accountId]) : this.db.get("SELECT 1 FROM mail_imap_runs WHERE account_id=? AND (state='complete' OR poll_at IS NOT NULL)", [accountId]);
                    if (!ready)
                        continue;
                }
                if (!input.enabled || !previous || previous.session_id !== input.sessionId || previous.credential_generation !== status.version.generation || previous.event_generation !== eventGeneration) {
                    this.db.run('INSERT INTO mail_notification_accounts VALUES(?,?,?,?,?,?) ON CONFLICT(account_id) DO UPDATE SET session_id=excluded.session_id,credential_generation=excluded.credential_generation,event_generation=excluded.event_generation,baseline_at=excluded.baseline_at,after_sequence=excluded.after_sequence', [accountId, input.sessionId, status.version.generation, eventGeneration, now, head]);
                    continue;
                }
                if (remainingEvents <= 0)
                    continue;
                const baseline = number.parse(previous.baseline_at), after = number.parse(previous.after_sequence), events = this.db.all('SELECT sequence,kind,entity_id FROM mail_local_events WHERE account_id=? AND sequence>? ORDER BY sequence LIMIT ?', [accountId, after, Math.min(perAccount, remainingEvents)]);
                remainingEvents -= events.length;
                const seen = new Set<string>();
                for (const event of events) {
                    if (event.kind !== 'message.changed' || typeof event.entity_id !== 'string' || seen.has(event.entity_id))
                        continue;
                    seen.add(event.entity_id);
                    const row = this.db.get(`SELECT m.locator_json,m.is_read,CASE WHEN im.internal_date>=0 THEN im.internal_date WHEN gm.internal_date>=0 THEN gm.internal_date WHEN unixepoch(json_extract(gr.metadata_json,'$.receivedDateTime'),'subsec')>=0 THEN CAST(unixepoch(json_extract(gr.metadata_json,'$.receivedDateTime'),'subsec')*1000 AS INTEGER) END received_at
     FROM mail_messages m LEFT JOIN mail_gmail_metadata gm ON gm.account_id=m.account_id AND gm.message_key=m.message_key LEFT JOIN mail_imap_messages im ON im.account_id=m.account_id AND im.message_key=m.message_key LEFT JOIN mail_graph_messages gr ON gr.account_id=m.account_id AND gr.message_key=m.message_key
     WHERE m.account_id=? AND m.message_key=? AND NOT EXISTS(SELECT 1 FROM mail_notification_claims c WHERE c.account_id=m.account_id AND c.message_key=m.message_key)
     AND NOT EXISTS(SELECT 1 FROM mail_tombstones t WHERE t.account_id=m.account_id AND t.message_key=m.message_key)
     AND EXISTS(SELECT 1 FROM mail_memberships f JOIN mail_folders ff ON ff.account_id=f.account_id AND ff.id=f.folder_id WHERE f.account_id=m.account_id AND f.message_key=m.message_key AND ff.role='inbox')
     AND NOT EXISTS(SELECT 1 FROM mail_memberships f LEFT JOIN mail_imap_folders i ON i.account_id=f.account_id AND i.path=f.folder_id WHERE f.account_id=m.account_id AND f.message_key=m.message_key AND ((m.provider='gmail' AND f.folder_id IN ('SPAM','TRASH')) OR i.special_use IN ('\\Junk','\\Trash')))`, [accountId, event.entity_id]);
                    if (!row || typeof row.received_at !== 'number' || row.received_at < baseline || row.received_at > now)
                        continue;
                    const locator = providerMessageLocatorSchema.parse(JSON.parse(text.parse(row.locator_json))), message = reads.read(accountId, locator);
                    if (locator.provider === 'gmail' ? !this.db.get("SELECT 1 FROM mail_memberships WHERE account_id=? AND message_key=? AND folder_id='UNREAD'", [accountId, event.entity_id]) : row.is_read !== 0)
                        continue;
                    this.db.run('INSERT INTO mail_notification_claims VALUES(?,?,?)', [accountId, event.entity_id, now]);
                    if (items.length >= 5) {
                        suppressed++;
                        continue;
                    }
                    const title = input.preview === 'none' ? 'New mail' : clean(message.metadata?.from ?? 'New mail', 200), body = input.preview === 'subject' ? clean(message.subject || '(No subject)', 300) : 'Open LegalWork to read this message.';
                    const item = { id: randomUUID(), target: { accountId, locator }, title, body };
                    if (Buffer.byteLength(JSON.stringify([...items, item]), 'utf8') > 48000) {
                        suppressed++;
                        continue;
                    }
                    items.push(item);
                }
                if (events.length)
                    this.db.run('UPDATE mail_notification_accounts SET after_sequence=? WHERE account_id=?', [number.parse(events.at(-1)?.sequence), accountId]);
            }
            return mailNotificationBatchSchema.parse({ items, suppressed });
        });
    }
}
