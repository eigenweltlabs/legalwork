import { z } from 'zod';
import { isIP } from 'node:net';
const path = z.string().min(1).max(512).refine(value => !/[\x00\r\n]/.test(value));
export const imapSettingsSchema = z.object({ host: z.string().min(1).max(253).toLowerCase().refine(value => isIP(value) !== 0 || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(value)), port: z.number().int().min(1).max(65535).default(993), username: path, folders: z.array(path).min(1).max(100).optional() }).strict();
export const imapConnectionSchema = imapSettingsSchema.extend({ password: z.string().min(1).max(4096).refine(value => !value.includes('\0')), reconnectAccountId: z.string().min(1).max(4096).optional() }).strict();
export type ImapSettings = z.infer<typeof imapSettingsSchema>;
export type ImapConnection = z.infer<typeof imapConnectionSchema>;
export class ImapError extends Error {
    constructor(readonly code: 'invalid_input' | 'authentication_failed' | 'certificate_failed' | 'unavailable' | 'timeout' | 'cancelled' | 'too_large' | 'uidvalidity_changed' | 'message_unavailable' | 'reconnect_required' | 'stale_credentials' | 'locked' | 'busy') { super(`mail_imap_${code}`); }
    get retryable() { return this.code === 'unavailable' || this.code === 'timeout'; }
}
export const imapConnectionResultSchema = z.union([z.object({ accountId: z.string().min(1).max(4096), provider: z.literal('imap') }).strict(), z.object({ error: z.enum(['invalid_input', 'authentication_failed', 'certificate_failed', 'unavailable', 'timeout', 'cancelled', 'too_large', 'uidvalidity_changed', 'message_unavailable', 'reconnect_required', 'stale_credentials', 'locked', 'busy']) }).strict()]);
export type ImapConnectionResult = z.infer<typeof imapConnectionResultSchema>;
export const imapDiscoverySchema = z.object({ accountId: z.string().min(1).max(4096), settings: imapSettingsSchema, capabilities: z.array(z.string().max(128)).max(256), folders: z.array(z.object({ path: z.string().max(512), delimiter: z.string().max(16).nullable(), specialUse: z.string().max(64).nullable(), selected: z.boolean(), selectable: z.boolean() }).strict()).max(50), nextCursor: z.string().max(512).nullable() }).strict();
export type ImapDiscovery = z.infer<typeof imapDiscoverySchema>;
