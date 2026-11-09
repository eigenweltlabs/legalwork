import type { BackOfficeRecord } from "@legalwork/types/back-office";
import type { ProjectField } from "@legalwork/types/workspace";

export const primaryProjectObjects = ["matters", "clients", "people", "companies"];
export function hasProjectFieldValue(field: ProjectField) {
  return field.type === "backoffice" ? Boolean(field.value?.recordIds.length) : field.value !== null && field.value !== "";
}

export function withProjectField(fields: ProjectField[], field: ProjectField): ProjectField[] {
  return fields.some(item => item.id === field.id) ? fields.map(item => item.id === field.id ? field : item) : [...fields, field];
}

export function projectConnectionField(fields: ProjectField[], objectId: string, label: string): Extract<ProjectField, { type: "backoffice" }> {
  const ids: Record<string, string> = { matters: "matter", clients: "client", people: "people", companies: "companies" };
  const base = ids[objectId] ?? "reference";
  const standardId = new RegExp(`^${base}(_\\d+)?$`);
  const existing = fields.find((field): field is Extract<ProjectField, { type: "backoffice" }> =>
    field.type === "backoffice" && field.objectId === objectId && ((field.labelSource === "suggested" && standardId.test(field.id)) || field.label === label));
  if (existing) return existing;
  let id = base;
  for (let suffix = 2; fields.some(field => field.id === id); suffix++) id = `${base}_${suffix}`;
  return { id, label, labelSource: ids[objectId] ? "suggested" : "custom", type: "backoffice", objectId, multiple: true, value: null };
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
