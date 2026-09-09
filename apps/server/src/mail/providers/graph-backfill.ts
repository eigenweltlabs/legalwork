import { performance } from "node:perf_hooks";
import { GraphReadTransport, GraphTransportError } from "./graph.js";
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
type Transport = Pick<GraphReadTransport, "listFolders" | "listMessages" | "getMessage" | "listAttachments" | "messageBytes" | "attachmentBytes">;
type Session = {
    run: GraphRun;
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
    }) {
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
        const nextRetryAt = run?.retry_at ?? p?.nextRetryAt ?? null;
        const state = !run ? "idle" : run.state === "complete" ? complete ? "complete" : "attention" : run.state === "attention" ? "attention" : run.state === "paused" || this.current?.run.account_id !== accountId ? "paused" : nextRetryAt !== null && nextRetryAt > Date.now() ? "waiting" : "syncing";
        return { accountId, provider: "graph", removed: 0, retained: 0, state, enumerated: p?.enumerated ?? 0, downloaded: p?.downloaded ?? 0, projected: p?.projected ?? 0, pending: p?.pending ?? 0, failed: p?.failed ?? 0, nextRetryAt, error: run?.error === "reconsent_required" ? "reconsent_required" : run?.error ? "provider_unavailable" : state === "attention" ? "content_incomplete" : null, inaccessible: p?.inaccessible ?? 0, referenceAttachments: p?.references ?? 0, unsupportedScopes: ["in-place-archive-mailbox"] };
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
        const run = this.state.start(accountId);
        if (run.state === "complete")
            return this.status(accountId);
        const session: Session = { run, abort: new AbortController(), pumping: false };
        this.current = session;
        this.schedule(session);
        return this.status(accountId);
    }
    pause(accountId: string) { this.state.account(accountId); const run = this.state.read(accountId); try {
        if (run?.state === "active")
            this.state.update(run, "paused");
    }
    finally {
        if (this.current?.run.account_id === accountId)
            this.stop(this.current);
    } return this.status(accountId); }
    private stop(session: Session) { session.abort.abort(); clearTimeout(session.timer); this.executor.pause(session.run.account_id); if (!session.pumping && this.current === session)
        this.current = undefined; }
    async close() { this.closed = true; this.executor.close(); const session = this.current; if (session)
        this.stop(session); if (session?.finished)
        await Promise.race([session.finished, new Promise<void>(resolve => setTimeout(resolve, 300))]); }
    private assert(session: Session, version?: MailCredentialVersion) { if (this.closed || session.abort.signal.aborted || this.current !== session)
        throw new GraphBackfillError("closed"); this.state.assert(session.run); if (version) {
        const now = this.credentials.status(session.run.account_id);
        if (now.state !== "connected" || now.version.generation !== version.generation || now.version.revision !== version.revision)
            throw new GraphBackfillError("locked");
    } }
    private schedule(session: Session, delay = 0) { if (this.closed || session.abort.signal.aborted)
        return; session.timer = setTimeout(() => { session.pumping = true; session.finished = this.turn(session).finally(() => { session.pumping = false; if (session.abort.signal.aborted && this.current === session)
        this.current = undefined; }); }, Math.min(60000, Math.max(0, delay))); }
    private async operation<T>(session: Session, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
        if (this.pending)
            throw new GraphBackfillError("busy");
        this.assert(session);
        const controller = new AbortController();
        const deadline=performance.now()+this.timeout;
        const abort = () => controller.abort();
        session.abort.signal.addEventListener("abort", abort, { once: true });
        let timer: ReturnType<typeof setTimeout> | undefined;
        const stopped = new Promise<never>((_, reject) => { controller.signal.addEventListener("abort", () => reject(new GraphTransportError("timeout")), { once: true }); timer = setTimeout(abort, this.timeout); });
        const operation = Promise.resolve().then(() => action(controller.signal));
        this.pending = operation;
        void operation.then(() => { if (this.pending === operation)
            this.pending = undefined; }, () => { if (this.pending === operation)
            this.pending = undefined; });
        try {
            const result = await Promise.race([operation, stopped]);
            this.assert(session);
            if (controller.signal.aborted || performance.now()>=deadline)
                throw new GraphTransportError("timeout");
            return result;
        }
        finally {
            clearTimeout(timer);
            session.abort.signal.removeEventListener("abort", abort);
            controller.abort();
        }
    }
    private async access(session: Session) { const access = await this.operation(session, () => this.options.access.acquire(session.run.account_id)); this.assert(session, access.version); if (!access.grantedScopes?.some(scope => scope === "Mail.ReadWrite" || scope === "https://graph.microsoft.com/Mail.ReadWrite" || scope === "Mail.Read" || scope === "https://graph.microsoft.com/Mail.Read"))
        throw new MailAccessError("reconsent_required"); return { version: access.version, transport: this.options.transport?.(access.accessToken) ?? new GraphReadTransport({ accessToken: access.accessToken, timeoutMs: this.timeout }) }; }
    private async turn(session: Session) {
        try {
            this.assert(session);
            if (session.run.retry_at !== null && session.run.retry_at > Date.now()) {
                this.schedule(session, session.run.retry_at - Date.now());
                return;
            }
            const db = this.options.database, accountId = session.run.account_id;
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
                            this.state.repository.putFolder(accountId, { id: item.id, name: item.displayName, kind: "folder", parentId: value.id || null });
                            db.run("INSERT INTO mail_graph_folder_queue(account_id,id,parent_id,depth,metadata_json,done) VALUES(?,?,?,?,?,?) ON CONFLICT(account_id,id) DO UPDATE SET metadata_json=excluded.metadata_json", [accountId,item.id,value.id||null,value.depth+1,JSON.stringify(item),item.childFolderCount>0?0:1]);
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
            if (!status.checkpoint.discoveryComplete) {
                const { transport, version } = await this.access(session);
                const page = await this.operation(session, signal => transport.listMessages(status.checkpoint.cursor ?? undefined, signal));
                this.assert(session, version);
                this.journal.commitPage({ ...scope, expectedCursor: status.checkpoint.cursor, expectedRevision: status.checkpoint.revision, nextCursor: page.nextLink, discoveryComplete: page.nextLink === null, jobs: page.items.map(item => ({ kind: "raw", locator: { provider: "graph", messageId: item.id } })) }, () => { this.assert(session, version); for (const item of page.items)
                    this.state.putMetadata(accountId, item); });
                session.run = this.state.update(session.run, "active");
                this.schedule(session);
                return;
            }
            const p = this.state.progress(accountId, session.run.generation);
            const complete = p.failed === 0 && p.unavailable === 0 && p.inaccessible === 0 && p.references === 0 && p.projected === p.enumerated && p.downloaded === p.enumerated;
            session.run = this.state.update(session.run, complete ? "complete" : "attention");
            this.stop(session);
        }
        catch (error) {
            if (this.closed || session.abort.signal.aborted)
                return;
            try {
                this.assert(session);
                const retry = (error instanceof GraphTransportError && error.retryable || error instanceof MailAccessError && error.retryable) && !this.pending && session.run.failures < 4;
                const failures = session.run.failures + 1, delay = Math.max(error instanceof GraphTransportError || error instanceof MailAccessError ? error.retryAfterMs ?? 0 : 0, 1000 * 2 ** Math.min(failures, 5));
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
            if(work.job.kind!=="raw"&&work.job.kind!=="body")throw new MailSyncExecutionFailure("permanent");
            const metadata=await transport.getMessage(locator.messageId,work.signal);fence();
            let raw=this.raw(accountId,key);
            const bound=this.options.database.get("SELECT raw_change_key FROM mail_graph_messages WHERE account_id=? AND message_key=?",[accountId,key]);
            if(!raw || bound?.raw_change_key!==metadata.changeKey){
                async function* stableOriginal(){
                    for await(const chunk of transport.messageBytes(locator.messageId,work.signal)){fence();yield chunk;}
                    const after=await transport.getMessage(locator.messageId,work.signal);fence();
                    if(after.changeKey!==metadata.changeKey)throw new GraphTransportError("transient");
                }
                raw=await this.content.writePart(accountId,locator,{kind:"raw",maxBytes:64*1024*1024},stableOriginal(),()=>{
                    fence();this.state.putMetadata(accountId,metadata);
                    this.options.database.run("UPDATE mail_graph_messages SET raw_change_key=?,parts_complete=0,error=NULL WHERE account_id=? AND message_key=?",[metadata.changeKey,accountId,key]);
                    if(work.job.kind==="raw")work.complete(()=>this.assert(session,version),[{kind:"body",locator}]);
                });
            }else if(work.job.kind==="raw"){
                work.complete(()=>{this.assert(session,version);this.state.putMetadata(accountId,metadata);},[{kind:"body",locator}]);
            }else this.options.database.transaction(()=>{fence();this.state.putMetadata(accountId,metadata);});
            if(work.job.kind==="raw")return;
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
                            if(part.size>32*1024*1024 || part.size>64*1024*1024-attachmentBytes)throw new GraphTransportError("too_large");
                            const reference = await this.content.writePart(accountId, locator, { kind: "attachment", partId: `graph:${part.id}`, maxBytes: 32 * 1024 * 1024, ...(part["@odata.type"] === "#microsoft.graph.fileAttachment" ? { expectedBytes: part.size } : {}) }, transport.attachmentBytes(locator.messageId, part.id, work.signal), () => fence());
                            attachmentBytes += reference.bytes;
                            if(attachmentBytes>64*1024*1024)throw new GraphTransportError("too_large");
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
            const afterAttachments=await transport.getMessage(locator.messageId,work.signal);fence();
            if(afterAttachments.changeKey!==metadata.changeKey)throw new GraphTransportError("transient");
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
                    const protectedPart=this.options.database.get(`SELECT 1 FROM mail_mime_parts WHERE account_id=? AND message_key=? AND raw_ref_id=? AND json_extract(metadata_json,'$.contentType') IN ('application/pkcs7-mime','application/x-pkcs7-mime','application/pgp-encrypted','application/x-microsoft-rpmsg-message') LIMIT 1`,[accountId,key,raw.id]);
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
