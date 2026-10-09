import type { CalendarItem, CalendarOccurrence } from "@legalwork/types/calendar";
import { ApiError } from "../errors.js";
import type { ServerConfig, WorkspaceInfo } from "../types.js";
import { taskStore } from "../task-store.js";
import { projectSyncStore } from "../project-sync-store.js";
import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { connectedTaskOrgId } from "../tasks-api.js";
import { calendarStore } from "./store.js";
import { addDays, dayInZone } from "./dates.js";
import { reminderInstant } from "./reminder-dates.js";
import { occurrences, exportCalendar, itemCalendar } from "./ical.js";

export async function calendarVisible(config: ServerConfig, workspace: WorkspaceInfo) {
  const link = (await projectSyncStore(config)).linkByWorkspace(workspace.id);
  if (!link || link.role === "owner") return true;
  const connection = await readEigenweltConnection(config);
  return connectedTaskOrgId(connection) === link.orgId && link.state === "active" && link.settings.scope.calendar !== false;
}
export async function calendarOccurrences(config: ServerConfig, workspace: WorkspaceInfo, from: string, to: string): Promise<CalendarOccurrence[]> {
  if (to <= from || to > addDays(from, 366)) throw new ApiError(400, "calendar_range", "Choose a date range of at most one year.");
  if (!(await calendarVisible(config, workspace))) return [];
  const store = await calendarStore(config), name = workspace.name || workspace.id;
  const result = store.list(workspace.id).flatMap(item => occurrences(item, name, from, to));
  const tasks = await datedTasks(config, workspace.id);
  for (const task of tasks) {
    if (!task.dueDate || task.deletedAt || task.status === "cancelled") continue;
    const allDay = task.dueDate.length === 10, day = allDay ? task.dueDate : dayInZone(task.dueDate, "Europe/Berlin");
    if (day < from || day >= to) continue;
    result.push({ id: `task:${task.id}`, itemId: task.id, uid: `task-${task.id}@legalwork`, projectId: workspace.id, projectName: name,
      kind: "task", title: task.title, start: task.dueDate, end: null, allDay, timeZone: "Europe/Berlin", status: task.status,
      assigneeUserId: task.assigneeUserId, provenance: null, verified: true, recurring: false });
  }
  return result.sort((a, b) => a.start.localeCompare(b.start));
}
export async function datedTasks(config: ServerConfig, projectId?: string) {
  if (projectId) {
    const link = (await projectSyncStore(config)).linkByWorkspace(projectId);
    if (link?.role === "member" && (link.state !== "active" || !link.settings.scope.tasks)) return [];
  }
  const connection = await readEigenweltConnection(config), orgId = connectedTaskOrgId(connection), store = await taskStore(config);
  const tasks = []; let cursor: string | undefined;
  do { const page = store.listTasks({ projectId, limit: 200, cursor }, orgId); tasks.push(...page.tasks); cursor = page.nextCursor ?? undefined; } while (cursor);
  return tasks;
}
export async function calendarExportItems(config: ServerConfig, workspace?: WorkspaceInfo, privateTasksOnly = false) {
  if (workspace && !(await calendarVisible(config, workspace))) return [];
  const items = workspace ? (await calendarStore(config)).list(workspace.id) : [];
  for (const task of await datedTasks(config, workspace?.id)) {
    if (!workspace && task.projectId) continue;
    if (privateTasksOnly && task.sync.orgId !== null) continue;
    if (!task.dueDate || task.status === "cancelled") continue;
    const item: CalendarItem = { id: task.id, uid: `task-${task.id}@legalwork`, projectId: workspace?.id ?? "inbox", title: task.title, description: task.description,
      kind: "deadline", start: task.dueDate, end: null, timeZone: "Europe/Berlin", status: task.status === "done" ? "completed" : "active", verified: true,
      assigneeUserId: task.assigneeUserId, taskIds: [], attachmentPaths: [], sessionIds: [], reminders: [], provenance: { kind: "manual", source: "Task due date", reason: "" },
      revision: 0, createdAt: task.createdAt, updatedAt: task.updatedAt, deletedAt: null, ical: "" };
    item.ical = itemCalendar(item); items.push(item);
  }
  return items;
}
export async function calendarExport(config: ServerConfig, workspace: WorkspaceInfo, profile: "native" | "calendar") {
  return exportCalendar(await calendarExportItems(config, workspace), profile);
}
/** Catch up on reminders missed while the local runtime was closed. Idempotent per occurrence. */
export async function collectCalendarReminders(config: ServerConfig, now = Date.now()) {
  const store = await calendarStore(config), today = new Date(now).toISOString().slice(0, 10);
  for (const workspace of config.workspaces) {
    if (workspace.workspaceType === "remote" || !(await calendarVisible(config, workspace))) continue;
    for (const item of store.list(workspace.id)) {
      if (item.status !== "active") continue;
      for (const occurrence of occurrences(item, workspace.name || workspace.id, addDays(today, -30), addDays(today, 366))) {
        const instant = Date.parse(reminderInstant(occurrence.start, occurrence.timeZone, occurrence.recurring, item.provenance.kind === "calculated" ? item.provenance.calculation : undefined));
        for (const minutes of item.reminders) {
          const at = instant - minutes * 60000;
          if (at > now || at < now - 30 * 86400000) continue;
          const key = `${occurrence.id}:${minutes}:${occurrence.start}`;
          store.enqueueReminder(key, { id: key, itemId: item.id, projectId: workspace.id, title: item.title, deadline: occurrence.start, kind: item.kind, dueAt: new Date(at).toISOString() });
        }
      }
    }
  }
}
