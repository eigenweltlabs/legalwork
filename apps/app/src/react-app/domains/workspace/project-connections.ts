import { t } from "@/i18n";
import { projectFieldLabel } from "./project-defaults-store";
import type { BackOfficeRecord } from "@legalwork/types/back-office";
import type { ProjectField } from "@legalwork/types/workspace";

type ReferenceField = Extract<ProjectField, { type: "backoffice" }>;
export function isProjectQuickAction(field: ProjectField): field is ReferenceField & { quickAction: true } {
  return field.type === "backoffice" && field.quickAction === true;
}

export function projectQuickActionLabel(field: ReferenceField) {
  const name = field.labelSource === "suggested" && field.id === "matter" && field.objectId === "matters"
    ? t("back_office.matters.singular") : projectFieldLabel(field);
  return t("projects.connections.add_record", { name });
}

export function clientsFromProjectMatters(fields: ProjectField[], directoryId: string | undefined, records: BackOfficeRecord[]) {
  const byId = new Map(records.filter(record => !record.archivedAt).map(record => [record.id, record]));
  const result = new Map<string, { client: BackOfficeRecord; matters: BackOfficeRecord[] }>();
  if (!directoryId) return [];
  const directClients = new Set(fields.flatMap(field => field.type === "backoffice" && field.objectId === "clients" && field.value?.directoryId === directoryId ? field.value.recordIds : []));
  for (const field of fields) {
    if (field.type !== "backoffice" || field.objectId !== "matters" || field.value?.directoryId !== directoryId) continue;
    for (const id of field.value.recordIds) {
      const matter = byId.get(id);
      if (matter?.objectId !== "matters") continue;
      const clients = matter.values.clients;
      for (const clientId of Array.isArray(clients) ? clients : typeof clients === "string" ? [clients] : []) {
        const client = typeof clientId === "string" ? byId.get(clientId) : undefined;
        if (client?.objectId !== "clients" || directClients.has(client.id)) continue;
        const entry = result.get(client.id) ?? { client, matters: [] };
        if (!entry.matters.some(source => source.id === matter.id)) entry.matters.push(matter);
        result.set(client.id, entry);
      }
    }
  }
  return [...result.values()];
}
