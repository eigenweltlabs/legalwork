import { ImapActions } from './imap-actions.js';
import { removeImapMessage } from '../storage/imap-incremental.js';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { ImapReadTransport, ImapDenseWindow, imapFailure, type ImapFolder } from './imap.js';
import { ImapError, imapDiscoverySchema, imapConnectionSchema, imapSettingsSchema, type ImapConnection, type ImapSettings } from './imap-config.js';
import { ImapCustody, type ImapVersion } from '../storage/imap-custody.js';
import { MailRepository } from '../storage/repository.js';
import { MailContentStore } from '../storage/content-store.js';
import { MailSyncJournal } from '../storage/sync-journal.js';
import { MailSyncExecutor, MailSyncExecutionFailure, type MailSyncWork } from '../runtime/sync-executor.js';
import { createStoredMimeProjector } from '../storage/mime-projection.js';
import { MimeProjectionError } from '../mime/project.js';
import { providerMessageKey, providerMessageLocatorSchema } from '../model.js';
import { imapSyncViewSchema, type ImapSyncView } from '../imap-sync-view.js';
import type { MailDatabase } from '../storage/database-interface.js';
const runSchema = z.object({ account_id: z.string(), generation: z.string(), revision: z.number(), state: z.enum(['active', 'paused', 'complete', 'attention']), retry_at: z.number().nullable(), error: z.string().nullable(), failures: z.number(), discovered: z.number(), poll_at: z.number().nullable(), epoch_resets: z.number() });
type Run = z.infer<typeof runSchema>;
type Transport = Pick<ImapReadTransport, 'connect' | 'discover' | 'open' | 'page' | 'raw' | 'close'> & Partial<Pick<ImapReadTransport, 'wait' | 'mutate'>>;
type Session = {
    run: Run;
    version: ImapVersion;
    abort: AbortController;
    transport?: Transport;
    timer?: ReturnType<typeof setTimeout>;
    task?: Promise<void>;
};
export class ImapBackfill {
    private readonly custody: ImapCustody;
    private readonly actions: ImapActions;
    private readonly repo: MailRepository;
    private readonly journal: MailSyncJournal;
    private readonly content: MailContentStore;
    private readonly executor: MailSyncExecutor;
    private readonly projector: ReturnType<typeof createStoredMimeProjector>;
    private current?: Session;
    private closed = false;
    private connecting?: {
        abort: AbortController;
        transport: Transport;
    };
    constructor(private readonly options: {
        database: MailDatabase;
        ownerId: string;
        pollMs?: number;
        transport?: (settings: ImapSettings, password: string) => Transport;
    }) { if (options.pollMs !== undefined && (!Number.isInteger(options.pollMs) || options.pollMs < 10 || options.pollMs > 60000))
        throw new ImapError('invalid_input'); this.actions = new ImapActions(options.database, options.ownerId); this.custody = new ImapCustody(options.database, options.ownerId); this.repo = new MailRepository(options.database, options.ownerId); this.journal = new MailSyncJournal(options.database, options.ownerId); this.content = new MailContentStore(options.database, options.ownerId); this.projector = createStoredMimeProjector(options); this.executor = new MailSyncExecutor({ journal: this.journal, handler: work => this.handle(work), maxConcurrentAccounts: 1, maxJobsPerRun: 2, jobTimeoutMs: 120000 }); }
    private transport(settings: ImapSettings, password: string) { return this.options.transport?.(settings, password) ?? new ImapReadTransport(settings, password); }
    private read(id: string) { this.custody.account(id); const row = this.options.database.get('SELECT * FROM mail_imap_runs WHERE account_id=?', [id]); return row ? runSchema.parse(row) : null; }
    private scope(run: Run) { return { accountId: run.account_id, generation: run.generation, scopeId: 'imap:all' }; }
    private assert(session: Session) {
        if (this.closed || session.abort.signal.aborted || this.current !== session)
            throw new ImapError('cancelled');
        this.custody.assert(session.run.account_id, session.version);
        const run = this.read(session.run.account_id);
        if (!run || run.state !== 'active' || run.generation !== session.run.generation || run.revision !== session.run.revision)
            throw new ImapError('cancelled');
    }
    discovery(accountId: string, after?: string) {
        const credential = this.custody.read(accountId), rows = this.options.database.all('SELECT path,delimiter,special_use,selected,selectable FROM mail_imap_folders i WHERE account_id=? AND path>? AND EXISTS(SELECT 1 FROM mail_folders f WHERE f.account_id=i.account_id AND f.id=i.path) ORDER BY path LIMIT 51', [accountId, after ?? '']), selected = rows.slice(0, 50);
        const result = imapDiscoverySchema.parse({ accountId, settings: credential.settings, capabilities: JSON.parse(z.string().parse(this.options.database.get('SELECT capabilities_json FROM mail_imap_runs WHERE account_id=?', [accountId])?.capabilities_json ?? '[]')), folders: selected.map(row => ({ path: row.path, delimiter: row.delimiter, specialUse: row.special_use, selected: row.selected === 1, selectable: row.selectable === 1 })), nextCursor: rows.length > 50 ? selected.at(-1)?.path : null });
        while (Buffer.byteLength(JSON.stringify(result)) > 48 * 1024 && result.folders.length) {
            result.folders.pop();
            result.nextCursor = result.folders.at(-1)?.path ?? null;
        }
        if (Buffer.byteLength(JSON.stringify(result)) > 48 * 1024 || selected.length && !result.folders.length)
            throw new ImapError('too_large');
        return result;
    }
    private folders(accountId: string, settings: ImapSettings, folders: ImapFolder[], generation: string) {
        const db = this.options.database;
        const paths = new Set(folders.map(folder => folder.path));
        db.run("UPDATE mail_imap_folders SET selected=0 WHERE account_id=?", [accountId]);
        if (generation === 'configuration' && settings.folders?.some(path => !paths.has(path)))
            throw new ImapError('invalid_input');
        for (const folder of folders) {
            this.repo.putFolder(accountId, { id: folder.path, name: folder.path, kind: 'folder', parentId: null });
        }
        const roleAvailable = db.all('PRAGMA table_info(mail_folders)').some(row => row.name === 'role');
        for (const folder of folders) {
            if (roleAvailable)
                db.run('UPDATE mail_folders SET role=? WHERE account_id=? AND id=?', [folder.path.toUpperCase() === 'INBOX' || folder.specialUse === '\\Inbox' ? 'inbox' : null, accountId, folder.path]);
            if (folder.parent && paths.has(folder.parent))
                this.repo.putFolder(accountId, { id: folder.path, name: folder.path, kind: 'folder', parentId: folder.parent });
            db.run('INSERT INTO mail_imap_folders(account_id,path,delimiter,special_use,selectable,selected,generation) VALUES(?,?,?,?,?,?,?) ON CONFLICT(account_id,path) DO UPDATE SET delimiter=excluded.delimiter,special_use=excluded.special_use,selectable=excluded.selectable,selected=excluded.selected,generation=excluded.generation,uid_next=CASE WHEN generation=excluded.generation THEN uid_next ELSE NULL END,after_uid=CASE WHEN generation=excluded.generation THEN after_uid ELSE 0 END,uid_span=CASE WHEN generation=excluded.generation THEN uid_span ELSE 1000 END,done=CASE WHEN generation=excluded.generation THEN done ELSE 0 END', [accountId, folder.path, folder.delimiter, folder.specialUse, folder.selectable ? 1 : 0, folder.selectable && (!settings.folders || settings.folders.includes(folder.path)) ? 1 : 0, generation]);
        }
    }
    async connect(input: ImapConnection): Promise<{
        accountId: string;
        provider: "imap";
    }> {
        if (this.closed)
            throw new ImapError('cancelled');
        if (this.current || this.connecting)
            throw new ImapError('busy');
        const parsed = imapConnectionSchema.safeParse(input);
        if (!parsed.success)
            throw new ImapError('invalid_input');
        const { password, reconnectAccountId, ...settings } = parsed.data, expected = reconnectAccountId ? this.custody.version(reconnectAccountId) : null;
        const flow = { abort: new AbortController(), transport: this.transport(settings, password) };
        this.connecting = flow;
        const deadline = performance.now() + 25000, timer = setTimeout(() => flow.abort.abort(), 25000);
        try {
            await flow.transport.connect(flow.abort.signal);
            const discovery = await flow.transport.discover(flow.abort.signal);
            if (performance.now() >= deadline)
                throw new ImapError("timeout");
            if (this.closed || flow.abort.signal.aborted)
                throw new ImapError('cancelled');
            return this.options.database.transaction(() => {
                if (this.closed || flow.abort.signal.aborted)
                    throw new ImapError('cancelled');
                const accountId = this.custody.connect(settings, password, reconnectAccountId, expected);
                if (settings.folders?.some(path => !discovery.folders.some(folder => folder.path === path))) throw new ImapError('invalid_input');
                this.folders(accountId, settings, discovery.folders, this.read(accountId)?.generation ?? 'configuration');
                this.options.database.run("INSERT INTO mail_imap_runs(account_id,generation,state,capabilities_json) VALUES(?,?,'active',?) ON CONFLICT(account_id) DO UPDATE SET revision=revision+1,capabilities_json=excluded.capabilities_json", [accountId, randomUUID(), JSON.stringify(discovery.capabilities)]);
                return { accountId, provider: 'imap' };
            });
        }
        catch (error) {
            throw performance.now() >= deadline ? new ImapError('timeout') : imapFailure(error);
        }
        finally {
            clearTimeout(timer);
            flow.transport.close();
            if (this.connecting === flow)
                this.connecting = undefined;
        }
    }
    cancelConnect(): void { this.connecting?.abort.abort(); this.connecting?.transport.close(); }
    status(accountId: string): ImapSyncView {
        const run = this.read(accountId), db = this.options.database;
        const progress = run ? this.journal.status(this.scope(run)) : null;
        const counts = run ? db.get(`SELECT count(*) AS enumerated,coalesce(sum(EXISTS(SELECT 1 FROM mail_content_manifests m JOIN mail_blob_publications p ON p.account_id=m.account_id AND p.ref_id=m.ref_id WHERE m.account_id=j.account_id AND m.message_key=j.message_key AND m.kind='raw' AND m.state='stored')),0) AS downloaded,coalesce(sum(EXISTS(SELECT 1 FROM mail_mime_projections p JOIN mail_content_manifests r ON r.account_id=p.account_id AND r.message_key=p.message_key AND r.kind='raw' AND r.ref_id=p.raw_ref_id JOIN mail_content_manifests b ON b.account_id=p.account_id AND b.message_key=p.message_key AND b.kind='body' AND b.ref_id=p.body_ref_id WHERE p.account_id=j.account_id AND p.message_key=j.message_key AND p.state='complete' AND NOT EXISTS(SELECT 1 FROM mail_content_manifests m LEFT JOIN mail_content_refs cr ON cr.account_id=m.account_id AND cr.id=m.ref_id LEFT JOIN mail_blob_publications pub ON pub.account_id=m.account_id AND pub.ref_id=m.ref_id LEFT JOIN mail_blob_objects o ON o.account_id=pub.account_id AND o.id=pub.object_id WHERE m.account_id=j.account_id AND m.message_key=j.message_key AND (m.state!='stored' OR o.state IS NOT 'published' OR o.bytes IS NOT cr.bytes OR o.chunk_count IS NOT (cr.bytes/65536+CASE WHEN cr.bytes%65536>0 THEN 1 ELSE 0 END))))),0) AS projected FROM mail_imap_messages j WHERE account_id=? AND seen_generation=? AND NOT EXISTS(SELECT 1 FROM mail_tombstones t WHERE t.account_id=j.account_id AND t.message_key=j.message_key AND t.reason='imap_removed')`, [accountId, run.generation]) : { enumerated: 0, downloaded: 0, projected: 0 };
        const pending = progress ? progress.jobs.queued + progress.jobs.running + progress.jobs.retry : 0, failed = progress?.jobs.failed ?? 0;
        const folders = db.get('SELECT count(*) AS folders,coalesce(sum(selected=0),0) AS excluded FROM mail_imap_folders WHERE account_id=?', [accountId]);
        const retry = run?.retry_at ?? (run ? db.get("SELECT min(CASE WHEN state='retry' THEN available_at WHEN state='running' THEN lease_until END) AS at FROM mail_sync_jobs WHERE account_id=? AND generation=?", [accountId, run.generation])?.at : null) ?? null;
        const complete = progress?.checkpoint.discoveryComplete && pending === 0 && failed === 0 && counts?.downloaded === counts?.enumerated && counts?.projected === counts?.enumerated;
        return imapSyncViewSchema.parse({ accountId, provider: 'imap', state: !run ? 'idle' : run.state === 'paused' ? 'paused' : (run.state === 'complete' || run.poll_at !== null && run.poll_at > Date.now() && this.current?.run.account_id === accountId) ? complete ? 'complete' : 'attention' : run.state === 'attention' ? 'attention' : this.current?.run.account_id !== accountId ? 'paused' : typeof retry === 'number' && retry > Date.now() ? 'waiting' : 'syncing', ...counts, pending, failed, removed: db.get("SELECT count(*) AS n FROM mail_tombstones WHERE account_id=? AND reason='imap_removed'", [accountId])?.n ?? 0, retained: this.options.database.get("SELECT count(*) AS n FROM mail_messages m JOIN mail_imap_folders f ON f.account_id=m.account_id AND f.path=json_extract(m.locator_json,'$.mailboxId') WHERE m.account_id=? AND (json_extract(m.locator_json,'$.uidValidity')!=f.uid_validity OR EXISTS(SELECT 1 FROM mail_tombstones t WHERE t.account_id=m.account_id AND t.message_key=m.message_key AND t.reason='imap_removed')) AND EXISTS(SELECT 1 FROM mail_content_manifests c JOIN mail_blob_publications p ON p.account_id=c.account_id AND p.ref_id=c.ref_id WHERE c.account_id=m.account_id AND c.message_key=m.message_key AND c.kind='raw' AND c.state='stored')", [accountId])?.n ?? 0, nextRetryAt: retry ?? run?.poll_at ?? null, error: run?.error ?? ((run?.state === 'complete' || run?.poll_at !== null) && !complete ? 'content_incomplete' : null), folders: folders?.folders ?? 0, excludedFolders: folders?.excluded ?? 0 });
    }
    start(accountId: string) {
        if (this.closed)
            throw new ImapError('cancelled');
        const credential = this.custody.read(accountId);
        if (this.current) {
            if (this.current.run.account_id === accountId && !this.current.abort.signal.aborted) {
                if (this.current.run.poll_at !== null)
                    this.wake(accountId);
                return this.status(accountId);
            }
            throw new ImapError('busy');
        }
        if (this.connecting)
            throw new ImapError('busy');
        const run = this.options.database.transaction(() => {
            this.custody.assert(accountId, credential.version);
            const old = this.read(accountId), fresh = !old || old.poll_at !== null || old.state === 'complete' || old.error === 'uidvalidity_changed';
            this.options.database.run("INSERT INTO mail_imap_runs(account_id,generation,state) VALUES(?,?,'active') ON CONFLICT(account_id) DO UPDATE SET state='active',revision=revision+1,epoch_resets=0,poll_at=NULL,generation=CASE WHEN ? THEN excluded.generation ELSE generation END,discovered=CASE WHEN ? THEN 0 ELSE discovered END,retry_at=CASE WHEN ? THEN NULL ELSE retry_at END,error=CASE WHEN ? THEN NULL ELSE error END,failures=CASE WHEN ? THEN 0 ELSE failures END", [accountId, randomUUID(), fresh ? 1 : 0, fresh ? 1 : 0, fresh ? 1 : 0, fresh ? 1 : 0, fresh ? 1 : 0]);
            const run = this.read(accountId);
            if (!run)
                throw new ImapError('unavailable');
            return run;
        });
        const session: Session = { run, version: credential.version, abort: new AbortController() };
        this.current = session;
        this.schedule(session);
        return this.status(accountId);
    }
    wake(accountId: string) {
        if (this.current?.run.account_id === accountId) {
            const session = this.current;
            try {
                // A wake is a scheduling hint, never permission to adopt another writer's run.
                this.options.database.transaction(() => {
                    this.assert(session);
                    this.options.database.run('UPDATE mail_imap_runs SET poll_at=0 WHERE account_id=?', [accountId]);
                    session.run = { ...session.run, poll_at: 0 };
                });
            } catch {
                // The intent was already durably queued; its current owner can dispatch it.
                this.stop(session);
                return;
            }
            if (!session.task) {
                clearTimeout(session.timer);
                this.schedule(session);
            }
        }
        else if (!this.current && !this.connecting) {
            try {
                this.start(accountId);
            }
            catch { /* Intent remains durable while unavailable. */ }
        }
    }
    private recoverEpoch(session: Session) {
        this.assert(session);
        if (session.run.epoch_resets >= 3) {
            this.change(session, () => { this.options.database.run("UPDATE mail_imap_runs SET state='attention',error='uidvalidity_changed' WHERE account_id=?", [session.run.account_id]); });
            this.stop(session);
            return;
        }
        this.change(session, () => { this.options.database.run('UPDATE mail_imap_runs SET epoch_resets=epoch_resets+1 WHERE account_id=?', [session.run.account_id]); });
        this.cycle(session);
        this.schedule(session);
    }
    private cycle(session: Session) {
        session.run = this.options.database.transaction(() => {
            this.assert(session);
            this.options.database.run("UPDATE mail_imap_runs SET generation=?,revision=revision+1,discovered=0,poll_at=NULL,retry_at=NULL,error=NULL,failures=0 WHERE account_id=?", [randomUUID(), session.run.account_id]);
            const next = this.read(session.run.account_id);
            if (!next) throw new ImapError('cancelled');
            return next;
        });
    }
    /** Metadata refreshes must not turn a superseded session into the current writer. */
    private refresh(session: Session) {
        const next = this.read(session.run.account_id);
        if (this.closed || session.abort.signal.aborted || !next ||
            next.generation !== session.run.generation || next.revision !== session.run.revision)
            throw new ImapError('cancelled');
        session.run = next;
    }
    private change(session: Session, body: () => void) {
        this.options.database.transaction(() => { this.assert(session); body(); });
    }
    pause(accountId: string) {
        this.custody.account(accountId);
        try {
            this.options.database.run("UPDATE mail_imap_runs SET state='paused',revision=revision+1 WHERE account_id=? AND state!='paused'", [accountId]);
        }
        finally {
            if (this.current?.run.account_id === accountId)
                this.stop(this.current);
        }
        return this.status(accountId);
    }
    private stop(session: Session) {
        session.abort.abort();
        session.transport?.close();
        clearTimeout(session.timer);
        this.executor.pause(session.run.account_id);
        if (!session.task && this.current === session)
            this.current = undefined;
    }
    async close() {
        this.closed = true;
        this.connecting?.abort.abort();
        this.connecting?.transport.close();
        this.executor.close();
        const session = this.current;
        if (session) {
            this.stop(session);
            await Promise.race([session.task, new Promise<void>(resolve => setTimeout(resolve, 300))]);
        }
    }
    private schedule(session: Session, delay = 0) {
        if (session.abort.signal.aborted || this.closed)
            return;
        session.timer = setTimeout(() => {
            session.task = this.turn(session).finally(() => {
                session.task = undefined;
                if (session.abort.signal.aborted && this.current === session)
                    this.current = undefined;
            });
        }, Math.min(60000, Math.max(0, delay)));
    }
    private async ready(session: Session) {
        if (session.transport)
            return session.transport;
        const credential = this.custody.read(session.run.account_id);
        this.assert(session);
        session.transport = this.transport(credential.settings, credential.password);
        await session.transport.connect(session.abort.signal);
        this.assert(session);
        return session.transport;
    }
    private async turn(session: Session) {
        try {
            this.assert(session);
            if (session.run.retry_at !== null && session.run.retry_at > Date.now()) {
                this.schedule(session, session.run.retry_at - Date.now());
                return;
            }
            const db = this.options.database, accountId = session.run.account_id, scope = this.scope(session.run);
            if(this.actions.ready(accountId)) {
                const transport=await this.ready(session);
                if(transport.mutate&&await this.actions.turn(accountId,session.version,{mutate:transport.mutate.bind(transport)},session.abort.signal,()=>this.assert(session))){
                    this.assert(session);session.transport?.close();session.transport=undefined;
                    if(session.run.poll_at!==null)this.cycle(session);
                    this.schedule(session);return;
                }
            }
            if (session.run.poll_at !== null) {
                const transport = await this.ready(session);
                if (session.run.poll_at > Date.now()) {
                    if (transport.wait) {
                        const changed = await transport.wait(session.abort.signal, Math.min(10000, session.run.poll_at - Date.now()));
                        this.assert(session);
                        if (!changed && session.run.poll_at !== null && session.run.poll_at > Date.now()) {
                            this.schedule(session, session.run.poll_at - Date.now());
                            return;
                        }
                    }
                    else {
                        this.schedule(session, session.run.poll_at - Date.now());
                        return;
                    }
                }
                this.cycle(session);
                this.schedule(session);
                return;
            }
            const status = this.journal.status(scope);
            if (status.jobs.queued + status.jobs.running + status.jobs.retry) {
                const result = await this.executor.run(scope);
                this.assert(session);
                if (result.stopped === 'timeout') {
                    this.change(session, () => { db.run("UPDATE mail_imap_runs SET state='attention',error='provider_unavailable' WHERE account_id=?", [accountId]); });
                    this.stop(session);
                    return;
                }
                if (this.read(accountId)?.error === 'uidvalidity_changed') {
                    this.recoverEpoch(session);
                    return;
                }
                const next = this.status(accountId).nextRetryAt;
                this.schedule(session, next === null ? 0 : next - Date.now());
                return;
            }
            const transport = await this.ready(session);
            if (!session.run.discovered) {
                const discovery = await transport.discover(session.abort.signal);
                this.assert(session);
                db.transaction(() => { this.assert(session); this.folders(accountId, this.custody.read(accountId).settings, discovery.folders, session.run.generation); db.run('UPDATE mail_imap_runs SET discovered=1,capabilities_json=?,error=NULL,failures=0 WHERE account_id=?', [JSON.stringify(discovery.capabilities), accountId]); });
                this.refresh(session);
                this.schedule(session);
                return;
            }
            const row = db.get('SELECT * FROM mail_imap_folders WHERE account_id=? AND generation=? AND selected=1 AND done=0 ORDER BY path LIMIT 1', [accountId, session.run.generation]);
            if (row) {
                const folder = z.object({ path: z.string(), uid_validity: z.number().nullable(), uid_next: z.number().nullable(), after_uid: z.number(), uid_span: z.number(), highest_modseq: z.string().nullable(), scan_modseq: z.string().nullable() }).parse(row);
                if (folder.uid_validity === null || folder.uid_next === null) {
                    let opened: Awaited<ReturnType<Transport['open']>>;
                    try {
                        opened = await transport.open(folder.path, session.abort.signal);
                    }
                    catch (error) {
                        if (imapFailure(error).code !== 'unavailable')
                            throw error;
                        const discovery = await transport.discover(session.abort.signal);
                        this.assert(session);
                        if (discovery.folders.some(value => value.path === folder.path))
                            throw error;
                        this.change(session, () => { db.run("UPDATE mail_imap_folders SET selected=0,done=1,generation='absent' WHERE account_id=? AND path=?", [accountId, folder.path]); });
                        this.schedule(session);
                        return;
                    }
                    this.assert(session);
                    this.change(session, () => { db.run('UPDATE mail_imap_folders SET highest_modseq=CASE WHEN uid_validity=? THEN highest_modseq ELSE NULL END,uid_validity=?,uid_next=?,scan_modseq=? WHERE account_id=? AND path=?', [opened.uidValidity, opened.uidValidity, opened.uidNext, opened.highestModseq ?? null, accountId, folder.path]); });
                    this.schedule(session);
                    return;
                }
                let page: Awaited<ReturnType<Transport['page']>>;
                try {
                    page = await transport.page(folder.path, folder.uid_validity, folder.after_uid, folder.uid_next - 1, session.abort.signal, folder.uid_span, folder.highest_modseq);
                }
                catch (error) {
                    if (!(error instanceof ImapDenseWindow))
                        throw error;
                    this.assert(session);
                    session.transport?.close();
                    session.transport = undefined;
                    this.change(session, () => { db.run('UPDATE mail_imap_folders SET uid_span=? WHERE account_id=? AND path=?', [error.span, accountId, folder.path]); });
                    this.schedule(session);
                    return;
                }
                this.assert(session);
                const validity = folder.uid_validity;
                if (page.items.some(item => item.flags === null && !db.get('SELECT 1 FROM mail_imap_messages WHERE account_id=? AND message_key=?', [accountId, providerMessageKey({ provider: 'imap', mailboxId: folder.path, uidValidity: validity, uid: item.uid })]))) {
                    this.change(session, () => { db.run('UPDATE mail_imap_folders SET highest_modseq=NULL WHERE account_id=? AND path=?', [accountId, folder.path]); });
                    this.schedule(session);
                    return;
                }
                this.journal.commitPage({ ...scope, expectedCursor: status.checkpoint.cursor, expectedRevision: status.checkpoint.revision, nextCursor: randomUUID(), discoveryComplete: false, jobs: page.items.filter(item => this.repo.readMessage(accountId, { provider: 'imap', mailboxId: folder.path, uidValidity: validity, uid: item.uid })?.contentState !== 'complete').map(item => ({ kind: 'raw', locator: { provider: 'imap', mailboxId: folder.path, uidValidity: validity, uid: item.uid } })) }, () => {
                    this.assert(session);
                    for (const item of page.items) {
                        const locator = { provider: 'imap', mailboxId: folder.path, uidValidity: validity, uid: item.uid } satisfies import('../model.js').ProviderMessageLocator, key = providerMessageKey(locator);
                        if (!db.get('SELECT 1 FROM mail_messages WHERE account_id=? AND message_key=?', [accountId, key]))
                            this.repo.ingestMessage(accountId, { locator, subject: '', rfcMessageId: null, threadId: null, memberships: [folder.path] });
                        if (item.flags !== null)
                            db.run('UPDATE mail_messages SET is_read=? WHERE account_id=? AND message_key=?', [item.flags.includes('\\Seen') ? 1 : 0, accountId, key]);
                        db.run("DELETE FROM mail_tombstones WHERE account_id=? AND message_key=? AND reason='imap_removed'", [accountId, key]);
                        db.run('INSERT INTO mail_imap_messages(account_id,message_key,internal_date,flags_json,modseq,seen_generation) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,message_key) DO UPDATE SET internal_date=excluded.internal_date,flags_json=CASE WHEN ? THEN mail_imap_messages.flags_json ELSE excluded.flags_json END,modseq=CASE WHEN ? THEN mail_imap_messages.modseq ELSE excluded.modseq END,seen_generation=excluded.seen_generation', [accountId, key, item.internalDate, JSON.stringify(item.flags ?? []), item.modseq, session.run.generation, item.flags === null ? 1 : 0, item.flags === null ? 1 : 0]);
                    }
                    db.run('UPDATE mail_imap_folders SET after_uid=?,uid_span=?,done=?,highest_modseq=CASE WHEN ? THEN scan_modseq ELSE highest_modseq END WHERE account_id=? AND path=?', [page.after, page.nextSpan, page.done ? 1 : 0, page.done ? 1 : 0, accountId, folder.path]);
                });
                this.change(session, () => { db.run('UPDATE mail_imap_runs SET error=NULL,failures=0,retry_at=NULL WHERE account_id=?', [accountId]); });
                this.refresh(session);
                this.schedule(session);
                return;
            }
            const missing = db.all("SELECT i.message_key FROM mail_imap_messages i JOIN mail_messages m ON m.account_id=i.account_id AND m.message_key=i.message_key LEFT JOIN mail_imap_folders f ON f.account_id=m.account_id AND f.path=json_extract(m.locator_json,'$.mailboxId') WHERE i.account_id=? AND i.seen_generation IS NOT ? AND (f.selected=1 OR f.generation IS NOT ?) AND NOT EXISTS(SELECT 1 FROM mail_tombstones t WHERE t.account_id=i.account_id AND t.message_key=i.message_key AND t.reason='imap_removed') LIMIT 100", [accountId, session.run.generation, session.run.generation]);
            if (missing.length) {
                db.transaction(() => { this.assert(session); for (const item of missing)
                    removeImapMessage(db, accountId, z.string().parse(item.message_key)); });
                this.schedule(session);
                return;
            }
            // Retire absent navigation folders after the bounded removal sweep. Keep UID history and raw originals.
            db.transaction(() => { this.assert(session); db.run('DELETE FROM mail_folders WHERE account_id=? AND id IN (SELECT path FROM mail_imap_folders WHERE account_id=? AND generation IS NOT ?)', [accountId,accountId,session.run.generation]); });
            if (!status.checkpoint.discoveryComplete)
                this.journal.commitPage({ ...scope, expectedCursor: status.checkpoint.cursor, expectedRevision: status.checkpoint.revision, nextCursor: null, discoveryComplete: true, jobs: [] }, () => this.assert(session));
            this.change(session, () => { db.run("UPDATE mail_imap_runs SET poll_at=?,epoch_resets=0,error=NULL WHERE account_id=?", [Date.now() + (this.options.pollMs ?? 60000), accountId]); });
            this.refresh(session);
            this.schedule(session);
        }
        catch (error) {
            if (this.closed || session.abort.signal.aborted)
                return;
            try {
                this.assert(session);
                const issue = imapFailure(error);
                if (issue.code === 'uidvalidity_changed') {
                    session.transport?.close();
                    session.transport = undefined;
                    this.recoverEpoch(session);
                    return;
                }
                const retry = issue.retryable && session.run.failures < 4, failures = Math.min(5, session.run.failures + 1), at = retry ? Date.now() + 1000 * 2 ** failures : null;
                session.transport?.close();
                session.transport = undefined;
                this.change(session, () => { this.options.database.run('UPDATE mail_imap_runs SET state=?,error=?,failures=?,retry_at=? WHERE account_id=?', [retry ? 'active' : 'attention', ['authentication_failed', 'certificate_failed', 'uidvalidity_changed'].includes(issue.code) ? issue.code : 'provider_unavailable', failures, at, session.run.account_id]); });
                this.refresh(session);
                if (retry)
                    this.schedule(session, at! - Date.now());
                else
                    this.stop(session);
            }
            catch {
                this.stop(session);
            }
        }
    }
    private async handle(work: MailSyncWork) {
        const session = this.current;
        if (!session || session.run.generation !== work.job.generation)
            throw new MailSyncExecutionFailure('permanent');
        const accountId = work.job.account_id;
        try {
            this.assert(session);
            const locator = providerMessageLocatorSchema.parse(JSON.parse(z.string().parse(this.options.database.get('SELECT locator_json FROM mail_messages WHERE account_id=? AND message_key=?', [accountId, work.job.message_key])?.locator_json)));
            if (locator.provider !== 'imap')
                throw new ImapError('invalid_input');
            const message = this.repo.readMessage(accountId, locator);
            const raw = message?.content.find(part => part.kind === 'raw' && part.bytesAvailable && part.ref_id);
            const fence = () => this.assert(session);
            if (work.job.kind === 'raw') {
                if (raw) {
                    work.complete(fence, message?.contentState === 'complete' ? [] : [{ kind: 'body', locator }]);
                    return;
                }
                const transport = await this.ready(session);
                const signal = AbortSignal.any([session.abort.signal, work.signal]);
                await this.content.writePart(accountId, locator, { kind: 'raw', maxBytes: 64 * 1024 * 1024 }, transport.raw(locator.mailboxId, locator.uidValidity, locator.uid, signal), () => { this.assert(session); work.complete(fence, [{ kind: 'body', locator }]); });
                return;
            }
            if (work.job.kind !== 'body' || !raw || raw.bytes === null || raw.sha256 === null || raw.ref_id === null)
                throw new ImapError('message_unavailable');
            await this.projector({ accountId, locator, reference: { id: raw.ref_id, bytes: raw.bytes, sha256: raw.sha256 }, work, assertCurrent: fence });
        }
        catch (error) {
            if (session.abort.signal.aborted || this.closed)
                throw new MailSyncExecutionFailure('retryable');
            this.assert(session);
            const issue = imapFailure(error);
            session.transport?.close();
            session.transport = undefined;
            if (issue.code === 'uidvalidity_changed')
                this.change(session, () => { this.options.database.run("UPDATE mail_imap_runs SET error='uidvalidity_changed' WHERE account_id=?", [accountId]); });
            if (issue.code === 'message_unavailable') {
                this.change(session, () => { removeImapMessage(this.options.database, accountId, work.job.message_key); });
                work.complete(() => this.assert(session));
                return;
            }
            if (['authentication_failed', 'certificate_failed'].includes(issue.code)) {
                this.change(session, () => { this.options.database.run("UPDATE mail_imap_runs SET state='attention',error=? WHERE account_id=?", [issue.code, accountId]); });
                this.stop(session);
            }
            throw new MailSyncExecutionFailure((error instanceof MimeProjectionError ? !['source_failed', 'sink_failed', 'cancelled'].includes(error.code) : !issue.retryable) ? 'permanent' : 'retryable', 1000);
        }
    }
}
