import { z } from "zod";
import { CalendarItemSchema } from "./schema.js";
import type { ServerConfig } from "../types.js";
import type { ProjectLink } from "../project-sync-store.js";
import { intakeRequest, type IntakeClient } from "../eigenwelt-intake.js";
import { calendarStore } from "./store.js";

export async function syncProjectCalendar(config: ServerConfig, client: IntakeClient, link: ProjectLink) {
  const store = await calendarStore(config);
  if (link.settings.scope.calendar === false) { store.withdraw(link.workspaceId, link.role === "owner"); return; }
  const path = `/api/projects/${encodeURIComponent(link.projectId)}/calendar`;
  const pending = store.pending(link.workspaceId);
  for (let offset = 0; offset < pending.length; offset += 100) {
    const batch = pending.slice(offset, offset + 100);
    const response = z.object({ items: z.array(CalendarItemSchema), conflicts: z.array(CalendarItemSchema) }).parse(await intakeRequest(client, "POST", path, {
      items: batch.map(entry => ({ baseRevision: entry.baseRevision, data: { ...entry.data, projectId: link.projectId, sessionIds: [], taskIds: link.settings.scope.tasks ? entry.data.taskIds : [] } })),
    }));
    for (const item of response.items) {
      const sent = batch.find(entry => entry.data.id === item.id);
      store.receive(link.workspaceId, item, sent?.data.revision);
    }
    for (const item of response.conflicts) store.receive(link.workspaceId, item);
  }
  const page = z.object({ items: z.array(CalendarItemSchema) }).parse(await intakeRequest(client, "GET", path));
  for (const item of page.items) store.receive(link.workspaceId, item);
}
