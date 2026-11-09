import { defaultBackOfficeValues, isInternalBackOfficeObject, type BackOfficeObject, type BackOfficeValue } from "@legalwork/types/back-office";
import type { ProjectReferenceFilters } from "@legalwork/types/workspace";
import type { BackOfficeState } from "./api";

export function quickCreateFieldIds(object: BackOfficeObject): string[] {
  if (object.quickCreateFields) return object.quickCreateFields;
  const defaults: Record<string, string[]> = {
    matters: ["clients", "fileNumber"], clients: ["company", "person", "clientNumber"],
    people: ["email", "company", "personType"], companies: ["organisationType", "domain"],
  };
  return defaults[object.id] ?? object.fields.filter(field => ["relation", "select", "boolean"].includes(field.type)).map(field => field.id);
}

export function creatableRecordObject(state: BackOfficeState | undefined, objectId?: string) {
  if (!state?.directoryId || !state.permissions.edit || !objectId || isInternalBackOfficeObject(objectId)) return undefined;
  if (!state.permissions.finance && ["feeAgreements", "billingItems", "invoices"].includes(objectId)) return undefined;
  return state.model.objects.find(object => object.id === objectId && !object.archived && !object.fields.some(field => field.required && field.visibility === "finance" && !state.permissions.finance));
}

/** A unique equality can supply a default. Several allowed types need a human choice. */
export function recordCreationValues(object: BackOfficeObject, name: string, filters?: ProjectReferenceFilters | null): Record<string, BackOfficeValue> {
  const values: Record<string, BackOfficeValue> = { ...defaultBackOfficeValues(object), name };
  if (filters?.mode !== "all") return values;
  for (const condition of filters.conditions) {
    const field = object.fields.find(field => field.id === condition.fieldId);
    if (!field || condition.operator !== "is") continue;
    if (condition.values.length === 1) {
      const value = condition.values[0];
      values[field.id] = field.type === "multiselect" || field.type === "relation" && field.multiple ? [String(value)] : value;
    } else if (field.id in values && !condition.values.some(value => value === values[field.id])) {
      delete values[field.id];
    }
  }
  return values;
}
