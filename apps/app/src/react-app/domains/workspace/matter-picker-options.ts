import { z, type BackOfficeRecord } from "@legalwork/types/back-office";

const recentKey = "legalwork.recent-matters.v1";
const recentSchema = z.array(z.object({ scope: z.string(), ids: z.array(z.string().uuid()).max(50) })).max(20);

function recentEntries() {
  try { return recentSchema.parse(JSON.parse(localStorage.getItem(recentKey) ?? "[]")); }
  catch { return []; }
}

export function recentMatterIds(scope: string): string[] {
  return recentEntries().find(entry => entry.scope === scope)?.ids ?? [];
}

export function rememberMatter(scope: string, id: string) {
  const entries = recentEntries();
  const ids = [id, ...(entries.find(entry => entry.scope === scope)?.ids ?? []).filter(previous => previous !== id)].slice(0, 50);
  try { localStorage.setItem(recentKey, JSON.stringify([{ scope, ids }, ...entries.filter(entry => entry.scope !== scope)].slice(0, 20))); }
  catch { /* Selection still works when local preferences cannot be saved. */ }
}

export function matterPickerOptions(records: BackOfficeRecord[], query: string, recentIds: string[]) {
  const clients = new Map(records.filter(record => record.objectId === "clients" && !record.archivedAt).map(record => [record.id, record]));
  const recent = new Map(recentIds.map((id, index) => [id, index]));
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  return records.filter(record => record.objectId === "matters" && !record.archivedAt).map(record => {
    const ids = record.values.clients;
    const clientNames = (Array.isArray(ids) ? ids : typeof ids === "string" ? [ids] : []).flatMap(id => {
      const client = typeof id === "string" ? clients.get(id) : undefined;
      return typeof client?.values.name === "string" ? [client.values.name] : [];
    });
    const reference = typeof record.values.fileNumber === "string" ? record.values.fileNumber.trim() : "";
    return { record, clientNames, reference };
  }).filter(({ record, clientNames, reference }) => {
    const text = [record.values.name, ...clientNames, reference].join(" ").toLocaleLowerCase();
    return words.every(word => text.includes(word));
  }).sort((a, b) => (recent.get(a.record.id) ?? recentIds.length) - (recent.get(b.record.id) ?? recentIds.length)
    || String(a.record.values.name).localeCompare(String(b.record.values.name)) || a.record.id.localeCompare(b.record.id));
}
