import { z } from "zod";
import { ApiError } from "../errors.js";
import { readEigenweltConnection } from "../eigenwelt-connection-store.js";
import { parseTaskCreate, parseTaskPatch, taskActorOf } from "../tasks-api.js";
import { scheduleTaskSync } from "../task-sync.js";
import { scheduleProjectSync } from "../project-sync.js";
import { announceSyncChange } from "../app-sync-events.js";
import type { ServerConfig } from "../types.js";
import { nativeSources } from "./native-links.js";
import type { BackOfficeActor } from "./schema.js";
import type { BackOfficeStore } from "./store.js";
import { backOfficeDirectoryIdentity } from "./access.js";
import { CalendarPatchSchema } from "../calendar/schema.js";

const scalar = z.union([z.string(), z.array(z.string()), z.null()]);
const mutation = z.object({
  action: z.enum(["create", "edit", "archive", "restore"]),
  id: z.uuid(),
  workspaceId: z.string(),
  directoryId: z.string(),
  userId: z.string(),
  fields: z.record(z.string(), scalar).default({}),
  expected: z.record(z.string(), scalar).default({}),
  reason: z.string().trim().optional(),
});
const taskFields: Record<string, string> = {
  name: "title",
  description: "description",
  due: "dueDate",
  status: "status",
  priority: "priority",
  assignee: "assigneeUserId",
  tags: "tags",
};
const calendarFields: Record<string, string> = {
  name: "title",
  description: "description",
  due: "start",
  zone: "timeZone",
  status: "status",
  assignee: "assigneeUserId",
  reminders: "reminders",
};
function patchFor(fields: z.infer<typeof mutation>["fields"], mapping: Record<string, string>) {
  const patch: Record<string, unknown> = {};
  for (const [id, value] of Object.entries(fields)) {
    if (!Object.hasOwn(mapping, id)) throw new ApiError(400, "native_field", "This field is read-only.");
    patch[mapping[id]] =
      id === "priority"
        ? z.enum(["0", "1", "2", "3", "4"]).transform(Number).parse(value)
        : id === "reminders"
          ? z.array(z.string().regex(/^\d+$/).transform(Number)).parse(value ?? [])
          : id === "tags"
            ? (value ?? [])
            : id === "description"
              ? (value ?? "")
              : value;
  }
  return patch;
}
function unchanged(current: object, fields: Record<string, unknown>) {
  return Object.entries(fields).every(
    ([key, value]) => JSON.stringify(Reflect.get(current, key)) === JSON.stringify(value),
  );
}
function checkFields(current: object, next: Record<string, unknown>, expected: Record<string, unknown>) {
  for (const field of Object.keys(next))
    if (Object.hasOwn(expected, field)) {
      const value: unknown = Reflect.get(current, field);
      if (
        JSON.stringify(value) !== JSON.stringify(expected[field]) &&
        JSON.stringify(value) !== JSON.stringify(next[field])
      )
        throw new ApiError(409, "native_field_conflict", "Two edits changed this field.", { field, value });
    }
}
export async function writeNative(
  config: ServerConfig,
  store: BackOfficeStore,
  scope: string,
  actor: BackOfficeActor,
  kind: "task" | "deadline",
  raw: unknown,
) {
  const input = mutation.parse(raw),
    sources = await nativeSources(config);
  const connection = await readEigenweltConnection(config);
  if (
    input.directoryId !== (await backOfficeDirectoryIdentity(config, scope, store)) ||
    input.userId !== actor.userId
  )
    throw new ApiError(409, "native_account", "The account changed.");
  store.requireAccount(scope, actor);
  const unavailable = () => new ApiError(404, "native_missing", "This record is unavailable.");
  if (kind === "task") {
    const author = taskActorOf(connection);
    if (input.action === "create") {
      if (input.workspaceId && !sources.taskVisible({ projectId: input.workspaceId, sync: { orgId: null } }))
        throw unavailable();
      const previous = sources.tasks.getTask(input.id);
      if (
        previous &&
        (!sources.taskVisible(previous) ||
          previous.deletedAt ||
          previous.createdByUserId !== author.userId ||
          (previous.projectId ?? "") !== input.workspaceId ||
          previous.title !== input.fields.name)
      )
        throw unavailable();
      const fields = patchFor(input.fields, taskFields);
      const status =
        fields.status === undefined ? undefined : parseTaskPatch({ status: fields.status }).status;
      const created = sources.tasks.createTask(
        parseTaskCreate({ ...fields, id: input.id, projectId: input.workspaceId || null }),
        author,
      );
      if (!previous && status && status !== created.status)
        sources.tasks.patchTask(created.id, { status }, author);
    } else {
      const current = sources.tasks.getTask(input.id);
      if (!current || !sources.taskVisible(current) || (current.projectId ?? "") !== input.workspaceId)
        throw unavailable();
      if (input.action === "archive") sources.tasks.deleteTask(input.id);
      if (input.action === "restore") sources.tasks.restoreTask(input.id);
      if (input.action === "edit") {
        if (current.deletedAt) throw unavailable();
        const patch = patchFor(input.fields, taskFields);
        checkFields(current, patch, patchFor(input.expected, taskFields));
        if (!unchanged(current, patch)) sources.tasks.patchTask(input.id, parseTaskPatch(patch), author);
      }
    }
    announceSyncChange(config, "tasks");
    scheduleTaskSync(config);
    return { id: input.id };
  }
  if (!sources.calendarProjects.some((w) => w.id === input.workspaceId)) throw unavailable();
  let id = input.id;
  if (input.action === "create") {
    const fields = patchFor(input.fields, calendarFields);
    const status = CalendarPatchSchema.shape.status.parse(fields.status);
    const item = sources.calendars.create(
      input.workspaceId,
      { ...fields, kind: "deadline" },
      undefined,
      undefined,
      input.id,
    );
    if (status && status !== item.status)
      sources.calendars.patch(input.workspaceId, item.id, { status, revision: item.revision });
    id = item.id;
  } else {
    const current = sources.calendars.get(input.workspaceId, id);
    if (current.kind !== "deadline") throw unavailable();
    if (input.action === "edit") {
      const patch = patchFor(input.fields, calendarFields);
      checkFields(current, patch, patchFor(input.expected, calendarFields));
      if (!unchanged(current, patch))
        sources.calendars.patch(
          input.workspaceId,
          id,
          CalendarPatchSchema.parse({ ...patch, revision: current.revision, reason: input.reason }),
        );
    } else sources.calendars.remove(input.workspaceId, id, current.revision, input.action === "restore");
  }
  announceSyncChange(config, "projects");
  scheduleProjectSync(config);
  return { id };
}
