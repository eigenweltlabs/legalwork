import type { ServerConfig } from "../types.js";
import type { BackOfficeActor, BackOfficeRecord } from "./schema.js";
import type { BackOfficeStore } from "./store.js";
import { nativeSources, visibleNativeLinks } from "./native-links.js";
export async function nativeRows(
  config: ServerConfig,
  store: BackOfficeStore,
  scope: string,
  actor: BackOfficeActor,
  kind: "task" | "deadline",
  archived: boolean,
  projectId: string | null,
) {
  const sources = await nativeSources(config);
  const edges = new Map<string, string[]>();
  for (const edge of visibleNativeLinks(store, { scope, actor }, sources, { kind })) {
    const key = JSON.stringify([edge.projectKey, edge.sourceId]);
    edges.set(key, [...(edges.get(key) ?? []), edge.recordId]);
  }
  const records: { sourceId: string; workspaceId: string; calculated: boolean; record: BackOfficeRecord }[] =
    [];
  function row(
    id: string,
    workspaceId: string,
    revision: number,
    createdAt: string,
    updatedAt: string,
    archivedAt: string | null,
    values: BackOfficeRecord["values"],
    calculated = false,
  ) {
    const source = JSON.stringify([kind === "task" ? "" : workspaceId, id]);
    records.push({
      sourceId: id,
      workspaceId,
      calculated,
      record: {
        id: kind + source,
        objectId: kind === "task" ? "@tasks" : "@deadlines",
        revision,
        ownerId: "",
        members: [],
        schemaRevision: 1,
        access: "org",
        createdAt,
        updatedAt,
        archivedAt,
        sourceId: undefined,
        values: { ...values, linked: edges.get(source) ?? [] },
      },
    });
  }
  if (kind === "task") {
    let cursor;
    do {
      const page = sources.tasks.listTasks(
        { limit: 200, cursor, ...(projectId ? { projectId } : {}), ...(archived ? { deleted: "only" } : {}) },
        sources.org,
      );
      for (const task of page.tasks)
        if (sources.taskVisible(task))
          row(
            task.id,
            task.projectId ?? "",
            Date.parse(task.updatedAt),
            task.createdAt,
            task.updatedAt,
            task.deletedAt,
            {
              name: task.title,
              description: task.description,
              status: task.status,
              priority: String(task.priority),
              assignee: task.assigneeUserId,
              due: task.dueDate,
              tags: task.tags,
            },
          );
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
  } else {
    for (const w of sources.calendarProjects) {
      if (projectId && projectId !== w.id) continue;
      for (const item of sources.calendars.list(w.id, archived))
        if (item.kind === "deadline" && Boolean(item.deletedAt) === archived)
          row(
            item.id,
            w.id,
            item.revision,
            item.createdAt,
            item.updatedAt,
            item.deletedAt,
            {
              name: item.title,
              description: item.description,
              status: item.status,
              due: item.start,
              zone: item.timeZone,
              assignee: item.assigneeUserId,
              reminders: item.reminders.map(String),
            },
            item.provenance.kind === "calculated",
          );
    }
  }
  return {
    records,
    members: sources.tasks
      .listMembers(sources.org)
      .map((m) => ({ id: m.userId, label: m.name || m.email || m.userId })),
    projects: sources.calendarProjects.map((w) => ({ id: w.id, name: w.displayName || w.name || w.id })),
    workspaceId: config.workspaces[0]?.id ?? null,
  };
}
