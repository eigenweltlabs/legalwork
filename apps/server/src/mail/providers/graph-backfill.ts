import { randomUUID } from "node:crypto";
import { GraphDeltaState, graphDeltaSchema } from "../storage/graph-delta.js";
import { providerMessageKey } from "../model.js";
import { performance } from "node:perf_hooks";
import { GraphReadTransport, GraphTransportError, graphFolderSchema } from "./graph.js";
import { MailAccessError, type MailAccessCoordinator } from "./access-coordinator.js";
import { GraphState, type GraphRun, type GraphIssue } from "../storage/graph-state.js";
import { MailCredentialRepository, type MailCredentialVersion } from "../storage/credentials.js";
import { MailContentStore, type MailContentReference } from "../storage/content-store.js";
import { createStoredMimeProjector } from "../storage/mime-projection.js";
import { MimeProjectionError } from "../mime/project.js";
import { MailSyncJournal } from "../storage/sync-journal.js";
import { MailSyncExecutor, MailSyncExecutionFailure, type MailSyncWork } from "../runtime/sync-executor.js";
import type { MailDatabase } from "../storage/database-interface.js";
import type { GraphSyncView } from "../graph-sync-view.js";
import { z } from "zod";
type Transport = Pick<GraphReadTransport, "listFolders" | "listMessages" | "getMessage" | "listAttachments" | "messageBytes" | "attachmentBytes" | "getFolder" | "messageDelta">;
type Session = {
    run: GraphRun;
    credentialGeneration: string;
    abort: AbortController;
    timer?: ReturnType<typeof setTimeout>;
    pumping: boolean;
    fatal?: boolean;
    finished?: Promise<void>;
};
export class GraphBackfillError extends Error {
    constructor(readonly code: "closed" | "busy" | "locked" | "not_found") { super(`mail_graph_backfill_${code}`); }
}
export class GraphBackfill {
    private readonly state: GraphState;
    private readonly delta: GraphDeltaState;
    private readonly pollInterval: number;
    private readonly journal: MailSyncJournal;
    private readonly content: MailContentStore;
    private readonly credentials: MailCredentialRepository;
    private readonly executor: MailSyncExecutor;
    private readonly project: ReturnType<typeof createStoredMimeProjector>;
    private current?: Session;
    private closed = false;
    private pending?: Promise<unknown>;
    private readonly timeout: number;
    constructor(private readonly options: {
        database: MailDatabase;
        ownerId: string;
        access: Pick<MailAccessCoordinator, "acquire">;
        transport?: (token: string) => Transport;
        operationTimeoutMs?: number;
        pollIntervalMs?: number;
    }) {
        this.pollInterval = options.pollIntervalMs ?? 60000;
        if (!Number.isSafeInteger(this.pollInterval) || this.pollInterval < 10 || this.pollInterval > 3600000)
            throw new Error("mail_graph_invalid_poll_interval");
        this.delta = new GraphDeltaState(options.database, options.ownerId);
        this.timeout = options.operationTimeoutMs ?? 120000;
        if (!Number.isSafeInteger(this.timeout) || this.timeout < 10 || this.timeout > 120000)
            throw new Error("mail_graph_invalid_timeout");
        this.state = new GraphState(options.database, options.ownerId);
        this.journal = new MailSyncJournal(options.database, options.ownerId);
        this.content = new MailContentStore(options.database, options.ownerId);
        this.credentials = new MailCredentialRepository(options.database, options.ownerId);
        this.project = createStoredMimeProjector(options);
        this.executor = new MailSyncExecutor({ journal: this.journal, handler: work => this.handle(work), maxConcurrentAccounts: 1, maxJobsPerRun: 2, jobTimeoutMs: this.timeout });
    }
    private scope(run: GraphRun) { return { accountId: run.account_id, generation: run.generation, scopeId: "graph:all" }; }
    status(accountId: string): GraphSyncView {
        const run = this.state.read(accountId);
        const p = run ? this.state.progress(accountId, run.generation) : null;
        const complete = !!run && this.journal.status(this.scope(run)).checkpoint.discoveryComplete && p?.folderPending === 0 && p.pending === 0 && p.failed === 0 && p.unavailable === 0 && p.inaccessible === 0 && p.references === 0 && p.projected === p.enumerated && p.downloaded === p.enumerated;
        const poll = this.delta.read(accountId);
        const nextRetryAt = run?.retry_at ?? p?.nextRetryAt ?? poll?.poll_at ?? null;
        const state = !run ? "idle" : run.state === "complete" ? complete ? "complete" : "attention" : run.state === "attention" ? "attention" : run.state === "paused" || this.current?.run.account_id !== accountId ? "paused" : poll?.phase === "idle" && poll.poll_at !== null && poll.poll_at > Date.now() ? complete ? "complete" : "attention" : nextRetryAt !== null && nextRetryAt > Date.now() ? "waiting" : "syncing";
        const removed = this.options.database.get("SELECT count(*) AS removed,coalesce(sum(EXISTS(SELECT 1 FROM mail_content_manifests m JOIN mail_blob_publications p ON p.account_id=m.account_id AND p.ref_id=m.ref_id WHERE m.account_id=t.account_id AND m.message_key=t.message_key AND m.kind='raw' AND m.state='stored')),0) AS retained FROM mail_tombstones t WHERE account_id=? AND reason='graph_removed'", [accountId]);
        return { accountId, provider: "graph", removed: z.number().parse(removed?.removed), retained: z.number().parse(removed?.retained), state, enumerated: p?.enumerated ?? 0, downloaded: p?.downloaded ?? 0, projected: p?.projected ?? 0, pending: p?.pending ?? 0, failed: p?.failed ?? 0, nextRetryAt, error: run?.error === "reconsent_required" ? "reconsent_required" : run?.error ? "provider_unavailable" : state === "attention" ? "content_incomplete" : null, inaccessible: p?.inaccessible ?? 0, referenceAttachments: p?.references ?? 0, unsupportedScopes: ["in-place-archive-mailbox"] };
    }
    start(accountId: string) {
        if (this.closed)
            throw new GraphBackfillError("closed");
        this.state.account(accountId);
        if (this.credentials.status(accountId).state !== "connected")
            throw new GraphBackfillError("locked");
        if (this.current || this.pending) {
            if (this.current?.run.account_id === accountId && !this.current.abort.signal.aborted)
                return this.status(accountId);
            throw new GraphBackfillError("busy");
        }
        let run = this.state.start(accountId);
        if (this.journal.status(this.scope(run)).checkpoint.discoveryComplete && !this.delta.read(accountId))
            run = this.delta.begin(run);
        const credential = this.credentials.status(accountId);
        if (credential.state !== "connected")
            throw new GraphBackfillError("locked");
        const session: Session = { run, credentialGeneration: credential.version.generation, abort: new AbortController(), pumping: false };
        this.current = session;
        this.schedule(session);
        return this.status(accountId);
    }
    pause(accountId: string) {
        this.state.account(accountId);
        const run = this.state.read(accountId);
        try {
            if (run?.state === "active")
                this.state.update(run, "paused");
        }
        finally {
            if (this.current?.run.account_id === accountId)
                this.stop(this.current);
        }
        return this.status(accountId);
    }
    private stop(session: Session) {
        session.abort.abort();
        clearTimeout(session.timer);
        this.executor.pause(session.run.account_id);
        if (!session.pumping && this.current === session)
            this.current = undefined;
    }
    async close() {
        this.closed = true;
        this.executor.close();
        const session = this.current;
        if (session)
            this.stop(session);
        if (session?.finished)
            await Promise.race([session.finished, new Promise<void>(resolve => setTimeout(resolve, 300))]);
    }
    private assert(session: Session, version?: MailCredentialVersion) {
        if (this.closed || session.abort.signal.aborted || this.current !== session)
            throw new GraphBackfillError("closed");
        this.state.assert(session.run);
        const credential = this.credentials.status(session.run.account_id);
        if (credential.state !== "connected" || credential.version.generation !== session.credentialGeneration)
            throw new GraphBackfillError("locked");
        if (version) {
            const now = this.credentials.status(session.run.account_id);
            if (now.state !== "connected" || now.version.generation !== version.generation || now.version.revision !== version.revision)
                throw new GraphBackfillError("locked");
        }
    }
    private schedule(session: Session, delay = 0) {
        if (this.closed || session.abort.signal.aborted)
            return;
        session.timer = setTimeout(() => {
            session.pumping = true;
            session.finished = this.turn(session).finally(() => {
                session.pumping = false;
                if (session.abort.signal.aborted && this.current === session)
                    this.current = undefined;
            });
        }, Math.min(60000, Math.max(0, delay)));
    }
    private async operation<T>(session: Session, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
        if (this.pending)
            throw new GraphBackfillError("busy");
        this.assert(session);
        const controller = new AbortController();
        const deadline = performance.now() + this.timeout;
        const abort = () => controller.abort();
        session.abort.signal.addEventListener("abort", abort, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stopped = new Promise<never>((_, reject) => { controller.signal.addEventListener("abort", () => reject(new GraphTransportError("timeout")), { once: true }); timer = setTimeout(abort, this.timeout); });
        const operation = Promise.resolve().then(() => action(controller.signal));
        this.pending = operation;
        void operation.then(() => {
            if (this.pending === operation)
                this.pending = undefined;
        }, () => {
            if (this.pending === operation)
                this.pending = undefined;
        });
        try {
            const result = await Promise.race([operation, stopped]);
            this.assert(session);
            if (controller.signal.aborted || performance.now() >= deadline)
                throw new GraphTransportError("timeout");
            return result;
        }
        finally {
            clearTimeout(timer);
            session.abort.signal.removeEventListener("abort", abort);
            controller.abort();
        }
    }
    private async access(session: Session) {
        const access = await this.operation(session, () => this.options.access.acquire(session.run.account_id));
        this.assert(session, access.version);
        if (!access.grantedScopes?.some(scope => scope === "Mail.ReadWrite" || scope === "https://graph.microsoft.com/Mail.ReadWrite" || scope === "Mail.Read" || scope === "https://graph.microsoft.com/Mail.Read"))
            throw new MailAccessError("reconsent_required");
        return { version: access.version, transport: this.options.transport?.(access.accessToken) ?? new GraphReadTransport({ accessToken: access.accessToken, timeoutMs: this.timeout }) };
    }
    private async turn(session: Session) {
        try {
            this.assert(session);
            if (session.run.retry_at !== null && session.run.retry_at > Date.now()) {
                this.schedule(session, session.run.retry_at - Date.now());
                return;
            }
            const db = this.options.database, accountId = session.run.account_id;
            const polling = this.delta.read(accountId);
            if (polling?.phase === 'idle') {
                if (polling.poll_at !== null && polling.poll_at > Date.now()) {
                    this.schedule(session, polling.poll_at - Date.now());
                    return;
                }
                session.run = this.delta.begin(session.run);
            }
            const folder = db.get("SELECT * FROM mail_graph_folder_queue WHERE account_id=? AND done=0 ORDER BY depth,id LIMIT 1", [accountId]);
            if (folder) {
                const value = z.object({ id: z.string(), parent_id: z.string().nullable(), depth: z.number(), cursor: z.string().nullable() }).parse(folder);
                const { transport, version } = await this.access(session);
                try {
                    const page = await this.operation(session, signal => transport.listFolders(value.id || null, value.cursor ?? undefined, signal));
                    this.assert(session, version);
                    db.transaction(() => {
                        this.assert(session, version);
                        if (value.depth >= 32 && page.items.length)
                            throw new GraphTransportError("too_large");
                        for (const item of page.items) {
                            if (item.id === value.id)
                                throw new GraphTransportError("invalid_response");
                            if (!this.delta.read(accountId))
                                this.state.repository.putFolder(accountId, { id: item.id, name: item.displayName, kind: "folder", parentId: value.id || null });
                            else
                                db.run("INSERT INTO mail_graph_delta(account_id,folder_id) VALUES(?,?) ON CONFLICT DO NOTHING", [accountId, item.id]);
                            db.run("INSERT INTO mail_graph_folder_queue(account_id,id,parent_id,depth,metadata_json,done) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET metadata_json=excluded.metadata_json", [accountId, item.id, value.id || null, value.depth + 1, JSON.stringify(item), item.childFolderCount > 0 ? 0 : 1]);
                        }
                        db.run("UPDATE mail_graph_folder_queue SET cursor=?,done=? WHERE account_id=? AND id=?", [page.nextLink, page.nextLink === null ? 1 : 0, accountId, value.id]);
                    });
                }
                catch (error) {
                    if (!(error instanceof GraphTransportError) || !["inaccessible", "not_found"].includes(error.code))
                        throw error;
                    this.assert(session, version);
                    db.run("UPDATE mail_graph_folder_queue SET done=1,error='protected_or_inaccessible' WHERE account_id=? AND id=?", [accountId, value.id]);
                }
                session.run = this.state.update(session.run, "active");
                this.schedule(session);
                return;
            }
            const scope = this.scope(session.run), status = this.journal.status(scope);
            if (status.jobs.queued + status.jobs.running + status.jobs.retry > 0) {
                const result = await this.executor.run(scope);
                this.assert(session);
                if (session.fatal || this.pending || result.stopped === "timeout") {
                    session.run = this.state.update(session.run, "attention", "provider_unavailable");
                    this.stop(session);
                    return;
                }
                const progress = this.state.progress(accountId, session.run.generation);
                const delay = progress.nextRetryAt === null ? 0 : Math.max(0, progress.nextRetryAt - Date.now());
                this.schedule(session, delay);
                return;
            }
            if (this.delta.read(accountId)) {
                await this.deltaTurn(session);
                return;
            }
            if (!status.checkpoint.discoveryComplete) {
                const { transport, version } = await this.access(session);
                const page = await this.operation(session, signal => transport.listMessages(status.checkpoint.cursor ?? undefined, signal));
                this.assert(session, version);
                this.journal.commitPage({ ...scope, expectedCursor: status.checkpoint.cursor, expectedRevision: status.checkpoint.revision, nextCursor: page.nextLink, discoveryComplete: page.nextLink === null, jobs: page.items.map(item => ({ kind: "raw", locator: { provider: "graph", messageId: item.id } })) }, () => {
                    this.assert(session, version);
                    for (const item of page.items)
                        this.state.putMetadata(accountId, item);
                });
                session.run = this.state.update(session.run, "active");
                this.schedule(session);
                return;
            }
            session.run = this.delta.begin(session.run);
            this.schedule(session);
        }
        catch (error) {
            if (this.closed || session.abort.signal.aborted)
                return;
            try {
                this.assert(session);
                const retry = (error instanceof GraphTransportError && error.retryable || error instanceof MailAccessError && error.retryable) && !this.pending && session.run.failures < 4;
                const failures = Math.min(5, session.run.failures + 1), delay = Math.max(error instanceof GraphTransportError || error instanceof MailAccessError ? error.retryAfterMs ?? 0 : 0, 1000 * 2 ** Math.min(failures, 5));
                session.run = this.state.update(session.run, retry ? "active" : "attention", error instanceof MailAccessError && error.reconsentRequired ? "reconsent_required" : "provider_unavailable", retry ? Math.min(Number.MAX_SAFE_INTEGER, Date.now() + delay) : null, failures);
                if (retry)
                    this.schedule(session, delay);
                else
                    this.stop(session);
            }
            catch {
                this.stop(session);
            }
        }
    }
    /** A page's continuation and every current-message check become durable together. */
    private commitDelta(session: Session, ids: string[], mutate: () => void, terminal = false) {
        const db = this.options.database, accountId = session.run.account_id, scope = this.scope(session.run), checkpoint = this.journal.status(scope).checkpoint;
        const unique = [...new Set(ids)];
        this.journal.commitPage({ ...scope, expectedCursor: checkpoint.cursor, expectedRevision: checkpoint.revision, nextCursor: terminal ? null : randomUUID(), discoveryComplete: terminal, jobs: unique.map(messageId => ({ kind: 'raw', locator: { provider: 'graph', messageId } })) }, () => {
            this.assert(session);
            for (const messageId of unique) {
                const locator = { provider: 'graph', messageId } satisfies import('../model.js').ProviderMessageLocator, key = providerMessageKey(locator);
                if (!db.get('SELECT 1 FROM mail_messages WHERE account_id=? AND message_key=?', [accountId, key]))
                    this.state.repository.ingestMessage(accountId, { locator, subject: '', rfcMessageId: null, threadId: null, memberships: [] });
                // A later page can mention a message already processed in this round. Replay its
                // bounded current-GET check; old content and unrelated action jobs stay intact.
                db.run("UPDATE mail_sync_jobs SET state='queued',attempts=0,available_at=?,last_error=NULL WHERE account_id=? AND generation=? AND message_key=? AND kind IN ('raw','body') AND state IN ('succeeded','failed')", [Date.now(), accountId, session.run.generation, key]);
            }
            mutate();
        });
        session.run = this.state.update(session.run, 'active');
        this.schedule(session);
    }
    private async deltaTurn(session: Session) {
        const db = this.options.database, accountId = session.run.account_id, poll = this.delta.read(accountId);
        if (!poll)
            throw new GraphTransportError('invalid_response');
        if (poll.phase === 'discover') {
            db.transaction(() => {
                this.assert(session);
                db.run("INSERT INTO mail_graph_delta(account_id,folder_id) SELECT account_id,id FROM mail_folders WHERE account_id=? ON CONFLICT DO NOTHING", [accountId]);
                db.run("UPDATE mail_graph_poll SET phase='folders' WHERE account_id=?", [accountId]);
            });
            this.schedule(session);
            return;
        }
        if (poll.phase === 'folders') {
            const { transport, version } = await this.access(session);
            if (!poll.root_id) {
                const root = await this.operation(session, signal => transport.getFolder('msgfolderroot', signal));
                this.assert(session, version);
                db.run('UPDATE mail_graph_poll SET root_id=? WHERE account_id=?', [root.id, accountId]);
                this.schedule(session);
                return;
            }
            const row = db.get('SELECT * FROM mail_graph_delta WHERE account_id=? AND refresh=1 ORDER BY folder_id LIMIT 1', [accountId]);
            if (row) {
                const folder = graphDeltaSchema.parse(row);
                try {
                    const latest = await this.operation(session, signal => transport.getFolder(folder.folder_id, signal));
                    this.assert(session, version);
                    db.transaction(() => {
                        this.assert(session, version);
                        db.run('UPDATE mail_graph_delta SET metadata_json=?,removed=0,refresh=0 WHERE account_id=? AND folder_id=?', [JSON.stringify(latest), accountId, folder.folder_id]);
                        if (latest.parentFolderId !== poll.root_id && latest.parentFolderId !== latest.id)
                            db.run('INSERT INTO mail_graph_delta(account_id,folder_id) VALUES(?,?) ON CONFLICT DO NOTHING', [accountId, latest.parentFolderId]);
                    });
                }
                catch (error) {
                    if (!(error instanceof GraphTransportError) || error.code !== 'not_found')
                        throw error;
                    this.assert(session, version);
                    db.run("UPDATE mail_graph_delta SET removed=1,refresh=0,phase='sweep' WHERE account_id=? AND folder_id=?", [accountId, folder.folder_id]);
                }
                session.run = this.state.update(session.run, 'active');
                this.schedule(session);
                return;
            }
            db.transaction(() => { this.assert(session); db.run('UPDATE mail_folders SET parent_id=NULL WHERE account_id=?', [accountId]); db.run("UPDATE mail_graph_poll SET phase='create',apply_after='' WHERE account_id=?", [accountId]); });
            this.schedule(session);
            return;
        }
        if (poll.phase === 'create' || poll.phase === 'parents') {
            const rows = db.all('SELECT * FROM mail_graph_delta WHERE account_id=? AND removed=0 AND folder_id>? ORDER BY folder_id LIMIT 100', [accountId, poll.apply_after]);
            db.transaction(() => {
                this.assert(session);
                for (const value of rows) {
                    const folder = graphDeltaSchema.parse(value), metadata = graphFolderSchema.parse(JSON.parse(folder.metadata_json ?? 'null'));
                    this.state.repository.putFolder(accountId, { id: metadata.id, name: metadata.displayName, kind: 'folder', parentId: poll.phase === 'create' || metadata.parentFolderId === poll.root_id ? null : metadata.parentFolderId });
                    db.run('UPDATE mail_graph_poll SET apply_after=? WHERE account_id=?', [folder.folder_id, accountId]);
                }
                if (!rows.length)
                    db.run("UPDATE mail_graph_poll SET phase=?,apply_after='' WHERE account_id=?", [poll.phase === 'create' ? 'parents' : 'messages', accountId]);
            });
            this.schedule(session);
            return;
        }
        const row = db.get("SELECT * FROM mail_graph_delta WHERE account_id=? AND phase!='done' ORDER BY folder_id LIMIT 1", [accountId]);
        if (!row) {
            this.commitDelta(session, [], () => db.run("UPDATE mail_graph_poll SET phase='idle',poll_at=? WHERE account_id=?", [Math.min(Number.MAX_SAFE_INTEGER, Date.now() + this.pollInterval), accountId]), true);
            return;
        }
        const folder = graphDeltaSchema.parse(row);
        if (folder.phase === 'sweep') {
            const rows = db.all(`SELECT m.message_key FROM mail_memberships m WHERE m.account_id=? AND m.folder_id=? AND m.message_key>? AND (?=1 OR NOT EXISTS(SELECT 1 FROM mail_graph_delta_seen s WHERE s.account_id=m.account_id AND s.folder_id=m.folder_id AND s.message_key=m.message_key AND s.generation=?)) ORDER BY m.message_key LIMIT 100`, [accountId, folder.folder_id, folder.sweep_after, folder.removed, session.run.generation]);
            const keys = rows.map(value => z.string().parse(value.message_key));
            if (!keys.length && folder.removed && db.get('SELECT 1 FROM mail_memberships WHERE account_id=? AND folder_id=? LIMIT 1', [accountId, folder.folder_id])) {
                const { transport, version } = await this.access(session);
                let latest: import("./graph.js").GraphFolder;
                try {
                    latest = await this.operation(session, signal => transport.getFolder(folder.folder_id, signal));
                }
                catch (error) {
                    if (error instanceof GraphTransportError && error.code === 'not_found')
                        throw new GraphTransportError('transient');
                    throw error;
                }
                this.assert(session, version);
                db.transaction(() => { this.assert(session, version); db.run("UPDATE mail_graph_delta SET removed=0,metadata_json=?,phase='pending',refresh=0 WHERE account_id=? AND folder_id=?", [JSON.stringify(latest), accountId, folder.folder_id]); db.run("UPDATE mail_graph_poll SET phase='folders' WHERE account_id=?", [accountId]); });
                session.run = this.state.update(session.run, 'active');
                this.schedule(session);
                return;
            }
            this.commitDelta(session, keys.map(key => z.tuple([z.literal('graph'), z.string()]).parse(JSON.parse(key))[1]), () => {
                if (keys.length)
                    db.run('UPDATE mail_graph_delta SET sweep_after=? WHERE account_id=? AND folder_id=?', [keys[keys.length - 1]!, accountId, folder.folder_id]);
                else if (folder.removed) {
                    if (db.get('SELECT 1 FROM mail_memberships WHERE account_id=? AND folder_id=? LIMIT 1', [accountId, folder.folder_id]))
                        throw new GraphTransportError('transient');
                    db.run('UPDATE mail_folders SET parent_id=NULL WHERE account_id=? AND parent_id=?', [accountId, folder.folder_id]);
                    db.run('DELETE FROM mail_folders WHERE account_id=? AND id=?', [accountId, folder.folder_id]);
                    db.run('DELETE FROM mail_graph_delta WHERE account_id=? AND folder_id=?', [accountId, folder.folder_id]);
                }
                else
                    db.run("UPDATE mail_graph_delta SET phase='done',baseline=0,reset_count=0 WHERE account_id=? AND folder_id=?", [accountId, folder.folder_id]);
            });
            return;
        }
        const { transport, version } = await this.access(session);
        try {
            const page = await this.operation(session, signal => transport.messageDelta(folder.folder_id, folder.next_link ?? folder.delta_link ?? undefined, signal));
            this.assert(session, version);
            this.commitDelta(session, page.items.map(item => item.id), () => {
                this.assert(session, version);
                for (const item of page.items)
                    if (!item['@removed'])
                        db.run('INSERT INTO mail_graph_delta_seen(account_id,folder_id,message_key,generation) VALUES(?,?,?,?) ON CONFLICT(account_id,folder_id,message_key) DO UPDATE SET generation=excluded.generation', [accountId, folder.folder_id, providerMessageKey({ provider: 'graph', messageId: item.id }), session.run.generation]);
                db.run('UPDATE mail_graph_delta SET next_link=?,delta_link=?,phase=? WHERE account_id=? AND folder_id=?', [page.nextLink, page.deltaLink ?? folder.delta_link, page.nextLink ? 'paging' : folder.baseline ? 'sweep' : 'done', accountId, folder.folder_id]);
            });
        }
        catch (error) {
            if (error instanceof GraphTransportError && error.code === 'delta_expired' && folder.reset_count < 2) {
                this.assert(session, version);
                db.transaction(() => { db.run("UPDATE mail_graph_delta SET next_link=NULL,delta_link=NULL,baseline=1,phase='pending',sweep_after='',reset_count=reset_count+1 WHERE account_id=? AND folder_id=?", [accountId, folder.folder_id]); db.run('DELETE FROM mail_graph_delta_seen WHERE account_id=? AND folder_id=?', [accountId, folder.folder_id]); });
                this.schedule(session);
                return;
            }
            if (error instanceof GraphTransportError && error.code === 'not_found') {
                try {
                    await this.operation(session, signal => transport.getFolder(folder.folder_id, signal));
                }
                catch (check) {
                    if (check instanceof GraphTransportError && check.code === 'not_found') {
                        this.assert(session, version);
                        db.run("UPDATE mail_graph_delta SET removed=1,phase='sweep',sweep_after='' WHERE account_id=? AND folder_id=?", [accountId, folder.folder_id]);
                        this.schedule(session);
                        return;
                    }
                    throw check;
                }
                throw new GraphTransportError('transient');
            }
            throw error;
        }
    }
    private raw(accountId: string, key: string): MailContentReference | null { const row = this.options.database.get("SELECT r.id,r.bytes,r.sha256 FROM mail_content_manifests m JOIN mail_content_refs r ON r.account_id=m.account_id AND r.id=m.ref_id JOIN mail_blob_publications p ON p.account_id=r.account_id AND p.ref_id=r.id WHERE m.account_id=? AND m.message_key=? AND m.kind='raw' AND m.state='stored'", [accountId, key]); return row ? z.object({ id: z.string(), bytes: z.number(), sha256: z.string() }).parse(row) : null; }
    private async handle(work: MailSyncWork) {
        const session = this.current;
        if (!session || session.run.account_id !== work.job.account_id || session.run.generation !== work.job.generation)
            throw new MailSyncExecutionFailure("permanent");
        const accountId = work.job.account_id, key = work.job.message_key;
        try {
            const identity = z.tuple([z.literal("graph"), z.string()]).parse(JSON.parse(key)), locator = { provider: "graph", messageId: identity[1] } satisfies import("../model.js").ProviderMessageLocator;
            const { transport, version } = await this.access(session);
            const fence = () => { this.assert(session, version); work.assertCurrent(); };
            fence();
            if (work.job.kind !== "raw" && work.job.kind !== "body")
                throw new MailSyncExecutionFailure("permanent");
            let metadata: import("./graph.js").GraphMessage;
            try {
                metadata = await transport.getMessage(locator.messageId, work.signal);
                fence();
            }
            catch (error) {
                if (!(error instanceof GraphTransportError) || error.code !== 'not_found')
                    throw error;
                fence();
                work.complete(() => { this.assert(session, version); this.delta.remove(accountId, key); });
                return;
            }
            let raw = this.raw(accountId, key);
            const bound = this.options.database.get("SELECT raw_change_key FROM mail_graph_messages WHERE account_id=? AND message_key=?", [accountId, key]);
            if (!raw || bound?.raw_change_key !== metadata.changeKey) {
                async function* stableOriginal() {
                    for await (const chunk of transport.messageBytes(locator.messageId, work.signal)) {
                        fence();
                        yield chunk;
                    }
                    const after = await transport.getMessage(locator.messageId, work.signal);
                    fence();
                    if (after.changeKey !== metadata.changeKey)
                        throw new GraphTransportError("transient");
                }
                raw = await this.content.writePart(accountId, locator, { kind: "raw", maxBytes: 64 * 1024 * 1024 }, stableOriginal(), () => {
                    fence();
                    this.state.putMetadata(accountId, metadata);
                    this.options.database.run("UPDATE mail_graph_messages SET raw_change_key=?,parts_complete=0,error=NULL WHERE account_id=? AND message_key=?", [metadata.changeKey, accountId, key]);
                    if (work.job.kind === "raw")
                        work.complete(() => this.assert(session, version), [{ kind: "body", locator }]);
                });
            }
            else if (work.job.kind === "raw") {
                const completed = this.options.database.get('SELECT parts_complete FROM mail_graph_messages WHERE account_id=? AND message_key=?', [accountId, key]);
                if (completed?.parts_complete === 1) {
                    work.complete(() => { this.assert(session, version); this.state.putMetadata(accountId, metadata); });
                    return;
                }
                work.complete(() => { this.assert(session, version); this.state.putMetadata(accountId, metadata); }, [{ kind: "body", locator }]);
            }
            else
                this.options.database.transaction(() => { fence(); this.state.putMetadata(accountId, metadata); });
            if (work.job.kind === "raw")
                return;
            let cursor: string | undefined, parts = 0, attachmentBytes = 0;
            const seen = new Set<string>();
            let unavailable = false;
            do {
                const page = await transport.listAttachments(locator.messageId, cursor, work.signal);
                fence();
                for (const part of page.items) {
                    if (++parts > 100 || seen.has(part.id))
                        throw new GraphTransportError("too_large");
                    seen.add(part.id);
                    let error: GraphIssue | null = part["@odata.type"] === "#microsoft.graph.referenceAttachment" ? "reference_attachment" : null, ref: string | null = null;
                    if (!error) {
                        try {
                            if (part.size > 32 * 1024 * 1024 || part.size > 64 * 1024 * 1024 - attachmentBytes)
                                throw new GraphTransportError("too_large");
                            const reference = await this.content.writePart(accountId, locator, { kind: "attachment", partId: `graph:${part.id}`, maxBytes: 32 * 1024 * 1024, ...(part["@odata.type"] === "#microsoft.graph.fileAttachment" ? { expectedBytes: part.size } : {}) }, transport.attachmentBytes(locator.messageId, part.id, work.signal), () => fence());
                            attachmentBytes += reference.bytes;
                            if (attachmentBytes > 64 * 1024 * 1024)
                                throw new GraphTransportError("too_large");
                            ref = reference.id;
                        }
                        catch (cause) {
                            if (!(cause instanceof GraphTransportError) || !["inaccessible", "not_found"].includes(cause.code))
                                throw cause;
                            error = "protected_or_inaccessible";
                        }
                    }
                    fence();
                    this.state.attachment(accountId, key, raw.id, part, ref, error);
                    unavailable ||= error !== null;
                }
                cursor = page.nextLink ?? undefined;
            } while (cursor !== undefined);
            fence();
            const afterAttachments = await transport.getMessage(locator.messageId, work.signal);
            fence();
            if (afterAttachments.changeKey !== metadata.changeKey)
                throw new GraphTransportError("transient");
            const completedWork: MailSyncWork = { job: work.job, signal: work.signal, assertCurrent: () => work.assertCurrent(), complete: (metadata, followups) => work.complete(writer => {
                    metadata(writer);
                    this.assert(session, version);
                    // Separate Graph attachment references remain owned even when the MIME projector replaces manifest associations.
                    for (const row of this.options.database.all("SELECT id FROM mail_graph_attachments WHERE account_id=? AND message_key=?", [accountId, key]))
                        if (typeof row.id === "string" && !seen.has(row.id))
                            this.options.database.run("DELETE FROM mail_graph_attachments WHERE account_id=? AND message_key=? AND id=?", [accountId, key, row.id]);
                    for (const row of this.options.database.all("SELECT a.id,a.ref_id,r.bytes,r.sha256 FROM mail_graph_attachments a LEFT JOIN mail_content_refs r ON r.account_id=a.account_id AND r.id=a.ref_id WHERE a.account_id=? AND a.message_key=? AND a.raw_ref_id=?", [accountId, key, raw.id])) {
                        if (typeof row.id !== "string")
                            throw new Error("mail_graph_invalid_part");
                        if (typeof row.ref_id === "string" && typeof row.bytes === "number" && typeof row.sha256 === "string") {
                            if (!this.options.database.get("SELECT 1 FROM mail_content_manifests WHERE account_id=? AND message_key=? AND kind='attachment' AND ref_id=?", [accountId, key, row.ref_id]))
                                writer.putContent(locator, { kind: "attachment", partId: `graph:${row.id}`, state: "stored", reference: { id: row.ref_id, bytes: row.bytes, sha256: row.sha256 } });
                        }
                        else
                            writer.putContent(locator, { kind: "attachment", partId: `graph:${row.id}`, state: "unavailable" });
                    }
                    const protectedPart = this.options.database.get(`SELECT 1 FROM mail_mime_parts WHERE account_id=? AND message_key=? AND raw_ref_id=? AND json_extract(metadata_json,'$.contentType') IN ('application/pkcs7-mime','application/x-pkcs7-mime','application/pgp-encrypted','application/x-microsoft-rpmsg-message') LIMIT 1`, [accountId, key, raw.id]);
                    unavailable ||= !!protectedPart;
                    this.options.database.run("UPDATE mail_graph_messages SET parts_complete=?,error=? WHERE account_id=? AND message_key=?", [unavailable ? 0 : 1, protectedPart ? "protected_or_inaccessible" : unavailable ? "content_incomplete" : null, accountId, key]);
                    if (unavailable)
                        writer.setAttachmentsEnumerated(locator, false);
                }, followups) };
            await this.project({ accountId, locator, reference: raw, work: completedWork, assertCurrent: () => this.assert(session, version) });
        }
        catch (error) {
            if (this.closed || session.abort.signal.aborted)
                throw new MailSyncExecutionFailure("retryable");
            work.assertCurrent();
            this.assert(session);
            const permanent = error instanceof MimeProjectionError && !["source_failed", "sink_failed"].includes(error.code) || error instanceof GraphTransportError && !error.retryable && error.code !== "unauthorized";
            const issue: GraphIssue = error instanceof GraphTransportError && error.code === "inaccessible" ? "protected_or_inaccessible" : error instanceof GraphTransportError && error.code === "not_found" ? "message_unavailable" : error instanceof MailAccessError && error.reconsentRequired ? "reconsent_required" : "content_incomplete";
            if (permanent)
                this.state.issue(accountId, key, issue);
            if (this.pending || error instanceof MailAccessError && !error.retryable || error instanceof GraphTransportError && error.code === "unauthorized") {
                session.fatal = true;
                this.executor.pause(accountId);
            }
            throw new MailSyncExecutionFailure(permanent ? "permanent" : "retryable", error instanceof GraphTransportError || error instanceof MailAccessError ? error.retryAfterMs ?? 1000 : 1000);
        }
    }
}
