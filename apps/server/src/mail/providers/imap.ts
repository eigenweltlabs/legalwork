import { imapPrecondition, imapFlags } from '../storage/imap-incremental.js';
import type { MailMutation } from '../local-view.js';
import { ImapFlow, type ImapFlowOptions } from 'imapflow';
import { z } from 'zod';
import { ImapError, type ImapSettings } from './imap-config.js';
const uid = z.number().int().min(1).max(0xffffffff);
const folder = z.object({ path: z.string().min(1).max(512), delimiter: z.string().max(16).nullable(), parent: z.string().max(512).nullable(), specialUse: z.string().max(64).nullable(), selectable: z.boolean() });
export class ImapDenseWindow extends Error {
    constructor(readonly span: number) { super('mail_imap_narrow_window'); }
}
export type ImapFolder = z.infer<typeof folder>;
export function imapFailure(error: unknown): ImapError {
    if (error instanceof ImapError)
        return error;
    const parsed = z.object({ code: z.string().optional(), authenticationFailed: z.boolean().optional() }).safeParse(error);
    if (parsed.success) {
        if (parsed.data.authenticationFailed)
            return new ImapError('authentication_failed');
        if (['CERT_HAS_EXPIRED', 'DEPTH_ZERO_SELF_SIGNED_CERT', 'SELF_SIGNED_CERT_IN_CHAIN', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE', 'ERR_TLS_CERT_ALTNAME_INVALID', 'UNABLE_TO_GET_ISSUER_CERT_LOCALLY'].includes(parsed.data.code ?? ''))
            return new ImapError('certificate_failed');
        if (['ETIMEDOUT', 'CONNECT_TIMEOUT', 'GREETING_TIMEOUT'].includes(parsed.data.code ?? ''))
            return new ImapError('timeout');
        if (['LiteralTooLarge', 'LineTooLarge', 'ResponseTooLarge'].includes(parsed.data.code ?? ''))
            return new ImapError('too_large');
    }
    return new ImapError('unavailable');
}
/** Single read-only implicit-TLS session. Callers serialize operations and close on cancellation. */
export class ImapReadTransport {
    private readonly client: ImapFlow;
    private ended = false;
    private failure?: ImapError;
    constructor(settings: ImapSettings, password: string, factory: (options: ImapFlowOptions) => ImapFlow = options => new ImapFlow(options)) {
        this.client = factory({ host: settings.host, port: settings.port, secure: true, auth: { user: settings.username, pass: password }, tls: { rejectUnauthorized: true, minVersion: 'TLSv1.2' }, logger: false, emitLogs: false, logRaw: false, disableAutoIdle: true, disableCompression: true, disableBinary: true, disableAutoEnable: false, qresync: true, maxIdleTime: 10000, connectionTimeout: 10000, greetingTimeout: 10000, socketTimeout: 15000, maxLiteralSize: 65536, maxLineLength: 16384, maxResponseSize: 131072 });
        this.client.on('error', error => { this.failure = imapFailure(error); this.close(); });
    }
    close() { this.ended = true; this.client.close(); }
    private check() {
        if (this.failure)
            throw this.failure;
        if (this.ended)
            throw new ImapError('cancelled');
    }
    private async operation<T>(signal: AbortSignal, action: () => Promise<T>, byteLimit = 2 * 1024 * 1024): Promise<T> {
        this.check();
        if (signal.aborted)
            throw new ImapError('cancelled');
        let interrupt: (error: ImapError) => void = () => { };
        const stopped = new Promise<never>((_, reject) => { interrupt = reject; });
        const initial = this.client.stats().received;
        let exceeded = false, timedOut = false;
        const abort = () => { this.close(); interrupt(new ImapError('cancelled')); };
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted)
            abort();
        const timer = setTimeout(() => { timedOut = true; this.close(); interrupt(new ImapError('timeout')); }, 20000), monitor = setInterval(() => {
            if (this.client.stats().received - initial > byteLimit) {
                exceeded = true;
                this.close();
                interrupt(new ImapError('too_large'));
            }
        }, 5);
        try {
            this.check();
            const result = await Promise.race([action(), stopped]);
            if (timedOut)
                throw new ImapError('timeout');
            if (exceeded || this.client.stats().received - initial > byteLimit)
                throw new ImapError('too_large');
            this.check();
            return result;
        }
        catch (error) {
            if (error instanceof ImapDenseWindow)
                throw error;
            if (signal.aborted)
                throw new ImapError('cancelled');
            if (timedOut)
                throw new ImapError('timeout');
            if (exceeded)
                throw new ImapError('too_large');
            throw this.failure ?? imapFailure(error);
        }
        finally {
            clearTimeout(timer);
            clearInterval(monitor);
            signal.removeEventListener('abort', abort);
        }
    }
    async connect(signal: AbortSignal) {
        await this.operation(signal, () => this.client.connect());
        if (!this.client.secureConnection)
            throw new ImapError('certificate_failed');
    }
    async discover(signal: AbortSignal) {
        return this.operation(signal, async () => {
            const rows = await this.client.list();
            if (rows.length > 1000)
                throw new ImapError('too_large');
            const folders = rows.map(row => folder.parse({ path: row.path, delimiter: row.delimiter || null, parent: row.parentPath || null, specialUse: row.specialUse ?? null, selectable: !row.flags.has('\\Noselect') }));
            const capabilities = z.array(z.string().max(128)).max(256).parse([...this.client.capabilities.keys()]);
            return { folders, capabilities };
        });
    }
    async open(path: string, signal: AbortSignal) { return this.operation(signal, async () => { const mailbox = await this.client.mailboxOpen(path, { readOnly: true }); return { uidValidity: uid.parse(Number(mailbox.uidValidity)), uidNext: uid.parse(mailbox.uidNext), highestModseq: mailbox.highestModseq?.toString() ?? null }; }); }
    async page(path: string, validity: number, after: number, ceiling: number, signal: AbortSignal, span = 1000, changedSince: string | null = null) {
        return this.operation(signal, async () => {
            const opened = await this.client.mailboxOpen(path, { readOnly: true });
            if (Number(opened.uidValidity) !== validity)
                throw new ImapError('uidvalidity_changed');
            let start = after + 1;
            if (this.client.capabilities.has('ESEARCH') && start <= ceiling) {
                const result = await this.client.search({ uid: `${start}:${ceiling}` }, { uid: true, returnOptions: ['MIN'] });
                if (!result || Array.isArray(result))
                    throw new ImapError('unavailable');
                if (result.min === undefined)
                    return { items: [], after: ceiling, done: true, nextSpan: 1000 };
                start = uid.parse(result.min);
                if (start <= after || start > ceiling)
                    throw new ImapError('unavailable');
            }
            const end = Math.min(ceiling, start + (opened.exists <= 1000 ? Math.max(span, ceiling - start + 1) : span) - 1), items: {
                uid: number;
                read: boolean;
                internalDate: number | null;
                flags: string[] | null;
                modseq: string | null;
            }[] = [];
            const incremental = changedSince !== null && this.client.enabled.has('CONDSTORE') && !opened.noModseq;
            const changed = new Map<number, {
                flags: string[];
                modseq: string | null;
            }>();
            if (incremental && end > after) {
                for await (const item of this.client.fetch(`${start}:${end}`, { uid: true, flags: true }, { uid: true, changedSince: BigInt(changedSince) })) {
                    if (changed.size >= 1000) {
                        this.close();
                        throw new ImapDenseWindow(Math.max(1000, Math.floor((end - after) / 16)));
                    }
                    if (item.uid < start || item.uid > end)
                        throw new ImapError('unavailable');
                    changed.set(item.uid, { flags: [...(item.flags ?? [])].filter(flag => flag !== '\\Recent').sort(), modseq: item.modseq?.toString() ?? null });
                }
            }
            if (end > after)
                for await (const message of this.client.fetch(`${start}:${end}`, { uid: true, flags: !incremental, internalDate: true }, { uid: true })) {
                    if (items.length >= 1000) {
                        this.close();
                        throw new ImapDenseWindow(Math.max(1000, Math.floor((end - after) / 16)));
                    }
                    const value = uid.parse(message.uid);
                    if (value <= after || value > end)
                        throw new ImapError('unavailable');
                    items.push({ flags: incremental ? changed.get(value)?.flags ?? null : [...(message.flags ?? [])].filter(flag => flag !== '\\Recent').sort(), modseq: incremental ? changed.get(value)?.modseq ?? null : message.modseq?.toString() ?? null, uid: value, read: message.flags?.has('\\Seen') ?? false, internalDate: message.internalDate instanceof Date && Number.isFinite(message.internalDate.getTime()) ? message.internalDate.getTime() : null });
                }
            return { items, after: end, done: end >= ceiling, nextSpan: items.length === 0 ? Math.min(0xffffffff, span * 16) : 1000 };
        });
    }
    async wait(signal: AbortSignal, milliseconds: number): Promise<boolean> {
        if (!this.client.capabilities.has('IDLE') || !this.client.mailbox)
            return false;
        return this.operation(signal, async () => {
            let notified = false;
            let wake: (() => void) | undefined;
            const changed = new Promise<void>(resolve => { wake = resolve; });
            const notify = () => { notified = true; wake?.(); };
            this.client.once('exists', notify);
            this.client.once('expunge', notify);
            this.client.once('flags', notify);
            const timer = setTimeout(() => wake?.(), Math.min(10000, milliseconds));
            const cleanup = () => { clearTimeout(timer); this.client.off('exists', notify); this.client.off('expunge', notify); this.client.off('flags', notify); };
            signal.addEventListener('abort', cleanup, { once: true });
            const idle = this.client.idle();
            try {
                await Promise.race([idle, changed]);
                await this.client.noop();
                await idle;
                return notified;
            }
            finally {
                cleanup();
                signal.removeEventListener('abort', cleanup);
            }
        });
    }
    /** The caller persists its dispatch boundary synchronously before any write command. */
    async mutate(input: MailMutation, signal: AbortSignal, dispatch: () => void): Promise<'confirmed' | 'unknown' | 'unsupported' | 'conflict'> {
        return this.operation(signal, async () => {
            let change = input.change;
            if (change.kind === 'special') {
                const special = {archive:'\\Archive',trash:'\\Trash',spam:'\\Junk',inbox:'\\Inbox'}[change.operation];
                const listed = await this.client.list();
                if (listed.length > 1000) throw new ImapError('too_large');
                const targets = listed.filter(folder => !folder.flags.has('\\Noselect') && (special === '\\Inbox' ? folder.path.toUpperCase() === 'INBOX' : folder.specialUse === special));
                if (targets.length !== 1) return 'unsupported';
                change = {kind:'move',destination:targets[0]!.path};
            }
            if (change.kind === 'mailbox') {
                if (input.precondition !== 'imap-mailbox-v1' || /[\r\n\0]/.test(change.path + (change.destination ?? '')))
                    return 'conflict';
                if (this.client.mailbox && !this.client.mailbox.readOnly)
                    await this.client.mailboxOpen(this.client.mailbox.path, { readOnly: true });
                const listed = await this.client.list();
                if (listed.length > 1000)
                    throw new ImapError('too_large');
                const existing = listed.find(folder => folder.path === change.path);
                if ((change.operation === 'create') === !!existing || change.path.toUpperCase() === 'INBOX')
                    return 'conflict';
                if (existing?.specialUse) return 'unsupported';
                if (change.operation === 'rename' && (!change.destination || listed.some(folder => folder.path === change.destination)))
                    return 'conflict';
                // Never DELETE a nonempty mailbox: message deletion is explicit and UID scoped.
                if (change.operation === 'delete') {
                    if (listed.some(folder => folder.parentPath === change.path)) return 'conflict';
                    const status = await this.client.status(change.path, { messages: true });
                    if (status.messages !== 0)
                        return 'conflict';
                }
                dispatch();
                if (change.operation === 'create')
                    await this.client.mailboxCreate(change.path);
                else if (change.operation === 'rename')
                    await this.client.mailboxRename(change.path, change.destination!);
                else
                    await this.client.mailboxDelete(change.path);
                return 'confirmed';
            }
            const locator = input.locator;
            if (!locator || locator.provider !== 'imap')
                return 'unsupported';
            const opened = await this.client.mailboxOpen(locator.mailboxId, { readOnly: false });
            if (Number(opened.uidValidity) !== locator.uidValidity || opened.readOnly)
                return 'conflict';
            const snapshot = await this.client.fetchOne(String(locator.uid), { uid: true, flags: true }, { uid: true });
            if (!snapshot || snapshot.uid !== locator.uid)
                return 'conflict';
            const flags = [...(snapshot.flags ?? [])].filter(flag => flag !== '\\Recent').sort();
            if (input.precondition !== imapPrecondition(locator, flags, snapshot.modseq?.toString() ?? null))
                return 'conflict';
            let add: string[] = [], remove: string[] = [];
            if (change.kind === 'read') {
                add = change.read ? ['\\Seen'] : [];
                remove = change.read ? [] : ['\\Seen'];
            }
            else if (change.kind === 'flags') {
                add = imapFlags.parse(change.add);
                remove = imapFlags.parse(change.remove);
            }
            else if (change.kind === 'memberships')
                return 'unsupported'; // IMAP copies have distinct identities, not labels.
            if (add.some(flag => flag === '\\Recent' || (!opened.permanentFlags?.has(flag) && !opened.permanentFlags?.has('\\*'))) || remove.includes('\\Recent') || add.some(flag => remove.includes(flag)))
                return 'unsupported';
            if (change.kind === 'move' && !this.client.capabilities.has('MOVE') && !this.client.capabilities.has('UIDPLUS'))
                return 'unsupported';
            if (change.kind === 'delete' && !this.client.capabilities.has('UIDPLUS'))
                return 'unsupported';
            if (change.kind === 'move' || change.kind === 'copy') {
                if (change.destination === locator.mailboxId || /[\r\n\0]/.test(change.destination))
                    return 'conflict';
                const destination = await this.client.status(change.destination, { uidValidity: true });
                if (!destination.uidValidity)
                    return 'conflict';
            }
            const deleteUid = async () => {
                if (!await this.client.messageFlagsAdd(String(locator.uid), ['\\Deleted'], { uid: true }))
                    return 'unknown' as const;
                if (!await this.client.messageDelete(String(locator.uid), { uid: true }))
                    return 'unknown' as const;
                return await this.client.fetchOne(String(locator.uid), { uid: true }, { uid: true }) ? 'unknown' as const : 'confirmed' as const;
            };
            dispatch();
            if (change.kind === 'copy')
                return await this.client.messageCopy(String(locator.uid), change.destination, { uid: true }) ? 'confirmed' : 'unknown';
            if (change.kind === 'move') {
                if (this.client.capabilities.has('MOVE'))
                    return await this.client.messageMove(String(locator.uid), change.destination, { uid: true }) ? 'confirmed' : 'unknown';
                // ImapFlow's generic fallback ignores a false COPY result; never call it.
                if (!await this.client.messageCopy(String(locator.uid), change.destination, { uid: true }))
                    return 'unknown';
                return deleteUid();
            }
            if (change.kind === 'delete')
                return deleteUid();
            // Delta STORE preserves unrelated flags on servers without CONDSTORE. Verify afterwards;
            // no false atomic CAS promise is made for those servers.
            if (add.length && !await this.client.messageFlagsAdd(String(locator.uid), add, { uid: true }))
                return 'unknown';
            if (remove.length && !await this.client.messageFlagsRemove(String(locator.uid), remove, { uid: true }))
                return 'unknown';
            const result = await this.client.fetchOne(String(locator.uid), { uid: true, flags: true }, { uid: true });
            return result && add.every(flag => result.flags?.has(flag)) && remove.every(flag => !result.flags?.has(flag)) ? 'confirmed' : 'unknown';
        });
    }
    async *raw(path: string, validity: number, messageUid: number, signal: AbortSignal): AsyncGenerator<Uint8Array> {
        const abort = () => this.close();
        signal.addEventListener('abort', abort, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined, timedOut = false;
        try {
            if (signal.aborted)
                throw new ImapError('cancelled');
            const opened = await this.open(path, signal);
            if (opened.uidValidity !== validity)
                throw new ImapError('uidvalidity_changed');
            timer = setTimeout(() => { timedOut = true; abort(); }, 120000);
            const value = await this.client.fetchOne(String(messageUid), { uid: true, size: true }, { uid: true });
            if (!value)
                throw new ImapError('message_unavailable');
            if (value.uid !== messageUid || !Number.isSafeInteger(value.size) || value.size! > 64 * 1024 * 1024)
                throw new ImapError('too_large');
            const download = await this.client.download(String(messageUid), undefined, { uid: true, maxBytes: 64 * 1024 * 1024 + 1, chunkSize: 65536 });
            let total = 0;
            for await (const piece of download.content) {
                this.check();
                if (signal.aborted)
                    throw new ImapError('cancelled');
                if (!(piece instanceof Uint8Array))
                    throw new ImapError('unavailable');
                total += piece.byteLength;
                if (total > 64 * 1024 * 1024)
                    throw new ImapError('too_large');
                for (let i = 0; i < piece.byteLength; i += 65536)
                    yield piece.subarray(i, i + 65536);
            }
            this.check();
            if (total !== value.size)
                throw new ImapError('unavailable');
        }
        catch (error) {
            throw signal.aborted ? new ImapError('cancelled') : timedOut ? new ImapError('timeout') : this.failure ?? imapFailure(error);
        }
        finally {
            clearTimeout(timer);
            signal.removeEventListener('abort', abort);
        }
    }
}
