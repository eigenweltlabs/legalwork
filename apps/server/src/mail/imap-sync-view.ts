import { z } from 'zod';
const count = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
export const imapSyncViewSchema = z.object({ accountId: z.string().min(1).max(4096), provider: z.literal('imap'), state: z.enum(['idle', 'syncing', 'paused', 'waiting', 'complete', 'attention']), enumerated: count, downloaded: count, projected: count, removed: count, retained: count, failed: count, pending: count, nextRetryAt: count.nullable(), error: z.enum(['authentication_failed', 'certificate_failed', 'uidvalidity_changed', 'message_unavailable', 'content_incomplete', 'provider_unavailable', 'storage_unavailable']).nullable(), folders: count, excludedFolders: count }).strict();
export type ImapSyncView = z.infer<typeof imapSyncViewSchema>;
