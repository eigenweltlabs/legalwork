import { z } from "zod";
import type { BackOfficeField, BackOfficeObject, BackOfficeRecord } from "./back-office.js";

const operand = z.union([z.string().min(1).max(4000), z.number().finite(), z.boolean()]);
export const projectReferenceConditionSchema = z.object({
  fieldId: z.string().min(1).max(100).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
  operator: z.enum(["is", "is_not", "contains", "not_contains", "gt", "gte", "lt", "lte", "empty", "not_empty"]),
  values: z.array(operand).max(100),
}).strict().superRefine((condition, ctx) => {
  const empty = condition.operator === "empty" || condition.operator === "not_empty";
  if (empty ? condition.values.length !== 0 : condition.values.length === 0)
    ctx.addIssue({ code: "custom", message: empty ? "This operator does not take values." : "Choose a filter value." });
  if (!["is", "is_not", "empty", "not_empty"].includes(condition.operator) && condition.values.length !== 1)
    ctx.addIssue({ code: "custom", message: "This operator needs one value." });
});
export const projectReferenceFiltersSchema = z.object({
  mode: z.enum(["all", "any"]).default("all"),
  conditions: z.array(projectReferenceConditionSchema).max(20),
}).strict();
export type ProjectReferenceCondition = z.infer<typeof projectReferenceConditionSchema>;
export type ProjectReferenceFilters = z.infer<typeof projectReferenceFiltersSchema>;

export function projectReferenceFilterFields(object: BackOfficeObject) {
  return object.fields.filter(field => field.visibility === "normal" && !["currency", "file"].includes(field.type));
}
export function projectReferenceOperators(field: BackOfficeField): ProjectReferenceCondition["operator"][] {
  const empty: ProjectReferenceCondition["operator"][] = ["empty", "not_empty"];
  if (field.type === "text" || field.type === "email") return ["is", "is_not", "contains", "not_contains", ...empty];
  if (["number", "date", "datetime"].includes(field.type)) return ["is", "is_not", "gt", "gte", "lt", "lte", ...empty];
  return ["is", "is_not", ...empty];
}
export function projectReferenceFilterError(object: BackOfficeObject, filters?: ProjectReferenceFilters | null): string | null {
  if (!filters?.conditions.length) return null;
  for (const condition of filters.conditions) {
    const field = projectReferenceFilterFields(object).find(field => field.id === condition.fieldId);
    if (!field) return "A selectable-record filter uses an unavailable field.";
    if (!projectReferenceOperators(field).includes(condition.operator)) return `Choose a valid operator for ${field.label}.`;
    if (condition.operator === "empty" || condition.operator === "not_empty") continue;
    for (const value of condition.values) {
      if (field.type === "boolean" ? typeof value !== "boolean" : field.type === "number" ? typeof value !== "number" : typeof value !== "string")
        return `Choose a valid value for ${field.label}.`;
      if (field.type === "relation" && !z.string().uuid().safeParse(value).success) return `Choose a record for ${field.label}.`;
      if (field.type === "date" || field.type === "datetime") {
        const text = String(value), date = new Date(field.type === "date" ? `${text}T00:00:00Z` : text);
        if (!Number.isFinite(date.getTime()) || (field.type === "date" && (!/^\d{4}-\d{2}-\d{2}$/.test(text) || date.toISOString().slice(0, 10) !== text)))
          return `Choose a valid date for ${field.label}.`;
      }
    }
  }
  return null;
}
export function matchesProjectReferenceFilters(record: BackOfficeRecord, object: BackOfficeObject, filters?: ProjectReferenceFilters | null): boolean {
  if (record.objectId !== object.id) return false;
  if (!filters?.conditions.length) return true;
  if (projectReferenceFilterError(object, filters)) return false;
  const matches = (condition: ProjectReferenceCondition) => {
    const value = record.values[condition.fieldId];
    const empty = value === undefined || value === null || value === "" || (Array.isArray(value) && !value.length);
    if (condition.operator === "empty") return empty;
    if (condition.operator === "not_empty") return !empty;
    if (empty) return false;
    const values = Array.isArray(value) ? value : [value];
    const [expected] = condition.values;
    const field = object.fields.find(field => field.id === condition.fieldId);
    const datetime = field?.type === "datetime";
    const actualComparable = datetime && typeof value === "string" ? Date.parse(value) : value;
    const expectedComparable = datetime && typeof expected === "string" ? Date.parse(expected) : expected;
    const includes = values.some(value => condition.values.some(expected => datetime && typeof value === "string" && typeof expected === "string" ? Date.parse(value) === Date.parse(expected) : value === expected));
    switch (condition.operator) {
      case "is": return includes;
      case "is_not": return !includes;
      case "contains": return typeof value === "string" && value.toLowerCase().includes(String(expected).toLowerCase());
      case "not_contains": return typeof value === "string" && !value.toLowerCase().includes(String(expected).toLowerCase());
      case "gt": return typeof actualComparable === "number" && typeof expectedComparable === "number" ? actualComparable > expectedComparable : typeof actualComparable === "string" && typeof expectedComparable === "string" && actualComparable > expectedComparable;
      case "gte": return typeof actualComparable === "number" && typeof expectedComparable === "number" ? actualComparable >= expectedComparable : typeof actualComparable === "string" && typeof expectedComparable === "string" && actualComparable >= expectedComparable;
      case "lt": return typeof actualComparable === "number" && typeof expectedComparable === "number" ? actualComparable < expectedComparable : typeof actualComparable === "string" && typeof expectedComparable === "string" && actualComparable < expectedComparable;
      case "lte": return typeof actualComparable === "number" && typeof expectedComparable === "number" ? actualComparable <= expectedComparable : typeof actualComparable === "string" && typeof expectedComparable === "string" && actualComparable <= expectedComparable;
    }
  };
  return filters.mode === "all" ? filters.conditions.every(matches) : filters.conditions.some(matches);
}
