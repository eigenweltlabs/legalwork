import { z } from "zod";
import type { BackOfficeField, BackOfficeObject, BackOfficeRecord, BackOfficeValue } from "./back-office.js";

const money = z.object({ amountMinor: z.number().int().safe(), currency: z.string().regex(/^[A-Z]{3}$/) }).strict();
export const BackOfficeFilterConditionSchema = z.object({
  fieldId: z.string().min(1).max(100).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
  operator: z.enum(["is", "is_not", "contains", "not_contains", "gt", "gte", "lt", "lte", "empty", "not_empty"]),
  values: z.array(z.union([z.string().min(1).max(16000), z.number().finite(), z.boolean(), money])).max(1000),
}).strict().superRefine((condition, ctx) => {
  const empty = condition.operator === "empty" || condition.operator === "not_empty";
  if (empty ? condition.values.length !== 0 : condition.values.length === 0)
    ctx.addIssue({ code: "custom", message: empty ? "This condition does not take a value." : "Choose a filter value." });
  if (!["is", "is_not", "empty", "not_empty"].includes(condition.operator) && condition.values.length !== 1)
    ctx.addIssue({ code: "custom", message: "This condition needs one value." });
});
export const BackOfficeFilterCriteriaSchema = z.object({
  mode: z.enum(["all", "any"]).default("all"),
  conditions: z.array(BackOfficeFilterConditionSchema).max(20),
}).strict();
export type BackOfficeFilterCondition = z.infer<typeof BackOfficeFilterConditionSchema>;
export type BackOfficeFilterCriteria = z.infer<typeof BackOfficeFilterCriteriaSchema>;

export function backOfficeFilterFields(object: BackOfficeObject, finance: boolean) {
  return object.fields.filter(field => field.visibility !== "private" && (field.visibility !== "finance" || finance));
}
export function backOfficeFilterOperators(field: BackOfficeField): BackOfficeFilterCondition["operator"][] {
  if (field.type === "file") return ["contains", "not_contains", "empty", "not_empty"];
  if (["text", "email"].includes(field.type)) return ["contains", "not_contains", "is", "is_not", "empty", "not_empty"];
  if (["number", "currency", "date", "datetime"].includes(field.type)) return ["is", "is_not", "gt", "gte", "lt", "lte", "empty", "not_empty"];
  return ["is", "is_not", "empty", "not_empty"];
}

export function backOfficeFilterError(object: BackOfficeObject, criteria: BackOfficeFilterCriteria): string | null {
  if (!BackOfficeFilterCriteriaSchema.safeParse(criteria).success) return "Complete each filter before applying it.";
  for (const condition of criteria.conditions) {
    const field = object.fields.find(field => field.id === condition.fieldId && field.visibility !== "private");
    if (!field) return "A filter uses an unavailable field.";
    if (!backOfficeFilterOperators(field).includes(condition.operator)) return `Choose a valid condition for ${field.label}.`;
    for (const value of condition.values) {
      if (field.type === "currency" ? !money.safeParse(value).success : field.type === "number" ? typeof value !== "number" : field.type === "boolean" ? typeof value !== "boolean" : typeof value !== "string") return `Choose a valid value for ${field.label}.`;
      if (field.type === "relation" && !z.string().uuid().safeParse(value).success) return `Choose a record for ${field.label}.`;
      if ((field.type === "date" || field.type === "datetime") && typeof value === "string") {
        const date = new Date(field.type === "date" ? `${value}T00:00:00Z` : value);
        if (!Number.isFinite(date.getTime()) || field.type === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(value) || date.toISOString().slice(0, 10) !== value)) return `Choose a valid date for ${field.label}.`;
      }
    }
  }
  return null;
}

const normalized = (value: string) => value.normalize("NFC").trim().toLocaleLowerCase();
export function compileBackOfficeFilters(object: BackOfficeObject, criteria: BackOfficeFilterCriteria): (record: BackOfficeRecord) => boolean {
  if (backOfficeFilterError(object, criteria)) return () => false;
  const fields = new Map(object.fields.map(field => [field.id, field]));
  const matches = (record: BackOfficeRecord, condition: BackOfficeFilterCondition) => {
    const field = fields.get(condition.fieldId)!;
    const actual = record.values[field.id], expected = condition.values[0];
    const empty = actual === undefined || actual === null || actual === "" || Array.isArray(actual) && !actual.length;
    if (condition.operator === "empty") return empty;
    if (condition.operator === "not_empty") return !empty;
    if (empty) return false;
    const values = Array.isArray(actual) ? actual : [actual];
    if (condition.operator === "contains" || condition.operator === "not_contains") {
      const found = values.some(value => {
        const text = typeof value === "string" ? value : typeof value === "object" && value && "name" in value ? value.name : "";
        return normalized(text).includes(normalized(String(expected)));
      });
      return condition.operator === "contains" ? found : !found;
    }
    const equal = values.some(value => condition.values.some(expected => {
      if (field.type === "currency") return typeof value === "object" && value && "amountMinor" in value && typeof expected === "object" && value.currency === expected.currency && value.amountMinor === expected.amountMinor;
      if (field.type === "datetime") return typeof value === "string" && typeof expected === "string" && Date.parse(value) === Date.parse(expected);
      if (["text", "email"].includes(field.type)) return typeof value === "string" && typeof expected === "string" && normalized(value) === normalized(expected);
      return value === expected;
    }));
    if (condition.operator === "is") return equal;
    if (condition.operator === "is_not") return !equal;
    const left = field.type === "currency" ? typeof actual === "object" && !Array.isArray(actual) && "amountMinor" in actual && typeof expected === "object" && actual.currency === expected.currency ? actual.amountMinor : undefined
      : field.type === "datetime" && typeof actual === "string" ? Date.parse(actual) : actual;
    const right = typeof expected === "object" ? expected.amountMinor : field.type === "datetime" && typeof expected === "string" ? Date.parse(expected) : expected;
    if (!(typeof left === "number" && typeof right === "number" || typeof left === "string" && typeof right === "string")) return false;
    if (condition.operator === "gt") return left > right;
    if (condition.operator === "gte") return left >= right;
    if (condition.operator === "lt") return left < right;
    return left <= right;
  };
  return record => record.objectId === object.id && (!criteria.conditions.length || (criteria.mode === "all" ? criteria.conditions.every(condition => matches(record, condition)) : criteria.conditions.some(condition => matches(record, condition))));
}
export function matchesBackOfficeFilters(record: BackOfficeRecord, object: BackOfficeObject, criteria: BackOfficeFilterCriteria): boolean {
  return compileBackOfficeFilters(object, criteria)(record);
}

/** Keep every legacy predicate, including arrays and false/zero values. */
export function backOfficeViewFilters(view?: { filterCriteria?: BackOfficeFilterCriteria | null; filters: Record<string, BackOfficeValue> }): BackOfficeFilterCriteria {
  if (view?.filterCriteria) return view.filterCriteria;
  return { mode: "all", conditions: Object.entries(view?.filters ?? {}).flatMap(([fieldId, value]): BackOfficeFilterCondition[] => {
    if (value === null || value === "" || Array.isArray(value) && !value.length) return [{ fieldId, operator: "empty" satisfies "empty", values: [] }];
    const values = (Array.isArray(value) ? value : [value]).flatMap(value => typeof value === "object" && "name" in value ? [] : [value]);
    return [{ fieldId, operator: "is" satisfies "is", values }];
  }) };
}
