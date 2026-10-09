import { createHash } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { z } from "zod";
import { openSqlite, type SqliteHandle } from "./runtime-db.js";
import { ApiError } from "./errors.js";

export const ChannelOwner = z.strictObject({ userId: z.string().min(1).max(128), orgId: z.string().min(1).max(128) });
export const ChannelInput = ChannelOwner.extend({ id: z.uuid(), conversationId: z.uuid(), channel: z.enum(["ios", "whatsapp", "email"]),
  text: z.string().min(1).max(65536), attachments: z.array(z.strictObject({ id: z.uuid(), filename: z.string().max(255),
    contentType: z.string().max(255), path: z.string().max(4096) })).max(10).default([]),
}).strict();
export const ChannelCommand = ChannelOwner.extend({ id: z.uuid(), command: z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("assistant.stop"), revision: z.number().int().positive() }),
  z.strictObject({ kind: z.literal("approval.reply"), targetId: z.string().max(255), revision: z.number().int().positive(),
    reply: z.enum(["once", "reject"]).optional(), answers: z.array(z.array(z.string().max(4000))).max(20).optional() }),
  z.strictObject({ kind: z.literal("schedule.update"), targetId: z.uuid(), revision: z.number().int().positive(),
    patch: z.strictObject({ title: z.string().min(1).max(500).optional(), prompt: z.string().max(20000).optional(), status: z.enum(["active", "paused"]).optional() }) }),
]) }).strict();
export const ChannelFileResult = z.strictObject({ path: z.string(), workspaceId: z.string(), filename: z.string(), contentType: z.string(), size: z.number().int().nonnegative() });
const Receipt = ChannelInput.extend({ fingerprint: z.string(), workspaceId: z.string(), sessionId: z.string(), messageId: z.string(),
  state: z.enum(["accepted", "sending", "running", "completed", "failed"]), textResult: z.string().nullable(),
  files: z.array(ChannelFileResult), code: z.string().nullable(), createdAt: z.number(), updatedAt: z.number(),
});
export type ChannelReceipt = z.infer<typeof Receipt>;
type Target = Pick<ChannelReceipt, "workspaceId" | "sessionId" | "messageId">;
export type ChannelEngine = {
  current: () => Promise<Omit<Target, "messageId">>;
  validate: (target: Target) => Promise<void>;
  hasMessage: (target: Target) => Promise<boolean>;
  busy: (target: Target) => Promise<boolean>;
  send: (receipt: ChannelReceipt) => Promise<void>;
  result: (target: ChannelReceipt) => Promise<{ state: "running" | "completed" | "failed"; text?: string; files?: z.infer<typeof ChannelFileResult>[]; code?: string }>;
};
const digest = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Host-only inbox. Journal before dispatch; an uncertain dispatch is never blindly replayed. */
export class ChannelRuntime {
  private locks = new Map<string, Promise<unknown>>();
  private constructor(private db: SqliteHandle, private engine: ChannelEngine, private available: () => boolean, private now: () => number) {}
  static async open(path: string, engine: ChannelEngine, available: () => boolean, now: () => number = Date.now) {
    await mkdir(dirname(path), { recursive: true });
    const db = await openSqlite(path);
    db.exec("CREATE TABLE IF NOT EXISTS channel_runtime_owner (id INTEGER PRIMARY KEY CHECK(id=1), data TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS channel_runtime_jobs (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS channel_runtime_conversations (id TEXT PRIMARY KEY, data TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS channel_runtime_commands (id TEXT PRIMARY KEY, fingerprint TEXT NOT NULL, data TEXT NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS channel_runtime_approvals (id TEXT PRIMARY KEY, hash TEXT NOT NULL, revision INTEGER NOT NULL)");
    db.exec("CREATE TABLE IF NOT EXISTS channel_runtime_settings (id TEXT PRIMARY KEY, value TEXT NOT NULL)");
    return new ChannelRuntime(db, engine, available, now);
  }
  close() { this.db.close?.(); }
  bind(owner: z.infer<typeof ChannelOwner>) {
    owner = ChannelOwner.parse(owner);
    const row = this.db.get("SELECT data FROM channel_runtime_owner WHERE id=1");
    if (row && digest(ChannelOwner.parse(JSON.parse(String(row.data)))) !== digest(owner))
      throw new ApiError(409, "channel_owner", "This worker belongs to another account or organization.");
    this.db.run("INSERT OR IGNORE INTO channel_runtime_owner VALUES (1, ?)", [JSON.stringify(owner)]);
  }
  private writable() {
    if (!this.available()) throw new ApiError(409, "channel_execution_blocked", "This worker does not own assistant execution.");
  }
  private async locked<T>(id: string, run: () => Promise<T>): Promise<T> {
    const next = (this.locks.get(id) ?? Promise.resolve()).catch(() => {}).then(run);
    this.locks.set(id, next);
    try { return await next; } finally { if (this.locks.get(id) === next) this.locks.delete(id); }
  }
  private save(receipt: ChannelReceipt) {
    receipt.updatedAt = this.now();
    this.db.run("INSERT INTO channel_runtime_jobs VALUES (?,?) ON CONFLICT(id) DO UPDATE SET data=excluded.data", [receipt.id, JSON.stringify(receipt)]);
  }
  private get(id: string) {
    const row = this.db.get("SELECT data FROM channel_runtime_jobs WHERE id=?", [id]);
    if (!row) throw new ApiError(404, "channel_job", "This runtime job does not exist.");
    return Receipt.parse(JSON.parse(String(row.data)));
  }
  jobs() { return this.db.all("SELECT data FROM channel_runtime_jobs").map(row => Receipt.parse(JSON.parse(String(row.data)))); }
  async accept(raw: unknown) {
    const input = ChannelInput.parse(raw); this.bind({ userId: input.userId, orgId: input.orgId }); this.writable();
    return this.locked("accept", async () => {
      const fingerprint = digest(input);
      const row = this.db.get("SELECT data FROM channel_runtime_jobs WHERE id=?", [input.id]);
      if (row) {
        const existing = Receipt.parse(JSON.parse(String(row.data)));
        if (existing.fingerprint !== fingerprint) throw new ApiError(409, "channel_idempotency", "This job ID has different content.");
        return this.inspectLocked(existing);
      }
      if (this.jobs().some(job => !["completed", "failed"].includes(job.state)))
        throw new ApiError(409, "channel_busy", "Another channel turn is still active.");
      const mappingKey = digest([input.orgId, input.userId, input.channel, input.conversationId]);
      const mapping = this.db.get("SELECT data FROM channel_runtime_conversations WHERE id=?", [mappingKey]);
      const target = mapping ? z.strictObject({ workspaceId: z.string(), sessionId: z.string() }).parse(JSON.parse(String(mapping.data))) : await this.engine.current();
      const receipt = Receipt.parse({ ...input, ...target, messageId: `msg_${digest([input.orgId, input.userId, input.id]).slice(0, 26)}`,
        fingerprint, state: "accepted", textResult: null, files: [], code: null, createdAt: this.now(), updatedAt: this.now() });
      await this.engine.validate(receipt);
      if (await this.engine.busy(receipt)) throw new ApiError(409, "channel_busy", "The Assistant is already handling a turn.");
      this.db.run("INSERT OR IGNORE INTO channel_runtime_conversations VALUES (?,?)", [mappingKey, JSON.stringify(target)]);
      this.save(receipt);
      receipt.state = "sending"; this.save(receipt);
      try { await this.engine.send(receipt); receipt.state = "running"; this.save(receipt); }
      catch {
        // Keep sending durable. Recovery checks the exact engine message ID;
        // no second prompt is sent after a timeout or a process restart.
        return this.inspectLocked(receipt);
      }
      return receipt;
    });
  }
  async inspect(id: string) { this.writable(); return this.locked("accept", () => this.inspectLocked(this.get(z.uuid().parse(id)))); }
  async cancel(id: string, stop: (receipt: ChannelReceipt) => Promise<void>) {
    this.writable();
    return this.locked("accept", async () => {
      const receipt = await this.inspectLocked(this.get(z.uuid().parse(id)));
      if (["completed", "failed"].includes(receipt.state)) return { stopped: false };
      await stop(receipt);
      receipt.state = "failed"; receipt.code = "cancelled"; this.save(receipt);
      return { stopped: true };
    });
  }
  async configure(fingerprint: string, reload: () => Promise<void>) {
    this.writable();
    return this.locked("accept", async () => {
      if (this.db.get("SELECT value FROM channel_runtime_settings WHERE id='model'")?.value === fingerprint) return { configured: true };
      for (const job of this.jobs()) if (!["completed", "failed"].includes((await this.inspectLocked(job)).state))
        throw new ApiError(409, "channel_busy", "Model configuration waits for the active turn.");
      await reload();
      this.db.run("INSERT INTO channel_runtime_settings VALUES ('model',?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", [fingerprint]);
      return { configured: true };
    });
  }
  private async inspectLocked(receipt: ChannelReceipt): Promise<ChannelReceipt> {
    if (["completed", "failed"].includes(receipt.state)) return receipt;
    await this.engine.validate(receipt);
    if (!await this.engine.hasMessage(receipt)) {
      // prompt_async acknowledges before the engine persists the user message.
      // A lost HTTP response can have the same window. Wait for that exact ID,
      // retaining the journal across restart, without issuing another prompt.
      if (this.now() - receipt.createdAt < 30000) return receipt;
      receipt.state = "failed"; receipt.code = "dispatch_uncertain"; this.save(receipt); return receipt;
    }
    const result = await this.engine.result(receipt);
    receipt.state = result.state;
    receipt.textResult = result.text ?? null; receipt.files = result.files ?? [];
    receipt.code = result.code ?? null; this.save(receipt); return receipt;
  }
  approvalRevision(id: string, hash: string) {
    const row = this.db.get("SELECT hash, revision FROM channel_runtime_approvals WHERE id=?", [id]);
    if (row?.hash === hash) return Number(row.revision);
    const revision = Number(row?.revision ?? 0) + 1;
    this.db.run("INSERT INTO channel_runtime_approvals VALUES (?,?,?) ON CONFLICT(id) DO UPDATE SET hash=excluded.hash, revision=excluded.revision", [id, hash, revision]);
    return revision;
  }
  async command(raw: unknown, run: (input: z.infer<typeof ChannelCommand>["command"]) => Promise<Record<string, unknown>>) {
    const input = ChannelCommand.parse(raw); this.bind({ userId: input.userId, orgId: input.orgId }); this.writable();
    return this.locked(`command:${input.id}`, async () => {
      const fingerprint = digest(input);
      const row = this.db.get("SELECT fingerprint, data FROM channel_runtime_commands WHERE id=?", [input.id]);
      if (row) {
        if (row.fingerprint !== fingerprint) throw new ApiError(409, "channel_idempotency", "This command ID has different content.");
        const value = z.record(z.string(), z.unknown()).parse(JSON.parse(String(row.data)));
        // A crash in a consequential command is not permission to replay it.
        return value.state === "sending" ? { state: "failed", result: { code: "command_uncertain" } } : value;
      }
      this.db.run("INSERT INTO channel_runtime_commands VALUES (?,?,?)", [input.id, fingerprint, JSON.stringify({ state: "sending" })]);
      let result: { state: "completed" | "failed"; result: Record<string, unknown> };
      try { result = { state: "completed", result: await run(input.command) }; }
      catch { result = { state: "failed", result: { code: "command_unavailable" } }; }
      this.db.run("UPDATE channel_runtime_commands SET data=? WHERE id=?", [JSON.stringify(result), input.id]);
      return result;
    });
  }
}
