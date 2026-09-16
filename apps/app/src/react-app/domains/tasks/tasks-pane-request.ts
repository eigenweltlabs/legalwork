/**
 * Asking for the Tasks pane from outside it. A task notification — its
 * toast, its system notification, its entry in the notification center —
 * shows its task there, or the task list when it names several. (A chip in
 * the chat opens its task in the session's side panel instead: see
 * task-reference.ts `requestOpenTask`.)
 *
 * The session route shows the pane. From a screen without it (Settings), the
 * app first goes to the session view, so the ask is also kept for a moment
 * and taken by that route when it mounts.
 */

/** Fired on `window`; the session route opens the Tasks pane on the task (a null id: the list). */
export const TASKS_PANE_OPEN_EVENT = "legalwork:tasks-pane-open";

export type TasksPaneOpenDetail = { taskId: string | null };

/** How long an ask waits for a session route to take it. */
const PENDING_MS = 10_000;

let pending: { taskId: string | null; at: number } | null = null;

export function requestTasksPane(taskId: string | null): void {
  pending = { taskId, at: Date.now() };
  window.dispatchEvent(new CustomEvent<TasksPaneOpenDetail>(TASKS_PANE_OPEN_EVENT, { detail: { taskId } }));
}

/** The ask still waiting, if it is recent; taken once. */
export function takePendingTasksPaneRequest(now: number = Date.now()): { taskId: string | null } | null {
  const request = pending;
  pending = null;
  return request && now - request.at <= PENDING_MS ? { taskId: request.taskId } : null;
}
