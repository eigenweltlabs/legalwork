import type { ScheduledTask } from "@legalwork/types/scheduled-tasks";
import type { ScheduledTaskStore } from "./store.js";

export type ScheduledExecutor = {
  available: (task: ScheduledTask) => Promise<boolean>;
  createSession: (task: ScheduledTask) => Promise<string>;
  send: (task: ScheduledTask, sessionId: string) => Promise<void>;
};

export class ScheduledTaskRunner {
  private ticking = false;
  private stopped = false;
  constructor(private store: ScheduledTaskStore, private executor: ScheduledExecutor, private now = Date.now) {}
  async tick() {
    if (this.ticking || this.stopped) return;
    this.ticking = true;
    try {
      for (const task of this.store.list()) {
        if (this.stopped) break;
        if (task.status !== "active" || !task.nextRunAt || Date.parse(task.nextRunAt) > this.now()) continue;
        // Busy or offline sessions retain their pending occurrence. Missed repeats coalesce to one run.
        let available: boolean;
        try { available = await this.executor.available(task); } catch { continue; }
        if (!available || this.stopped) continue;
        const run = this.store.claim(task, this.now());
        if (!run) continue;
        try {
          run.sessionId = task.sessionId ?? await this.executor.createSession(task);
          this.store.record(run);
          // Creating a chat is asynchronous. Honor a pause, deletion or edit
          // that happened after the claim but before delivery began.
          const current = this.store.get(task.workspaceId, task.id);
          if (current.revision !== task.revision + 1 || current.status === "paused") throw new Error("The task changed before delivery. No message was sent.");
          await this.executor.send(task, run.sessionId);
          this.store.record({ ...run, status: "sent" });
        } catch (error) { this.store.fail(task, run, error); }
      }
    } finally { this.ticking = false; }
  }
  start() {
    const tick = () => { void this.tick().catch(error => console.warn("[scheduled-tasks]", error)); };
    const timer = setInterval(tick, 15000);
    timer.unref(); tick();
    return () => { this.stopped = true; clearInterval(timer); };
  }
}
