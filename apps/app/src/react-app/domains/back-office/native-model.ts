import {
  z,
  BackOfficeStoredRecordSchema,
  type BackOfficeField,
  type BackOfficeObject,
} from "@legalwork/types/back-office";
import { t } from "@/i18n";
import { TASK_PRIORITIES, TASK_STATUSES, taskPriorityLabel, taskStatusLabel } from "../tasks/task-format";

export type NativeKind = "task" | "deadline";
export const nativeKind = (id: string): NativeKind | undefined =>
  id === "@tasks" ? "task" : id === "@deadlines" ? "deadline" : undefined;
export const allRecordsTarget = "@directory";
export const nativeResponse = z.object({
  records: z.array(
    z.object({
      sourceId: z.string(),
      workspaceId: z.string(),
      calculated: z.boolean(),
      record: BackOfficeStoredRecordSchema.extend({
        id: z.string(),
        objectId: z.string(),
        ownerId: z.string(),
        values: z.record(z.string(), z.union([z.string(), z.array(z.string()), z.null()])),
      }),
    }),
  ),
  members: z.array(z.object({ id: z.string(), label: z.string() })),
  projects: z.array(z.object({ id: z.string(), name: z.string() })),
  workspaceId: z.string().nullable(),
});
export type NativeRow = z.infer<typeof nativeResponse>["records"][number];
export function choices(kind: NativeKind) {
  return {
    status:
      kind === "task"
        ? TASK_STATUSES.map((id) => [id, taskStatusLabel(id)] as const)
        : [
            ["active", t("calendar.active")],
            ["completed", t("calendar.completed")],
            ["cancelled", t("calendar.cancelled")],
          ],
    priority: TASK_PRIORITIES.map((id) => [String(id), taskPriorityLabel(id)] as const),
  };
}
export function nativeModel(kind: NativeKind): BackOfficeObject {
  const options = choices(kind);
  const field = (
    id: string,
    label: string,
    type: BackOfficeField["type"],
    props: Partial<BackOfficeField> = {},
  ): BackOfficeField => ({
    id,
    label,
    type,
    protected: true,
    visibility: "normal",
    required: false,
    multiple: false,
    options: [],
    ...props,
  });
  const task = kind === "task";
  return {
    id: task ? "@tasks" : "@deadlines",
    label: t(task ? "tasks.column_title" : "calendar.deadline"),
    plural: t(task ? "tasks.title" : "native.deadlines"),
    icon: kind,
    protected: true,
    archived: false,
    description: "",
    fields: [
      field("name", t("native.title"), "text", { required: true }),
      field("status", t("calendar.status"), "select", {
        options: options.status.map((pair) => pair[1]),
        required: true,
      }),
      ...(task
        ? [
            field("priority", t("native.priority"), "select", {
              options: options.priority.map((pair) => pair[1]),
              required: true,
            }),
          ]
        : []),
      field("due", t("native.due"), "datetime", { required: !task }),
      field("assignee", t("tasks.column_assignee"), "relation", { target: "@member" }),
      field("linked", t("native.linked"), "relation", { target: allRecordsTarget, multiple: true }),
      ...(task
        ? [field("tags", t("native.tags"), "multiselect")]
        : [
            field("zone", t("calendar.timezone"), "text", { required: true }),
            field("reminders", t("native.reminders"), "multiselect"),
          ]),
      field("description", t("native.description"), "text"),
    ],
  };
}
export function stringIds(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((id): id is string => typeof id === "string") : [];
}
