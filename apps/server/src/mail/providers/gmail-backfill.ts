import { performance } from "node:perf_hooks";
import { MimeProjectionError } from "../mime/project.js";
import type { MailDatabase } from "../storage/database-interface.js";
import { MailContentStore, type MailContentReference } from "../storage/content-store.js";
import { MailCredentialRepository, type MailCredentialVersion } from "../storage/credentials.js";
import { GmailRunStore, type GmailRun } from "../storage/gmail-state.js";
import { MailSyncJournal, type SyncScope } from "../storage/sync-journal.js";
import { MailSyncExecutor, MailSyncExecutionFailure, type MailSyncWork } from "../runtime/sync-executor.js";
type MailSyncView = Extract<import("../sync-view.js").MailSyncView,{provider:"gmail"}>;
import { providerMessageKey, type ProviderMessageLocator } from "../model.js";
import { MailAccessError, type MailAccessCoordinator } from "./access-coordinator.js";
import { GmailReadTransport, GmailTransportError, type GmailRawMetadata } from "./gmail.js";
export class GmailBackfillError extends Error {
  constructor(readonly code: "closed" | "busy" | "not_found" | "locked" | "configuration_invalid" | "storage_unavailable") { super(`mail_gmail_backfill_${code}`); }
}
export type GmailProjectionInput = { accountId: string; locator: ProviderMessageLocator; reference: MailContentReference;
  source: Iterable<Uint8Array> | AsyncIterable<Uint8Array>; work: MailSyncWork; assertCurrent(): void };
export type GmailBackfillOptions = { database: MailDatabase; ownerId: string; access: Pick<MailAccessCoordinator, "acquire">;
  projectRaw?: (input: GmailProjectionInput) => Promise<void>;
  transport?: (accessToken: string) => Pick<GmailReadTransport, "listLabels" | "listMessages" | "consumeRaw" | "getProfile" | "listHistory" | "getMetadata">;
  jobsPerTurn?: number; pageSize?: number; operationTimeoutMs?: number; turnDelayMs?: number; pollIntervalMs?: number };
type Session = { run: GmailRun; abort: AbortController; labelsLoaded: boolean; timer?: ReturnType<typeof setTimeout>; pumping: boolean;
  error: MailSyncView["error"]; fatal: boolean; finished?: Promise<void> };
function bounded(value: number | undefined, fallback: number, min: number, max: number): number {
  const number = value ?? fallback;
  if (!Number.isSafeInteger(number) || number < min || number > max) throw new GmailBackfillError("configuration_invalid");
  return number;
}
function classify(error: unknown): { code: NonNullable<MailSyncView["error"]>; retry: boolean; delay: number; fatal: boolean } {
  if (error instanceof MimeProjectionError) return { code: ["source_failed", "sink_failed"].includes(error.code) ? "storage_unavailable" : "content_incomplete", retry: ["source_failed", "sink_failed"].includes(error.code), delay: 1000, fatal: false };
  if (error instanceof MailAccessError) return { code: error.reconsentRequired ? "reconsent_required" : error.code === "configuration_invalid" || error.code === "binding_mismatch" ? "configuration_invalid" : "provider_unavailable", retry: error.retryable, delay: error.retryAfterMs ?? 1000, fatal: !error.retryable };
  if (error instanceof GmailTransportError) return { code: error.code === "access_token_rejected" || error.code === "reconsent_required" ? "reconsent_required" : error.code === "rate_limited" ? "rate_limited" : error.code === "not_found" ? "message_unavailable" : error.code === "raw_too_large" || error.code === "response_too_large" ? "content_incomplete" : "provider_unavailable",
    retry: error.retryable, delay: error.retryAfterMs ?? 1000, fatal: ["access_token_rejected", "reconsent_required", "forbidden", "quota_exceeded"].includes(error.code) };
  return { code: "storage_unavailable", retry: true, delay: 1000, fatal: false };
}
/** One-slot awaited bridge: encoded provider envelope stays in transport; decoded MIME is never collected here. */
async function* chunks(produce: (consume: (chunk: Uint8Array) => Promise<void>) => Promise<void>, signal: AbortSignal): AsyncGenerator<Uint8Array> {
  let slot: { chunk: Uint8Array; resolve(): void; reject(error: Error): void } | undefined;
  let active: typeof slot;
  let done = false, failure: unknown, wake: () => void = () => {};
  const abort = () => { failure = new Error("cancelled"); done = true; slot?.reject(new Error("cancelled")); active?.reject(new Error("cancelled")); wake(); };
  signal.addEventListener("abort", abort, { once: true });
  if (signal.aborted) abort();
  const producing = Promise.resolve().then(() => {
    if (done) throw new Error("cancelled");
    return produce(chunk => new Promise<void>((resolve, reject) => { if (done) { reject(new Error("cancelled")); return; } slot = { chunk, resolve, reject }; wake(); }));
  }).then(() => { done = true; wake(); }, error => { failure = error; done = true; wake(); });
  try {
    while (true) {
      if (failure) throw failure;
      const current = slot;
      if (current) { slot = undefined; active = current; try { yield current.chunk; current.resolve(); active = undefined; } catch (error) { current.reject(new Error("consumer_failed")); throw error; } }
      else if (done) return;
      else await new Promise<void>(resolve => { wake = resolve; });
    }
  } finally { abort(); signal.removeEventListener("abort", abort); void producing; }
}
/** Recent-window then all-history backfill. Only one active account/raw request, no public credential surface. */
export class GmailBackfill {
  private readonly runs: GmailRunStore;
  private readonly journal: MailSyncJournal;
  private readonly credentials: MailCredentialRepository;
  private readonly content: MailContentStore;
  private readonly executor: MailSyncExecutor;
  private readonly pageSize: number;
  private readonly operationTimeout: number;
  private readonly turnDelay: number;
  private readonly pollInterval: number;
  private current?: Session;
  private closed = false;
  private pendingOperation?: Promise<unknown>;
  constructor(private readonly options: GmailBackfillOptions) {
    this.pageSize = bounded(options.pageSize, 100, 1, 500);
    this.operationTimeout = bounded(options.operationTimeoutMs, 60000, 10, 120000);
    this.turnDelay = bounded(options.turnDelayMs, 0, 0, 1000);
    this.pollInterval = bounded(options.pollIntervalMs, 60000, 1000, 3600000);
    this.runs = new GmailRunStore(options.database, options.ownerId);
    this.journal = new MailSyncJournal(options.database, options.ownerId);
    this.credentials = new MailCredentialRepository(options.database, options.ownerId);
    this.content = new MailContentStore(options.database, options.ownerId);
    this.executor = new MailSyncExecutor({ journal: this.journal, handler: work => this.handle(work), maxConcurrentAccounts: 1,
      maxJobsPerRun: bounded(options.jobsPerTurn, 5, 1, 25), jobTimeoutMs: this.operationTimeout });
  }
  private stamp(run: GmailRun) { return { generation: run.generation, revision: run.revision }; }
  private account(accountId: string): void {
    const row = this.options.database.get("SELECT provider FROM mail_accounts WHERE id=? AND owner_id=?", [accountId, this.options.ownerId]);
    if (!row) throw new GmailBackfillError("not_found");
    if (row.provider !== "gmail") throw new GmailBackfillError("configuration_invalid");
  }
  status(accountId: string): MailSyncView {
    this.account(accountId);
    const run = this.runs.read(accountId);
    if (!run) return { accountId, provider: "gmail", state: "idle", enumerated: 0, downloaded: 0, projected: 0, failed: 0, pending: 0, removed: 0, retained: 0, nextRetryAt: null, error: null };
    const progress = this.runs.progress(accountId, run.generation);
    const retry = run.nextRetryAt ?? progress.nextRetryAt;
    const complete = progress.enumerationComplete && progress.failed === 0 && progress.pending === 0 && progress.downloaded === progress.enumerated && progress.projected === progress.enumerated;
    const invalidated = run.phase === "history" && (progress.failed > 0 || (run.pollAt !== null && progress.pending === 0 && !complete));
    const state = run.state === "paused" ? "paused" : run.state === "attention" ? "attention" : run.state === "complete" ? complete ? "complete" : "attention"
      : !this.current || this.current.run.accountId !== accountId || this.current.abort.signal.aborted ? "paused" : invalidated ? "attention" : retry !== null && retry > Date.now() ? "waiting" : run.phase === "history" && run.pollAt !== null && run.pollAt > Date.now() && complete ? "complete" : "syncing";
    return { accountId, provider: "gmail", state, enumerated: progress.enumerated, downloaded: progress.downloaded,
      projected: progress.projected, failed: progress.failed, pending: progress.pending, removed: progress.removed, retained: progress.retained, nextRetryAt: retry, error: run.error ?? ((run.state === "complete" && !complete) || invalidated ? "content_incomplete" : null) };
  }
  start(accountId: string): MailSyncView {
    if (this.closed) throw new GmailBackfillError("closed"); this.account(accountId);
    if (this.credentials.status(accountId).state !== "connected") throw new GmailBackfillError("locked");
    if (this.current) {
      if (this.current.run.accountId === accountId && !this.current.abort.signal.aborted) return this.status(accountId);
      throw new GmailBackfillError("busy");
    }
    if (this.pendingOperation) throw new GmailBackfillError("busy");
    const run = this.runs.startOrResume(accountId);

    const session: Session = { run, abort: new AbortController(), labelsLoaded: false, pumping: false, error: null, fatal: false };
    this.current = session; this.schedule(session, 0); return this.status(accountId);
  }
  pause(accountId: string): MailSyncView {
    if (this.closed) throw new GmailBackfillError("closed"); this.account(accountId);
    const run = this.runs.read(accountId);
    try { if (run && run.state !== "paused") this.runs.setState(accountId, this.stamp(run), "paused"); }
    finally { if (this.current?.run.accountId === accountId) this.stop(this.current); }
    return this.status(accountId);
  }
  private stop(session: Session): void {
    session.abort.abort(); clearTimeout(session.timer); this.executor.pause(session.run.accountId);
    if (!session.pumping && this.current === session) this.current = undefined;
  }
  async close(): Promise<void> {
    this.closed = true; this.executor.close(); const session = this.current;
    if (session) this.stop(session);
    // Durable active run resumes after reopen; stop invalidates all callbacks before waiting.
    if (session?.finished) await Promise.race([session.finished, new Promise<void>(resolve => setTimeout(resolve, 300))]);
  }
  private assert(session: Session, version?: MailCredentialVersion): void {
    if (this.closed || session.abort.signal.aborted || this.current !== session) throw new GmailBackfillError("closed");
    this.runs.assertCurrent(session.run.accountId, this.stamp(session.run));
    if (version) {
      const status = this.credentials.status(session.run.accountId);
      if (status.state !== "connected" || status.version.generation !== version.generation || status.version.revision !== version.revision) throw new GmailBackfillError("locked");
    }
  }
  private schedule(session: Session, delay: number): void {
    if (this.closed || session.abort.signal.aborted || this.current !== session) return;
    session.timer = setTimeout(() => {
      session.pumping = true;
      session.finished = this.turn(session).catch(() => {}).finally(() => { session.pumping = false; if (session.abort.signal.aborted && this.current === session) this.current = undefined; });
    }, Math.min(60000, Math.max(this.turnDelay, delay)));
  }
  private async boundedOperation<T>(session: Session, action: (signal: AbortSignal) => Promise<T>): Promise<T> {
    if (this.pendingOperation) throw new GmailBackfillError("busy");
    const controller = new AbortController(), deadline = performance.now() + this.operationTimeout;
    const abort = () => controller.abort();
    session.abort.signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(abort, this.operationTimeout);
    const stopped = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new GmailTransportError("timeout")), { once: true }));
    try {
      this.assert(session);
      const operation = Promise.resolve().then(() => action(controller.signal));
      this.pendingOperation = operation;
      void operation.then(() => { if (this.pendingOperation === operation) this.pendingOperation = undefined; }, () => { if (this.pendingOperation === operation) this.pendingOperation = undefined; });
      const result = await Promise.race([operation, stopped]);
      this.assert(session);
      if (controller.signal.aborted || performance.now() >= deadline) throw new GmailTransportError("timeout");
      return result;
    } finally { clearTimeout(timer); session.abort.signal.removeEventListener("abort", abort); controller.abort(); }
  }
  private async access(session: Session) {
    const access = await this.boundedOperation(session, () => this.options.access.acquire(session.run.accountId)); this.assert(session, access.version);
    if (!access.grantedScopes?.includes("https://www.googleapis.com/auth/gmail.modify")) throw new MailAccessError("reconsent_required");
    return { access, transport: this.options.transport?.(access.accessToken) ?? new GmailReadTransport({ accessToken: access.accessToken, timeoutMs: this.operationTimeout }) };
  }
  private async turn(session: Session): Promise<void> {
    try {
      this.assert(session);
      if (session.run.nextRetryAt !== null && session.run.nextRetryAt > Date.now()) { this.schedule(session, session.run.nextRetryAt - Date.now()); return; }
      if (session.run.historyId === null) {
        const { access, transport } = await this.access(session);
        const profile = await this.boundedOperation(session, signal => transport.getProfile({ signal })); this.assert(session, access.version);
        const existing = !!this.options.database.get("SELECT 1 FROM mail_sync_scopes WHERE account_id=? AND generation=? AND revision>0 LIMIT 1", [session.run.accountId, session.run.generation]);
        session.run = existing ? this.runs.beginReconciliation(session.run.accountId, this.stamp(session.run), profile.historyId)
          : this.runs.captureBaseline(session.run.accountId, this.stamp(session.run), profile.historyId);
      }
      if (session.run.phase === "history") { await this.history(session); return; }
      if (!session.labelsLoaded) {
        const { access, transport } = await this.access(session);
        const { labels } = await this.boundedOperation(session, signal => transport.listLabels({ signal })); this.assert(session, access.version);
        this.options.database.transaction(() => {
          this.assert(session, access.version);
          for (const label of labels) this.options.database.run("INSERT INTO mail_folders(account_id,id,name,kind,parent_id) VALUES(?,?,?,'label',NULL) ON CONFLICT(account_id,id) DO UPDATE SET name=excluded.name", [session.run.accountId, label.id, label.name]);
        }); session.labelsLoaded = true;
        session.run = this.runs.setState(session.run.accountId, this.stamp(session.run), "active", { failureCount: 0 });
      }
      const recent: SyncScope = { accountId: session.run.accountId, generation: session.run.generation, scopeId: "gmail:recent" };
      const recentStatus = this.journal.status(recent);
      const scope = recentStatus.checkpoint.discoveryComplete && recentStatus.jobs.queued + recentStatus.jobs.running + recentStatus.jobs.retry === 0
        ? { ...recent, scopeId: "gmail:all" } : recent;
      const status = this.journal.status(scope);
      if (status.jobs.queued + status.jobs.running + status.jobs.retry > 0) {
        await this.executor.run(scope); this.assert(session);
        if (session.fatal) { session.run = this.runs.setState(scope.accountId, this.stamp(session.run), "attention", { error: session.error }); this.stop(session); return; }
        const next = this.options.database.get(`SELECT min(CASE WHEN j.state='running' THEN j.lease_until ELSE j.available_at END) AS due
          FROM mail_sync_jobs j JOIN mail_sync_scope_jobs s ON s.account_id=j.account_id AND s.job_id=j.id
          WHERE s.account_id=? AND s.generation=? AND s.scope_id=? AND j.state IN ('queued','retry','running')`, [scope.accountId, scope.generation, scope.scopeId]);
        const nextRetryAt = typeof next?.due === "number" ? next.due : null;
        if (nextRetryAt !== null && nextRetryAt > Date.now()) {
          session.run = this.runs.setState(scope.accountId, this.stamp(session.run), "active", { nextRetryAt, error: session.error });
          this.schedule(session, nextRetryAt - Date.now()); return;
        }
      } else if (!status.checkpoint.discoveryComplete) {
        const { access, transport } = await this.access(session);
        const page = await this.boundedOperation(session, signal => transport.listMessages({ pageToken: status.checkpoint.cursor ?? undefined, pageSize: this.pageSize,
          recentAfterSeconds: scope.scopeId === "gmail:recent" ? session.run.recentAfter : undefined, signal }));
        this.assert(session, access.version);
        this.journal.commitPage({ ...scope, expectedCursor: status.checkpoint.cursor, expectedRevision: status.checkpoint.revision,
          nextCursor: page.nextPageToken, discoveryComplete: page.nextPageToken === null,
          jobs: page.messages.map(message => ({ kind: "raw", locator: { provider: "gmail", messageId: message.id } })) }, writer => {
          this.assert(session, access.version);
          for (const message of page.messages) {
            const locator = { provider: "gmail", messageId: message.id } satisfies ProviderMessageLocator;
            if (!this.options.database.get("SELECT 1 FROM mail_messages WHERE account_id=? AND message_key=?", [scope.accountId, providerMessageKey(locator)]))
              writer.ingestMessage({ locator, rfcMessageId: null, subject: "", threadId: message.threadId, memberships: [] });
            this.runs.markSeenFromList(scope.accountId, locator, scope.generation);
          }
        });
        session.run = this.runs.setState(scope.accountId, this.stamp(session.run), "active", { failureCount: 0 });
      }
      const progress = this.runs.progress(scope.accountId, scope.generation);
      if (progress.enumerationComplete && progress.pending === 0) {
        const complete = progress.failed === 0 && progress.downloaded === progress.enumerated && progress.projected === progress.enumerated;
        if (!complete) session.error ??= "content_incomplete";
        const reconciled = this.runs.markMissingBatch(scope.accountId, scope.generation, 100);
        if (reconciled.remaining) { this.schedule(session, 0); return; }
        session.run = this.runs.advanceHistory(scope.accountId, this.stamp(session.run), { pageToken: null, pollAt: null });
        this.schedule(session, 0); return;
      }
      session.run = this.runs.setState(scope.accountId, this.stamp(session.run), "active", { error: session.error, nextRetryAt: null });
      this.schedule(session, 0);
    } catch (error) {
      if (this.closed || session.abort.signal.aborted) return;
      try {
        this.assert(session); const failure = classify(error);
        const failureCount = Math.min(5, session.run.failureCount + 1), retry = failure.retry && failureCount < 5 && !this.pendingOperation;
        const delay = Math.max(failure.delay, 1000 * 2 ** (failureCount - 1));
        const nextRetryAt = retry ? Math.min(Number.MAX_SAFE_INTEGER, Date.now() + delay) : null;
        session.run = this.runs.setState(session.run.accountId, this.stamp(session.run), retry ? "active" : "attention", { error: failure.code, nextRetryAt, failureCount });
        if (retry) this.schedule(session, delay); else this.stop(session);
      } catch { this.stop(session); }
    }
  }
  private rawReference(accountId: string, locator: ProviderMessageLocator): MailContentReference | null {
    const row = this.options.database.get(`SELECT r.id,r.bytes,r.sha256 FROM mail_content_manifests m
      JOIN mail_content_refs r ON r.account_id=m.account_id AND r.id=m.ref_id
      JOIN mail_blob_publications p ON p.account_id=r.account_id AND p.ref_id=r.id
      JOIN mail_blob_objects o ON o.account_id=p.account_id AND o.id=p.object_id AND o.state='published'
      WHERE m.account_id=? AND m.message_key=? AND m.kind='raw' AND m.state='stored'`, [accountId, providerMessageKey(locator)]);
    return row && typeof row.id === "string" && typeof row.bytes === "number" && typeof row.sha256 === "string" ? { id: row.id, bytes: row.bytes, sha256: row.sha256 } : null;
  }
  private async history(session: Session): Promise<void> {
    const scope = { accountId: session.run.accountId, generation: session.run.generation, scopeId: "gmail:history" };
    const status = this.journal.status(scope);
    if (status.jobs.queued + status.jobs.retry + status.jobs.running > 0) {
      await this.executor.run(scope); this.assert(session);
      if (session.fatal) { session.run = this.runs.setState(scope.accountId, this.stamp(session.run), "attention", { error: session.error }); this.stop(session); return; }
      const next = this.options.database.get(`SELECT min(CASE WHEN j.state='running' THEN j.lease_until ELSE j.available_at END) AS due FROM mail_sync_jobs j
        JOIN mail_sync_scope_jobs s ON s.account_id=j.account_id AND s.job_id=j.id WHERE s.account_id=? AND s.generation=? AND s.scope_id=? AND j.state IN ('queued','retry','running')`, [scope.accountId, scope.generation, scope.scopeId]);
      const due = typeof next?.due === "number" ? next.due : null;
      if (due !== null) {
        session.run = this.runs.setState(scope.accountId, this.stamp(session.run), "active", { error: session.error, nextRetryAt: due > Date.now() ? due : null });
        this.schedule(session, Math.max(0, due - Date.now())); return;
      }
    }
    const progress = this.runs.progress(scope.accountId, scope.generation);
    if (progress.failed > 0) session.error ??= "content_incomplete";
    if (session.run.pollAt !== null && session.run.pollAt > Date.now()) { this.schedule(session, session.run.pollAt - Date.now()); return; }
    const { access, transport } = await this.access(session);
    const { labels } = await this.boundedOperation(session, signal => transport.listLabels({ signal })); this.assert(session, access.version);
    this.options.database.transaction(() => {
      this.assert(session, access.version);
      for (const label of labels) this.options.database.run("INSERT INTO mail_folders(account_id,id,name,kind,parent_id) VALUES(?,?,?,'label',NULL) ON CONFLICT(account_id,id) DO UPDATE SET name=excluded.name", [scope.accountId, label.id, label.name]);
    });
    if (session.run.historyId === null) throw new GmailBackfillError("configuration_invalid");
    let page;
    try { page = await this.boundedOperation(session, signal => transport.listHistory({ startHistoryId: session.run.historyId ?? "0", pageToken: session.run.historyPageToken ?? undefined, pageSize: this.pageSize, signal })); }
    catch (error) {
      if (!(error instanceof GmailTransportError) || error.code !== "not_found") throw error;
      const profile = await this.boundedOperation(session, signal => transport.getProfile({ signal })); this.assert(session, access.version);
      session.run = this.runs.beginReconciliation(scope.accountId, this.stamp(session.run), profile.historyId); session.labelsLoaded = false;
      this.schedule(session, 0); return;
    }
    this.assert(session, access.version);
    const messages = new Map<string, { id: string; threadId: string }>();
    for (const record of page.records) for (const change of record.changes) if (change.kind !== "deleted") messages.set(change.messageId, { id: change.messageId, threadId: change.threadId });
    const jobs = [...messages.values()].filter(message => !this.rawReference(scope.accountId, { provider: "gmail", messageId: message.id }))
      .map(message => ({ kind: "raw", locator: { provider: "gmail", messageId: message.id } } satisfies import("../storage/sync-journal.js").SyncDownloadJob));
    const committed = this.options.database.transaction(() => {
      this.assert(session, access.version);
      this.journal.commitPage({ ...scope, expectedCursor: status.checkpoint.cursor, expectedRevision: status.checkpoint.revision, nextCursor: page.nextPageToken, discoveryComplete: false, jobs }, writer => {
        this.assert(session, access.version);
        for (const record of page.records) for (const change of record.changes) {
          const locator: ProviderMessageLocator = { provider: "gmail", messageId: change.messageId };
          if (change.kind === "deleted") { this.runs.markRemoved(scope.accountId, locator, record.id); continue; }
          if (!this.options.database.get("SELECT 1 FROM mail_messages WHERE account_id=? AND message_key=?", [scope.accountId, providerMessageKey(locator)])) writer.ingestMessage({ locator, subject: "", rfcMessageId: null, threadId: change.threadId, memberships: [] });
          if (change.kind === "added" || !this.runs.isPresent(scope.accountId, locator)) this.runs.markPresent(scope.accountId, locator, scope.generation, record.id);
          if (change.kind === "labelsAdded" || change.kind === "labelsRemoved") this.runs.applyLabelDelta(scope.accountId, locator, { add: change.kind === "labelsAdded" ? change.labelIds : [], remove: change.kind === "labelsRemoved" ? change.labelIds : [], historyId: record.id });
        }
      });
      return this.runs.advanceHistory(scope.accountId, this.stamp(session.run), { ...(page.nextPageToken === null ? { historyId: page.historyId } : {}), pageToken: page.nextPageToken, pollAt: page.nextPageToken === null ? Date.now() + this.pollInterval : null });
    });
    session.run = committed; session.error = null;
    this.schedule(session, 0);
  }
  private async handle(work: MailSyncWork): Promise<void> {
    const session = this.current;
    if (!session || session.run.accountId !== work.job.account_id || session.run.generation !== work.job.generation) throw new MailSyncExecutionFailure("permanent");
    let credentialVersion: MailCredentialVersion | undefined;
    try {
      const parsed: unknown = JSON.parse(work.job.message_key);
      if (!Array.isArray(parsed) || parsed.length !== 2 || parsed[0] !== "gmail" || typeof parsed[1] !== "string") throw new MailSyncExecutionFailure("permanent");
      const locator: ProviderMessageLocator = { provider: "gmail", messageId: parsed[1] };
      if (!this.runs.isPresent(work.job.account_id, locator)) {
        const credential = this.credentials.status(work.job.account_id);
        if (credential.state !== "connected") throw new MailAccessError("locked");
        work.complete(() => this.assert(session, credential.version)); return;
      }
      const { access, transport } = await this.access(session);
      credentialVersion = access.version;
      const assertCurrent = () => { work.assertCurrent(); this.assert(session, access.version); };
      const assertSnapshot = (historyId: string) => {
        assertCurrent(); const known = this.runs.readMessageHistoryId(work.job.account_id, locator);
        if (known !== null && BigInt(historyId) < BigInt(known)) throw new GmailTransportError("transient");
      };
      assertCurrent();
      if (work.job.kind === "raw") {
        if (this.rawReference(work.job.account_id, locator)) {
          try {
            const metadata = await transport.getMetadata(locator.messageId, { signal: work.signal }); assertSnapshot(metadata.historyId);
            const previous = this.runs.readGmailMetadata(work.job.account_id, locator);
            work.complete(() => { this.assert(session, access.version); const known = this.runs.readMessageHistoryId(work.job.account_id, locator); if (known !== null && BigInt(metadata.historyId) < BigInt(known)) throw new GmailTransportError("transient"); if (!this.runs.putGmailMetadata(work.job.account_id, locator, { threadId: metadata.threadId, labelIds: metadata.labelIds, historyId: metadata.historyId, internalDate: metadata.internalDate === null ? previous?.internalDate ?? 0 : Number(metadata.internalDate) })) throw new GmailTransportError("transient"); }, [{ kind: "body", locator }]);
          } catch (error) {
            if (!(error instanceof GmailTransportError) || error.code !== "not_found") throw error;
            assertCurrent(); work.complete(() => { this.assert(session, access.version); this.runs.markAbsentFromFetch(work.job.account_id, locator); });
          }
          return;
        }
        let metadata: GmailRawMetadata | undefined;
        const source = chunks(async consume => {
          metadata = await transport.consumeRaw(locator.messageId, async chunk => { assertCurrent(); await consume(chunk); }, { signal: work.signal });
          assertCurrent(); const known = this.runs.readMessageHistoryId(work.job.account_id, locator);
          if (known !== null && BigInt(metadata.historyId) < BigInt(known)) {
            const current = await transport.getMetadata(locator.messageId, { signal: work.signal }); assertSnapshot(current.historyId);
            metadata = { ...metadata, threadId: current.threadId, labelIds: current.labelIds, historyId: current.historyId, internalDate: current.internalDate ?? metadata.internalDate };
          }
        }, work.signal);
        await this.content.writePart(work.job.account_id, locator, { kind: "raw", maxBytes: 64 * 1024 * 1024 }, source, () => {
          assertCurrent(); if (!metadata) throw new Error("missing metadata"); assertSnapshot(metadata.historyId);
          if (!this.runs.putGmailMetadata(work.job.account_id, locator, { internalDate: Number(metadata.internalDate), threadId: metadata.threadId, labelIds: metadata.labelIds, historyId: metadata.historyId })) throw new GmailTransportError("transient");
          work.complete(() => { this.assert(session, access.version); }, [{ kind: "body", locator }]);
        });
      } else if (work.job.kind === "body") {
        if (!this.options.projectRaw) { session.error = "content_incomplete"; throw new MailSyncExecutionFailure("permanent"); }
        const row = this.options.database.get(`SELECT r.id,r.bytes,r.sha256 FROM mail_content_manifests m JOIN mail_content_refs r ON r.account_id=m.account_id AND r.id=m.ref_id WHERE m.account_id=? AND m.message_key=? AND m.kind='raw' AND m.state='stored'`, [work.job.account_id, work.job.message_key]);
        if (!row || typeof row.id !== "string" || typeof row.bytes !== "number" || typeof row.sha256 !== "string") throw new Error("missing raw");
        await this.options.projectRaw({ accountId: work.job.account_id, locator, reference: { id: row.id, bytes: row.bytes, sha256: row.sha256 },
          source: this.content.read(work.job.account_id, row.id), work, assertCurrent: () => this.assert(session, access.version) });
      } else throw new MailSyncExecutionFailure("permanent");
    } catch (error) {
      if (error instanceof GmailTransportError && error.code === "not_found" && work.job.kind === "raw") {
        work.assertCurrent(); if (!credentialVersion) throw new MailSyncExecutionFailure("retryable"); this.assert(session, credentialVersion);
        const identity: unknown = JSON.parse(work.job.message_key);
        if (Array.isArray(identity) && identity[0] === "gmail" && typeof identity[1] === "string") { const locator: ProviderMessageLocator = { provider: "gmail", messageId: identity[1] }; work.complete(() => { this.assert(session, credentialVersion); this.runs.markAbsentFromFetch(work.job.account_id, locator); }); return; }
      }
      if (error instanceof MailSyncExecutionFailure) throw error;
      const failure = classify(error); session.error = failure.code; session.fatal ||= failure.fatal || this.pendingOperation !== undefined;
      if (session.fatal) this.executor.pause(work.job.account_id);
      throw new MailSyncExecutionFailure(failure.retry || failure.fatal ? "retryable" : "permanent", failure.delay);
    }
  }
}
