import { z } from "zod";
export { z } from "zod";

export const BACK_OFFICE_PROTOCOL = 1;
export const BACK_OFFICE_TEMPLATE = 2;
const identifier = z
  .string()
  .min(1)
  .max(100)
  .regex(/^[a-zA-Z][a-zA-Z0-9_-]*$/);
export const BackOfficeFieldSchema = z.object({
  id: identifier,
  label: z.string().trim().min(1).max(120),
  type: z.enum([
    "text",
    "email",
    "number",
    "currency",
    "date",
    "datetime",
    "boolean",
    "select",
    "multiselect",
    "relation",
  ]),
  protected: z.boolean().default(false),
  required: z.boolean().default(false),
  target: identifier.optional(),
  multiple: z.boolean().default(false),
  options: z.array(z.string().min(1).max(120)).max(100).default([]),
  visibility: z.enum(["normal", "finance", "private"]).default("normal"),
});
export const BackOfficeObjectSchema = z.object({
  id: identifier,
  label: z.string().trim().min(1).max(120),
  plural: z.string().trim().min(1).max(120),
  description: z.string().max(2000).default(""),
  icon: z.string().max(60).default("database"),
  protected: z.boolean().default(false),
  archived: z.boolean().default(false),
  fields: z.array(BackOfficeFieldSchema).min(1).max(100),
});
export const BackOfficeModelSchema = z.object({
  templateVersion: z.number().int().positive(),
  revision: z.number().int().nonnegative(),
  objects: z.array(BackOfficeObjectSchema).min(1).max(100),
});
export const BackOfficeValueSchema = z.union([
  z.string().max(16000),
  z.number().finite(),
  z.boolean(),
  z.array(z.string().max(200)).max(1000),
  z.object({
    amountMinor: z.number().int().safe(),
    currency: z.string().regex(/^[A-Z]{3}$/),
  }),
  z.null(),
]);
export const BackOfficeRecordSchema = z.object({
  id: z.string().uuid(),
  objectId: identifier,
  values: z.record(identifier, BackOfficeValueSchema),
  revision: z.number().int().nonnegative(),
  schemaRevision: z.number().int().nonnegative(),
  access: z.enum(["org", "members"]).default("org"),
  members: z.array(z.string().min(1).max(200)).max(500).default([]),
  ownerId: z.string().min(1).max(200),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});
export const BackOfficeViewSchema = z.object({
  id: z.string().uuid(),
  objectId: identifier,
  name: z.string().trim().min(1).max(120),
  type: z.enum(["table", "kanban", "calendar", "list"]).default("table"),
  groupField: identifier.nullable().default(null),
  dateField: identifier.nullable().default(null),
  calendarMode: z.enum(["day", "week", "month"]).default("month"),
  icon: z
    .enum([
      "table",
      "kanban",
      "calendar",
      "list",
      "briefcase",
      "building",
      "users",
      "tag",
    ])
    .nullable()
    .default(null),
  archived: z.boolean().default(false),
  columns: z.array(identifier).max(100),
  widths: z.record(identifier, z.number().min(80).max(800)).default({}),
  query: z.string().max(500).default(""),
  filters: z.record(identifier, BackOfficeValueSchema).default({}),
  sortField: identifier.default("name"),
  sortDirection: z.enum(["asc", "desc"]).default("asc"),
});
export type BackOfficeField = z.infer<typeof BackOfficeFieldSchema>;
export type BackOfficeObject = z.infer<typeof BackOfficeObjectSchema>;
export type BackOfficeModel = z.infer<typeof BackOfficeModelSchema>;
export type BackOfficeRecord = z.infer<typeof BackOfficeRecordSchema>;
export type BackOfficeValue = z.infer<typeof BackOfficeValueSchema>;
export type BackOfficeView = z.infer<typeof BackOfficeViewSchema>;
export type BackOfficeActor = {
  userId: string;
  agentId?: string;
  model: boolean;
  edit: boolean;
  finance: boolean;
};
export const BackOfficeChangeSchema = z.object({
  id: z.string().uuid(),
  kind: z.enum(["record", "model", "view"]),
  baseRevision: z.number().int().nonnegative(),
  schemaRevision: z.number().int().nonnegative(),
  changedFields: z.array(identifier).max(100).optional(),
  data: z.unknown(),
});
export const BackOfficeSyncSchema = z.object({
  protocol: z.literal(BACK_OFFICE_PROTOCOL),
  changes: z.array(BackOfficeChangeSchema).max(100),
  cursor: z.number().int().nonnegative(),
});
export type BackOfficeChange = z.infer<typeof BackOfficeChangeSchema>;

function field(
  id: string,
  label: string,
  type: BackOfficeField["type"] = "text",
  extra: Partial<BackOfficeField> = {},
): BackOfficeField {
  return BackOfficeFieldSchema.parse({
    id,
    label,
    type,
    protected: true,
    ...extra,
  });
}
const relation = (
  id: string,
  label: string,
  target: string,
  multiple = false,
) => field(id, label, "relation", { target, multiple });
const selection = (id: string, label: string, options: string[]) =>
  field(id, label, "select", { options });
const money = (id: string, label: string) =>
  field(id, label, "currency", { visibility: "finance" });
function object(
  id: string,
  label: string,
  plural: string,
  icon: string,
  fields: BackOfficeField[],
): BackOfficeObject {
  return BackOfficeObjectSchema.parse({
    id,
    label,
    plural,
    icon,
    protected: true,
    fields: [field("name", "Name", "text", { required: true }), ...fields],
  });
}
export function defaultBackOfficeModel(): BackOfficeModel {
  const billing = () => [
    relation("matter", "Matter", "matters"),
    relation("client", "Client", "clients"),
  ];
  return {
    templateVersion: BACK_OFFICE_TEMPLATE,
    revision: 1,
    objects: [
      object("matters", "Matter", "Matters", "briefcase", [
        field("fileNumber", "File number"),
        relation("clients", "Clients", "clients", true),
        selection("status", "Status", [
          "Intake",
          "Active",
          "On hold",
          "Closed",
        ]),
        selection("practiceArea", "Practice area", [
          "Corporate / M&A",
          "Employment",
          "Commercial",
          "Disputes",
          "Privacy",
          "Real estate",
          "Other",
        ]),
        relation("leadLawyer", "Lead lawyer", "people"),
        field("openedOn", "Opened", "date"),
        relation("parentMatter", "Parent matter", "matters"),
        field("externalReference", "Alternative reference"),
        field("department", "Department"),
        money("claimValue", "Value in dispute"),
        field("subject", "Subject"),
        field("tags", "Tags", "multiselect"),
        field("actaportId", "Actaport ID"),
      ]),
      object("clients", "Client", "Clients", "clients", [
        field("clientNumber", "Client number"),
        selection("clientType", "Client type", ["Company", "Individual"]),
        relation("company", "Company", "companies"),
        relation("person", "Person", "people"),
        field("billingAddress", "Billing address"),
        field("billingEmail", "Billing email", "email"),
        field("buyerReference", "E-invoice buyer reference"),
        field("actaportId", "Actaport ID"),
      ]),
      object("people", "Person", "People", "person", [
        field("email", "Email", "email"),
        field("phone", "Phone"),
        field("jobTitle", "Job title"),
        relation("company", "Company", "companies"),
        field("address", "Address"),
        field("city", "City"),
        field("salutation", "Salutation"),
        field("birthDate", "Birth date", "date"),
        field("nationality", "Nationality"),
        field("taxNumber", "Tax number", "text", { visibility: "finance" }),
        field("actaportId", "Actaport ID"),
      ]),
      object("companies", "Company", "Companies", "company", [
        field("domain", "Domain name"),
        field("industry", "Industry"),
        field("registrationNumber", "Registration number"),
        field("legalForm", "Legal form"),
        field("email", "Email", "email"),
        field("phone", "Phone"),
        field("address", "Address"),
        field("city", "City"),
        field("vatId", "VAT ID", "text", { visibility: "finance" }),
        relation("contact", "Primary contact", "people"),
        field("actaportId", "Actaport ID"),
      ]),
      object("parties", "Matter party", "Matter parties", "link", [
        relation("matter", "Matter", "matters"),
        selection("role", "Role", [
          "Client",
          "Billing recipient",
          "Counterparty",
          "Counsel",
          "Court",
          "Insurer",
          "Contact",
          "Other",
        ]),
        relation("person", "Person", "people"),
        relation("company", "Company", "companies"),
        relation("client", "Client account", "clients"),
        field("reference", "Party reference"),
        field("subrole", "Subrole"),
        field("actaportId", "Actaport ID"),
      ]),
      object("projectLinks", "Project link", "Project links", "folder", [
        field("projectId", "Project ID", "text", { required: true }),
        relation("matter", "Matter", "matters"),
      ]),
      object("feeAgreements", "Fee agreement", "Fee agreements", "receipt", [
        ...billing(),
        selection("basis", "Fee basis", [
          "Hourly",
          "Flat fee",
          "Flat fee with included time",
          "RVG",
        ]),
        money("hourlyRate", "Hourly rate"),
        money("flatFee", "Flat fee"),
        field("includedMinutes", "Included minutes", "number"),
        field("incrementMinutes", "Billing increment (min)", "number"),
        field("terms", "Terms"),
      ]),
      object("timeEntries", "Time entry", "Time entries", "clock", [
        ...billing(),
        relation("timekeeper", "Timekeeper", "people"),
        field("startedAt", "Started at", "datetime"),
        field("endedAt", "Ended at", "datetime"),
        field("recordedMinutes", "Recorded minutes", "number"),
        field("billableMinutes", "Billable minutes", "number"),
        money("hourlyRate", "Hourly rate"),
        field("privateNote", "Private work note", "text", {
          visibility: "private",
        }),
        field("billingNarrative", "Billing narrative"),
        selection("status", "Status", [
          "Draft",
          "Submitted",
          "Approved",
          "Invoiced",
          "Written off",
        ]),
        relation("invoice", "Invoice", "invoices"),
        field("actaportId", "Actaport ID"),
      ]),
      object("billingItems", "Billing item", "Billing items", "receipt", [
        ...billing(),
        selection("kind", "Item type", [
          "Flat fee",
          "RVG",
          "Own expense",
          "Third-party expense",
        ]),
        field("serviceDate", "Service date", "date"),
        field("description", "Description"),
        field("quantity", "Quantity", "number"),
        money("netAmount", "Net amount"),
        field("vatPercent", "VAT (%)", "number"),
        relation("invoice", "Invoice", "invoices"),
        field("actaportId", "Actaport ID"),
      ]),
      object("invoices", "Invoice", "Invoices", "receipt", [
        ...billing(),
        field("invoiceNumber", "Invoice number"),
        selection("status", "Status", [
          "Draft",
          "Issued",
          "Part paid",
          "Paid",
          "Cancelled",
          "Credited",
        ]),
        field("issuedOn", "Issue date", "date"),
        field("dueOn", "Due date", "date"),
        money("netTotal", "Net total"),
        money("grossTotal", "Gross total"),
        money("outstanding", "Outstanding"),
        relation("originalInvoice", "Original invoice", "invoices"),
        field("actaportId", "Actaport ID"),
      ]),
    ],
  };
}

export function assertModelChange(
  previous: BackOfficeModel,
  candidate: BackOfficeModel,
): void {
  const ids = candidate.objects.map((object) => object.id);
  if (new Set(ids).size !== ids.length)
    throw new Error("Object IDs must be unique.");
  for (const original of previous.objects.filter(
    (object) => object.protected,
  )) {
    const next = candidate.objects.find((object) => object.id === original.id);
    if (!next || !next.protected || next.archived)
      throw new Error(`${original.plural} is part of the protected model.`);
    for (const originalField of original.fields.filter(
      (field) => field.protected,
    )) {
      const nextField = next.fields.find(
        (field) => field.id === originalField.id,
      );
      if (
        !nextField ||
        !nextField.protected ||
        ["type", "target", "multiple", "required", "visibility"].some(
          (key) =>
            Reflect.get(nextField, key) !== Reflect.get(originalField, key),
        )
      )
        throw new Error(
          `${originalField.label} has a protected type and relationship.`,
        );
      if (
        originalField.options.some(
          (option) => !nextField.options.includes(option),
        )
      )
        throw new Error("Protected options cannot be removed.");
    }
  }
  for (const object of candidate.objects) {
    if (
      new Set(object.fields.map((field) => field.id)).size !==
      object.fields.length
    )
      throw new Error("Field IDs must be unique.");
    if (
      !object.fields.some(
        (field) =>
          field.id === "name" && field.type === "text" && field.required,
      )
    )
      throw new Error("Every object needs a text Name field.");
    for (const field of object.fields) {
      if (field.type === "relation" && !ids.includes(field.target ?? ""))
        throw new Error(`${field.label} needs an existing target object.`);
    }
  }
}

export function validateBackOfficeValues(
  object: BackOfficeObject,
  values: Record<string, BackOfficeValue>,
): void {
  for (const [id, value] of Object.entries(values)) {
    const field = object.fields.find((field) => field.id === id);
    if (!field) throw new Error(`Unknown field ${id}. Refresh the data model.`);
    if (value === null || value === "") continue;
    const valid =
      field.type === "currency"
        ? typeof value === "object" &&
          !Array.isArray(value) &&
          "amountMinor" in value
        : field.type === "number"
          ? typeof value === "number" && Number.isFinite(value)
          : field.type === "boolean"
            ? typeof value === "boolean"
            : field.type === "relation"
              ? field.multiple
                ? Array.isArray(value)
                : typeof value === "string"
              : field.type === "multiselect"
                ? Array.isArray(value)
                : typeof value === "string";
    if (!valid) throw new Error(`Check the value of ${field.label}.`);
    if (
      field.type === "select" &&
      typeof value === "string" &&
      !field.options.includes(value)
    )
      throw new Error(`Choose an existing ${field.label} option.`);
    if (
      field.type === "currency" &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      (!Number.isSafeInteger(value.amountMinor) ||
        !/^[A-Z]{3}$/.test(value.currency))
    )
      throw new Error("Use a valid currency and an amount in minor units.");
    if (
      field.type === "email" &&
      typeof value === "string" &&
      !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)
    )
      throw new Error("Enter a valid email address.");
    if (
      field.type === "date" &&
      typeof value === "string" &&
      (!/^\d{4}-\d{2}-\d{2}$/.test(value) ||
        !Number.isFinite(Date.parse(value)) ||
        new Date(value).toISOString().slice(0, 10) !== value)
    )
      throw new Error("Use YYYY-MM-DD for dates.");
  }
  for (const [id, value] of Object.entries(values)) {
    const field = object.fields.find((field) => field.id === id);
    if (
      field?.type === "datetime" &&
      typeof value === "string" &&
      value &&
      !Number.isFinite(Date.parse(value))
    )
      throw new Error("Use a valid date and time.");
    if (
      field?.type === "multiselect" &&
      field.options.length &&
      Array.isArray(value) &&
      value.some((item) => !field.options.includes(item))
    )
      throw new Error(`Choose existing ${field.label} options.`);
  }
  for (const field of object.fields.filter((field) => field.required))
    if (
      values[field.id] === undefined ||
      values[field.id] === null ||
      (typeof values[field.id] === "string" && !String(values[field.id]).trim())
    )
      throw new Error(`${field.label} is required.`);
}

export function visibleBackOfficeRecord(
  record: BackOfficeRecord,
  actor: BackOfficeActor,
): boolean {
  if (
    ["feeAgreements", "billingItems", "invoices"].includes(record.objectId) &&
    !actor.finance
  )
    return false;
  if (
    record.objectId === "timeEntries" &&
    !actor.finance &&
    record.ownerId !== actor.userId
  )
    return false;
  return (
    record.access === "org" ||
    record.ownerId === actor.userId ||
    record.members.includes(actor.userId)
  );
}
export function readableBackOfficeRecord(
  record: BackOfficeRecord,
  object: BackOfficeObject,
  actor: BackOfficeActor,
): BackOfficeRecord {
  return {
    ...record,
    values: Object.fromEntries(
      Object.entries(record.values).filter(([id]) => {
        const field = object.fields.find((field) => field.id === id);
        return field?.visibility === "private"
          ? record.ownerId === actor.userId
          : field?.visibility !== "finance" || actor.finance;
      }),
    ),
  };
}

export const BackOfficeSnapshotSchema = z.object({
  protocol: z.literal(BACK_OFFICE_PROTOCOL),
  model: BackOfficeModelSchema,
  records: z.array(BackOfficeRecordSchema),
  views: z.array(BackOfficeViewSchema),
  cursor: z.number().int().nonnegative(),
  accepted: z.array(z.string().uuid()).default([]),
  conflicts: z
    .array(z.object({ id: z.string().uuid(), message: z.string() }))
    .default([]),
});
export type BackOfficeSnapshot = z.infer<typeof BackOfficeSnapshotSchema>;

/** Add new shipped definitions by stable ID while preserving firm extensions and labels. */
export function upgradeBackOfficeModel(
  current: BackOfficeModel,
  baseline = defaultBackOfficeModel(),
): BackOfficeModel {
  if (current.templateVersion >= baseline.templateVersion) return current;
  const objects = current.objects.map((object) => {
    const core = baseline.objects.find((item) => item.id === object.id);
    if (!core) return object;
    for (const field of core.fields.filter((field) => field.protected)) {
      const existing = object.fields.find((item) => item.id === field.id);
      if (
        existing &&
        (existing.type !== field.type ||
          existing.target !== field.target ||
          existing.multiple !== field.multiple)
      )
        throw new Error(`A migration is required for ${field.label}.`);
      if (!existing && field.required)
        throw new Error(
          `Fill ${field.label} before applying this template upgrade.`,
        );
    }
    return {
      ...object,
      fields: [
        ...object.fields,
        ...core.fields.filter(
          (field) =>
            !object.fields.some((existing) => existing.id === field.id),
        ),
      ],
    };
  });
  objects.push(
    ...baseline.objects.filter(
      (object) => !objects.some((existing) => existing.id === object.id),
    ),
  );
  return {
    ...current,
    objects,
    templateVersion: baseline.templateVersion,
    revision: current.revision + 1,
  };
}

/** Resolve an already permission-filtered directory without granting project access. */
export function backOfficeProjectContext(
  records: BackOfficeRecord[],
  projectId: string,
) {
  const active = records.filter((record) => !record.archivedAt);
  const links = active.filter(
    (record) =>
      record.objectId === "projectLinks" &&
      record.values.projectId === projectId,
  );
  const matterIds = new Set(
    links.flatMap((link) =>
      typeof link.values.matter === "string" ? [link.values.matter] : [],
    ),
  );
  const matters = active.filter(
    (record) => record.objectId === "matters" && matterIds.has(record.id),
  );
  const clientIds = new Set(
    matters.flatMap((record) =>
      Array.isArray(record.values.clients) ? record.values.clients : [],
    ),
  );
  for (const party of active.filter(
    (record) =>
      record.objectId === "parties" &&
      record.values.role === "Client" &&
      typeof record.values.matter === "string" &&
      matterIds.has(record.values.matter),
  )) {
    if (typeof party.values.client === "string")
      clientIds.add(party.values.client);
  }
  return {
    links,
    matters,
    clients: active.filter(
      (record) => record.objectId === "clients" && clientIds.has(record.id),
    ),
  };
}

/** Storage junctions are managed through relationship controls, not record tables. */
export function isInternalBackOfficeObject(id: string) {
  return id === "projectLinks";
}

export function validateBackOfficeView(
  model: BackOfficeModel,
  view: BackOfficeView,
): void {
  const object = model.objects.find(
    (object) => object.id === view.objectId && !object.archived,
  );
  if (!object || isInternalBackOfficeObject(object.id))
    throw new Error("Choose a visible object for the view.");
  const fields = new Set(object.fields.map((field) => field.id));
  if (
    view.columns.some((id) => !fields.has(id)) ||
    !fields.has(view.sortField) ||
    Object.keys(view.filters).some((id) => !fields.has(id))
  )
    throw new Error("Choose fields from the selected object.");
  if (
    view.type === "kanban" &&
    !object.fields.some(
      (field) =>
        field.id === view.groupField &&
        (field.type === "select" ||
          (field.type === "relation" && !field.multiple)),
    )
  )
    throw new Error(
      "Choose a select or single-relation field for Kanban stages.",
    );
  if (
    view.type === "calendar" &&
    view.dateField !== "createdAt" &&
    view.dateField !== "updatedAt" &&
    !object.fields.some(
      (field) =>
        field.id === view.dateField &&
        (field.type === "date" || field.type === "datetime"),
    )
  )
    throw new Error("Choose a date field for the calendar.");
}

export function groupViewRecords(
  rows: BackOfficeRecord[],
  field: BackOfficeField,
  records: BackOfficeRecord[],
) {
  const values =
    field.type === "select"
      ? field.options
      : [
          ...new Set(
            rows.flatMap((record) =>
              typeof record.values[field.id] === "string" &&
              record.values[field.id]
                ? [String(record.values[field.id])]
                : [],
            ),
          ),
        ];
  return [...values, null].map((value) => ({
    value,
    label:
      value === null
        ? ""
        : field.type === "relation"
          ? String(
              records.find((record) => record.id === value)?.values.name ?? "",
            )
          : value,
    records: rows.filter(
      (record) => (record.values[field.id] || null) === value,
    ),
  }));
}

export function dayKey(date: Date) {
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}
export function recordDay(
  record: BackOfficeRecord,
  field: string,
): string | null {
  const value =
    field === "createdAt"
      ? record.createdAt
      : field === "updatedAt"
        ? record.updatedAt
        : record.values[field];
  if (typeof value !== "string" || !value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : dayKey(date);
}
export function calendarDays(
  anchor: Date,
  mode: BackOfficeView["calendarMode"],
  weekStart: number,
): Date[] {
  const first = new Date(
    anchor.getFullYear(),
    anchor.getMonth(),
    mode === "month" ? 1 : anchor.getDate(),
    12,
  );
  let count = mode === "day" ? 1 : 7;
  if (mode !== "day") {
    const offset = (first.getDay() - weekStart + 7) % 7;
    if (mode === "month")
      count =
        Math.ceil(
          (offset +
            new Date(
              anchor.getFullYear(),
              anchor.getMonth() + 1,
              0,
            ).getDate()) /
            7,
        ) * 7;
    first.setDate(first.getDate() - offset);
  }
  return Array.from(
    { length: count },
    (_, index) =>
      new Date(
        first.getFullYear(),
        first.getMonth(),
        first.getDate() + index,
        12,
      ),
  );
}
export function moveCalendarDate(
  value: unknown,
  field: BackOfficeField,
  day: string,
): string {
  if (field.type === "date") return day;
  const [year, month, date] = day.split("-").map(Number);
  const moved =
    typeof value === "string" && value
      ? new Date(value)
      : new Date(year, month - 1, date, 9);
  moved.setFullYear(year, month - 1, date);
  return moved.toISOString();
}
