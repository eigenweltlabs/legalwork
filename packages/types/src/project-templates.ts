import { projectReferenceFiltersSchema } from "./project-reference-filters.js";
import { DEFAULT_INTERNAL_PERSON_TYPES } from "./back-office.js";
export * from "./project-reference-filters.js";
import { z } from "zod";
import { projectTemplateStrings } from "./project-template-strings.js";
export { projectTemplateStrings } from "./project-template-strings.js";

type Locale = "en" | "de";


function t(key: string, locale: Locale): string {
  const strings: Record<string, string> = projectTemplateStrings[locale];
  return strings[key] ?? key;
}

/** A template defines fields only. Every project starts with empty, optional values. */
export function emptyProjectFields(fields: ProjectField[]): ProjectField[] {
  return fields.map(field => {
    const copy = { ...field, value: null, ...(field.options ? { options: [...field.options] } : {}) };
    return copy.type === "backoffice" && copy.filters ? { ...copy, filters: { ...copy.filters, conditions: copy.filters.conditions.map(condition => ({ ...condition, values: [...condition.values] })) } } : copy;
  });
}

/** Resolve only our known presets. Legacy defaults are recognized by both id and original label. */
function suggestedLabels(locale: Locale): Record<string, string> {
  return {
    matter: t("projects.schema.matter", locale),
    matter_number: t("projects.schema.matter_number", locale),
    client: t("projects.schema.client", locale),
    opposing_party: t("projects.schema.opposing_party", locale),
    subject: t("projects.schema.subject", locale),
    practice_area: t("projects.schema.practice_area", locale),
    responsible: t("projects.schema.responsible", locale),
    status: t("projects.schema.status", locale),
    opened_on: t("projects.schema.opened_on", locale),
    court: t("projects.schema.court", locale),
    external_reference: t("projects.schema.external_reference", locale),
    counterparty: t("projects.schema.counterparty", locale),
    contract_type: t("projects.schema.contract_type", locale),
    contract_value: t("projects.schema.contract_value", locale),
    currency: t("projects.schema.currency", locale),
    effective_date: t("projects.schema.effective_date", locale),
    project_owner: t("projects.schema.project_owner", locale),
    department: t("projects.schema.department", locale),
    objective: t("projects.schema.objective", locale),
    target_date: t("projects.schema.target_date", locale),
    priority: t("projects.schema.priority", locale),
    process: t("projects.schema.process", locale),
    reference: t("projects.schema.reference", locale),
    vendor: t("projects.schema.vendor", locale),
    renewal_date: t("projects.schema.renewal_date", locale),
    budget: t("projects.schema.budget", locale),
    research_question: t("projects.schema.research_question", locale),
    jurisdiction: t("projects.schema.jurisdiction", locale),
    deliverable: t("projects.schema.deliverable", locale),
  };
}

export function projectFieldLabel(field: ProjectField, locale: Locale = "en"): string {
  const label = suggestedLabels(locale)[field.id];
  if (!label || field.labelSource === "custom") return field.label;
  if (field.labelSource === "suggested" ||
      ["en", "de"].some((language) =>
        suggestedLabels(language === "de" ? "de" : "en")[field.id] === field.label)) return label;
  return field.label;
}

/** Preserve label provenance when a field editor saves or copies defaults. */
export function localizedProjectFields(fields: ProjectField[], locale: Locale = "en"): ProjectField[] {
  return fields.map((field) => ({
    ...field,
    label: projectFieldLabel(field, locale),
    labelSource: field.labelSource ?? (
      suggestedLabels("en")[field.id] === field.label || suggestedLabels("de")[field.id] === field.label
        ? "suggested" : "custom"
    ),
  }));
}

/** Localize untouched preset choices only when copying a schema, never saved project values. */
export function localizedTemplateFields(fields: ProjectField[], locale: Locale = "en"): ProjectField[] {
  return emptyProjectFields(localizedProjectFields(fields, locale)).map((field) => {
    const keys = field.id === "status" ? ["status_open", "status_active", "status_waiting", "status_closed"]
      : field.id === "priority" ? ["priority_low", "priority_normal", "priority_high"] : [];
    if (field.labelSource !== "suggested" || !keys.length || field.options?.length !== keys.length) return field;
    const unchanged = (["en", "de"] satisfies Locale[]).some((language) => keys.every((key, index) => field.options?.[index] === t(`projects.schema.${key}`, language)));
    return unchanged ? { ...field, options: keys.map((key) => t(`projects.schema.${key}`, locale)) } : field;
  });
}

export const internalPeopleFilters = () => projectReferenceFiltersSchema.parse({ mode: "all", conditions: [
  { fieldId: "personType", operator: "is", values: [...DEFAULT_INTERNAL_PERSON_TYPES] },
  { fieldId: "active", operator: "is", values: [true] },
] });

export function defaultAkteFields(locale: Locale = "en"): ProjectField[] {
  return [
    { id: "matter", labelSource: "suggested", label: t("projects.schema.matter", locale), type: "backoffice", objectId: "matters", multiple: true, value: null },
    { id: "matter_number", labelSource: "suggested", label: t("projects.schema.matter_number", locale), type: "text", value: null },
    { id: "client", labelSource: "suggested", label: t("projects.schema.client", locale), type: "backoffice", objectId: "clients", multiple: true, value: null },
    { id: "opposing_party", labelSource: "suggested", label: t("projects.schema.opposing_party", locale), type: "backoffice", objectId: "companies", multiple: true, value: null },
    { id: "subject", labelSource: "suggested", label: t("projects.schema.subject", locale), type: "text", value: null },
    { id: "practice_area", labelSource: "suggested", label: t("projects.schema.practice_area", locale), type: "text", value: null },
    { id: "responsible", labelSource: "suggested", label: t("projects.schema.responsible", locale), type: "backoffice", objectId: "people", multiple: true, filters: internalPeopleFilters(), value: null },
    { id: "status", labelSource: "suggested", label: t("projects.schema.status", locale), type: "select", value: null,
      options: [t("projects.schema.status_open", locale), t("projects.schema.status_active", locale), t("projects.schema.status_waiting", locale), t("projects.schema.status_closed", locale)] },
    { id: "opened_on", labelSource: "suggested", label: t("projects.schema.opened_on", locale), type: "date", value: null },
    { id: "court", labelSource: "suggested", label: t("projects.schema.court", locale), type: "backoffice", objectId: "companies", multiple: true, filters: { mode: "all", conditions: [{ fieldId: "organisationType", operator: "is", values: ["Court", "Public authority"] }] }, value: null },
    { id: "external_reference", labelSource: "suggested", label: t("projects.schema.external_reference", locale), type: "text", value: null },
  ];
}

export type ProjectMetadataTemplate = {
  id: string;
  name: string;
  nameSource?: "suggested" | "custom";
  fields: ProjectField[];
};

function suggestedTemplateNames(locale: Locale): Record<string, string> {
  return {
    legal_matter: t("projects.templates.legal_matter", locale),
    internal: t("projects.templates.internal", locale),
    contracts: t("projects.templates.contracts", locale),
    administration: t("projects.templates.administration", locale),
    research: t("projects.templates.research", locale),
  };
}

export function projectTemplateName(template: ProjectMetadataTemplate, locale: Locale = "en"): string {
  return template.nameSource === "suggested" ? suggestedTemplateNames(locale)[template.id] ?? template.name : template.name;
}

export function defaultProjectTemplates(locale: Locale = "en"): ProjectMetadataTemplate[] {
  const labels = suggestedLabels(locale);
  const field = (id: string, type: Exclude<ProjectField["type"], "backoffice"> = "text"): ProjectField => ({
    id, label: labels[id], labelSource: "suggested", type, value: null,
    ...(id === "status" ? { options: [t("projects.schema.status_open", locale), t("projects.schema.status_active", locale), t("projects.schema.status_waiting", locale), t("projects.schema.status_closed", locale)] } : {}),
    ...(id === "priority" ? { options: [t("projects.schema.priority_low", locale), t("projects.schema.priority_normal", locale), t("projects.schema.priority_high", locale)] } : {}),
  });
  const reference = (id: string, objectId: string): ProjectField => ({ id, label: labels[id], labelSource: "suggested", type: "backoffice", objectId, multiple: true, ...(objectId === "people" ? { filters: internalPeopleFilters() } : {}), value: null });
  const schemas: Record<string, ProjectField[]> = {
    legal_matter: defaultAkteFields(locale),
    internal: [field("objective"), reference("project_owner", "people"), field("department"), field("status", "select"), field("priority", "select"), field("target_date", "date")],
    contracts: [reference("counterparty", "companies"), field("contract_type"), field("reference"), reference("project_owner", "people"), field("status", "select"), field("effective_date", "date"), field("renewal_date", "date"), field("contract_value", "number"), field("currency")],
    research: [field("research_question"), reference("project_owner", "people"), field("practice_area"), field("jurisdiction"), field("deliverable"), field("status", "select"), field("target_date", "date")],
  };
  const names = suggestedTemplateNames(locale);
  return Object.entries(schemas).map(([id, fields]) => ({ id, name: names[id], nameSource: "suggested", fields }));
}


export const projectFieldIdSchema = z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/);
const standardProjectFieldSchema = z
  .object({
    id: projectFieldIdSchema,
    label: z.string().trim().min(1).max(100),
    labelSource: z.enum(["suggested", "custom"]).optional(),
    type: z.enum(["text", "number", "date", "select"]),
    value: z.union([z.string().max(4000), z.number().finite(), z.null()]),
    options: z.array(z.string().trim().min(1).max(200)).max(100).optional(),
  })
  .superRefine((field, ctx) => {
    if (field.value === null || field.value === "") return;
    if (field.type === "number" && typeof field.value !== "number") {
      ctx.addIssue({
        code: "custom",
        message: "Number fields need a numeric value.",
      });
    } else if (field.type !== "number" && typeof field.value !== "string") {
      ctx.addIssue({
        code: "custom",
        message: "This field needs a text value.",
      });
    } else if (
      field.type === "select" &&
      !field.options?.includes(String(field.value))
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Choose one of the field's options.",
      });
    } else if (field.type === "date") {
      const value = String(field.value);
      const date = new Date(`${value}T00:00:00Z`);
      if (
        !/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(date.getTime()) ||
        date.toISOString().slice(0, 10) !== value
      ) {
        ctx.addIssue({
          code: "custom",
          message: "Enter a valid calendar date.",
        });
      }
    }
  });
export const projectRecordReferenceSchema = z.object({
  directoryId: z.string().min(1).max(200),
  recordIds: z.array(z.string().uuid()).min(1).max(1000).refine(ids => new Set(ids).size === ids.length, "Record IDs must be unique."),
}).strict();
const backOfficeProjectFieldSchema = z.object({
  id: projectFieldIdSchema,
  label: z.string().trim().min(1).max(100),
  labelSource: z.enum(["suggested", "custom"]).optional(),
  type: z.literal("backoffice"),
  objectId: z.string().min(1).max(100).regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/),
  multiple: z.boolean().default(true),
  filters: projectReferenceFiltersSchema.nullable().optional(),
  value: projectRecordReferenceSchema.nullable(),
  options: z.array(z.string()).max(0).optional(),
}).superRefine((field, ctx) => {
  if (!field.multiple && field.value && field.value.recordIds.length > 1)
    ctx.addIssue({ code: "custom", message: "Choose one record for this field." });
});
export const projectFieldSchema = z.discriminatedUnion("type", [standardProjectFieldSchema, backOfficeProjectFieldSchema]);
export const projectFieldValueSchema = z.union([z.string().max(4000), z.number().finite(), projectRecordReferenceSchema, z.null()]);
export type ProjectField = z.infer<typeof projectFieldSchema>;
export type ProjectRecordReference = z.infer<typeof projectRecordReferenceSchema>;
export const projectFieldsSchema = z
  .array(projectFieldSchema)
  .max(50)
  .refine(
    (fields) => new Set(fields.map((field) => field.id)).size === fields.length,
    "Field IDs must be unique.",
  );

export const projectTemplateCatalogSchema = z.object({
  revision: z.number().int().nonnegative(),
  defaultTemplateId: z.string().max(100).nullable(),
  templates: z.array(z.object({
    id: z.string().min(1).max(100).regex(/^[a-zA-Z0-9_-]+$/),
    name: z.string().trim().min(1).max(100),
    nameSource: z.enum(["suggested", "custom"]).optional(),
    fields: projectFieldsSchema.transform(emptyProjectFields),
  })).max(100),
}).superRefine((catalog, ctx) => {
  if (new Set(catalog.templates.map((template) => template.id)).size !== catalog.templates.length)
    ctx.addIssue({ code: "custom", message: "Template IDs must be unique." });
  if (catalog.defaultTemplateId !== null && !catalog.templates.some((template) => template.id === catalog.defaultTemplateId))
    ctx.addIssue({ code: "custom", message: "Choose an existing default template." });
});
export type ProjectTemplateCatalog = z.infer<typeof projectTemplateCatalogSchema>;

/** Upgrade only untouched built-in template definitions; never reinterpret saved text values or custom schemas. */
export function upgradeProjectTemplateReferences(catalog: ProjectTemplateCatalog): ProjectTemplateCatalog {
  const defaults = defaultProjectTemplates();
  return { ...catalog, templates: catalog.templates.map(template => {
    const current = defaults.find(item => item.id === template.id);
    if (!current || template.nameSource !== "suggested") return template;
    const legacy = current.fields.filter(field => field.id !== "matter").map((field): ProjectField => field.type === "backoffice"
      ? { id: field.id, label: field.label, labelSource: field.labelSource, type: "text", value: null } : field);
    const normalized = localizedTemplateFields(template.fields, "en");
    const previousReferences = current.fields.map((field): ProjectField => field.id === "court" || field.id === "opposing_party"
      ? { id: field.id, label: field.label, labelSource: field.labelSource, type: "text", value: null } : field);
    const signature = (fields: ProjectField[]) => JSON.stringify(fields.map(field => [field.id, field.label, field.labelSource, field.type, field.options ?? null, ...(field.type === "backoffice" ? [field.objectId, field.multiple, field.filters ?? null] : [])]));
    const previousUnfiltered = current.fields.map((field): ProjectField => field.type === "backoffice" ? { ...field, filters: undefined } : field);
    if (![legacy, previousReferences, previousUnfiltered, previousReferences.map((field): ProjectField => field.type === "backoffice" ? { ...field, filters: undefined } : field)].some(fields => signature(normalized) === signature(fields))) return template;
    return { ...template, fields: current.fields };
  }) };
}
