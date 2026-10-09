import { randomBytes } from "node:crypto";
import { z } from "zod";
import { Store, UserId, type Worker } from "./store.js";

const Status = z.object({ enabled: z.boolean(), status: z.object({
  canExecute: z.boolean(), role: z.enum(["files", "executor"]), nextRunAt: z.string().nullable(),
}).optional() });

export interface Runtime {
  create(worker: Worker): Promise<string>;
  connect(id: string): Promise<void>;
  request(worker: Worker, path: string, init?: RequestInit): Promise<Response>;
  pause(id: string): Promise<void>;
  extend(id: string): Promise<void>;
}

export class Lifecycle {
  private locks = new Map<string, Promise<unknown>>();
  private active = new Map<string, number>();
  constructor(readonly store: Store, readonly runtime: Runtime, readonly template: string, readonly idleMs = 600_000) {}

  private async locked<T>(userId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(userId) ?? Promise.resolve();
    const next = previous.catch(() => {}).then(run);
    this.locks.set(userId, next);
    try { return await next; }
    finally { if (this.locks.get(userId) === next) this.locks.delete(userId); }
  }

  async provision(userId: string): Promise<Worker> {
    UserId.parse(userId);
    return this.locked(userId, async () => {
      if (this.store.get(userId)) throw new Error("Worker already provisioned");
      const worker: Worker = {
        userId, sandboxId: null, template: this.template, synced: false, state: "starting",
        clientToken: randomBytes(32).toString("hex"), hostToken: randomBytes(32).toString("hex"),
        lastUsedAt: Date.now(), nextRunAt: null,
      };
      this.store.save(worker);
      try {
        worker.sandboxId = await this.runtime.create(worker);
        this.store.save(worker);
        await this.ready(worker);
        worker.state = "running";
        this.store.save(worker);
        return worker;
      } catch (error) {
        worker.state = "failed";
        this.store.save(worker);
        throw error;
      }
    });
  }

  private async ready(worker: Worker): Promise<void> {
    const health = await this.runtime.request(worker, "/health");
    if (!health.ok) throw new Error("Worker health check failed");
    const response = await this.runtime.request(worker, "/cloud-sync/status", {
      headers: { Authorization: `Bearer ${worker.clientToken}` },
    });
    if (!response.ok) throw new Error("Worker sync status unavailable");
    const status = Status.parse(await response.json());
    if (worker.synced) {
      if (!status.enabled) throw new Error("Configured sync is disabled");
      const resumed = await this.runtime.request(worker, "/cloud-sync/resume", {
        method: "POST", headers: { "x-legalwork-host-token": worker.hostToken },
      });
      if (!resumed.ok) throw new Error("Worker ownership/resume check failed; routing blocked");
      const check = await this.runtime.request(worker, "/cloud-sync/status", { headers: { Authorization: `Bearer ${worker.clientToken}` } });
      const current = check.ok ? Status.parse(await check.json()).status : undefined;
      if (!current?.canExecute || current.role !== "executor") throw new Error("Worker execution is not ready");
    } else if (status.enabled) {
      // Activating sync is explicit; never adopt a newly enabled worker while
      // its ownership/readiness is unchecked.
      throw new Error("Sync configuration changed; activate it through the controller");
    }
    worker.nextRunAt = status.status?.nextRunAt ?? null;
  }

  private async wakeLocked(worker: Worker): Promise<Worker> {
    if (!worker.sandboxId || worker.state === "failed" || worker.state === "starting") throw new Error("Worker needs operator recovery");
    try {
      await this.runtime.connect(worker.sandboxId);
      await this.ready(worker);
      worker.state = "running";
      worker.lastUsedAt = Date.now();
      this.store.save(worker);
      return worker;
    } catch (error) {
      worker.state = "failed";
      this.store.save(worker);
      throw error;
    }
  }

  async wake(userId: string): Promise<Worker> {
    return this.locked(userId, async () => {
      const worker = this.store.get(userId);
      if (!worker) throw new Error("Unknown worker");
      return this.wakeLocked(worker);
    });
  }

  async activate(userId: string): Promise<void> {
    await this.locked(userId, async () => {
      const worker = this.store.get(userId);
      if (!worker?.sandboxId) throw new Error("Unknown worker");
      await this.runtime.connect(worker.sandboxId);
      worker.synced = true;
      // Persist the fail-closed transition before checking a newly configured
      // replica. Credentials/sync profiles are provisioned separately.
      worker.state = "failed";
      this.store.save(worker);
      await this.ready(worker);
      worker.state = "running";
      worker.lastUsedAt = Date.now();
      this.store.save(worker);
    });
  }

  async pause(userId: string): Promise<void> {
    await this.locked(userId, async () => {
      const worker = this.store.get(userId);
      if (!worker?.sandboxId || worker.state !== "running") return;
      if ((this.active.get(userId) ?? 0) > 0) throw new Error("Worker has active requests");
      await this.runtime.connect(worker.sandboxId);
      let checkpointed = false;
      if (worker.synced) {
        const response = await this.runtime.request(worker, "/cloud-sync/checkpoint", {
          method: "POST", headers: { "x-legalwork-host-token": worker.hostToken },
        });
        if (!response.ok) throw new Error("Worker is busy or checkpoint failed");
        checkpointed = true;
      }
      try {
        // Capture scheduling while the checkpoint's execution barrier is held.
        const response = await this.runtime.request(worker, "/cloud-sync/status", { headers: { Authorization: `Bearer ${worker.clientToken}` } });
        if (!response.ok) throw new Error("Worker schedule unavailable");
        worker.nextRunAt = Status.parse(await response.json()).status?.nextRunAt ?? null;
        await this.runtime.pause(worker.sandboxId);
        worker.state = "paused";
        this.store.save(worker);
      } catch (error) {
        if (checkpointed) {
          const response = await this.runtime.request(worker, "/cloud-sync/resume", {
            method: "POST", headers: { "x-legalwork-host-token": worker.hostToken },
          });
          if (!response.ok) { worker.state = "failed"; this.store.save(worker); }
        }
        throw error;
      }
    });
  }

  // The release function lives as long as the streamed response. An open SSE
  // stream must prevent pause just as an ordinary request does.
  async acquire(userId: string): Promise<{ worker: Worker; release: () => void }> {
    return this.locked(userId, async () => {
      const found = this.store.get(userId);
      if (!found) throw new Error("Unknown worker");
      const worker = await this.wakeLocked(found);
      this.active.set(userId, (this.active.get(userId) ?? 0) + 1);
      let released = false;
      return { worker, release: () => {
        if (released) return;
        released = true;
        this.active.set(userId, (this.active.get(userId) ?? 1) - 1);
        const latest = this.store.get(userId);
        if (latest) { latest.lastUsedAt = Date.now(); this.store.save(latest); }
      } };
    });
  }

  async tick(): Promise<void> {
    for (const worker of this.store.all()) {
      try {
        const due = worker.nextRunAt ? Date.parse(worker.nextRunAt) <= Date.now() + 30_000 : false;
        if (worker.state === "paused" && due) await this.wake(worker.userId);
        else if (worker.state === "running" && worker.sandboxId) {
          // SDK connect may resume a sandbox. Serialize renewal with pause and
          // re-read state so a stale scheduler row cannot wake a paused VM.
          await this.locked(worker.userId, async () => {
            const current = this.store.get(worker.userId);
            if (current?.state === "running" && current.sandboxId) await this.runtime.extend(current.sandboxId);
          });
          if (!due && Date.now() - worker.lastUsedAt > this.idleMs) await this.pause(worker.userId);
        }
      } catch { /* Retry busy checkpoints next tick; failed ownership stays blocked. */ }
    }
  }
}
