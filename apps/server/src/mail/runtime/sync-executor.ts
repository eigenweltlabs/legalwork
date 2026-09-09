import { performance } from "node:perf_hooks";
import { z } from "zod";
import type { MailSyncJournal, SyncDownloadJob, SyncJob, SyncMetadataWriter, SyncScope } from "../storage/sync-journal.js";

/** Explicit handler failure; arbitrary provider exceptions are always redacted and retryable. */
export class MailSyncExecutionFailure extends Error {
  constructor(readonly classification: "retryable" | "permanent", readonly retryAfterMs = 0) { super("mail_sync_handler_failed"); }
}
export class MailSyncExecutorError extends Error {
  constructor(readonly code: "closed" | "busy" | "capacity" | "invalid_input" | "not_found" | "unavailable" | "inactive" | "deadline") {
    super(`mail_sync_executor_${code}`);
  }
}
export interface MailSyncWork {
  readonly job: Readonly<SyncJob>;
  readonly signal: AbortSignal;
  assertCurrent(): void;
  complete(metadata: (writer: SyncMetadataWriter) => unknown, followups?: readonly SyncDownloadJob[]): void;
}
export type MailSyncRunResult = { attempted: number; succeeded: number; retry: number; failed: number; leaseLost: number;
  stopped: "drained" | "limit" | "paused" | "timeout" | "lease_lost" };
export type MailSyncExecutorOptions = {
  journal: MailSyncJournal;
  handler: (work: MailSyncWork) => Promise<void>;
  maxConcurrentAccounts?: number;
  maxJobsPerRun?: number;
  leaseMs?: number;
  renewEveryMs?: number;
  jobTimeoutMs?: number;
};
type Run = { controller: AbortController; pendingWork?: Promise<void>; finished: boolean };
const scopeSchema = z.object({ accountId: z.string().min(1).max(4096), scopeId: z.string().min(1).max(4096), generation: z.string().min(1).max(4096) }).strict();
function bounded(value: number, min: number, max: number): number {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new MailSyncExecutorError("invalid_input");
  return value;
}
function unavailable(error: unknown): MailSyncExecutorError {
  return new MailSyncExecutorError(error instanceof Error && error.message === "Mail account not found" ? "not_found" : "unavailable");
}
/** Bounded executor substrate. It supplies no provider handler, discovery loop or scheduler. */
export class MailSyncExecutor {
  private closed = false;
  private readonly runs = new Map<string, Run>();
  private readonly concurrency: number;
  private readonly maxJobs: number;
  private readonly leaseMs: number;
  private readonly renewMs: number;
  private readonly timeoutMs: number;
  constructor(private readonly options: MailSyncExecutorOptions) {
    this.concurrency = bounded(options.maxConcurrentAccounts ?? 1, 1, 8);
    this.maxJobs = bounded(options.maxJobsPerRun ?? 10, 1, 100);
    this.leaseMs = bounded(options.leaseMs ?? 30000, 10, 300000);
    this.renewMs = bounded(options.renewEveryMs ?? Math.max(1, Math.floor(this.leaseMs / 3)), 1, this.leaseMs - 1);
    this.timeoutMs = bounded(options.jobTimeoutMs ?? 120000, 10, 600000);
    if (typeof options.handler !== "function") throw new MailSyncExecutorError("invalid_input");
  }
  run(input: SyncScope): Promise<MailSyncRunResult> {
    if (this.closed) return Promise.reject(new MailSyncExecutorError("closed"));
    const parsed = scopeSchema.safeParse(input);
    if (!parsed.success) return Promise.reject(new MailSyncExecutorError("invalid_input"));
    const scope = parsed.data;
    if (this.runs.has(scope.accountId)) return Promise.reject(new MailSyncExecutorError("busy"));
    if (this.runs.size >= this.concurrency) return Promise.reject(new MailSyncExecutorError("capacity"));
    const run: Run = { controller: new AbortController(), finished: false };
    this.runs.set(scope.accountId, run);
    return this.perform(scope, run).finally(() => {
      run.finished = true;
      // Noncooperative work retains its slot until settlement; restarting requires worker termination.
      if (!run.pendingWork) this.runs.delete(scope.accountId);
    });
  }
  pause(accountId: string): void { this.runs.get(accountId)?.controller.abort(); }
  close(): void { this.closed = true; for (const run of this.runs.values()) run.controller.abort(); }
  private async perform(scope: SyncScope, run: Run): Promise<MailSyncRunResult> {
    const result: MailSyncRunResult = { attempted: 0, succeeded: 0, retry: 0, failed: 0, leaseLost: 0, stopped: "limit" };
    for (let index = 0; index < this.maxJobs; index++) {
      if (run.controller.signal.aborted) { result.stopped = "paused"; break; }
      let job: SyncJob | undefined;
      try { [job] = this.options.journal.claim(scope, 1, this.leaseMs); }
      catch (error) { throw unavailable(error); }
      if (!job) { result.stopped = "drained"; break; }
      result.attempted++;
      const outcome = await this.execute(scope.accountId, job, run);
      result[outcome.state]++;
      if (outcome.stop) { result.stopped = outcome.stop; break; }
    }
    return result;
  }
  private async execute(accountId: string, job: SyncJob, run: Run): Promise<{ state: "succeeded" | "retry" | "failed" | "leaseLost"; stop?: "paused" | "timeout" | "lease_lost" }> {
    const journal = this.options.journal, token = job.lease_token;
    if (!token) throw new MailSyncExecutorError("unavailable");
    const controller = new AbortController(), deadline = performance.now() + this.timeoutMs;
    let active = true;
    let reason: "paused" | "timeout" | "lease_lost" | undefined;
    const abort = (value: typeof reason) => { reason ??= value; controller.abort(); };
    const pause = () => abort("paused");
    run.controller.signal.addEventListener("abort", pause, { once: true });
    const local = () => {
      if (!active || this.closed || run.controller.signal.aborted || controller.signal.aborted) throw new MailSyncExecutorError("inactive");
      if (performance.now() >= deadline) { abort("timeout"); throw new MailSyncExecutorError("deadline"); }
    };
    const assertCurrent = () => { local(); journal.assertLease(accountId, job.id, token); local(); };
    const work: MailSyncWork = Object.freeze({ job: Object.freeze({ ...job }), signal: controller.signal, assertCurrent,
      complete: (metadata: (writer: SyncMetadataWriter) => unknown, followups: readonly SyncDownloadJob[] = []) => {
        assertCurrent();
        if (typeof metadata !== "function" || Object.prototype.toString.call(metadata) === "[object AsyncFunction]") throw new MailSyncExecutorError("invalid_input");
        journal.succeedWithFollowups(accountId, job.id, token, followups, writer => {
          // The journal checks lease before/after this callback. Reentering it here is prohibited.
          local(); const result = metadata(writer); local(); return result;
        });
      },
    });
    const stopped = new Promise<never>((_, reject) => controller.signal.addEventListener("abort", () => reject(new MailSyncExecutorError("inactive")), { once: true }));
    const timer = setTimeout(() => abort("timeout"), this.timeoutMs);
    const renewal = setInterval(() => {
      try {
        local();
        if (journal.readJob(accountId, job.id)?.state === "succeeded") { clearInterval(renewal); return; }
        assertCurrent(); journal.renew(accountId, job.id, token, this.leaseMs);
      }
      catch { abort(reason ?? "lease_lost"); }
    }, this.renewMs);
    const handled = Promise.resolve().then(() => { assertCurrent(); return this.options.handler(work); });
    const settlement = handled.then(() => {}, () => {}).finally(() => {
      if (run.pendingWork === settlement) run.pendingWork = undefined;
      if (run.finished && !run.pendingWork) this.runs.delete(accountId);
    });
    run.pendingWork = settlement;
    let failure: unknown;
    try { await Promise.race([handled, stopped]); local(); }
    catch (error) { failure = error; }
    finally {
      active = false;
      clearTimeout(timer); clearInterval(renewal);
      run.controller.signal.removeEventListener("abort", pause);
    }
    try {
      // complete() may have run inside a publication transaction that subsequently rolled back.
      // Conversely, a handler can throw after a committed success. Durable state decides both cases.
      const current = journal.readJob(accountId, job.id);
      if (current?.state === "succeeded") return { state: "succeeded", stop: reason };
      if (current?.state !== "running" || current.lease_token !== token) return { state: "leaseLost", stop: reason ?? "lease_lost" };
      try { journal.assertLease(accountId, job.id, token); }
      catch { return { state: "leaseLost", stop: reason ?? "lease_lost" }; }
      const permanent = !reason && failure instanceof MailSyncExecutionFailure && failure.classification === "permanent";
      const advice = failure instanceof MailSyncExecutionFailure && Number.isSafeInteger(failure.retryAfterMs) && failure.retryAfterMs >= 0 ? failure.retryAfterMs : 0;
      journal.fail(accountId, job.id, token, !permanent, advice);
      const retired = journal.readJob(accountId, job.id);
      return { state: retired?.state === "failed" ? "failed" : "retry", stop: reason };
    } catch (error) { throw unavailable(error); }
  }
}
