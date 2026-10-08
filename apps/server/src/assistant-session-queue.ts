import { randomBytes } from "node:crypto";
import { z } from "zod";
import { openSqlite, type SqliteHandle } from "./runtime-db.js";
import { ApiError } from "./errors.js";

const targetSchema = z.object({ workspaceId: z.string(), sessionId: z.string() });
export type AssistantSessionTarget = z.infer<typeof targetSchema>;
const entrySchema = targetSchema.extend({
  id: z.string(), prompt: z.string().trim().min(1).max(12000),
  state: z.enum(["queued", "sending", "sent", "paused", "cancelled"]),
  allowInterrupted: z.boolean(), createdAt: z.number(), error: z.string().nullable(),
  requestId: z.string().optional(),
});
export type AssistantQueuedMessage = z.infer<typeof entrySchema>;
export type AssistantQueueExecutor = {
  inspect: (target: AssistantSessionTarget) => Promise<{ busy: boolean; pending: boolean; interrupted: boolean }>;
  hasMessage: (target: AssistantSessionTarget, id: string) => Promise<boolean>;
  send: (entry: AssistantQueuedMessage) => Promise<void>;
  abort: (target: AssistantSessionTarget) => Promise<string[] | void>;
};

/** Follow-ups survive navigation and restarts, and never interrupt a running turn. */
export class AssistantSessionQueue {
  private locks = new Map<string, Promise<unknown>>();
  private ticking: Promise<void> | null = null;
  private stopped = false;
  private stopping = 0;
  private constructor(private db: SqliteHandle, private executor: AssistantQueueExecutor) {}
  static async open(path: string, executor: AssistantQueueExecutor) {
    const db = await openSqlite(path);
    db.exec("CREATE TABLE IF NOT EXISTS assistant_session_queue (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, session_id TEXT NOT NULL, data TEXT NOT NULL)");
    return new AssistantSessionQueue(db, executor);
  }
  list(target: AssistantSessionTarget) {
    return this.db.all("SELECT data FROM assistant_session_queue WHERE workspace_id = ? AND session_id = ? ORDER BY rowid", [target.workspaceId, target.sessionId])
      .map(row => entrySchema.parse(JSON.parse(String(row.data))))
      .filter(entry => entry.state !== "sent" && entry.state !== "cancelled");
  }
  private save(entry: AssistantQueuedMessage) {
    this.db.run("INSERT INTO assistant_session_queue VALUES (?, ?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", [entry.id, entry.workspaceId, entry.sessionId, JSON.stringify(entry)]);
  }
  private locked<T>(target: AssistantSessionTarget, action: () => Promise<T>): Promise<T> {
    const key = JSON.stringify(target);
    const operation = (this.locks.get(key) ?? Promise.resolve()).catch(() => {}).then(action);
    this.locks.set(key, operation);
    return operation.finally(() => { if (this.locks.get(key) === operation) this.locks.delete(key); });
  }
  receipt(target: AssistantSessionTarget, prompt: string, requestId?: string) {
    if (!requestId) return null;
    const row = this.db.get("SELECT data FROM assistant_session_queue WHERE workspace_id = ? AND session_id = ? AND json_extract(data, '$.requestId') = ? AND json_extract(data, '$.prompt') = ?", [target.workspaceId, target.sessionId, requestId, prompt.trim()]);
    return row ? entrySchema.parse(JSON.parse(String(row.data))) : null;
  }
  async submit(target: AssistantSessionTarget, prompt: string, requestId?: string) {
    return this.locked(target, async () => {
      // Same pending instruction is idempotent, including after a lost HTTP response.
      const duplicate = this.receipt(target, prompt, requestId) ?? this.list(target).find(entry => entry.prompt === prompt.trim());
      if (duplicate) return duplicate;
      const status = await this.executor.inspect(target);
      const now = Date.now();
      const id = `msg_${BigInt.asUintN(48, BigInt(now) * 4096n).toString(16).padStart(12, "0")}${randomBytes(7).toString("hex")}`;
      const entry = entrySchema.parse({ ...target, id, prompt, requestId, state: "queued", allowInterrupted: !status.busy && status.interrupted, createdAt: now, error: null });
      this.save(entry);
      await this.deliver(target);
      const row = this.db.get("SELECT data FROM assistant_session_queue WHERE id = ?", [id]);
      return entrySchema.parse(JSON.parse(String(row?.data)));
    });
  }
  async update(target: AssistantSessionTarget, id: string, action: "cancel" | "edit" | "resume", prompt?: string) {
    return this.locked(target, async () => {
      const entry = this.list(target).find(item => item.id === id);
      if (!entry) throw new ApiError(404, "queued_message_missing", "This queued message is no longer pending.");
      if (entry.state === "sending") throw new ApiError(409, "queued_message_sending", "Delivery is being confirmed. Stop the session to cancel it safely.");
      const updated = entrySchema.parse({ ...entry, ...(action === "edit" ? { prompt } : {}),
        state: action === "cancel" ? "cancelled" : action === "resume" ? "queued" : entry.state,
        ...(action === "resume" ? { allowInterrupted: true, error: null } : {}) });
      this.save(updated);
      return updated;
    });
  }
  async stop(target: AssistantSessionTarget) {
    this.stopping++;
    try {
      // Drain in-flight sends before aborting, and prevent a child queue restarting it.
      await Promise.allSettled(this.locks.values());
      return await this.locked(target, async () => {
        const queued = this.list(target);
        for (const entry of queued) this.save({ ...entry, state: "cancelled", error: null });
        const children = await this.executor.abort(target);
        let cancelled = queued.length;
        for (const sessionId of children ?? []) {
          if (sessionId === target.sessionId) continue;
          for (const entry of this.list({ ...target, sessionId })) { this.save({ ...entry, state: "cancelled", error: null }); cancelled++; }
        }
        return { stopped: true, cancelledQueuedMessages: cancelled };
      });
    } finally { this.stopping--; }
  }
  private async deliver(target: AssistantSessionTarget) {
    const entry = this.list(target)[0];
    if (!entry || entry.state === "paused" || this.stopped || this.stopping) return;
    try {
      // Check the stable message identity before retrying an ambiguous send.
      if (entry.state === "sending" && await this.executor.hasMessage(target, entry.id)) {
        this.save({ ...entry, state: "sent", error: null });
        return;
      }
      const status = await this.executor.inspect(target);
      if (status.busy || status.pending) return;
      if (status.interrupted && !entry.allowInterrupted) {
        this.save({ ...entry, state: "paused", error: "The session stopped or failed. Resume explicitly or cancel this queued message." });
        return;
      }
      this.save({ ...entry, state: "sending", error: null });
      await this.executor.send(entry);
      // Keep the receipt identity until the engine confirms the stored message.
      if (await this.executor.hasMessage(target, entry.id)) this.save({ ...entry, state: "sent", error: null });
    } catch (error) {
      const row = this.db.get("SELECT data FROM assistant_session_queue WHERE id = ?", [entry.id]);
      const current = entrySchema.parse(JSON.parse(String(row?.data)));
      this.save({ ...current, error: error instanceof Error ? error.message : "Delivery could not be confirmed." });
    }
  }
  tick() {
    if (!this.ticking && !this.stopped) this.ticking = (async () => {
      const targets = this.db.all("SELECT DISTINCT workspace_id, session_id FROM assistant_session_queue WHERE json_extract(data, '$.state') IN ('queued', 'sending')");
      for (const row of targets) {
        const target = { workspaceId: String(row.workspace_id), sessionId: String(row.session_id) };
        await this.locked(target, () => this.deliver(target));
      }
    })().finally(() => { this.ticking = null; });
    return this.ticking ?? Promise.resolve();
  }
  start() {
    const timer = setInterval(() => { void this.tick().catch(error => console.warn("[assistant-session-queue]", error)); }, 2000);
    timer.unref();
    return async () => { this.stopped = true; clearInterval(timer); await this.ticking; await Promise.allSettled(this.locks.values()); };
  }
}
