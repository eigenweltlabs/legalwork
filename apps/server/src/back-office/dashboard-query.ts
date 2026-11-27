import { createHash } from "node:crypto";
import type { BackOfficeDataQuery } from "@legalwork/types/views";
import type { WikiValue } from "@legalwork/types/wiki";
import { backOfficeMajorAmount, backOfficeRecordUrl, isInternalBackOfficeObject, type BackOfficeActor, type BackOfficeModel, type BackOfficeRecord } from "./schema.js";
import { ApiError } from "../errors.js";
import { queryIndexedRows } from "../wiki/data-query.js";

/** Records have already passed the directory's record and field access checks. */
export function queryDirectoryRecords(model: BackOfficeModel, actor: BackOfficeActor, readRecords: (objectId: string) => BackOfficeRecord[], query: BackOfficeDataQuery, recordLinks = false) {
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
  const filterFields = new Set((query.filters ?? []).map(f => f.field));
  const requested = new Set([...query.fields, ...filterFields, ...(query.sort ?? []).map(s => s.field),
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
    const relationIds = new Map<string, string[]>();
    for (const key of requested) {
      const f = fields.get(key), v = record.values[key];
      if (!f || v == null) continue;
      if (f.type === "relation") {
        const links = (Array.isArray(v) ? v : [v]).flatMap(id => {
          const linked = f.target && typeof id === "string" ? related.get(f.target)?.get(id) : undefined;
          return linked && typeof linked.values.name === "string" ? [{ id: linked.id, name: linked.values.name }] : [];
        });
        const names = links.map(link => link.name);
        values[key] = f.multiple ? names : names[0] ?? null;
        if (filterFields.has(key)) relationIds.set(key, links.map(link => link.id));
      } else if (typeof v === "object" && !Array.isArray(v)) {
        values[key] = query.currency ? (v.currency === query.currency ? backOfficeMajorAmount(v) : null) : v;
      } else if (Array.isArray(v)) values[key] = v.map(item => typeof item === "string" || "url" in item ? item : item.name);
      else values[key] = v;
    }
    // Related names and visible identities can change without a revision on this row.
    const revisionInput = relationIds.size ? [values, [...relationIds]] : values;
    const revision = createHash("sha256").update(JSON.stringify(revisionInput)).digest("hex");
    return { path: record.id, type: object.id, revision, updatedAt: Date.parse(record.updatedAt), archived: !!record.archivedAt, values, relationIds };
  });
  const property = (row: (typeof indexed)[number], field: string) =>
    field === "$id" ? row.path : field === "$archived" ? row.archived : row.values[field];
  const result = queryIndexedRows(indexed, query, new Set([...fields.keys(), "$id", "$archived"]), property, recordLinks ? ["$id", "$archived"] : [], null,
    (row, field, operand) => {
      const value = property(row, field);
      const ids = row.relationIds.get(field);
      const target = fields.get(field)?.target;
      if (!ids || !target) return value;
      // Resolve ID operands against the same visible targets used to render relation names.
      const targets = related.get(target);
      const isRecordId = (candidate: WikiValue | undefined) => typeof candidate === "string" && targets?.has(candidate);
      if (Array.isArray(value)) {
        return value.map((name, index) => isRecordId(Array.isArray(operand) ? operand[index] : operand) ? ids[index] : name);
      }
      return isRecordId(operand) ? ids[0] ?? null : value;
    });
  return {
    ...result,
    rows: recordLinks && !query.groupBy && !query.metrics?.length ? result.rows.map(row => ({
      ...row,
      $url: backOfficeRecordUrl({ objectId: object.id, id: String(row.$id) }, row.$archived === true),
    })) : result.rows,
    sourceKind: "backOffice" as const,
  };
}
