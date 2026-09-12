import { createHash } from 'node:crypto';
import { z } from 'zod';
import { providerMessageKey, type ProviderMessageLocator } from '../model.js';
import type { MailDatabase } from './database-interface.js';
import { storedImapPrecondition } from './imap-incremental.js';

export function gmailMutationPrecondition(labels: string[]) {
  return 'gmail:' + createHash('sha256').update(JSON.stringify([...new Set(labels)].sort())).digest('hex');
}
export function graphMutationPrecondition(changeKey: string) {
  return 'graph:' + createHash('sha256').update(changeKey).digest('hex');
}
export function folderMutationPrecondition(folder: {name:string;parentId:string|null}) {
  return 'folder:' + createHash('sha256').update(JSON.stringify([folder.name, folder.parentId])).digest('hex');
}
export function storedFolderMutationPrecondition(db: MailDatabase, accountId: string, folderId: string): string | null {
  const provider = db.get('SELECT provider FROM mail_accounts WHERE id=?', [accountId])?.provider;
  if(provider==='archive')return null;
  const row = db.get('SELECT name,parent_id FROM mail_folders WHERE account_id=? AND id=?', [accountId,folderId]);
  if (!row) return null;
  if (provider === 'imap') return 'imap-mailbox-v1';
  if (provider === 'gmail') return folderMutationPrecondition({name:z.string().parse(row.name),parentId:null});
  const raw = db.get('SELECT metadata_json FROM mail_graph_delta WHERE account_id=? AND folder_id=? AND metadata_json IS NOT NULL', [accountId,folderId]) ?? db.get('SELECT metadata_json FROM mail_graph_folder_queue WHERE account_id=? AND id=?',[accountId,folderId]);
  if (typeof raw?.metadata_json !== 'string') return null;
  const metadata = z.object({displayName:z.string(),parentFolderId:z.string()}).parse(JSON.parse(raw.metadata_json));
  return folderMutationPrecondition({name:metadata.displayName,parentId:metadata.parentFolderId});
}
/** Provider observations, never locally optimistic state, authorize a queued mutation. */
export function storedMutationPrecondition(db: MailDatabase, accountId: string, locator: ProviderMessageLocator) {
  if (locator.provider === 'archive') return null;
  if (locator.provider === 'imap') return storedImapPrecondition(db, accountId, locator);
  const key = providerMessageKey(locator);
  if (locator.provider === 'gmail') {
    if (!db.get('SELECT 1 FROM mail_gmail_metadata WHERE account_id=? AND message_key=?', [accountId, key])) return null;
    const labels = db.all('SELECT folder_id FROM mail_memberships WHERE account_id=? AND message_key=? ORDER BY folder_id', [accountId, key]);
    return gmailMutationPrecondition(labels.map(row => z.string().parse(row.folder_id)));
  }
  const row = db.get('SELECT metadata_json FROM mail_graph_messages WHERE account_id=? AND message_key=?', [accountId, key]);
  if (typeof row?.metadata_json !== 'string') return null;
  return graphMutationPrecondition(z.object({ changeKey: z.string() }).parse(JSON.parse(row.metadata_json)).changeKey);
}
