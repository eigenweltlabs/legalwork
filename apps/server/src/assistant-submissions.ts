import { AssistantExecutionTargetSchema, AssistantSubmissionStateSchema, AssistantSubmissionPartSchema, AssistantSubmitInputSchema } from "./native-shared-values.js";
import { z } from "zod";
import { SessionAuthoritySchema, type SessionAuthority } from "./wiki/agent-access.js";
import type { QueueEntry } from "./session-queue-schema.js";
import { ApiError } from "./errors.js";
import { openSqlite, type Row, type SqliteHandle } from "./runtime-db.js";
import type { AssistantExecutionTarget, AssistantSubmission, AssistantSubmitInput } from "@legalwork/types/launcher";

export type SubmissionTarget = { workspaceId: string; sessionId: string };
export type SubmissionPart = z.infer<typeof AssistantSubmissionPartSchema>;
export type SubmissionPayload = { parts: SubmissionPart[]; model?: { providerID: string; modelID: string }; agent?: string; variant?: string; command?: { name: string; arguments: string }; queue?: AssistantSubmitInput["queue"]; authority?: SessionAuthority };
const SubmissionPayloadSchema = z.object({
  parts: z.array(AssistantSubmissionPartSchema),
  model: z.object({ providerID: z.string(), modelID: z.string() }).optional(), agent: z.string().optional(), variant: z.string().optional(),
  command: z.object({ name: z.string(), arguments: z.string() }).optional(),
  queue: AssistantSubmitInputSchema.shape.queue,
  authority: SessionAuthoritySchema.optional(),
});
export type SubmissionExecutor = {
  hasMessage: (target: SubmissionTarget, messageId: string, payload: SubmissionPayload) => Promise<boolean>;
  send: (entry: AssistantSubmission, payload: SubmissionPayload) => Promise<void>;
  waiting?: (entry: AssistantSubmission, payload: SubmissionPayload) => Promise<boolean>;
  /** The engine's view once a message is stored: nothing yet, a running turn, an answer, or an error. */
  outcome: (target: SubmissionTarget, messageId: string, payload: SubmissionPayload) => Promise<"accepted" | "running" | "completed" | "failed">;
};
const SENDING_GRACE_MS = 60_000;

/**
 * Identified Assistant submissions. A client request ID and message ID exist
 * before dispatch; a retry after a lost acknowledgement reuses them, and the
 * engine's stored message decides whether anything is sent again.
 */
export class AssistantSubmissions {
  private locks = new Map<string, Promise<unknown>>();
  private constructor(private db: SqliteHandle, private executor: SubmissionExecutor) {}
  static async open(path: string, executor: SubmissionExecutor) {
    const db = await openSqlite(path);
    db.exec("CREATE TABLE IF NOT EXISTS assistant_submissions (request_id TEXT PRIMARY KEY, message_id TEXT NOT NULL UNIQUE, conversation_id TEXT NOT NULL, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, state TEXT NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, error TEXT, preview TEXT NOT NULL, parts TEXT NOT NULL, target TEXT NOT NULL)");
    db.exec("CREATE INDEX IF NOT EXISTS assistant_submissions_session ON assistant_submissions (session_id, created_at)");
    return new AssistantSubmissions(db, executor);
  }
  private item(row: Row): AssistantSubmission {
    return { requestId: String(row.request_id), messageId: String(row.message_id), conversationId: String(row.conversation_id), workspaceId: String(row.workspace_id), sessionId: String(row.session_id),
      state: AssistantSubmissionStateSchema.parse(row.state), createdAt: Number(row.created_at), updatedAt: Number(row.updated_at), error: row.error === null || row.error === undefined ? null : String(row.error), preview: String(row.preview),
      target: AssistantExecutionTargetSchema.parse(JSON.parse(String(row.target))) };
  }
  private save(entry: AssistantSubmission, payload?: SubmissionPayload) {
    const now = Date.now();
    const saved = { ...entry, updatedAt: now };
    if (payload) this.db.run("INSERT INTO assistant_submissions (request_id, message_id, conversation_id, workspace_id, session_id, state, created_at, updated_at, error, preview, parts, target) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
      [saved.requestId, saved.messageId, saved.conversationId, saved.workspaceId, saved.sessionId, saved.state, saved.createdAt, saved.updatedAt, saved.error, saved.preview, JSON.stringify(payload), JSON.stringify(saved.target)]);
    else this.db.run("UPDATE assistant_submissions SET state = ?, updated_at = ?, error = ? WHERE request_id = ?", [saved.state, saved.updatedAt, saved.error, saved.requestId]);
    return saved;
  }
  private locked<T>(requestId: string, action: () => Promise<T>): Promise<T> {
    const operation = (this.locks.get(requestId) ?? Promise.resolve()).catch(() => {}).then(action);
    this.locks.set(requestId, operation);
    return operation.finally(() => { if (this.locks.get(requestId) === operation) this.locks.delete(requestId); });
  }
  get(requestId: string): AssistantSubmission | null {
    const row = this.db.get("SELECT * FROM assistant_submissions WHERE request_id = ?", [requestId]);
    return row ? this.item(row) : null;
  }
  /** Queue metadata is editable. Restore only the ceiling held in the trusted
   * submission receipt, bound to this exact staged message and destination. */
  async prepareQueued(target: SubmissionTarget, queued: QueueEntry, restore: (authority: SessionAuthority | undefined) => Promise<void>) {
    const messageId = queued.messageId ?? (queued.execution.kind === "prompt" ? queued.execution.id : undefined);
    if (!messageId) return;
    const row = this.db.get("SELECT * FROM assistant_submissions WHERE message_id = ?", [messageId]);
    if (!row) return;
    const entry = this.item(row), payload = this.payload(entry.requestId);
    if (payload.queue?.id !== queued.id) return;
    if (entry.workspaceId !== target.workspaceId || entry.sessionId !== target.sessionId)
      throw new ApiError(403, "submission_scope", "This queued request belongs to another chat.");
    await restore(payload.authority);
  }
  latest(sessionId: string): AssistantSubmission | null {
    const row = this.db.get("SELECT * FROM assistant_submissions WHERE session_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1", [sessionId]);
    return row ? this.item(row) : null;
  }
  /** The execution constraint bound to a conversation's latest request, enforced on delegation. */
  constraint(sessionId: string): AssistantExecutionTarget | null {
    return this.latest(sessionId)?.target ?? null;
  }
  /**
   * The constraint that applies right now: the oldest identified request the
   * engine has not finished, since turns run in order. A finished request binds
   * nothing, so a later message sent from Home is free to pick its own project,
   * and a queued general question does not unbind the job still running.
   */
  async activeConstraint(sessionId: string): Promise<AssistantExecutionTarget | null> {
    const recent = this.db.all("SELECT * FROM assistant_submissions WHERE session_id = ? AND state NOT IN ('completed', 'failed') ORDER BY created_at DESC, rowid DESC", [sessionId]).map(row => this.item(row));
    const open: AssistantSubmission[] = [];
    for (const entry of recent) {
      const current = await this.reconcile(entry);
      if (current.state !== "completed" && current.state !== "failed" && !await this.executor.waiting?.(current, this.payload(current.requestId))) open.push(current);
    }
    return open.at(-1)?.target ?? null;
  }
  submit(input: Omit<AssistantSubmission, "state" | "createdAt" | "updatedAt" | "error"> & { payload: SubmissionPayload }) {
    return this.locked(input.requestId, async () => {
      const existing = this.get(input.requestId);
      if (existing) {
        if (existing.messageId !== input.messageId || existing.sessionId !== input.sessionId) throw new ApiError(409, "submission_identity", "This request ID already belongs to another message.");
        // A retry after a lost acknowledgement resends only what the engine never stored; anything else re-reads the engine.
        return existing.state === "unconfirmed" || existing.state === "sending" && Date.now() - existing.updatedAt >= SENDING_GRACE_MS ? this.dispatch(existing) : this.reconcile(existing);
      }
      const byMessage = this.db.get("SELECT request_id FROM assistant_submissions WHERE message_id = ?", [input.messageId]);
      if (byMessage) throw new ApiError(409, "submission_identity", "This message ID already belongs to another request.");
      const now = Date.now();
      const { payload, ...rest } = input;
      return this.dispatch(this.save({ ...rest, state: "sending", createdAt: now, updatedAt: now, error: null }, payload));
    });
  }
  prepare<T>(requestId: string, action: () => Promise<T>) { return this.locked(`prepare:${requestId}`, action); }
  retry(requestId: string) {
    return this.locked(requestId, async () => {
      const entry = this.get(requestId);
      if (!entry) throw new ApiError(404, "submission_not_found", "This request is unknown.");
      return entry.state === "unconfirmed" || entry.state === "sending" && Date.now() - entry.updatedAt >= SENDING_GRACE_MS ? this.dispatch(entry) : this.reconcile(entry);
    });
  }
  private payload(requestId: string): SubmissionPayload {
    const row = this.db.get("SELECT parts FROM assistant_submissions WHERE request_id = ?", [requestId]);
    return SubmissionPayloadSchema.parse(JSON.parse(String(row?.parts ?? "{\"parts\":[]}")));
  }
  private async dispatch(entry: AssistantSubmission): Promise<AssistantSubmission> {
    const target = { workspaceId: entry.workspaceId, sessionId: entry.sessionId };
    const payload = this.payload(entry.requestId);
    try {
      if (!(await this.executor.hasMessage(target, entry.messageId, payload))) await this.executor.send(entry, payload);
      const stored = await this.executor.hasMessage(target, entry.messageId, payload);
      // promptAsync acknowledges before the engine necessarily exposes the message.
      // Keep checking the same request during the grace period; do not offer a duplicate send.
      return this.save({ ...entry, state: stored ? "accepted" : "sending", error: null });
    } catch (error) {
      // The engine may have stored the message before the response was lost; its record decides.
      const refused = error instanceof ApiError && error.status < 500;
      const stored = refused ? false : await this.executor.hasMessage(target, entry.messageId, payload).catch(() => false);
      return this.save({ ...entry, state: stored ? "accepted" : refused ? "failed" : "unconfirmed", error: stored ? null : error instanceof Error ? error.message : String(error) });
    }
  }
  /** Re-read the engine instead of trusting the last HTTP response. Never resends an accepted message. */
  async reconcile(entry: AssistantSubmission): Promise<AssistantSubmission> {
    const target = { workspaceId: entry.workspaceId, sessionId: entry.sessionId };
    if (entry.state === "failed" || entry.state === "completed") return entry;
    try {
      if (entry.state === "sending" || entry.state === "unconfirmed") {
        if (await this.executor.hasMessage(target, entry.messageId, this.payload(entry.requestId))) entry = this.save({ ...entry, state: "accepted", error: null });
        else return entry.state === "sending" && Date.now() - entry.updatedAt < SENDING_GRACE_MS ? entry : this.save({ ...entry, state: "unconfirmed", error: entry.error ?? "Delivery could not be confirmed." });
      }
      const outcome = await this.executor.outcome(target, entry.messageId, this.payload(entry.requestId));
      if (outcome === entry.state || (outcome === "accepted" && entry.state === "running")) return entry;
      return this.save({ ...entry, state: outcome, error: outcome === "failed" ? "The Assistant did not finish this request." : null });
    } catch (error) {
      return { ...entry, error: error instanceof Error ? error.message : String(error) };
    }
  }
  status(requestId: string) {
    return this.locked(requestId, async () => {
      const entry = this.get(requestId);
      if (!entry) throw new ApiError(404, "submission_not_found", "This request is unknown to the server.");
      return this.reconcile(entry);
    });
  }
}
