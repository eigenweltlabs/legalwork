import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { sessionQueueSchema, type QueueAction, type QueueEntry, type SessionQueue } from "./session-queue-schema.js";
import { ApiError } from "./errors.js";
import type { ServerConfig } from "./types.js";

export type QueueTransport = {
  idle: (workspaceId: string, sessionId: string) => Promise<boolean>;
  send: (workspaceId: string, sessionId: string, entry: QueueEntry) => Promise<void | { pause: boolean; reason?: "stop" | "error" }>;
};
/** Only use before calling a delivery endpoint; later failures may have been accepted. */
export class QueuePreparationError extends Error {}
const keyOf = (workspaceId: string, sessionId: string) => JSON.stringify([workspaceId, sessionId]);
const conflict = () => new ApiError(409, "queue_changed", "The queue changed in another window. Refresh and try again.");

/** One backend dispatcher; atomic private files survive renderer and server
 * restarts. An interrupted dispatch is never automatically sent a second time. */
export class SessionMessageQueue {
  private states = new Map<string, SessionQueue>();
  private writes = new Map<string, Promise<unknown>>();
  private running = new Set<string>();
  private starting = new Map<string, Promise<void>>();
  private pending = new Set<string>();
  private removed = new Set<string>();
  private ready: Promise<void>;
  private timer: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(private directory: string, private transport: QueueTransport) {
    this.ready = this.load();
    // Keep startup failures observable by API calls without an unhandled rejection.
    void this.ready.catch(() => {});
    this.timer = setInterval(() => { void this.tick().catch(() => {}); }, 1_000);
    this.timer.unref?.();
  }
  private async load() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    for (const name of await readdir(this.directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const raw = await readFile(join(this.directory, name), "utf8");
      let queue: SessionQueue;
      try { queue = sessionQueueSchema.parse(JSON.parse(raw)); }
      catch {
        // Retain the damaged file for recovery; do not let it stop other chats.
        await rename(join(this.directory, name), join(this.directory, `${name}.invalid-${randomUUID()}`));
        console.warn("An invalid message queue was preserved and excluded from dispatch.");
        continue;
      }
      for (const entry of queue.entries) {
        if (entry.edit) delete entry.edit;
        if (entry.status === "sending") {
          entry.status = "uncertain";
          entry.error = "Delivery was interrupted. Check the conversation before removing or submitting this message again.";
          queue.paused = true;
          queue.pauseReason = "error";
        }
      }
      queue.revision++;
      await this.persist(queue);
      const key = keyOf(queue.workspaceId, queue.sessionId);
      this.states.set(key, queue);
      if (queue.entries.length) this.pending.add(key);
    }
  }
  private async persist(queue: SessionQueue) {
    const name = createHash("sha256").update(keyOf(queue.workspaceId, queue.sessionId)).digest("hex") + ".json";
    const temporary = join(this.directory, `.${name}.${randomUUID()}`);
    await writeFile(temporary, JSON.stringify(queue), { mode: 0o600 });
    await rename(temporary, join(this.directory, name));
  }
  private snapshot(workspaceId: string, sessionId: string): SessionQueue {
    return structuredClone(this.states.get(keyOf(workspaceId, sessionId)) ?? { workspaceId, sessionId, revision: 0, paused: false, completedIds: [], entries: [] });
  }
  async read(workspaceId: string, sessionId: string): Promise<SessionQueue> {
    await this.ready;
    // Publish the dispatch decision, not the transient persisted "queued" state.
    // An unavailable transport still leaves the durable message visible to retry.
    await this.starting.get(keyOf(workspaceId, sessionId))?.catch(() => {});
    return this.snapshot(workspaceId, sessionId);
  }
  async readIfChanged(workspaceId: string, sessionId: string, revision: string | null) {
    await this.ready;
    const current = await this.read(workspaceId, sessionId);
    return revision === String(current.revision) ? null : current;
  }
  private async change(workspaceId: string, sessionId: string, update: (queue: SessionQueue) => void) {
    await this.ready;
    const key = keyOf(workspaceId, sessionId);
    const previous = this.writes.get(key);
    const operation = (async () => {
      await previous?.catch(() => {});
      if (this.removed.has(key)) throw new ApiError(404, "session_not_found", "This conversation was deleted.");
      const queue = this.snapshot(workspaceId, sessionId);
      update(queue);
      queue.revision++;
      await this.persist(queue);
      this.states.set(key, queue);
      if (queue.entries.length) this.pending.add(key); else this.pending.delete(key);
      return structuredClone(queue);
    })();
    this.writes.set(key, operation);
    try { return await operation; } finally { if (this.writes.get(key) === operation) this.writes.delete(key); }
  }
  async act(workspaceId: string, sessionId: string, action: QueueAction) {
    const result = await this.change(workspaceId, sessionId, queue => {
      if ("revision" in action && action.revision !== queue.revision) throw conflict();
      const now = Date.now();
      for (const entry of queue.entries) if (entry.edit && entry.edit.expires <= now) delete entry.edit;
      const entry = "id" in action ? queue.entries.find(item => item.id === action.id) : undefined;
      if (action.type === "enqueue") {
        if (queue.completedIds.includes(action.id)) {
          if (action.editToken) throw conflict();
          return;
        }
        if (entry) {
          if (!action.editToken) return; // A retried enqueue is idempotent.
          if (entry.lastEditToken === action.editToken) return;
          if (entry.status === "sending" || entry.edit?.token !== action.editToken) throw conflict();
          Object.assign(entry, { draft: action.draft, execution: action.execution, status: "queued", lastEditToken: action.editToken });
          delete entry.edit; delete entry.error;
        } else {
          if (action.editToken) throw conflict();
          if (queue.entries.length >= 100) throw new ApiError(400, "queue_full", "The queue is full.");
          queue.entries.push({ id: action.id, draft: action.draft, execution: action.execution, status: "queued" });
          if (queue.paused && queue.pauseReason === "stop" && !queue.entries.some(item => item.status === "uncertain")) {
            queue.paused = false; delete queue.pauseReason;
            queue.resumeRevision = queue.revision + 1;
          }
        }
      } else if (action.type === "pause") {
        if (!action.paused && queue.entries.some(item => item.edit || item.status === "uncertain")) throw conflict();
        queue.paused = action.paused;
        if (action.paused) queue.pauseReason = action.reason;
        else { delete queue.pauseReason; queue.resumeRevision = queue.revision + 1; }
        if (!action.paused) for (const item of queue.entries) { if (item.status === "failed") item.status = "queued"; delete item.error; }
      } else if (action.type === "reorder") {
        const requested = new Set(action.ids);
        const waiting = queue.entries.filter(item => item.status !== "sending");
        if (requested.size !== action.ids.length || requested.size !== waiting.length || waiting.some(item => !requested.has(item.id))) throw conflict();
        waiting.sort((a, b) => action.ids.indexOf(a.id) - action.ids.indexOf(b.id));
        // The in-flight delivery keeps its place and cannot be sent a second time.
        queue.entries = [...queue.entries.filter(item => item.status === "sending"), ...waiting];
      } else {
        if (!entry || entry.status === "sending") throw conflict();
        if (action.type === "edit") {
          if (entry.status === "uncertain" || (entry.edit && entry.edit.token !== action.token)) throw conflict();
          entry.edit = { token: action.token, expires: now + 120_000 };
        } else if (action.type === "remove") {
          if (entry.edit) throw conflict();
          queue.entries = queue.entries.filter(item => item.id !== action.id);
          queue.completedIds = [...queue.completedIds, action.id].slice(-500);
        } else {
          if (entry.edit?.token !== action.token) throw conflict();
          if (action.type === "release") delete entry.edit;
          else entry.edit.expires = now + 120_000;
        }
      }
    });
    const starting = this.start(result);
    if (action.type === "enqueue") {
      // Only wait for the idle check and durable claim, never for the model reply.
      await starting.catch(() => {});
      return this.read(workspaceId, sessionId);
    }
    // Stop and edit controls must remain responsive during a slow idle check.
    void starting.catch(() => {});
    return result;
  }
  async tick() {
    await this.ready;
    if (this.stopped) return;
    for (const key of this.pending) {
      const queue = this.states.get(key);
      if (!queue) continue;
      if (queue.entries.some(entry => entry.edit && entry.edit.expires <= Date.now())) {
        await this.change(queue.workspaceId, queue.sessionId, current => {
          for (const entry of current.entries) if (entry.edit && entry.edit.expires <= Date.now()) delete entry.edit;
        });
      }
      void this.start(this.states.get(key) ?? queue).catch(() => {});
    }
  }
  private start(queue: SessionQueue): Promise<void> {
    const key = keyOf(queue.workspaceId, queue.sessionId);
    if (this.running.has(key)) return this.starting.get(key) ?? Promise.resolve();
    if (this.stopped || queue.paused || queue.entries[0]?.status !== "queued" || queue.entries.some(entry => entry.edit)) return Promise.resolve();
    this.running.add(key);
    const starting = this.prepareDispatch(queue.workspaceId, queue.sessionId).then(prepared => {
      if (!prepared) { this.running.delete(key); return; }
      void this.deliver(queue.workspaceId, queue.sessionId, prepared.item, prepared.revision)
        .finally(() => this.running.delete(key)).catch(() => {});
    }, error => { this.running.delete(key); throw error; }).finally(() => this.starting.delete(key));
    this.starting.set(key, starting);
    return starting;
  }
  private async prepareDispatch(workspaceId: string, sessionId: string) {
    if (!await this.transport.idle(workspaceId, sessionId) || this.stopped) return;
    let item: QueueEntry | undefined;
    let dispatchRevision = 0;
    await this.change(workspaceId, sessionId, queue => {
      const first = queue.entries[0];
      if (queue.paused || !first || first.status !== "queued" || queue.entries.some(entry => entry.edit)) return;
      first.status = "sending"; item = structuredClone(first); dispatchRevision = queue.revision;
    });
    if (!item || this.stopped) return;
    return { item, revision: dispatchRevision };
  }
  private async deliver(workspaceId: string, sessionId: string, sent: QueueEntry, dispatchRevision: number) {
    try {
      const result = await this.transport.send(workspaceId, sessionId, sent);
      await this.change(workspaceId, sessionId, queue => {
        queue.entries = queue.entries.filter(entry => entry.id !== sent.id);
        queue.completedIds = [...queue.completedIds, sent.id].slice(-500);
        if (result?.pause && (queue.resumeRevision ?? 0) <= dispatchRevision) {
          queue.paused = true; queue.pauseReason = result.reason ?? "error";
        }
      });
    } catch (error) {
      if (this.removed.has(keyOf(workspaceId, sessionId))) return;
      await this.change(workspaceId, sessionId, queue => {
        const entry = queue.entries.find(entry => entry.id === sent.id);
        if (entry) {
          entry.status = error instanceof QueuePreparationError ? "failed" : "uncertain";
          entry.error = error instanceof Error ? error.message : "Message delivery failed.";
        }
        queue.paused = true;
        queue.pauseReason = "error";
      });
    }
  }
  async removeSession(workspaceId: string, sessionId: string) {
    await this.ready;
    const key = keyOf(workspaceId, sessionId);
    this.removed.add(key);
    await this.writes.get(key)?.catch(() => {});
    this.states.delete(key); this.pending.delete(key);
    const name = createHash("sha256").update(key).digest("hex") + ".json";
    await rm(join(this.directory, name), { force: true });
  }
  stop() { this.stopped = true; clearInterval(this.timer); }
}

const queues = new WeakMap<ServerConfig, SessionMessageQueue>();
export function registerMessageQueue(config: ServerConfig, transport: QueueTransport) {
  const directory = join(dirname(config.configPath || process.env.LEGALWORK_RUNTIME_DB || join(homedir(), ".config/legalwork/config.json")), "message-queues");
  const queue = new SessionMessageQueue(directory, transport); queues.set(config, queue); return queue;
}
export function stopMessageQueue(config: ServerConfig) { queues.get(config)?.stop(); queues.delete(config); }
