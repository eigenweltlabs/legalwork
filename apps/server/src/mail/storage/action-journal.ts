import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { MailDatabase } from "./database-interface.js";
import { assertMailSchema } from "./consistency.js";

const id = z.string().min(1).max(4096);
const integer = z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER);
const revision = integer.refine(value => value > 0);
const versionInput = z.object({ generation: z.string().uuid(), revision }).strict();
const leaseInput = z.object({ accountId: id, id, generation: z.string().uuid(), token: z.string().uuid() }).strict();
const policy = z.object({ maxAttempts: z.number().int().min(1).max(20).default(5),
  retryBaseMs: z.number().int().min(1).max(3600000).default(1000),
  retryMaxMs: z.number().int().min(1).max(86400000).default(60000) }).strict().refine(value => value.retryMaxMs >= value.retryBaseMs);
const enqueueInput = z.object({ replayKey: z.string().regex(/^[\x21-\x7e]{1,256}$/), kind: z.enum(["mutation", "submission"]),
  payloadJson: z.string().min(2).max(32768), precondition: z.string().min(1).max(4096).nullable(),
  conflictPolicy: z.enum(["manual", "refresh_then_reapply"]), retry: policy.default({ maxAttempts: 5, retryBaseMs: 1000, retryMaxMs: 60000 }) }).strict();
const stateInput = z.enum(["queued", "running", "dispatching", "retry", "succeeded", "failed", "cancelled", "uncertain"]);
const errorInput = z.enum(["preflight_retryable", "preflight_permanent", "lease_expired", "outcome_unknown", "rejected", "conflict", "cancelled", "reconciled"]);
const rowInput = z.object({ account_id: id, id, replay_key: z.string(), kind: z.enum(["mutation", "submission"]), payload_json: z.string(),
  precondition: z.string().nullable(), conflict_policy: z.enum(["manual", "refresh_then_reapply"]), generation: z.string().uuid(), revision,
  state: stateInput, attempts: integer, max_attempts: integer, retry_base_ms: integer, retry_max_ms: integer,
  available_at: integer, lease_token: z.string().uuid().nullable(), lease_until: integer.nullable(),
  cancel_requested: z.union([z.literal(0), z.literal(1)]), last_error: errorInput.nullable() });
type Row = z.infer<typeof rowInput>;
export type MailActionVersion = z.infer<typeof versionInput>;
export type MailActionLease = z.infer<typeof leaseInput>;
export type MailActionInput = z.input<typeof enqueueInput>;
export type MailActionStatus = { id: string; kind: Row["kind"]; state: Row["state"]; version: MailActionVersion;
  attempts: number; maxAttempts: number; availableAt: number; cancelRequested: boolean; lastError: Row["last_error"]; conflictPolicy: Row["conflict_policy"] };
export type MailClaimedAction = { lease: MailActionLease; leaseUntil: number; payloadJson: string; precondition: string | null; status: MailActionStatus };
export type MailActionErrorCode = "invalid_input" | "account_not_found" | "not_found" | "replay_conflict" | "stale_version" | "stale_lease" | "invalid_state" | "storage_unavailable";
export class MailActionError extends Error {
  constructor(readonly code: MailActionErrorCode) { super(`mail_action_${code}`); }
}
function parse<T>(schema: z.ZodType<T>, value: unknown): T {
  const result = schema.safeParse(value);
  if (!result.success) throw new MailActionError("invalid_input");
  return result.data;
}
const errors = new Set<MailActionErrorCode>(["invalid_input", "account_not_found", "not_found", "replay_conflict", "stale_version", "stale_lease", "invalid_state", "storage_unavailable"]);
function safe<T>(body: () => T): T {
  try { return body(); }
  catch (error) { throw new MailActionError(error instanceof MailActionError && errors.has(error.code) ? error.code : "storage_unavailable"); }
}
function status(row: Row): MailActionStatus {
  return { id: row.id, kind: row.kind, state: row.state, version: { generation: row.generation, revision: row.revision },
    attempts: row.attempts, maxAttempts: row.max_attempts, availableAt: row.available_at,
    cancelRequested: row.cancel_requested === 1, lastError: row.last_error, conflictPolicy: row.conflict_policy };
}
function next(row: Row): number {
  if (row.revision === Number.MAX_SAFE_INTEGER) throw new MailActionError("storage_unavailable");
  return row.revision + 1;
}
/** Worker-internal durable intent. Call markDispatched immediately BEFORE an external side effect.
 * No provider execution, payload interpretation, credential retrieval or implicit uncertain replay. */
export class MailActionJournal {
  private readonly ownerId: string;
  constructor(private readonly database: MailDatabase, ownerId: string, private readonly now: () => number = Date.now) {
    this.ownerId = safe(() => parse(id, ownerId));
    safe(() => assertMailSchema(database));
  }
  private time(): number { return parse(integer, this.now()); }
  private account(accountId: string): void {
    if (!this.database.get("SELECT id FROM mail_accounts WHERE id=? AND owner_id=?", [parse(id, accountId), this.ownerId])) throw new MailActionError("account_not_found");
  }
  private load(accountId: string, actionId: string): Row {
    const row = this.database.get("SELECT * FROM mail_action_jobs WHERE account_id=? AND id=?", [accountId, parse(id, actionId)]);
    if (!row) throw new MailActionError("not_found");
    return parse(rowInput, row);
  }
  private matches(row: Row, expected: MailActionVersion): void {
    if (row.generation !== expected.generation || row.revision !== expected.revision) throw new MailActionError("stale_version");
  }
  private leased(input: MailActionLease): Row {
    const lease = parse(leaseInput, input); this.account(lease.accountId);
    const row = this.load(lease.accountId, lease.id);
    if (row.generation !== lease.generation || row.lease_token !== lease.token || row.lease_until === null || row.lease_until <= this.time()
      || (row.state !== "running" && row.state !== "dispatching")) throw new MailActionError("stale_lease");
    return row;
  }
  private terminal(row: Row, state: Row["state"], error: Row["last_error"], availableAt = row.available_at, cancelled = row.cancel_requested): MailActionStatus {
    this.database.run("UPDATE mail_action_jobs SET state=?,revision=?,lease_token=NULL,lease_until=NULL,last_error=?,available_at=?,cancel_requested=? WHERE account_id=? AND id=?",
      [state, next(row), error, availableAt, cancelled, row.account_id, row.id]);
    return status(this.load(row.account_id, row.id));
  }
  private retry(row: Row, error: "preflight_retryable" | "lease_expired", retryAfterMs = 0): MailActionStatus {
    if (row.attempts >= row.max_attempts) return this.terminal(row, "failed", error);
    const backoff = Math.min(row.retry_max_ms, row.retry_base_ms * 2 ** Math.max(0, row.attempts - 1));
    const availableAt = Math.min(Number.MAX_SAFE_INTEGER, this.time() + Math.max(backoff, retryAfterMs));
    parse(integer, availableAt);
    return this.terminal(row, "retry", error, availableAt);
  }
  enqueue(accountId: string, supplied: MailActionInput): MailActionStatus {
    return safe(() => {
      const input = parse(enqueueInput, supplied);
      if (Buffer.byteLength(input.payloadJson) > 32768 || (input.kind === "submission" && input.conflictPolicy !== "manual")) throw new MailActionError("invalid_input");
      let payload: unknown;
      try { payload = JSON.parse(input.payloadJson); } catch { throw new MailActionError("invalid_input"); }
      if (!payload || typeof payload !== "object" || Array.isArray(payload)) throw new MailActionError("invalid_input");
      return this.database.transaction(() => {
        this.account(accountId);
        const found = this.database.get("SELECT * FROM mail_action_jobs WHERE account_id=? AND replay_key=?", [accountId, input.replayKey]);
        if (found) {
          const row = parse(rowInput, found);
          if (row.kind !== input.kind || row.payload_json !== input.payloadJson || row.precondition !== input.precondition || row.conflict_policy !== input.conflictPolicy
            || row.max_attempts !== input.retry.maxAttempts || row.retry_base_ms !== input.retry.retryBaseMs || row.retry_max_ms !== input.retry.retryMaxMs) throw new MailActionError("replay_conflict");
          return status(row);
        }
        const actionId = randomUUID();
        this.database.run(`INSERT INTO mail_action_jobs(account_id,id,replay_key,kind,payload_json,precondition,conflict_policy,generation,revision,state,attempts,max_attempts,retry_base_ms,retry_max_ms,available_at)
          VALUES(?,?,?,?,?,?,?,?,1,'queued',0,?,?,?,?)`, [accountId, actionId, input.replayKey, input.kind, input.payloadJson, input.precondition, input.conflictPolicy,
          randomUUID(), input.retry.maxAttempts, input.retry.retryBaseMs, input.retry.retryMaxMs, this.time()]);
        return status(this.load(accountId, actionId));
      });
    });
  }
  read(accountId: string, actionId: string): MailActionStatus {
    return safe(() => { this.account(accountId); return status(this.load(accountId, actionId)); });
  }
  list(accountId: string, options: { after?: string; limit?: number } = {}): MailActionStatus[] {
    return safe(() => {
      this.account(accountId);
      const selected = parse(z.object({ after: id.optional(), limit: z.number().int().min(1).max(100).default(50) }).strict(), options);
      return this.database.all("SELECT * FROM mail_action_jobs WHERE account_id=? AND id>? ORDER BY id LIMIT ?", [accountId, selected.after ?? "", selected.limit]).map(row => status(parse(rowInput, row)));
    });
  }
  /** Legacy data is preserved but never eligible for replay, even if its historical state says queued. */
  legacyStatus(accountId: string): { unmanaged: number; unresolved: number } {
    return safe(() => {
      this.account(accountId);
      return parse(z.object({ unmanaged: integer, unresolved: integer }), this.database.get("SELECT count(*) AS unmanaged,coalesce(sum(state!='succeeded'),0) AS unresolved FROM mail_actions WHERE account_id=?", [accountId]));
    });
  }
  claim(accountId: string, leaseMs = 30000, kind?: "mutation" | "submission"): MailClaimedAction | null {
    return safe(() => this.database.transaction(() => {
      this.account(accountId);
      const now = this.time(), until = parse(integer, now + parse(z.number().int().min(1).max(300000), leaseMs));
      const found = this.database.get("SELECT * FROM mail_action_jobs WHERE account_id=? AND state IN ('queued','retry') AND available_at<=? AND attempts<max_attempts AND (? IS NULL OR kind=?) ORDER BY available_at,id LIMIT 1", [accountId, now, kind ?? null, kind ?? null]);
      if (!found) return null;
      const row = parse(rowInput, found), token = randomUUID();
      this.database.run("UPDATE mail_action_jobs SET state='running',revision=?,attempts=attempts+1,lease_token=?,lease_until=?,last_error=NULL WHERE account_id=? AND id=?", [next(row), token, until, accountId, row.id]);
      return { lease: { accountId, id: row.id, generation: row.generation, token }, leaseUntil: until, payloadJson: row.payload_json,
        precondition: row.precondition, status: status(this.load(accountId, row.id)) };
    }));
  }
  renew(lease: MailActionLease, leaseMs = 30000): number {
    return safe(() => this.database.transaction(() => {
      const row = this.leased(lease), until = parse(integer, this.time() + parse(z.number().int().min(1).max(300000), leaseMs));
      const extended = Math.max(row.lease_until ?? 0, until);
      this.database.run("UPDATE mail_action_jobs SET revision=?,lease_until=? WHERE account_id=? AND id=?", [next(row), extended, row.account_id, row.id]);
      return extended;
    }));
  }
  /** Durable ambiguity boundary. A crash after this commit is uncertain even if no bytes reached the provider. */
  markDispatched(lease: MailActionLease): MailActionStatus {
    return safe(() => this.database.transaction(() => {
      const row = this.leased(lease);
      if (row.state !== "running") throw new MailActionError("invalid_state");
      this.database.run("UPDATE mail_action_jobs SET state='dispatching',revision=? WHERE account_id=? AND id=?", [next(row), row.account_id, row.id]);
      return status(this.load(row.account_id, row.id));
    }));
  }
  failBeforeDispatch(lease: MailActionLease, retryable: boolean, retryAfterMs = 0): MailActionStatus {
    return safe(() => this.database.transaction(() => {
      const row = this.leased(lease); parse(z.boolean(), retryable); parse(integer, retryAfterMs);
      if (row.state !== "running") throw new MailActionError("invalid_state");
      return retryable ? this.retry(row, "preflight_retryable", retryAfterMs) : this.terminal(row, "failed", "preflight_permanent");
    }));
  }
  recordOutcome(lease: MailActionLease, outcome: "succeeded" | "rejected" | "conflict" | "unknown"): MailActionStatus {
    return safe(() => this.database.transaction(() => {
      parse(z.enum(["succeeded", "rejected", "conflict", "unknown"]), outcome);
      const row = this.leased(lease);
      if (row.state !== "dispatching") throw new MailActionError("invalid_state");
      return this.terminal(row, outcome === "succeeded" ? "succeeded" : outcome === "unknown" ? "uncertain" : "failed",
        outcome === "succeeded" ? null : outcome === "unknown" ? "outcome_unknown" : outcome);
    }));
  }
  recoverExpired(accountId: string, limit = 100): number {
    return safe(() => this.database.transaction(() => {
      this.account(accountId); parse(z.number().int().min(1).max(100), limit);
      const rows = this.database.all("SELECT * FROM mail_action_jobs WHERE account_id=? AND state IN ('running','dispatching') AND lease_until<=? ORDER BY lease_until,id LIMIT ?", [accountId, this.time(), limit]);
      for (const found of rows) {
        const row = parse(rowInput, found);
        if (row.state === "dispatching") this.terminal(row, "uncertain", "outcome_unknown");
        else this.retry(row, "lease_expired");
      }
      return rows.length;
    }));
  }
  cancel(accountId: string, actionId: string, expected: MailActionVersion): MailActionStatus {
    return safe(() => this.database.transaction(() => {
      this.account(accountId); const row = this.load(accountId, actionId); this.matches(row, parse(versionInput, expected));
      if (["succeeded", "failed", "cancelled"].includes(row.state)) return status(row);
      const result = this.terminal(row, row.state === "dispatching" || row.state === "uncertain" ? "uncertain" : "cancelled", "cancelled", row.available_at, 1);
      this.database.run("UPDATE mail_action_jobs SET generation=? WHERE account_id=? AND id=?", [randomUUID(), accountId, actionId]);
      return { ...result, version: status(this.load(accountId, actionId)).version };
    }));
  }
  /** Explicit evidence-based resolution, never a replay or permission to resend. */
  reconcile(accountId: string, actionId: string, expected: MailActionVersion, outcome: "succeeded" | "failed"): MailActionStatus {
    return safe(() => this.database.transaction(() => {
      this.account(accountId); parse(z.enum(["succeeded", "failed"]), outcome);
      const row = this.load(accountId, actionId); this.matches(row, parse(versionInput, expected));
      if (row.state !== "uncertain") throw new MailActionError("invalid_state");
      return this.terminal(row, outcome, "reconciled");
    }));
  }
}
