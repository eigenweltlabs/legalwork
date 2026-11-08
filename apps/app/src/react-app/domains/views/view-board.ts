import { isBackOfficeQuery } from "@legalwork/types/views";
import type { ViewRecord, WikiDataResult } from "@legalwork/types/views";

/** The renderer cannot choose a write target or revision. Derive both from the query result. */
export function viewBoardSource(view: ViewRecord, datasets: Record<string, WikiDataResult>, row: Record<string, unknown>, field: string) {
  if (view.mode !== "dashboard" || view.owner.kind !== "wiki" || typeof row.__viewBinding !== "string") return null;
  const binding = row.__viewBinding;
  if (!Object.hasOwn(view.queries, binding) || !Object.hasOwn(datasets, binding)) return null;
  const query = view.queries[binding], data = datasets[binding];
  if (isBackOfficeQuery(query) || query.groupBy || query.metrics?.length || !query.fields.includes(field) || !field.startsWith("properties.")) return null;
  const property = field.slice(11);
  if (!property || property.length > 200 || /[\u0000-\u001f]/.test(property) || ["__proto__", "prototype", "constructor", "<<"].includes(property)) return null;
  if (data.sourceOwner && (data.sourceOwner.kind !== "wiki" || data.sourceOwner.id !== view.owner.id)) return null;
  const sourceRow = data.rows.find(source => source.path === row.path);
  const source = data.sources?.find(source => source.path === row.path);
  if (!sourceRow || !source?.revision || !source.path.toLowerCase().endsWith(".md")) return null;
  // Reject fabricated or altered rows and non-string grouping properties.
  if (Object.entries(sourceRow).some(([key, value]) => JSON.stringify(row[key]) !== JSON.stringify(value))) return null;
  if (sourceRow[field] != null && typeof sourceRow[field] !== "string") return null;
  return { wikiId: view.owner.id, path: source.path, baseRevision: source.revision, property };
}
