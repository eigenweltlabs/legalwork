/**
 * Task announcements: what the app shows for the task notifications the
 * server hands out (legalwork-server `claimTaskNotifications`).
 *
 * A claim is filtered by the user's settings and grouped by kind. Each kind
 * becomes one entry in the notification center, which gathers further tasks
 * of that kind until it is read ("3 tasks are overdue"), and, for the tasks
 * of this claim only, one toast while the window is in front or one system
 * notification while it is not (shell/task-notifications-listener.tsx).
 */
import type {
  LegalworkTaskAudience,
  LegalworkTaskNotification,
  LegalworkTaskNotificationKind,
} from "@/app/lib/legalwork-server";
import { t } from "@/i18n";
import type {
  AppNotification,
  NotificationInput,
  NotificationTaskRef,
} from "@/react-app/kernel/notification-store";

import { taskDueTone } from "./task-format";
import type { TaskNotificationPreferences, TaskNotificationScope } from "./task-notification-preferences";

/** The kinds in the order a batch shows them: what is the user's first. */
const KIND_ORDER: LegalworkTaskNotificationKind[] = ["assigned", "new", "overdue", "due_today"];

/** How many tasks a center entry remembers by name; its count goes on past that. */
const MAX_ENTRY_TASKS = 100;
/** How many titles an announcement names before "and N more". */
const NAMED_TITLES = 2;

export type TaskAnnouncementTask = NotificationTaskRef & { dueDate: string | null };

export type TaskAnnouncement = {
  kind: LegalworkTaskNotificationKind;
  tasks: TaskAnnouncementTask[];
};

function isArrival(kind: LegalworkTaskNotificationKind): boolean {
  return kind === "new" || kind === "assigned";
}

function kindWanted(kind: LegalworkTaskNotificationKind, preferences: TaskNotificationPreferences): boolean {
  switch (kind) {
    case "new":
    case "assigned":
      return preferences.arrivals;
    case "due_today":
      return preferences.dueToday;
    case "overdue":
      return preferences.overdue;
  }
}

function audienceWanted(audience: LegalworkTaskAudience, scope: TaskNotificationScope): boolean {
  switch (scope) {
    case "mine":
      return audience === "mine";
    case "unassigned":
      return audience !== "others";
    case "all":
      return true;
  }
}

/**
 * What of a claim the user wants to hear, by kind. A task announced as
 * arriving is not announced again for its due day in the same claim: the
 * arrival says it ("… · overdue").
 */
export function selectTaskAnnouncements(
  notifications: readonly LegalworkTaskNotification[],
  preferences: TaskNotificationPreferences,
): TaskAnnouncement[] {
  const wanted = notifications.filter(
    (notification) =>
      kindWanted(notification.kind, preferences) && audienceWanted(notification.audience, preferences.scope),
  );
  const arrived = new Set(wanted.filter((notification) => isArrival(notification.kind)).map((notification) => notification.taskId));
  const byKind = new Map<LegalworkTaskNotificationKind, TaskAnnouncementTask[]>();
  for (const notification of wanted) {
    if (!isArrival(notification.kind) && arrived.has(notification.taskId)) continue;
    const tasks = byKind.get(notification.kind) ?? [];
    if (!tasks.some((task) => task.id === notification.taskId)) {
      tasks.push({ id: notification.taskId, title: notification.title, dueDate: notification.dueDate });
    }
    byKind.set(notification.kind, tasks);
  }
  return KIND_ORDER.flatMap((kind) => {
    const tasks = byKind.get(kind);
    return tasks && tasks.length > 0 ? [{ kind, tasks }] : [];
  });
}

/** The center entry a kind gathers in until it is read. */
export function taskNotificationDedupeKey(kind: LegalworkTaskNotificationKind): string {
  return `tasks:${kind}`;
}

function headline(kind: LegalworkTaskNotificationKind, count: number): string {
  switch (kind) {
    case "new":
      return t("tasks.notify_new", { count });
    case "assigned":
      return t("tasks.notify_assigned", { count });
    case "due_today":
      return t("tasks.notify_due_today", { count });
    case "overdue":
      return t("tasks.notify_overdue", { count });
  }
}

/** One task's line: its title, and for an arrival whether it is already due. */
function taskLine(kind: LegalworkTaskNotificationKind, task: NotificationTaskRef & { dueDate?: string | null }): string {
  if (!isArrival(kind)) return task.title;
  const tone = taskDueTone(task.dueDate ?? null);
  if (tone === "today") return t("tasks.notify_title_due_today", { title: task.title });
  if (tone === "overdue") return t("tasks.notify_title_overdue", { title: task.title });
  return task.title;
}

/** "A", "A, B", or "A, B and 3 more". */
function describeTasks(
  kind: LegalworkTaskNotificationKind,
  tasks: ReadonlyArray<NotificationTaskRef & { dueDate?: string | null }>,
  total: number,
): string {
  const first = tasks[0];
  if (total === 1 && first) return taskLine(kind, first);
  const named = tasks.slice(0, NAMED_TITLES).map((task) => task.title).join(", ");
  const rest = total - Math.min(tasks.length, NAMED_TITLES);
  return rest > 0 ? t("tasks.notify_titles_more", { titles: named, count: rest }) : named;
}

/** Title and text of an announcement: a toast, or a system notification. */
export function taskAnnouncementText(announcement: TaskAnnouncement): { title: string; body: string } {
  const total = announcement.tasks.length;
  return { title: headline(announcement.kind, total), body: describeTasks(announcement.kind, announcement.tasks, total) };
}

/** What a click on an announcement opens: the one task, or (null) the task list. */
export function taskAnnouncementTarget(tasks: readonly NotificationTaskRef[]): string | null {
  return tasks.length === 1 ? (tasks[0]?.id ?? null) : null;
}

/** The label of the button that opens it. */
export function taskAnnouncementActionLabel(total: number): string {
  return total === 1 ? t("tasks.notify_open_task") : t("tasks.notify_show_tasks");
}

/**
 * The center entry for an announcement, gathered into the unread entry of its
 * kind when there is one: the newest tasks first, each task once.
 */
export function taskCenterEntry(announcement: TaskAnnouncement, unread?: AppNotification): NotificationInput {
  const previous = unread?.action?.type === "open-tasks" ? unread.action : null;
  const known = new Set(previous?.tasks.map((task) => task.id) ?? []);
  const added = announcement.tasks.filter((task) => !known.has(task.id));
  const tasks = [...added, ...(previous?.tasks ?? [])].slice(0, MAX_ENTRY_TASKS);
  const total = (previous?.total ?? 0) + added.length;
  return {
    kind: "tasks",
    severity: announcement.kind === "overdue" ? "warning" : "info",
    dedupeKey: taskNotificationDedupeKey(announcement.kind),
    title: headline(announcement.kind, total),
    body: describeTasks(announcement.kind, tasks, total),
    action: { type: "open-tasks", tasks: tasks.map((task) => ({ id: task.id, title: task.title })), total },
    actionLabel: taskAnnouncementActionLabel(total),
  };
}

/**
 * The id a system notification carries: what it opens is written into it, so
 * a click still finds its task after the window was reloaded.
 */
export function taskSystemNotificationId(target: string | null, nonce: string): string {
  return `tasks|${target ?? ""}|${nonce}`;
}

/** What a clicked system notification opens; undefined when it is not a task announcement. */
export function taskSystemNotificationTarget(id: string): string | null | undefined {
  const match = /^tasks\|([\w-]*)\|/.exec(id);
  if (!match) return undefined;
  return match[1] ? match[1] : null;
}
