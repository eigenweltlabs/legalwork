import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { ScheduledTaskInputSchema, ScheduledTaskSchema, ScheduledRunSchema, type ScheduledTask, type ScheduledRun } from "./schema.js";
import { openSqlite, type SqliteHandle } from "../runtime-db.js";
import { ApiError } from "../errors.js";
import { nextOccurrence } from "./schedule.js";

export class ScheduledTaskStore {
  private constructor(private db: SqliteHandle) {}
  static async open(path: string) {
    await mkdir(dirname(path), { recursive: true });
    const db = await openSqlite(path);
    db.exec(`CREATE TABLE IF NOT EXISTS scheduled_tasks (id TEXT PRIMARY KEY, workspace_id TEXT NOT NULL, data TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS scheduled_task_runs (id TEXT PRIMARY KEY, task_id TEXT NOT NULL, data TEXT NOT NULL);`);
    return new ScheduledTaskStore(db);
  }
  list(workspaceId?: string): ScheduledTask[] {
    return this.db.all("SELECT data FROM scheduled_tasks" ).map(row => ScheduledTaskSchema.parse(JSON.parse(String(row.data))))
      .filter(task => !workspaceId || task.workspaceId === workspaceId)
      .sort((a, b) => (a.nextRunAt ?? "z").localeCompare(b.nextRunAt ?? "z"));
  }
  get(workspaceId: string, id: string): ScheduledTask {
    const row = this.db.get("SELECT data FROM scheduled_tasks WHERE id = ? AND workspace_id = ?", [id, workspaceId]);
    if (!row) throw new ApiError(404, "scheduled_task_missing", "Scheduled task not found.");
    return ScheduledTaskSchema.parse(JSON.parse(String(row.data)));
  }
  create(workspaceId: string, raw: unknown, now = Date.now()) {
    const input = ScheduledTaskInputSchema.parse(raw);
    const nextRunAt = nextOccurrence(input.schedule, now);
    if (!nextRunAt) throw new ApiError(400, "schedule_expired", "Choose a schedule with a future run.");
    const task: ScheduledTask = { ...input, id: randomUUID(), workspaceId, revision: 1, status: "active", nextRunAt, createdAt: new Date(now).toISOString(), updatedAt: new Date(now).toISOString() };
    this.write(task); return task;
  }
  update(workspaceId: string, id: string, revision: number, patch: Partial<ReturnType<typeof ScheduledTaskInputSchema.parse>> & { status?: "active" | "paused" }, now = Date.now()) {
    return this.transaction(() => {
      const task = this.get(workspaceId, id);
      this.checkRevision(task, revision);
      const input = ScheduledTaskInputSchema.parse({ title: task.title, prompt: task.prompt, schedule: task.schedule, sessionId: task.sessionId, model: task.model, projectAccess: task.projectAccess, ...Object.fromEntries(Object.entries(patch).filter(([key]) => key !== "status")) });
      const changedSchedule = JSON.stringify(input.schedule) !== JSON.stringify(task.schedule);
      const status = patch.status ?? (changedSchedule ? "active" : task.status);
      const recalculate = changedSchedule || (status === "active" && task.status !== "active");
      const nextRunAt = recalculate ? nextOccurrence(input.schedule, now) : task.nextRunAt;
      if (status === "active" && !nextRunAt) throw new ApiError(400, "schedule_expired", "Choose a future time before resuming this task.");
      const result = { ...task, ...input, status, nextRunAt, revision: revision + 1, updatedAt: new Date(now).toISOString() };
      this.write(result); return result;
    });
  }
  remove(workspaceId: string, id: string, revision: number) {
    this.transaction(() => {
      this.checkRevision(this.get(workspaceId, id), revision);
      this.db.run("DELETE FROM scheduled_tasks WHERE id = ?", [id]);
      this.db.run("DELETE FROM scheduled_task_runs WHERE task_id = ?", [id]);
    });
  }
  runs(taskId: string): ScheduledRun[] {
    return this.db.all("SELECT data FROM scheduled_task_runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 50", [taskId]).map(row => ScheduledRunSchema.parse(JSON.parse(String(row.data))));
  }
  /** Advance and journal BEFORE dispatch. Another process cannot claim the same occurrence. */
  claim(snapshot: ScheduledTask, now: number): ScheduledRun | null {
    return this.transaction(() => {
      let task: ScheduledTask;
      try { task = this.get(snapshot.workspaceId, snapshot.id); } catch { return null; }
      if (task.revision !== snapshot.revision || task.status !== "active" || !task.nextRunAt || Date.parse(task.nextRunAt) > now) return null;
      const nextRunAt = nextOccurrence(task.schedule, now);
      const run: ScheduledRun = { projectAccess: task.projectAccess, id: randomUUID(), taskId: task.id, dueAt: task.nextRunAt, startedAt: new Date(now).toISOString(), sessionId: task.sessionId, status: "dispatching", error: null };
      this.write({ ...task, nextRunAt, status: nextRunAt ? "active" : "completed", revision: task.revision + 1, updatedAt: run.startedAt });
      this.db.run("INSERT INTO scheduled_task_runs (id, task_id, data) VALUES (?, ?, ?)", [run.id, run.taskId, JSON.stringify(run)]);
      this.db.run("DELETE FROM scheduled_task_runs WHERE task_id = ? AND id NOT IN (SELECT id FROM scheduled_task_runs WHERE task_id = ? ORDER BY rowid DESC LIMIT 50)", [task.id, task.id]);
      return run;
    });
  }
  record(run: ScheduledRun) {
    // UPDATE avoids resurrecting history after the user deletes a task mid-dispatch.
    this.db.run("UPDATE scheduled_task_runs SET data = ? WHERE id = ?", [JSON.stringify(run), run.id]);
  }
  fail(task: ScheduledTask, run: ScheduledRun, error: unknown) {
    this.transaction(() => {
      this.record({ ...run, status: "failed", error: error instanceof Error ? error.message : "Could not send the scheduled task." });
      const row = this.db.get("SELECT data FROM scheduled_tasks WHERE id = ?", [task.id]);
      if (!row) return;
      const current = ScheduledTaskSchema.parse(JSON.parse(String(row.data)));
      // Preserve edits made while the request was in flight.
      if (current.revision === task.revision + 1) this.write({ ...current, status: "paused", revision: current.revision + 1 });
    });
  }
  private checkRevision(task: ScheduledTask, revision: number) {
    if (task.revision !== revision) throw new ApiError(409, "scheduled_task_conflict", "This task changed. Reopen it before saving.");
  }
  private write(task: ScheduledTask) {
    this.db.run("INSERT INTO scheduled_tasks (id, workspace_id, data) VALUES (?, ?, ?) ON CONFLICT(id) DO UPDATE SET data = excluded.data", [task.id, task.workspaceId, JSON.stringify(task)]);
  }
  private transaction<T>(operation: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try { const result = operation(); this.db.exec("COMMIT"); return result; }
    catch (error) { this.db.exec("ROLLBACK"); throw error; }
  }
}
