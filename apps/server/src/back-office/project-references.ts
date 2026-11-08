import type { ProjectField } from "@legalwork/types/workspace";
import { matchesProjectReferenceFilters, projectReferenceFilterError } from "../project-schema.js";
import { ApiError } from "../errors.js";
import type { ServerConfig } from "../types.js";
import { backOfficeAccess, backOfficeDirectoryIdentity } from "./access.js";
import { backOfficeStore } from "./store.js";
import { isInternalBackOfficeObject } from "./schema.js";

type ReferenceField = Extract<ProjectField, { type: "backoffice" }>;
function previousSelection(before: ProjectField[], field: ReferenceField) {
  const previous = before.find(previous => previous.id === field.id);
  return previous?.type === "backoffice" && previous.objectId === field.objectId && previous.value?.directoryId === field.value?.directoryId
    ? previous.value?.recordIds ?? [] : [];
}
export async function projectReferenceDirectory(config: ServerConfig, team?: boolean) {
  const { scope, actor } = await backOfficeAccess(config, team);
  const store = await backOfficeStore(config), directoryId = await backOfficeDirectoryIdentity(config, scope, store);
  const model = store.model(scope), records = store.records(scope, actor);
  store.requireAccount(scope, actor);
  return { scope, actor, store, directoryId, model, records };
}
function referenceObject(context: Awaited<ReturnType<typeof projectReferenceDirectory>>, field: ReferenceField) {
  const object = context.model.objects.find(object => object.id === field.objectId && !object.archived && !isInternalBackOfficeObject(object.id));
  if (!object || (!context.actor.finance && ["feeAgreements", "billingItems", "invoices"].includes(object.id)))
    throw new ApiError(400, "project_reference_unavailable", "The selected Back Office object is unavailable.");
  const error = projectReferenceFilterError(object, field.filters);
  if (error) throw new ApiError(400, "invalid_project_reference_filter", error);
  return object;
}

/** New assignments must match. Keeping or removing an existing assignment never depends on its current type/status. */
export async function validateProjectReferences(config: ServerConfig, before: ProjectField[], after: ProjectField[]): Promise<void> {
  const changed = after.filter((field): field is ReferenceField => {
    if (field.type !== "backoffice") return false;
    const previous = before.find(previous => previous.id === field.id);
    // Empty definitions can initialize projects while Back Office is unavailable.
    if (!previous && !field.value) return false;
    const kept = previousSelection(before, field);
    return previous?.type !== "backoffice" || previous.objectId !== field.objectId || JSON.stringify(previous.filters) !== JSON.stringify(field.filters)
      || Boolean(field.value?.recordIds.some(id => !kept.includes(id)));
  });
  if (!changed.length) return;
  const context = await projectReferenceDirectory(config);
  for (const field of changed) {
    const object = referenceObject(context, field), kept = previousSelection(before, field);
    for (const id of field.value?.recordIds ?? []) {
      if (kept.includes(id)) continue;
      if (field.value?.directoryId !== context.directoryId)
        throw new ApiError(409, "project_reference_directory_changed", "Choose records from the current Back Office directory.");
      const record = context.records.find(record => record.id === id && record.objectId === field.objectId && !record.archivedAt);
      if (!record || !matchesProjectReferenceFilters(record, object, field.filters))
        throw new ApiError(400, "project_reference_filter_mismatch", `Choose an available record matching the filters for ${field.label}.`);
    }
  }
  context.store.requireAccount(context.scope, context.actor);
}

export async function projectReferenceOptions(config: ServerConfig, field: ReferenceField, query: string) {
  const context = await projectReferenceDirectory(config), object = referenceObject(context, field);
  const available = context.records.filter(record => record.objectId === field.objectId && !record.archivedAt);
  return {
    directoryId: context.directoryId,
    field,
    records: available.filter(record => matchesProjectReferenceFilters(record, object, field.filters) && String(record.values.name ?? "").toLocaleLowerCase().includes(query.toLocaleLowerCase())),
    selectedRecords: field.value?.directoryId === context.directoryId ? available.filter(record => field.value?.recordIds.includes(record.id)) : [],
  };
}

/** Resolve identities with current directory permissions, never copied record names. */
export function projectBackOfficeReferences(context: Awaited<ReturnType<typeof projectReferenceDirectory>>, projectFields: ProjectField[]) {
  context.store.requireAccount(context.scope, context.actor);
  const fields = projectFields.flatMap(field => field.type === "backoffice" && field.value?.directoryId === context.directoryId && !isInternalBackOfficeObject(field.objectId)
    ? [{ id: field.id, label: field.label, objectId: field.objectId, records: context.records.filter(record => record.objectId === field.objectId && field.value?.recordIds.includes(record.id)) }] : []);
  const records = [...new Map(fields.flatMap(field => field.records).map(record => [record.id, record])).values()];
  const available = new Map(context.records.map(record => [record.id, record]));
  const seen = new Set(records.map(record => record.id));
  for (const record of records) {
    const object = context.model.objects.find(object => object.id === record.objectId);
    for (const field of object?.fields ?? []) {
      if (field.type !== "relation" || !field.target || isInternalBackOfficeObject(field.target)
        || !context.model.objects.some(object => object.id === field.target && !object.archived)
        || !context.actor.finance && ["feeAgreements", "billingItems", "invoices"].includes(field.target)) continue;
      const value = record.values[field.id];
      for (const id of Array.isArray(value) ? value : [value]) {
        if (typeof id !== "string" || seen.has(id)) continue;
        const related = available.get(id);
        if (!related || related.objectId !== field.target) continue;
        seen.add(id); records.push(related);
      }
    }
  }
  return { directoryId: context.directoryId, fields, records, matters: records.filter(record => record.objectId === "matters"), clients: records.filter(record => record.objectId === "clients") };
}
