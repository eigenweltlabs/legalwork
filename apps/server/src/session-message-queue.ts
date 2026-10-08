import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { sessionQueueSchema, type QueueAction, type QueueEntry, type SessionQueue } from "./session-queue-schema.js";
import { ApiError } from "./errors.js";
import type { ServerConfig } from "./types.js";

export type QueueTransport = {
  idle: (workspaceId: string, sessionId: string) => Promise<boolean>;
  send: (workspaceId: string, sessionId: string, entry: QueueEntry) => Promise<void>;
};
const keyOf = (workspaceId: string, sessionId: string) => JSON.stringify([workspaceId, sessionId]);
const conflict = () => new ApiError(409, "queue_changed", "The queue changed in another window. Refresh and try again.");

/** One backend dispatcher; atomic private files survive renderer and server
 * restarts. An interrupted dispatch is never automatically sent a second time. */
export class SessionMessageQueue {
  private states = new Map<string, SessionQueue>();
  private writes = new Map<string, Promise<unknown>>();
  private running = new Set<string>();
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
        if (entry.edit) { delete entry.edit; queue.paused = true; }
        if (entry.status === "sending") {
          entry.status = "uncertain";
          entry.error = "Delivery was interrupted. Check the conversation before removing or submitting this message again.";
          queue.paused = true;
        }
      }
      queue.revision++;
      await this.persist(queue);
      this.states.set(keyOf(queue.workspaceId, queue.sessionId), queue);
    }
  }
  private async persist(queue: SessionQueue) {
    const name = createHash("sha256").update(keyOf(queue.workspaceId, queue.sessionId)).digest("hex") + ".json";
    const temporary = join(this.directory, `.${name}.${randomUUID()}`);
    await writeFile(temporary, JSON.stringify(queue), { mode: 0o600 });
    await rename(temporary, join(this.directory, name));
  }
  async read(workspaceId: string, sessionId: string): Promise<SessionQueue> {
    await this.ready;
    return structuredClone(this.states.get(keyOf(workspaceId, sessionId)) ?? { workspaceId, sessionId, revision: 0, paused: false, completedIds: [], entries: [] });
  }
  private async change(workspaceId: string, sessionId: string, update: (queue: SessionQueue) => void) {
    await this.ready;
    const key = keyOf(workspaceId, sessionId);
    const previous = this.writes.get(key);
    const operation = (async () => {
      await previous?.catch(() => {});
      const queue = await this.read(workspaceId, sessionId);
      update(queue);
      queue.revision++;
      await this.persist(queue);
      this.states.set(key, queue);
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
        if (queue.completedIds.includes(action.id)) return;
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
        }
      } else if (action.type === "pause") {
        if (!action.paused && queue.entries.some(item => item.edit || item.status === "uncertain")) throw conflict();
        queue.paused = action.paused;
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
          entry.edit = { token: action.token, expires: now + 120_000 }; queue.paused = true;
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
    void this.tick().catch(() => {});
    return result;
  }
  async tick() {
    await this.ready;
    if (this.stopped) return;
    for (const [key, queue] of this.states) {
      if (queue.entries.some(entry => entry.edit && entry.edit.expires <= Date.now())) {
        await this.change(queue.workspaceId, queue.sessionId, current => {
          for (const entry of current.entries) if (entry.edit && entry.edit.expires <= Date.now()) delete entry.edit;
        });
      }
      if (this.running.has(key) || queue.paused || !queue.entries.length) continue;
      this.running.add(key);
      void this.dispatch(queue.workspaceId, queue.sessionId).finally(() => this.running.delete(key)).catch(() => {});
    }
  }
  private async dispatch(workspaceId: string, sessionId: string) {
    if (!await this.transport.idle(workspaceId, sessionId) || this.stopped) return;
    let item: QueueEntry | undefined;
    await this.change(workspaceId, sessionId, queue => {
      const first = queue.entries[0];
      if (queue.paused || !first || first.status !== "queued" || first.edit) return;
      first.status = "sending"; item = structuredClone(first);
    });
    if (!item || this.stopped) return;
    const sent = item;
    try {
      await this.transport.send(workspaceId, sessionId, sent);
      await this.change(workspaceId, sessionId, queue => { queue.entries = queue.entries.filter(entry => entry.id !== sent.id); queue.completedIds = [...queue.completedIds, sent.id].slice(-500); });
    } catch (error) {
      await this.change(workspaceId, sessionId, queue => {
        const entry = queue.entries.find(entry => entry.id === sent.id);
        if (entry) {
          entry.status = "uncertain";
          entry.error = error instanceof Error ? error.message : "Message delivery failed.";
        }
        queue.paused = true;
      });
    }
  }
  async removeSession(workspaceId: string, sessionId: string) {
    await this.change(workspaceId, sessionId, queue => {
      queue.completedIds = [...queue.completedIds, ...queue.entries.map(entry => entry.id)].slice(-500);
      queue.entries = [];
      queue.paused = true;
    });
  }
  stop() { this.stopped = true; clearInterval(this.timer); }
}

const queues = new WeakMap<ServerConfig, SessionMessageQueue>();
export function registerMessageQueue(config: ServerConfig, transport: QueueTransport) {
  const directory = join(dirname(config.configPath || process.env.LEGALWORK_RUNTIME_DB || join(homedir(), ".config/legalwork/config.json")), "message-queues");
  const queue = new SessionMessageQueue(directory, transport); queues.set(config, queue); return queue;
}
export function stopMessageQueue(config: ServerConfig) { queues.get(config)?.stop(); queues.delete(config); }
