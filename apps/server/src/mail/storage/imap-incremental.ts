import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { MailDatabase } from './database-interface.js';
import { providerMessageKey, type ProviderMessageLocator } from '../model.js';
export const IMAP_INCREMENTAL_SQL = `
ALTER TABLE mail_imap_runs ADD COLUMN poll_at INTEGER;
ALTER TABLE mail_imap_runs ADD COLUMN epoch_resets INTEGER NOT NULL DEFAULT 0 CHECK(epoch_resets BETWEEN 0 AND 3);
ALTER TABLE mail_imap_messages ADD COLUMN flags_json TEXT NOT NULL DEFAULT '[]' CHECK(json_valid(flags_json));
ALTER TABLE mail_imap_messages ADD COLUMN modseq TEXT;
ALTER TABLE mail_imap_messages ADD COLUMN seen_generation TEXT;
ALTER TABLE mail_imap_folders ADD COLUMN highest_modseq TEXT;
ALTER TABLE mail_imap_folders ADD COLUMN scan_modseq TEXT;
CREATE TABLE mail_imap_action_results(account_id TEXT NOT NULL,id TEXT NOT NULL,result TEXT NOT NULL CHECK(result IN ('confirmed','unknown','unsupported','conflict','rejected')),PRIMARY KEY(account_id,id),FOREIGN KEY(account_id,id) REFERENCES mail_action_jobs(account_id,id));
`;
export const imapFlags = z.array(z.string().regex(/^(?:\\(?:Seen|Answered|Flagged|Deleted|Draft|Recent)|[A-Za-z0-9_$-]{1,128})$/)).max(100);
export function imapPrecondition(locator: ProviderMessageLocator, flags: string[], modseq: string | null): string {
    return 'imap-v1:' + createHash('sha256').update(JSON.stringify([providerMessageKey(locator), [...flags].sort(), modseq])).digest('hex');
}
export function storedImapPrecondition(db: MailDatabase, accountId: string, locator: ProviderMessageLocator): string | null {
    if (locator.provider !== 'imap')
        return null;
    const row = db.get('SELECT flags_json,modseq FROM mail_imap_messages WHERE account_id=? AND message_key=?', [accountId, providerMessageKey(locator)]);
    if (!row)
        return null;
    return imapPrecondition(locator, z.array(z.string()).parse(JSON.parse(z.string().parse(row.flags_json))), z.string().nullable().parse(row.modseq));
}
/** Presence changes preserve the message, originals, memberships, draft pins and action records. */
export function removeImapMessage(db: MailDatabase, accountId: string, key: string) {
    db.run("INSERT INTO mail_tombstones(account_id,message_key,reason,observed_at) VALUES(?,?,'imap_removed',?) ON CONFLICT(account_id,message_key) DO UPDATE SET reason='imap_removed',observed_at=excluded.observed_at", [accountId, key, new Date().toISOString()]);
}
