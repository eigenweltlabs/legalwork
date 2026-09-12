import {outboxErrors} from './mail-outbox-errors';
import {outboxErrorSchema} from '../../../../../server/src/mail/outbox-view';
import {senderListSchema,type SenderSettings,type SenderConfigure} from '../../../../../server/src/mail/sender-view';
import { graphMailboxIdentitySchema, graphMailboxResultSchema, type GraphMailboxInput } from '../../../../../server/src/mail/graph-mailbox-view';
import { z } from 'zod';
import type { MailMessageView, MailPartView } from '../../../../../server/src/mail/read-view';
import type { MailAccountView, MailFolderView, MailPage } from '../../../../../server/src/mail/service-interface';
const id = z.string().min(1).max(32768);
const metadata = z.object({ subject: z.string().nullable(), from: z.string().nullable(), to: z.string().nullable(), cc: z.string().nullable(), bcc: z.string().nullable(), replyTo: z.string().nullable(), date: z.string().nullable(), messageId: z.string().nullable() });
export const locator = z.discriminatedUnion('provider', [z.object({ provider: z.literal('gmail'), messageId: id }), z.object({ provider: z.literal('graph'), messageId: id }), z.object({ provider: z.literal('imap'), mailboxId: id, uidValidity: z.number().int().positive(), uid: z.number().int().positive() })]);
const message = z.object({ accountId: id, key: id, locator, subject: z.string(), rawReferenceId: id.nullable().optional(), receivedAt: z.number().nullable().optional(), isRead: z.boolean().nullable().optional(), isFlagged:z.boolean().nullable().optional(), mutationPrecondition:z.string().nullable().optional(), threadId: id.nullable(), rfcMessageId: z.string().nullable(), removed: z.boolean(), memberships: z.array(id), contentState: z.enum(['complete', 'downloading', 'attention']), metadata: metadata.nullable() });
const part = z.object({ key: id, kind: z.enum(['raw', 'body', 'attachment']), partId: z.string(), state: z.enum(['stored', 'pending', 'unavailable']), referenceId: id.nullable(), bytes: z.number().int().nonnegative().nullable(), sha256: id.nullable(), bytesAvailable: z.boolean(), filename: z.string().nullable(), contentType: z.string().nullable(), contentId: z.string().nullable() });
const account = z.object({ id, provider: z.enum(['gmail', 'graph', 'imap']), displayName: z.string(), personal: z.boolean().optional(), identity: graphMailboxIdentitySchema.optional() });
const folder = z.object({ id, name: z.string(), kind: z.enum(['folder', 'label']), parentId: id.nullable(), mutationPrecondition:z.string().nullable().optional(), role: z.literal("inbox").optional() });
const page = <T extends z.ZodType>(item: T) => z.object({ items: z.array(item), nextCursor: id.nullable() });
export const bodyEnvelope = z.object({ version: z.literal(1), bodies: z.array(z.object({ partId: z.string(), contentType: z.enum(['text/plain', 'text/html']), text: z.string() })).max(2000) });
export const syncSchema = z.object({ state: z.string(), enumerated: z.number(), downloaded: z.number(), projected: z.number(), failed: z.number(), pending: z.number(), error: z.string().nullable(), unsupportedScopes: z.array(z.string()).optional(), inaccessible: z.number().optional(), referenceAttachments: z.number().optional() });
export type SyncStatus = z.infer<typeof syncSchema>;
export type { MailMessageView, MailPartView, MailAccountView, MailFolderView, MailPage };
export function mailOrigin(value: string): string {
    // Validate raw spelling before URL normalization (127.1 / integer / octal hosts normalize).
    if (!/^http:\/\/(127\.0\.0\.1|\[::1\]):[1-9]\d{0,4}\/?$/.test(value))
        throw Error('Mail requires the local desktop server.');
    const url = new URL(value);
    if (Number(url.port) > 65535 || !url.port)
        throw Error('Invalid local mail endpoint.');
    return url.origin;
}
export class MailClient {
    private readonly origin: string;
    constructor(base: string, private readonly token: string, private readonly transport: typeof fetch = (input, init) => fetch(input, init)) { this.origin = mailOrigin(base); if (!token)
        throw Error('Local host authentication is unavailable.'); }
    async request<T>(path: string, schema: {parse(value:unknown):T}, signal: AbortSignal, body?: unknown, post = false, timeoutMs = 15000): Promise<T> {
        const response = await this.transport(this.origin + '/mail/v1' + path, { method: body !== undefined || post ? 'POST' : 'GET', headers: { 'X-LegalWork-Host-Token': this.token, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) }, body: body === undefined ? undefined : JSON.stringify(body), signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]), redirect: 'error', cache: 'no-store', credentials: 'omit' });
        if (!response.ok) {
            if(response.status===409){const value=await response.clone().json().catch(()=>null);const parsed=outboxErrorSchema.safeParse(typeof value?.error?.code==='string'?value.error.code.replace(/^mail_outbox_/,''):typeof value?.code==='string'?value.code.replace(/^mail_outbox_/,''):'');if(parsed.success)throw Error(outboxErrors[parsed.data]);}
            throw Error(response.status === 423 ? 'Mail is temporarily unavailable. Please retry.' : response.status === 404 ? 'This account or message is unavailable.' : response.status === 401 ? 'Local host authentication expired.' : `Mail request failed (${response.status}).`);
        }
        return schema.parse(await response.json());
    }
    changeCursor(accountId:string,signal:AbortSignal){return this.request(`/accounts/${encodeURIComponent(accountId)}/events/query`,z.object({stream:z.string(),nextCursor:z.number()}),signal,{cursorOnly:true});}
    status(signal: AbortSignal) { return this.request('/status', z.object({ state: z.string() }), signal); }
    unlock(signal: AbortSignal) { return this.request('/unlock', z.object({ state: z.string() }), signal, undefined, true); }
    lock(signal: AbortSignal) { return this.request('/lock', z.object({ state: z.string() }), signal, undefined, true); }
    senders(accountId:string,signal:AbortSignal,refresh=false){return this.request(`/accounts/${encodeURIComponent(accountId)}/senders${refresh?'/refresh':''}`,senderListSchema,signal,undefined,refresh,90000);}
    senderSettings(accountId:string,input:SenderSettings,signal:AbortSignal){return this.request(`/accounts/${encodeURIComponent(accountId)}/senders/settings`,senderListSchema,signal,input);}
    configureSender(accountId:string,input:SenderConfigure,signal:AbortSignal){return this.request(`/accounts/${encodeURIComponent(accountId)}/senders/configure`,senderListSchema,signal,input);}
    configureGraphMailbox(input:GraphMailboxInput,signal:AbortSignal){return this.request('/graph/mailboxes',graphMailboxResultSchema,signal,input);}
    accounts(signal: AbortSignal, after?: string) { return this.request('/accounts?limit=100' + (after ? '&after=' + encodeURIComponent(after) : ''), page(account), signal); }
    folders(accountId: string, signal: AbortSignal, after?: string) { return this.request(`/accounts/${encodeURIComponent(accountId)}/folders?limit=100` + (after ? '&after=' + encodeURIComponent(after) : ''), page(folder), signal); }
    messages(accountId: string, input: {
        after?: string;
        folderId?: string;
        threadId?: string;
        inboxOnly?: boolean;
    }, signal: AbortSignal) { return this.request(`/accounts/${encodeURIComponent(accountId)}/messages/query`, page(message), signal, { ...input, limit: 25, order: 'received' }); }
    readLocator(accountId:string, locator:MailMessageView["locator"], signal:AbortSignal){return this.request(`/accounts/${encodeURIComponent(accountId)}/messages/read`,message,signal,{locator});}
    check(item: MailMessageView, signal: AbortSignal) { return this.request(`/accounts/${encodeURIComponent(item.accountId)}/messages/read`, message, signal, { locator: item.locator }); }
    parts(item: MailMessageView, signal: AbortSignal, after?: string) { return this.request(`/accounts/${encodeURIComponent(item.accountId)}/messages/parts`, page(part), signal, { locator: item.locator, page: { limit: 100, ...(after ? { after } : {}) } }); }
    sync(accountId: string, signal: AbortSignal, operation?: 'start' | 'pause') { return this.request(`/accounts/${encodeURIComponent(accountId)}/sync${operation ? '/' + operation : ''}`, syncSchema, signal, undefined, Boolean(operation)); }
    async bytes(item: MailMessageView, part: MailPartView, signal: AbortSignal, maxBytes = 64 * 1024 * 1024): Promise<Uint8Array<ArrayBuffer>> {
        if (!part.bytesAvailable || part.bytes === null || part.bytes > maxBytes || !part.referenceId || !part.sha256)
            throw Error('This content is unavailable offline or exceeds the reader limit.');
        const output = new Uint8Array(part.bytes);
        let offset = 0;
        do {
            const value: {
                accountId: string;
                referenceId: string;
                offset: number;
                totalBytes: number;
                sha256: string;
                data: string;
                nextOffset: number | null;
            } = await this.request(`/accounts/${encodeURIComponent(item.accountId)}/messages/content`, z.object({ accountId: id, referenceId: id, offset: z.number(), totalBytes: z.number(), sha256: id, data: z.string().max(32768), nextOffset: z.number().nullable() }), signal, { locator: item.locator, request: { kind: part.kind, partId: part.partId, referenceId: part.referenceId, offset, limit: 24576 } });
            const bytes = Uint8Array.from(atob(value.data), char => char.charCodeAt(0));
            if (value.accountId !== item.accountId || value.referenceId !== part.referenceId || value.totalBytes !== output.length || value.sha256 !== part.sha256 || value.offset !== offset || offset + bytes.length > output.length || value.nextOffset !== (offset + bytes.length === output.length ? null : offset + bytes.length) || (!bytes.length && output.length))
                throw Error('Stored content changed. Reload the message.');
            output.set(bytes, offset);
            offset += bytes.length;
            if (value.nextOffset === null)
                break;
        } while (offset < output.length);
        const hash = Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', output)), byte => byte.toString(16).padStart(2, '0')).join('');
        if (signal.aborted)
            throw Error('Cancelled');
        if (hash !== part.sha256)
            throw Error('Stored content failed its integrity check.');
        return output;
    }
}
/** Keyset pages are merged only after every account has a current head. */
export class UnifiedMailPages {
    readonly exclusions: {
        accountId: string;
        reason: string;
    }[] = [];
    private streams: {
        accountId: string;
        buffer: MailMessageView[];
        cursor: string | null;
        started: boolean;
    }[];
    constructor(private client: MailClient, accounts: MailAccountView[], private folderId?: string, private threadId?: string, private inboxOnly = false) { this.streams = accounts.map(account => ({ accountId: account.id, buffer: [], cursor: null, started: false })); }
    get hasMore() { return this.streams.some(stream => !stream.started || stream.buffer.length > 0 || stream.cursor !== null); }
    async next(signal: AbortSignal): Promise<MailMessageView[]> {
        const output: MailMessageView[] = [];
        for (let count = 0; count < 25; count++) {
            for (const stream of this.streams)
                if (!stream.buffer.length && (!stream.started || stream.cursor !== null)) {
                    try {
                        const response = await this.client.messages(stream.accountId, { ...(stream.cursor ? { after: stream.cursor } : {}), ...(this.folderId ? { folderId: this.folderId } : {}), ...(this.threadId ? { threadId: this.threadId } : {}), inboxOnly: this.inboxOnly }, signal);
                        stream.buffer = response.items;
                        stream.cursor = response.nextCursor;
                        stream.started = true;
                    }
                    catch (error) {
                        if (signal.aborted)
                            throw error;
                        stream.started = true;
                        stream.cursor = null;
                        this.exclusions.push({ accountId: stream.accountId, reason: error instanceof Error ? error.message : "Unavailable" });
                    }
                }
            const heads = this.streams.filter(stream => stream.buffer.length).sort((a, b) => compareMail(a.buffer[0], b.buffer[0]));
            if (!heads.length)
                break;
            const item = heads[0].buffer.shift();
            if (item)
                output.push(item);
        }
        return output;
    }
}
export function compareMail(a: MailMessageView, b: MailMessageView): number {
    const time = (b.receivedAt ?? -1) - (a.receivedAt ?? -1);
    if (time)
        return time;
    return a.accountId < b.accountId ? -1 : a.accountId > b.accountId ? 1 : a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}
