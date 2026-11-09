import { announceSyncChange } from "./app-sync-events.js";
import { createHash, randomUUID } from "node:crypto";
import { mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { sessionQueueSchema, type QueueAction, type QueueEntry, type SessionQueue } from "./session-queue-schema.js";
import { ApiError } from "./errors.js";
import type { ServerConfig } from "./types.js";
import { isNativeDeliveryRejected } from "./native-delivery.js";

export type QueueTransport = {
  confirmed?: (workspaceId: string, sessionId: string, entry: QueueEntry) => Promise<boolean>;
  idle: (workspaceId: string, sessionId: string) => Promise<boolean>;
  send: (workspaceId: string, sessionId: string, entry: QueueEntry) => Promise<void | { pause: boolean; reason?: "stop" | "error" } | { accepted: true }>;
  settled?: (workspaceId: string, sessionId: string, entry: QueueEntry) => Promise<{ pause: boolean; reason?: "stop" | "error" } | undefined>;
};
/** Only use before calling a delivery endpoint; later failures may have been accepted. */
export class QueuePreparationError extends Error {}
const keyOf = (workspaceId: string, sessionId: string) => JSON.stringify([workspaceId, sessionId]);
const inFlight = (entry: QueueEntry) => entry.status === "sending" || entry.status === "accepted";
const conflict = () => new ApiError(409, "queue_changed", "The queue changed in another window. Refresh and try again.");

/** One backend dispatcher; atomic private files survive renderer and server
 * restarts. An interrupted dispatch is never automatically sent a second time. */
export class SessionMessageQueue {
  private states = new Map<string, SessionQueue>();
  private writes = new Map<string, Promise<unknown>>();
  private running = new Set<string>();
  private starting = new Map<string, Promise<void>>();
  private deliveries = new Map<string, { delivery?: "steer"; operation: Promise<void> }>();
  private pending = new Set<string>();
  private removed = new Set<string>();
  private ready: Promise<void>;
  private timer: ReturnType<typeof setInterval>;
  private stopped = false;
  private changes = new Map<string, Set<() => void>>();
  constructor(private directory: string, private transport: QueueTransport, private readonly onChange?: () => void) {
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
          entry.error = "Delivery was interrupted. The saved message is being checked against the conversation. Do not send another copy.";
          if (entry.delivery !== "steer") { queue.paused = true; queue.pauseReason = "error"; }
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
  /** Wait for the durable entry lifecycle, including pre-admission staging.
   * State notifications avoid a polling loop or an arbitrary task deadline. */
  async waitForEntry(workspaceId: string, sessionId: string, id: string, signal: AbortSignal) {
    const key = keyOf(workspaceId, sessionId);
    for (;;) {
      signal.throwIfAborted();
      if (this.stopped) throw new ApiError(503, "server_stopped", "The server stopped while waiting for the queued message.");
      let wake = () => {};
      const changed = new Promise<void>(resolve => { wake = resolve; });
      const listeners = this.changes.get(key) ?? new Set<() => void>();
      this.changes.set(key, listeners); listeners.add(wake);
      signal.addEventListener("abort", wake, { once: true });
      try {
        const entry = (await this.read(workspaceId, sessionId)).entries.find(entry => entry.id === id);
        if (!entry) return;
        if (entry.status === "failed" || entry.status === "uncertain") throw new ApiError(409, "queue_delivery_unconfirmed", entry.error ?? "Message delivery could not be confirmed. Check the conversation before retrying.", { entryId: id });
        await changed;
      } finally {
        signal.removeEventListener("abort", wake); listeners.delete(wake);
        if (!listeners.size) this.changes.delete(key);
      }
    }
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
      for (const listener of this.changes.get(key) ?? []) listener();
      this.onChange?.();
      if (queue.entries.length) this.pending.add(key); else this.pending.delete(key);
      return structuredClone(queue);
    })();
    this.writes.set(key, operation);
    try { return await operation; } finally { if (this.writes.get(key) === operation) this.writes.delete(key); }
  }
  async act(workspaceId: string, sessionId: string, action: QueueAction) {
    const resumeOnSend = action.type === "enqueue" && !action.editToken && action.resumeStopped !== false;
    if (resumeOnSend) {
      await this.ready;
      const queue = this.states.get(keyOf(workspaceId, sessionId));
      const previous = queue?.entries[0];
      // The chat can show the terminal reply before the queue's next poll.
      if (queue?.entries.length === 1 && !queue.paused && previous?.status === "accepted" && previous.id !== action.id) {
        await this.settleAccepted(workspaceId, sessionId, previous);
      }
    }
    const result = await this.change(workspaceId, sessionId, queue => {
      if (action.type !== "steer" && "revision" in action && action.revision !== queue.revision) throw conflict();
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
          if (inFlight(entry) || entry.edit?.token !== action.editToken) throw conflict();
          Object.assign(entry, { draft: action.draft, execution: action.execution, status: "queued", lastEditToken: action.editToken, contentRevision: queue.revision + 1 });
          delete entry.edit; delete entry.error; delete entry.delivery;
        } else {
          if (action.editToken) throw conflict();
          if (queue.entries.length >= 100) throw new ApiError(400, "queue_full", "The queue is full.");
          const resumeAfterError = queue.pauseReason === "error" && queue.entries.length === 0;
          const resumeAfterStop = queue.pauseReason === "stop" && !queue.entries.some(item => item.status === "uncertain");
          if (resumeOnSend && queue.paused && (resumeAfterError || resumeAfterStop)) {
            queue.paused = false; delete queue.pauseReason;
            queue.resumeRevision = queue.revision + 1;
          }
          queue.entries.push({ id: action.id, draft: action.draft, execution: action.execution, status: "queued", contentRevision: queue.revision + 1 });
        }
      } else if (action.type === "steer") {
        if (queue.completedIds.includes(action.id)) return;
        if (!entry || entry.execution.kind !== "prompt" || entry.draft.mode !== "prompt" || entry.draft.command || entry.edit || (entry.contentRevision ?? 0) > action.revision) throw conflict();
        // Lost responses and double clicks join the same durable operation.
        if (entry.delivery === "steer" && entry.status !== "failed") return;
        if (entry.status === "uncertain") throw conflict();
        // Dispatch may have claimed/admitted this exact content since the UI
        // snapshot. Record the promotion before waiting for that admission.
        entry.delivery = "steer"; entry.status = "sending";
        entry.dispatchRevision = queue.revision;
        delete entry.error;
      } else if (action.type === "pause") {
        if (!action.paused && queue.entries.some(item => item.edit || item.status === "uncertain")) throw conflict();
        queue.paused = action.paused;
        if (action.paused) queue.pauseReason = action.reason;
        else { delete queue.pauseReason; queue.resumeRevision = queue.revision + 1; }
        if (!action.paused) for (const item of queue.entries) { if (item.status === "failed") item.status = "queued"; delete item.error; }
      } else if (action.type === "reorder") {
        const requested = new Set(action.ids);
        const waiting = queue.entries.filter(item => !inFlight(item));
        if (requested.size !== action.ids.length || requested.size !== waiting.length || waiting.some(item => !requested.has(item.id))) throw conflict();
        waiting.sort((a, b) => action.ids.indexOf(a.id) - action.ids.indexOf(b.id));
        // The in-flight delivery keeps its place and cannot be sent a second time.
        queue.entries = [...queue.entries.filter(item => inFlight(item)), ...waiting];
      } else {
        if (!entry || inFlight(entry)) throw conflict();
        if (action.type === "edit") {
          if (entry.status === "uncertain" || (entry.edit && entry.edit.token !== action.token)) throw conflict();
          entry.edit = { token: action.token, expires: now + 120_000 };
        } else if (action.type === "remove") {
          if (entry.edit || entry.status === "uncertain") throw conflict();
          queue.entries = queue.entries.filter(item => item.id !== action.id);
          queue.completedIds = [...queue.completedIds, action.id].slice(-500);
        } else {
          if (entry.edit?.token !== action.token) throw conflict();
          if (action.type === "release") delete entry.edit;
          else entry.edit.expires = now + 120_000;
        }
      }
    });
    if (action.type === "steer") {
      await this.runDelivery(workspaceId, sessionId, action.id);
      return this.read(workspaceId, sessionId);
    }
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
      for (const entry of queue.entries.filter(entry => entry.status === "uncertain")) {
        if (entry.delivery === "steer") {
          // The native stable ID makes retry safe even if the crash preceded
          // admission. The transport promotes existing inbox items first.
          await this.runDelivery(queue.workspaceId, queue.sessionId, entry.id);
          continue;
        }
        if (await this.transport.confirmed?.(queue.workspaceId, queue.sessionId, entry).catch(() => false)) {
          await this.change(queue.workspaceId, queue.sessionId, current => {
            if (this.transport.settled) {
              const accepted = current.entries.find(item => item.id === entry.id);
              if (accepted) { accepted.status = "accepted"; delete accepted.error; }
            } else {
              current.entries = current.entries.filter(item => item.id !== entry.id);
              current.completedIds = [...current.completedIds, entry.id].slice(-500);
            }
            if (current.pauseReason === "error" && !current.entries.some(item => item.status === "uncertain" || item.status === "failed")) {
              current.paused = false;
              delete current.pauseReason;
            }
          });
        }
      }
      for (const entry of (this.states.get(key) ?? queue).entries.filter(entry => entry.status === "accepted")) {
        await this.settleAccepted(queue.workspaceId, queue.sessionId, entry);
      }
      if (queue.entries.some(entry => entry.edit && entry.edit.expires <= Date.now())) {
        await this.change(queue.workspaceId, queue.sessionId, current => {
          for (const entry of current.entries) if (entry.edit && entry.edit.expires <= Date.now()) delete entry.edit;
        });
      }
      void this.start(this.states.get(key) ?? queue).catch(() => {});
    }
  }
  private async settleAccepted(workspaceId: string, sessionId: string, entry: QueueEntry) {
    const outcome = await this.transport.settled?.(workspaceId, sessionId, entry).catch(() => undefined);
    if (outcome === undefined) return;
    await this.change(workspaceId, sessionId, queue => {
      const latest = queue.entries.find(item => item.id === entry.id);
      if (!latest || latest.status !== "accepted" || latest.delivery !== entry.delivery) return;
      queue.entries = queue.entries.filter(item => item.id !== entry.id);
      queue.completedIds = [...queue.completedIds, entry.id].slice(-500);
      if (!queue.paused && entry.delivery !== "steer" && outcome.pause && (queue.resumeRevision ?? 0) <= (entry.dispatchRevision ?? queue.revision)) {
        queue.paused = true;
        queue.pauseReason = outcome.reason ?? "error";
      }
    });
  }
  private start(queue: SessionQueue): Promise<void> {
    const key = keyOf(queue.workspaceId, queue.sessionId);
    if (this.running.has(key)) return this.starting.get(key) ?? Promise.resolve();
    if (this.stopped || queue.paused || queue.entries[0]?.status !== "queued" || queue.entries.some(entry => entry.edit || inFlight(entry) || entry.status === "uncertain")) return Promise.resolve();
    this.running.add(key);
    const starting = this.prepareDispatch(queue.workspaceId, queue.sessionId).then(prepared => {
      if (!prepared) { this.running.delete(key); return; }
      void this.runDelivery(queue.workspaceId, queue.sessionId, prepared.item.id)
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
      if (queue.paused || !first || first.status !== "queued" || queue.entries.some(entry => entry.edit || inFlight(entry) || entry.status === "uncertain")) return;
      first.status = "sending"; first.dispatchRevision = queue.revision; item = structuredClone(first); dispatchRevision = queue.revision;
    });
    if (!item || this.stopped) return;
    return { item, revision: dispatchRevision };
  }
  private async runDelivery(workspaceId: string, sessionId: string, id: string) {
    const key = JSON.stringify([workspaceId, sessionId, id]);
    const previous = this.deliveries.get(key);
    const delivery = this.snapshot(workspaceId, sessionId).entries.find(item => item.id === id)?.delivery;
    if (previous && previous.delivery === delivery) return previous.operation;
    const operation = (async () => {
      await previous?.operation.catch(() => {});
      if (this.stopped) return;
      const entry = this.snapshot(workspaceId, sessionId).entries.find(item => item.id === id);
      if (!entry || !(entry.status === "sending" || entry.status === "uncertain" && entry.delivery === "steer")) return;
      await this.deliver(workspaceId, sessionId, entry, entry.dispatchRevision ?? 0);
    })();
    this.deliveries.set(key, { delivery, operation });
    try { await operation; }
    finally { if (this.deliveries.get(key)?.operation === operation) this.deliveries.delete(key); }
  }
  private async deliver(workspaceId: string, sessionId: string, sent: QueueEntry, dispatchRevision: number) {
    try {
      const result = await this.transport.send(workspaceId, sessionId, sent);
      if (this.stopped) return;
      await this.change(workspaceId, sessionId, queue => {
        if (queue.entries.find(entry => entry.id === sent.id)?.delivery !== sent.delivery) return;
        if (result && "accepted" in result) {
          const accepted = queue.entries.find(entry => entry.id === sent.id);
          if (accepted) { accepted.status = "accepted"; delete accepted.error; }
          return;
        }
        queue.entries = queue.entries.filter(entry => entry.id !== sent.id);
        queue.completedIds = [...queue.completedIds, sent.id].slice(-500);
        if (!queue.paused && sent.delivery !== "steer" && result?.pause && (queue.resumeRevision ?? 0) <= dispatchRevision) {
          queue.paused = true; queue.pauseReason = result.reason ?? "error";
        }
      });
    } catch (error) {
      if (this.stopped || this.removed.has(keyOf(workspaceId, sessionId))) return;
      const confirmed = !(error instanceof QueuePreparationError) &&
        await this.transport.confirmed?.(workspaceId, sessionId, sent).catch(() => false);
      if (this.stopped) return;
      await this.change(workspaceId, sessionId, queue => {
        if (queue.entries.find(entry => entry.id === sent.id)?.delivery !== sent.delivery) return;
        if (confirmed) {
          if (this.transport.settled) {
            const accepted = queue.entries.find(entry => entry.id === sent.id);
            if (accepted) { accepted.status = "accepted"; delete accepted.error; }
          } else {
            queue.entries = queue.entries.filter(entry => entry.id !== sent.id);
            queue.completedIds = [...queue.completedIds, sent.id].slice(-500);
          }
          return;
        }
        const entry = queue.entries.find(entry => entry.id === sent.id);
        if (entry) {
          entry.status = error instanceof QueuePreparationError || isNativeDeliveryRejected(error) ? "failed" : "uncertain";
          entry.error = error instanceof Error ? error.message : "Message delivery failed.";
        }
        if (sent.delivery !== "steer") { queue.paused = true; queue.pauseReason = "error"; }
      });
    }
  }
  async removeSession(workspaceId: string, sessionId: string) {
    await this.ready;
    const key = keyOf(workspaceId, sessionId);
    this.removed.add(key);
    await this.writes.get(key)?.catch(() => {});
    this.states.delete(key); this.pending.delete(key);
    for (const listener of this.changes.get(key) ?? []) listener();
    const name = createHash("sha256").update(key).digest("hex") + ".json";
    await rm(join(this.directory, name), { force: true });
  }
  stop() { this.stopped = true; clearInterval(this.timer); for (const listeners of this.changes.values()) for (const listener of listeners) listener(); }
}

const queues = new WeakMap<ServerConfig, SessionMessageQueue>();
export function registeredMessageQueue(config: ServerConfig) { return queues.get(config); }
export function registerMessageQueue(config: ServerConfig, transport: QueueTransport) {
  const directory = join(dirname(config.configPath || process.env.LEGALWORK_RUNTIME_DB || join(homedir(), ".config/legalwork/config.json")), "message-queues");
  const queue = new SessionMessageQueue(directory, transport, () => announceSyncChange(config, "queues")); queues.set(config, queue); return queue;
}
export function stopMessageQueue(config: ServerConfig) { queues.get(config)?.stop(); queues.delete(config); }
