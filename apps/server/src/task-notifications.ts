import {
  localDayKey,
  taskStore,
  taskStoreAvailable,
  type Task,
  type TaskNotificationKind,
  type TaskStore,
} from "./task-store.js";
import type { ServerConfig } from "./types.js";

/**
 * Task notifications: what the app announces about the tasks on this machine
 * while it runs. Four occasions:
 *
 * - `new`: a task arrived from the firm (pulled, not filed by the member).
 * - `assigned`: a task arrived assigned to the member, or was reassigned to them.
 * - `due_today` / `overdue`: an open task's due day has come, or has passed.
 *
 * The server only notes that something happened (task-store.ts,
 * `task_notifications`), once per task and occasion. The app claims the
 * notes, filters them by the user's settings and shows them — in its
 * notification center, and as a system notification while it is in the
 * background. Nothing is announced while the app is not running; what
 * happened meanwhile (a pull at start, a due day that passed) is announced
 * when it runs again.
 *
 * Arrivals are noted during the pull (task-sync.ts); due days by a timer
 * that checks every minute, so a day change or a wake from sleep is noticed
 * within that minute. What the member did on this machine themselves — a due
 * date set, a task reopened — is not announced (task-store.ts
 * `acknowledgeDue`), and the first pull after signing in brings the firm's
 * backlog, which is not news either.
 */

/** What a pulled task means for the signed-in member `me` (null: nobody signed in), if anything. */
export function arrivalNotification(before: Task | null, after: Task, me: string | null): "new" | "assigned" | null {
  if (after.deletedAt !== null || after.status === "done" || after.status === "cancelled") return null;
  if (before === null) {
    // Filed by the member from another device or the web: not news to them.
    if (me !== null && after.createdByUserId === me) return null;
    return me !== null && after.assigneeUserId === me ? "assigned" : "new";
  }
  if (me !== null && after.assigneeUserId === me && before.assigneeUserId !== me) return "assigned";
  return null;
}

/**
 * Note what a pull brought. An arrival is noted with the reminder its due
 * date calls for, in one go, so the app gets both in the same claim and can
 * say it once ("assigned to you · overdue").
 */
export function noteArrival(
  store: TaskStore,
  task: Task,
  kind: Extract<TaskNotificationKind, "new" | "assigned">,
  occasion: string,
  now: number = Date.now(),
): void {
  store.recordNotification(task.id, kind, occasion, now);
  store.recordDueNotifications(now, [task.id]);
}

/** How often the due days are checked while the server runs. */
const REMINDER_INTERVAL_MS = 60_000;
/** The first check, shortly after start: what came due while the app was closed. */
const FIRST_REMINDER_DELAY_MS = 5_000;

/** One check: note what is due, and once a day forget what can no longer matter. */
export async function runTaskReminders(
  config: ServerConfig,
  state: { prunedDay: string | null },
  now: number = Date.now(),
): Promise<number> {
  // No runtime DB yet, no tasks: nothing to open (or create) for a check.
  if (!taskStoreAvailable(config)) return 0;
  const store = await taskStore(config);
  const noted = store.recordDueNotifications(now);
  const today = localDayKey(now);
  if (state.prunedDay !== today) {
    store.pruneNotifications(now);
    state.prunedDay = today;
  }
  return noted;
}

/** Checks the due days in the background while the server is up. Returns the stop function. */
export function startTaskReminderTimer(config: ServerConfig, intervalMs: number = REMINDER_INTERVAL_MS): () => void {
  const state = { prunedDay: null as string | null };
  const run = () => {
    void runTaskReminders(config, state).catch(() => undefined);
  };
  const timer = setInterval(run, intervalMs);
  timer.unref?.();
  const first = setTimeout(run, FIRST_REMINDER_DELAY_MS);
  first.unref?.();
  return () => {
    clearInterval(timer);
    clearTimeout(first);
  };
}
