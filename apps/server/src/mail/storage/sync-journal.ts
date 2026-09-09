import { randomUUID } from "node:crypto";
import { z } from "zod";
import { providerMessageKey, providerMessageLocatorSchema } from "../model.js";
import { MailRepository, type MailFolderInput, type MailMessageInput, type MailContentInput } from "./repository.js";
import type { ProviderMessageLocator } from "../model.js";
import type { MailDatabase } from "./database-interface.js";

const id = z.string().min(1).max(4096);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const cursor = z.string().max(32768).nullable();
const scopeInput = z.object({ accountId: id, scopeId: id, generation: id }).strict();
const jobInput = z.object({ kind: z.enum(["raw", "body", "attachment"]), locator: providerMessageLocatorSchema,
  partId: z.string().max(4096).default("") }).strict().superRefine((value, context) => {
  if ((value.kind === "attachment") !== (value.partId.length > 0)) context.addIssue({ code: "custom", message: "Only attachment jobs require a part ID" });
});
const pageInput = scopeInput.extend({ expectedCursor: cursor, expectedRevision: integer, nextCursor: cursor,
  discoveryComplete: z.boolean(), jobs: z.array(jobInput).max(1000) }).strict();
const policyInput = z.object({ maxAttempts: z.number().int().min(1).max(20).default(5),
  retryBaseMs: z.number().int().min(1).max(3600000).default(1000),
  retryMaxMs: z.number().int().min(1).max(86400000).default(60000) }).strict().refine(value => value.retryMaxMs >= value.retryBaseMs);
const checkpointRow = z.object({ cursor, revision: integer, discovery_complete: z.union([z.literal(0), z.literal(1)]) });
const jobRow = z.object({ account_id: id, id, kind: z.enum(["raw", "body", "attachment"]), message_key: z.string().min(1), part_id: z.string(), generation: id,
  state: z.enum(["queued", "running", "retry", "succeeded", "failed"]), attempts: integer, max_attempts: integer,
  retry_base_ms: integer, retry_max_ms: integer, available_at: integer, lease_token: id.nullable(), lease_until: integer.nullable(),
  last_error: z.enum(["retryable", "permanent", "lease_expired"]).nullable() });
export type SyncScope = z.infer<typeof scopeInput>;
export type SyncPage = z.input<typeof pageInput>;
export type SyncDownloadJob = z.input<typeof jobInput>;
export type SyncRetryPolicy = z.input<typeof policyInput>;
export type SyncJob = z.infer<typeof jobRow>;
export type SyncCheckpoint = { cursor: string | null; revision: number; discoveryComplete: boolean };
/** Revoked as soon as its synchronous callback returns. Account is deliberately absent from each method. */
export interface SyncMetadataWriter {
  putFolder(input: MailFolderInput): void;
  ingestMessage(input: MailMessageInput): string;
  putContent(locator: ProviderMessageLocator, input: MailContentInput): void;
  setAttachmentsEnumerated(locator: ProviderMessageLocator, complete: boolean): void;
}
const countLimit = z.number().int().min(1).max(100);

/** Local journal primitives only. One serial storage writer; callbacks must not perform network I/O.
 * Owner is fixed by the trusted service. Generations are explicit independent enumeration sessions. */
export class MailSyncJournal {
  private readonly ownerId: string;
  private callbackActive = false;
  private readonly policy: z.infer<typeof policyInput>;
  constructor(private readonly database: MailDatabase, ownerId: string,
    private readonly now: () => number = Date.now, policy: SyncRetryPolicy = {}) {
    this.ownerId = id.parse(ownerId);
    this.policy = policyInput.parse(policy);
  }
  private time(): number { return integer.parse(this.now()); }
  private account(accountId: string): string {
    const row = this.database.get("SELECT provider FROM mail_accounts WHERE id=? AND owner_id=?", [id.parse(accountId), this.ownerId]);
    if (!row) throw new Error("Mail account not found");
    return z.enum(["gmail", "graph", "imap"]).parse(row.provider);
  }
  private checkpoint(scope: SyncScope): SyncCheckpoint {
    const raw = this.database.get("SELECT cursor,revision,discovery_complete FROM mail_sync_scopes WHERE account_id=? AND scope_id=? AND generation=?", [scope.accountId, scope.scopeId, scope.generation]);
    if (!raw) return { cursor: null, revision: 0, discoveryComplete: false };
    const row = checkpointRow.parse(raw);
    return { cursor: row.cursor, revision: row.revision, discoveryComplete: row.discovery_complete === 1 };
  }
  readCheckpoint(input: SyncScope): SyncCheckpoint {
    this.operation();
    const scope = scopeInput.parse(input); this.account(scope.accountId);
    return this.checkpoint(scope);
  }
  private writeMetadata(accountId: string, callback: (writer: SyncMetadataWriter) => unknown): void {
    const repository = new MailRepository(this.database, this.ownerId);
    let active = true;
    const check = () => { if (!active) throw new Error("Sync metadata writer expired"); };
    const writer: SyncMetadataWriter = {
      putFolder(input) { check(); repository.putFolder(accountId, input); },
      ingestMessage(input) { check(); return repository.ingestMessage(accountId, input); },
      putContent(locator, input) { check(); repository.putContent(accountId, locator, input); },
      setAttachmentsEnumerated(locator, complete) { check(); repository.setAttachmentsEnumerated(accountId, locator, complete); },
    };
    this.callbackActive = true;
    try {
      this.database.transaction(() => {
        const result = callback(writer);
        active = false;
        return result;
      });
    } finally { active = false; this.callbackActive = false; }
  }
  private operation(): void { if (this.callbackActive) throw new Error("Sync journal callbacks cannot reenter the journal"); }
  private insertJob(accountId: string, generation: string, job: z.infer<typeof jobInput>, now: number, policy: z.infer<typeof policyInput>): string {
    const key = providerMessageKey(job.locator);
    this.database.run(`INSERT INTO mail_sync_jobs(account_id,id,kind,message_key,part_id,generation,state,attempts,max_attempts,retry_base_ms,retry_max_ms,available_at)
      VALUES(?,?,?,?,?,?,'queued',0,?,?,?,?) ON CONFLICT(account_id,kind,message_key,part_id,generation) DO NOTHING`,
    [accountId, randomUUID(), job.kind, key, job.partId, generation, policy.maxAttempts, policy.retryBaseMs, policy.retryMaxMs, now]);
    const found = this.database.get("SELECT id FROM mail_sync_jobs WHERE account_id=? AND kind=? AND message_key=? AND part_id=? AND generation=?",
      [accountId, job.kind, key, job.partId, generation]);
    return id.parse(found?.id);
  }
  /** Same-message body/attachment work is the raw job's dependency closure, including later discovery/scopes. */
  private linkMessageChildren(accountId: string, generation: string, messageKey: string): void {
    this.database.run(`INSERT INTO mail_sync_scope_jobs(account_id,scope_id,generation,job_id)
      SELECT s.account_id,s.scope_id,s.generation,c.id FROM mail_sync_jobs p
      JOIN mail_sync_scope_jobs s ON s.account_id=p.account_id AND s.job_id=p.id AND s.generation=p.generation
      JOIN mail_sync_jobs c ON c.account_id=p.account_id AND c.generation=p.generation AND c.message_key=p.message_key
      WHERE p.account_id=? AND p.generation=? AND p.message_key=? AND p.kind='raw' AND c.kind IN ('body','attachment')
      ON CONFLICT DO NOTHING`, [accountId, generation, messageKey]);
  }
  /** Callback and new jobs commit with the cursor, or everything rolls back. Even same-cursor pages increment revision. */
  commitPage(input: SyncPage, persistMetadata: (writer: SyncMetadataWriter) => unknown): SyncCheckpoint {
    this.operation();
    const page = pageInput.parse(input);
    if (typeof persistMetadata !== "function" || Object.prototype.toString.call(persistMetadata) === "[object AsyncFunction]") throw new Error("Sync metadata callback must be synchronous");
    return this.database.transaction(() => {
      const provider = this.account(page.accountId);
      const previous = this.checkpoint(page);
      if (previous.cursor !== page.expectedCursor || previous.revision !== page.expectedRevision) throw new Error("Stale sync cursor");
      if (previous.discoveryComplete) throw new Error("Sync discovery already complete");
      if (page.expectedRevision === Number.MAX_SAFE_INTEGER) throw new Error("Sync revision exhausted");
      const now = this.time();
      // A nested transaction delegates thenable rejection/rollback to the encrypted adapter.
      this.writeMetadata(page.accountId, persistMetadata);
      this.database.run(`INSERT INTO mail_sync_scopes(account_id,scope_id,generation,cursor,revision,discovery_complete) VALUES(?,?,?,?,?,?)
        ON CONFLICT(account_id,scope_id,generation) DO UPDATE SET cursor=excluded.cursor,revision=excluded.revision,discovery_complete=excluded.discovery_complete`,
      [page.accountId, page.scopeId, page.generation, page.nextCursor, previous.revision + 1, page.discoveryComplete ? 1 : 0]);
      for (const job of page.jobs) {
        if (job.locator.provider !== provider) throw new Error("Provider identity does not match account");
        const jobId = this.insertJob(page.accountId, page.generation, job, now, this.policy);
        this.database.run("INSERT INTO mail_sync_scope_jobs(account_id,scope_id,generation,job_id) VALUES(?,?,?,?) ON CONFLICT DO NOTHING",
          [page.accountId, page.scopeId, page.generation, jobId]);
      }
      for (const key of new Set(page.jobs.map(job => providerMessageKey(job.locator)))) this.linkMessageChildren(page.accountId, page.generation, key);
      return this.checkpoint(page);
    });
  }
  private delay(job: SyncJob): number { return Math.min(job.retry_max_ms, job.retry_base_ms * 2 ** (job.attempts - 1)); }
  private retire(job: SyncJob, now: number, reason: "retryable" | "permanent" | "lease_expired", retryAfterMs = 0): void {
    const state = reason === "permanent" || job.attempts >= job.max_attempts ? "failed" : "retry";
    const available = state === "failed" ? now : Math.min(Number.MAX_SAFE_INTEGER, now + Math.max(this.delay(job), retryAfterMs));
    this.database.run("UPDATE mail_sync_jobs SET state=?,available_at=?,lease_token=NULL,lease_until=NULL,last_error=? WHERE account_id=? AND id=?",
      [state, available, reason, job.account_id, job.id]);
  }
  /** Expired attempts consume retry budget. Bounded reclaim preserves backoff across restarts. */
  reclaimExpired(accountId: string, limit = 100): number {
    this.operation();
    countLimit.parse(limit);
    return this.database.transaction(() => {
      this.account(accountId); const now = this.time();
      const jobs = this.database.all("SELECT * FROM mail_sync_jobs WHERE account_id=? AND state='running' AND lease_until<=? ORDER BY lease_until,id LIMIT ?", [accountId, now, limit]).map(row => jobRow.parse(row));
      for (const job of jobs) this.retire(job, now, "lease_expired");
      return jobs.length;
    });
  }
  /** Claims only the requested generation/scope. Other scopes can share the same deduped job. */
  claim(input: SyncScope, limit = 10, leaseMs = 30000): SyncJob[] {
    this.operation();
    const scope = scopeInput.parse(input); countLimit.parse(limit);
    z.number().int().min(1).max(300000).parse(leaseMs);
    return this.database.transaction(() => {
      this.account(scope.accountId);
      this.reclaimExpired(scope.accountId);
      const now = this.time(), until = integer.parse(now + leaseMs);
      const jobs = this.database.all(`SELECT j.* FROM mail_sync_jobs j JOIN mail_sync_scope_jobs s ON s.account_id=j.account_id AND s.job_id=j.id
        WHERE s.account_id=? AND s.scope_id=? AND s.generation=? AND j.state IN ('queued','retry') AND j.available_at<=? AND j.attempts<j.max_attempts
        ORDER BY j.available_at,j.id LIMIT ?`, [scope.accountId, scope.scopeId, scope.generation, now, limit]).map(row => jobRow.parse(row));
      return jobs.map(job => {
        const token = randomUUID();
        this.database.run("UPDATE mail_sync_jobs SET state='running',attempts=attempts+1,lease_token=?,lease_until=? WHERE account_id=? AND id=?", [token, until, scope.accountId, job.id]);
        return { ...job, state: "running", attempts: job.attempts + 1, lease_token: token, lease_until: until };
      });
    });
  }
  private leased(accountId: string, jobId: string, token: string, now: number): SyncJob {
    this.account(accountId);
    const row = this.database.get("SELECT * FROM mail_sync_jobs WHERE account_id=? AND id=? AND state='running' AND lease_token=? AND lease_until>?",
      [accountId, id.parse(jobId), id.parse(token), now]);
    if (!row) throw new Error("Stale sync lease");
    return jobRow.parse(row);
  }
  /** Internal executor fence; authorization and expiry are rechecked against durable state. */
  assertLease(accountId: string, jobId: string, token: string): void {
    this.operation(); this.leased(accountId, jobId, token, this.time());
  }
  readJob(accountId: string, jobId: string): SyncJob | undefined {
    this.operation(); this.account(accountId);
    const row = this.database.get("SELECT * FROM mail_sync_jobs WHERE account_id=? AND id=?", [accountId, id.parse(jobId)]);
    return row ? jobRow.parse(row) : undefined;
  }
  /** Executor may atomically persist its result here. Success alone is NOT a claim of downloaded bytes. */
  succeed(accountId: string, jobId: string, token: string, persistResult: (writer: SyncMetadataWriter) => unknown): void {
    this.succeedWithFollowups(accountId, jobId, token, [], persistResult);
  }
  /** Atomically discovers raw-message parts, preserving the parent's generation and shared scopes. */
  succeedWithFollowups(accountId: string, jobId: string, token: string, input: readonly SyncDownloadJob[], persistResult: (writer: SyncMetadataWriter) => unknown): void {
    this.operation();
    const jobs = z.array(jobInput).max(1000).parse(input);
    if (typeof persistResult !== "function" || Object.prototype.toString.call(persistResult) === "[object AsyncFunction]") throw new Error("Sync result callback must be synchronous");
    this.database.transaction(() => {
      const parent = this.leased(accountId, jobId, token, this.time());
      const provider = this.account(accountId);
      for (const job of jobs) {
        if (parent.kind !== "raw" || job.kind === "raw") throw new Error("Only raw jobs may discover body or attachment followups");
        if (job.locator.provider !== provider || providerMessageKey(job.locator) !== parent.message_key) throw new Error("Followup identity must match parent message");
      }
      this.writeMetadata(accountId, persistResult);
      const now = this.time();
      for (const job of jobs) this.insertJob(accountId, parent.generation, job, now,
        { maxAttempts: parent.max_attempts, retryBaseMs: parent.retry_base_ms, retryMaxMs: parent.retry_max_ms });
      if (parent.kind === "raw") this.linkMessageChildren(accountId, parent.generation, parent.message_key);
      // Recheck after metadata and child insertion: expired or replaced leases cannot commit either.
      this.leased(accountId, jobId, token, this.time());
      this.database.run("UPDATE mail_sync_jobs SET state='succeeded',lease_token=NULL,lease_until=NULL,last_error=NULL WHERE account_id=? AND id=?", [accountId, jobId]);
    });
  }
  fail(accountId: string, jobId: string, token: string, retryable: boolean, retryAfterMs = 0): void {
    this.operation();
    z.boolean().parse(retryable);
    integer.parse(retryAfterMs);
    this.database.transaction(() => {
      const now = this.time();
      this.retire(this.leased(accountId, jobId, token, now), now, retryable ? "retryable" : "permanent", retryAfterMs);
    });
  }
  renew(accountId: string, jobId: string, token: string, leaseMs = 30000): void {
    this.operation();
    z.number().int().min(1).max(300000).parse(leaseMs);
    this.database.transaction(() => {
      const now = this.time(); const job = this.leased(accountId, jobId, token, now);
      this.database.run("UPDATE mail_sync_jobs SET lease_until=? WHERE account_id=? AND id=?", [Math.max(job.lease_until ?? 0, integer.parse(now + leaseMs)), accountId, jobId]);
    });
  }
  /** State counts do not assert content completeness; an untouched scope is not an empty discovered mailbox. */
  status(input: SyncScope) {
    this.operation();
    const scope = scopeInput.parse(input); this.account(scope.accountId);
    const counts = { queued: 0, running: 0, retry: 0, succeeded: 0, failed: 0 };
    for (const row of this.database.all(`SELECT j.state,count(*) AS count FROM mail_sync_jobs j JOIN mail_sync_scope_jobs s ON s.account_id=j.account_id AND s.job_id=j.id
      WHERE s.account_id=? AND s.scope_id=? AND s.generation=? GROUP BY j.state`, [scope.accountId, scope.scopeId, scope.generation])) {
      const state = jobRow.shape.state.parse(row.state); counts[state] = integer.parse(row.count);
    }
    return { checkpoint: this.checkpoint(scope), jobs: counts };
  }
}
