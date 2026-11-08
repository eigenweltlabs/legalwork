import { createHash } from "node:crypto";
import type { BackOfficeDataQuery } from "@legalwork/types/views";
import type { WikiValue } from "@legalwork/types/wiki";
import { isInternalBackOfficeObject, type BackOfficeActor, type BackOfficeModel, type BackOfficeRecord } from "./schema.js";
import { ApiError } from "../errors.js";
import { queryIndexedRows } from "../wiki/data-query.js";

/** Records have already passed the directory's record and field access checks. */
export function queryDirectoryRecords(model: BackOfficeModel, actor: BackOfficeActor, readRecords: (objectId: string) => BackOfficeRecord[], query: BackOfficeDataQuery) {
  const object = model.objects.find(o => o.id === query.objectId && !o.archived);
  if (!object || isInternalBackOfficeObject(object.id) || (!actor.finance && ["invoices", "billingItems", "feeAgreements"].includes(object.id)))
    throw new ApiError(403, "directory_object_unavailable", "This Back Office model is unavailable.");
  const fields = new Map(object.fields.filter(f => actor.finance || f.visibility !== "finance").map(f => [f.id, f]));
  for (const metric of query.metrics ?? []) {
    if (metric.op === "count") continue;
    const f = fields.get(metric.field ?? "");
    if (!f || !["number", "currency"].includes(f.type) || (f.type === "currency" && !query.currency))
      throw new ApiError(400, "directory_numeric_metric", "Choose a numeric field and specify the currency for monetary aggregates.");
  }
  const records = readRecords(object.id);
  const requested = new Set([...query.fields, ...(query.filters ?? []).map(f => f.field), ...(query.sort ?? []).map(s => s.field),
    ...(query.groupBy ? [query.groupBy] : []), ...(query.metrics ?? []).flatMap(m => m.field ? [m.field] : [])]);
  const related = new Map<string, Map<string, BackOfficeRecord>>();
  for (const key of requested) {
    const target = fields.get(key)?.target;
    if (target && !isInternalBackOfficeObject(target) && !related.has(target)) {
      const rows = target === object.id ? records : readRecords(target);
      related.set(target, new Map(rows.map(row => [row.id, row])));
    }
  }
  const indexed = records.map(record => {
    const values: Record<string, WikiValue> = Object.create(null);
    for (const key of requested) {
      const f = fields.get(key), v = record.values[key];
      if (!f || v == null) continue;
      if (f.type === "relation") {
        const names = (Array.isArray(v) ? v : [v]).flatMap(id => {
          const linked = f.target && typeof id === "string" ? related.get(f.target)?.get(id) : undefined;
          return linked && typeof linked.values.name === "string" ? [linked.values.name] : [];
        });
        values[key] = f.multiple ? names : names[0] ?? null;
      } else if (typeof v === "object" && !Array.isArray(v)) {
        values[key] = query.currency ? (v.currency === query.currency ? v.amountMinor / 100 : null) : v;
      } else if (Array.isArray(v)) values[key] = v.map(item => typeof item === "string" ? item : item.name);
      else values[key] = v;
    }
    // Related names and field redactions can change without a revision on this row.
    const revision = createHash("sha256").update(JSON.stringify(values)).digest("hex");
    return { path: record.id, type: object.id, revision, updatedAt: Date.parse(record.updatedAt), archived: !!record.archivedAt, values };
  });
  return { ...queryIndexedRows(indexed, query, new Set([...fields.keys(), "$id", "$archived"]), (row, field) => field === "$id" ? row.path : field === "$archived" ? row.archived : row.values[field], [], null), sourceKind: "backOffice" as const };
}
