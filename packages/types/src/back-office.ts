import { z } from "zod";
export { z } from "zod";

export const BACK_OFFICE_PROTOCOL = 1;
export const BACK_OFFICE_TEMPLATE = 4;
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
    "file",
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
export const BACK_OFFICE_FILE_LIMIT = 10 * 1024 * 1024;
export const BackOfficeFileSchema = z.object({
  id: z.string().uuid(),
  recordId: z.string().uuid(),
  fieldId: identifier,
  name: z
    .string()
    .min(1)
    .max(255)
    .regex(/^[^/\\\u0000-\u001f]+$/),
  size: z.number().int().min(1).max(BACK_OFFICE_FILE_LIMIT),
  sha256: z.string().regex(/^[a-f0-9]{64}$/),
  contentType: z.enum([
    "application/pdf",
    "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
    "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    "application/vnd.openxmlformats-officedocument.presentationml.presentation",
    "image/png",
    "image/jpeg",
    "image/gif",
    "image/webp",
    "text/plain",
    "text/markdown",
    "text/csv",
    "application/json",
    "application/octet-stream",
  ]),
});
export const BackOfficeFilesSchema = z.array(BackOfficeFileSchema).max(20);
export type BackOfficeFile = z.infer<typeof BackOfficeFileSchema>;

export const BackOfficeValueSchema = z.union([
  BackOfficeFilesSchema,
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
export const BackOfficeStoredRecordSchema = z.object({
  id: z.string().uuid(),
  objectId: identifier,
  values: z.record(identifier, BackOfficeValueSchema),
  sourceId: z.string().max(16000).nullable().optional(),
  revision: z.number().int().nonnegative(),
  schemaRevision: z.number().int().nonnegative(),
  access: z.enum(["org", "members"]).default("org"),
  members: z.array(z.string().min(1).max(200)).max(500).default([]),
  ownerId: z.string().min(1).max(200),
  createdAt: z.string().datetime(),
  updatedAt: z.string().datetime(),
  archivedAt: z.string().datetime().nullable(),
});
export const BackOfficeRecordSchema = BackOfficeStoredRecordSchema.transform(
  (record) => {
    // Retire the preview template's provider-specific field without losing import identity.
    const { actaportId, ...values } = record.values;
    return {
      ...record,
      values,
      sourceId:
        record.sourceId === undefined && typeof actaportId === "string"
          ? actaportId
          : record.sourceId,
    };
  },
);
export const BackOfficeViewSchema = z
  .object({
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
  })
  .transform((view) => ({
    ...view,
    columns: view.columns.filter((id) => id !== "actaportId"),
    widths: Object.fromEntries(
      Object.entries(view.widths).filter(([id]) => id !== "actaportId"),
    ),
    filters: Object.fromEntries(
      Object.entries(view.filters).filter(([id]) => id !== "actaportId"),
    ),
    sortField: view.sortField === "actaportId" ? "name" : view.sortField,
  }));
export type BackOfficeField = z.infer<typeof BackOfficeFieldSchema>;
export type BackOfficeObject = z.infer<typeof BackOfficeObjectSchema>;
export type BackOfficeModel = z.infer<typeof BackOfficeModelSchema>;
export type BackOfficeRecord = z.infer<typeof BackOfficeRecordSchema>;
export type BackOfficeValue = z.infer<typeof BackOfficeValueSchema>;
export type BackOfficeView = z.infer<typeof BackOfficeViewSchema>;
export type BackOfficeActor = {
  userId: string;
  principalKey?: string;
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
  changedMetadata: z.array(z.enum(["sourceId", "sharing", "archive"])).max(3).optional(),
  authorKey: z.string().min(1).max(300).optional(),
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
      ]),
      object("clients", "Client", "Clients", "clients", [
        field("clientNumber", "Client number"),
        selection("clientType", "Client type", ["Company", "Individual"]),
        relation("company", "Company", "companies"),
        relation("person", "Person", "people"),
        field("billingAddress", "Billing address"),
        field("billingEmail", "Billing email", "email"),
        field("buyerReference", "E-invoice buyer reference"),
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
      ]),
      object("projectLinks", "Project link", "Project links", "folder", [
        field("projectId", "Project ID", "text", { required: true }),
        relation("matter", "Matter", "matters"),
      ]),
      object("feeAgreements", "Fee agreement", "Fee agreements", "receipt", [
        ...billing(),
        field("signedAgreement", "Signed agreement", "file"),
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
      ]),
      object("invoices", "Invoice", "Invoices", "receipt", [
        ...billing(),
        field("invoiceFile", "Invoice PDF", "file"),
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
    if (field.type === "file") {
      const files = BackOfficeFilesSchema.safeParse(value);
      if (
        !files.success ||
        (!field.multiple && files.data.length > 1) ||
        new Set(files.data.map((file) => file.id)).size !== files.data.length
      )
        throw new Error(
          `Choose ${field.multiple ? "valid files" : "one file"} for ${field.label}.`,
        );
      continue;
    }
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
                ? Array.isArray(value) &&
                  value.every((item) => typeof item === "string")
                : typeof value === "string"
              : field.type === "multiselect"
                ? Array.isArray(value) &&
                  value.every((item) => typeof item === "string")
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
      value.some(
        (item) => typeof item !== "string" || !field.options.includes(item),
      )
    )
      throw new Error(`Choose existing ${field.label} options.`);
  }
  for (const field of object.fields.filter((field) => field.required)) {
    const value = values[field.id];
    if (
      values[field.id] === undefined ||
      values[field.id] === null ||
      (typeof values[field.id] === "string" &&
        !String(values[field.id]).trim()) ||
      (Array.isArray(value) && value.length === 0)
    )
      throw new Error(`${field.label} is required.`);
  }
}

export function visibleBackOfficeRecord(
  record: Pick<BackOfficeRecord, "objectId" | "ownerId" | "access" | "members">,
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
        if (!field) return false;
        return field.visibility === "private"
          ? record.ownerId === actor.userId
          : field?.visibility !== "finance" || actor.finance;
      }),
    ),
  };
}

/** Saved selection criteria must not disclose values of unreadable fields. */
export function readableBackOfficeView(view: BackOfficeView, model: BackOfficeModel, actor: BackOfficeActor, recordIds: ReadonlySet<string> = new Set()): BackOfficeView | null {
  const object = model.objects.find(object => object.id === view.objectId);
  if (!object || object.archived || (!actor.finance && ["feeAgreements", "billingItems", "invoices"].includes(object.id))) return null;
  const allowed = (id: string) => object.fields.some(field => field.id === id && field.visibility !== "private" && (field.visibility !== "finance" || actor.finance));
  return {
    ...view,
    columns: view.columns.filter(allowed),
    widths: Object.fromEntries(Object.entries(view.widths).filter(([id]) => allowed(id))),
    filters: Object.fromEntries(Object.entries(view.filters).filter(([id, value]) => {
      if (!allowed(id)) return false;
      if (object.fields.find(field => field.id === id)?.type !== "relation" || value === null) return true;
      return (Array.isArray(value) ? value : [value]).every(id => typeof id === "string" && recordIds.has(id));
    })),
    query: object.fields.some(field => !allowed(field.id)) ? "" : view.query,
    sortField: allowed(view.sortField) ? view.sortField : "name",
    groupField: view.groupField && allowed(view.groupField) ? view.groupField : null,
    dateField: view.dateField && allowed(view.dateField) ? view.dateField : null,
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
        ...object.fields.filter(
          (field) => !(field.protected && field.id === "actaportId"),
        ),
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
      Array.isArray(record.values.clients)
        ? record.values.clients.filter((id) => typeof id === "string")
        : [],
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

export const BACK_OFFICE_AUDIT_VERSION = 2;
export const BACK_OFFICE_AUDIT_GENESIS = "0".repeat(64);
export const BACK_OFFICE_AUDIT_EMPTY_STATE =
  "74234e98afe7498fb5daf1f36ac2d78acc339464f950703b8c019892f982b90b";
const digest = z.string().regex(/^[a-f0-9]{64}$/);
const base64 = z
  .string()
  .min(1)
  .max(2000)
  .regex(/^[A-Za-z0-9+/]+={0,2}$/);

export const BackOfficeAuditActorSchema = z
  .object({
    id: z.string().min(1).max(200),
    name: z.string().max(200).nullable(),
    kind: z.enum(["user", "agent", "system"]),
    identitySource: z.enum([
      "platform",
      "account-cache",
      "operating-system",
      "migration",
    ]),
    deviceId: z.string().uuid().nullable(),
    agentId: z.string().max(200).nullable(),
  })
  .strict();

export const BackOfficeAuditPayloadSchema = z
  .object({
    version: z.literal(BACK_OFFICE_AUDIT_VERSION),
    streamId: z.string().uuid(),
    sequence: z.number().int().positive().safe(),
    eventId: z.string().uuid(),
    recordedAt: z.string().datetime(),
    scope: z.string().min(1).max(200),
    actor: BackOfficeAuditActorSchema,
    action: z.string().min(1).max(100),
    entityType: z.enum([
      "record",
      "model",
      "view",
      "directory",
      "file",
      "proposal",
      "policy",
      "replica",
    ]),
    entityId: z.string().min(1).max(200),
    modelRevision: z.number().int().nonnegative().safe(),
    payloadNonce: digest,
    beforeNonce: digest.nullable(),
    afterNonce: digest.nullable(),
    before: z.json().nullable(),
    after: z.json().nullable(),
  })
  .strict()
  .refine(
    (payload) =>
      (payload.before === null) === (payload.beforeNonce === null) &&
      (payload.after === null) === (payload.afterNonce === null),
    "Only an empty state has no private commitment nonce.",
  );

// Proofs deliberately exclude record contents. They can be independently
// witnessed without uploading clients, matters, file names or model definitions.
export const BackOfficeAuditProofSchema = z
  .object({
    version: z.literal(BACK_OFFICE_AUDIT_VERSION),
    streamId: z.string().uuid(),
    eventId: z.string().uuid(),
    scopeKey: digest,
    sequence: z.number().int().positive().safe(),
    previousHash: digest,
    payloadHash: digest,
    entityType: z.enum([
      "record",
      "model",
      "view",
      "directory",
      "file",
      "proposal",
      "policy",
      "replica",
    ]),
    entityKey: digest,
    beforeHash: digest,
    afterHash: digest,
    hash: digest,
    publicKey: base64,
    signature: base64,
  })
  .strict();

export const BackOfficeAuditEntrySchema = z
  .object({
    payload: BackOfficeAuditPayloadSchema,
    proof: BackOfficeAuditProofSchema,
  })
  .strict();

export const BackOfficeAuditHeadSchema = z
  .object({
    streamId: z.string().uuid(),
    sequence: z.number().int().nonnegative().safe(),
    hash: digest,
    publicKey: base64,
  })
  .strict();

export type BackOfficeAuditActor = z.infer<typeof BackOfficeAuditActorSchema>;
export type BackOfficeAuditPayload = z.infer<
  typeof BackOfficeAuditPayloadSchema
>;
export type BackOfficeAuditProof = z.infer<typeof BackOfficeAuditProofSchema>;
export type BackOfficeAuditEntry = z.infer<typeof BackOfficeAuditEntrySchema>;
export type BackOfficeAuditHead = z.infer<typeof BackOfficeAuditHeadSchema>;

/** Deterministic, lossless encoding of the supported JSON value domain. */
export function canonicalBackOfficeAudit(
  value: z.infer<ReturnType<typeof z.json>>,
): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value))
    return `[${value.map(canonicalBackOfficeAudit).join(",")}]`;
  return `{${Object.keys(value)
    .sort()
    .map(
      (key) => `${JSON.stringify(key)}:${canonicalBackOfficeAudit(value[key])}`,
    )
    .join(",")}}`;
}

export const BackOfficeHistoryTargetSchema = z
  .object({
    type: z.enum(["record", "model", "view"]),
    id: z.string().min(1).max(200),
  })
  .strict()
  .refine(
    (target) =>
      target.type === "model"
        ? target.id === "model"
        : z.string().uuid().safeParse(target.id).success,
    "Choose a valid history target.",
  );
export const BackOfficeHistoryItemSchema = z
  .object({
    eventId: z.string().uuid(),
    entityType: z.enum(["record", "model", "view"]),
    entityId: z.string(),
    recordedAt: z.string().datetime(),
    actor: BackOfficeAuditActorSchema,
    action: z.string(),
    modelRevision: z.number().int().nonnegative(),
    before: z.json().nullable(),
    after: z.json().nullable(),
    beforeFields: z.array(BackOfficeFieldSchema),
    afterFields: z.array(BackOfficeFieldSchema),
    redacted: z.boolean(),
    // A redacted display is not the payload committed by the original proof.
    // Never attach a modified payload to a proof and claim that it verifies.
    payload: BackOfficeAuditPayloadSchema.nullable(),
    proof: BackOfficeAuditProofSchema,
  })
  .strict();
export const BackOfficeHistoryPageSchema = z.object({
  items: z.array(BackOfficeHistoryItemSchema),
  nextCursor: z.string().uuid().nullable(),
  heads: z.array(BackOfficeAuditHeadSchema),
  source: z.enum(["local", "platform"]),
  independentlyAcknowledged: z.boolean(),
});
export type BackOfficeHistoryItem = z.infer<typeof BackOfficeHistoryItemSchema>;
export type BackOfficeHistoryTarget = z.infer<
  typeof BackOfficeHistoryTargetSchema
>;
export const BackOfficeHistoryExportBodySchema = z
  .object({
    format: z.literal("legalwork.back-office.history.v2"),
    exportId: z.string().uuid(),
    exportedAt: z.string().datetime(),
    scope: z.string().min(1),
    target: BackOfficeHistoryTargetSchema,
    source: z.enum(["local", "platform"]),
    exportedBy: BackOfficeAuditActorSchema,
    heads: z.array(BackOfficeAuditHeadSchema),
    proofs: z.array(BackOfficeAuditProofSchema),
    items: z.array(BackOfficeHistoryItemSchema),
    withheldPayloads: z.number().int().nonnegative(),
  })
  .strict();
export const BackOfficeHistoryExportSchema = z
  .object({
    body: BackOfficeHistoryExportBodySchema,
    publicKey: base64,
    signature: base64,
  })
  .strict();
export type BackOfficeHistoryExportBody = z.infer<
  typeof BackOfficeHistoryExportBodySchema
>;
export type BackOfficeHistoryExport = z.infer<
  typeof BackOfficeHistoryExportSchema
>;
type HistoryRecord = z.infer<typeof BackOfficeStoredRecordSchema>;
type AuditJson = z.infer<ReturnType<typeof z.json>>;
const auditJson = (value: unknown): AuditJson =>
  z.json().parse(JSON.parse(JSON.stringify(value)));

function historyRecord(value: AuditJson | null): HistoryRecord | null {
  const direct = BackOfficeStoredRecordSchema.safeParse(value);
  if (direct.success) return direct.data;
  if (value && !Array.isArray(value) && typeof value === "object") {
    const wrapped = BackOfficeStoredRecordSchema.safeParse(value.data);
    if (wrapped.success) return wrapped.data;
  }
  return null;
}
function historyModel(value: AuditJson | null): BackOfficeModel | null {
  const direct = BackOfficeModelSchema.safeParse(value);
  if (direct.success) return direct.data;
  if (value && !Array.isArray(value) && typeof value === "object") {
    const wrapped = BackOfficeModelSchema.safeParse(value.model);
    if (wrapped.success) return wrapped.data;
  }
  return null;
}
function historyComparableRecord(value: AuditJson | null): AuditJson | null {
  if (
    value &&
    !Array.isArray(value) &&
    typeof value === "object" &&
    "data" in value
  ) {
    if (
      Object.keys(value).some(
        (key) => !["id", "object_id", "data", "revision", "seq"].includes(key),
      )
    )
      return value;
    return value.data;
  }
  return value;
}
function fieldReadable(
  field: BackOfficeField,
  record: HistoryRecord | null,
  actor: BackOfficeActor,
) {
  return field.visibility === "private"
    ? Boolean(record && record.ownerId === actor.userId)
    : field.visibility !== "finance" || actor.finance;
}

/** Shared by local/server history, agent tools and exports. Input entries must
 * already have their signatures, ordering and projection verified by the host. */
export function readableBackOfficeHistory(options: {
  entries: readonly BackOfficeAuditEntry[];
  model: BackOfficeModel;
  records: readonly HistoryRecord[];
  views: readonly BackOfficeView[];
  actor: BackOfficeActor;
  target: BackOfficeHistoryTarget;
  projectIds: ReadonlySet<string>;
}): BackOfficeHistoryItem[] {
  const { actor, target } = options;
  const currentRecords = new Map(
    options.records.map((record) => [record.id, record]),
  );
  const historicalRecords = new Map<string, HistoryRecord>();
  const models = new Map<number, BackOfficeModel>();
  const result: BackOfficeHistoryItem[] = [];
  const readable = (
    record: HistoryRecord,
    records: ReadonlyMap<string, HistoryRecord>,
    visited = new Set<string>(),
  ): boolean => {
    if (visited.has(record.id) || !visibleBackOfficeRecord(record, actor))
      return false;
    visited.add(record.id);
    if (
      record.objectId === "projectLinks" &&
      (typeof record.values.projectId !== "string" ||
        !options.projectIds.has(record.values.projectId))
    )
      return false;
    const matter = record.values.matter;
    if (typeof matter !== "string" || matter === record.id) return true;
    const parent = records.get(matter),
      currentParent = currentRecords.get(matter);
    return Boolean(
      parent &&
        currentParent &&
        readable(parent, records, visited) &&
        readable(currentParent, currentRecords, new Set()),
    );
  };
  const current = currentRecords.get(target.id);
  const currentObject =
    current &&
    options.model.objects.find((object) => object.id === current.objectId);
  if (
    target.type === "record" &&
    (!current ||
      !currentObject ||
      (currentObject.archived && !actor.model) ||
      !readable(current, currentRecords))
  )
    return [];
  if (target.type === "model" && !actor.model) return [];
  const currentView =
    target.type === "view"
      ? options.views.find((view) => view.id === target.id)
      : null;
  const viewObject =
    currentView &&
    options.model.objects.find((object) => object.id === currentView.objectId);
  if (
    target.type === "view" &&
    (!currentView ||
      !viewObject ||
      viewObject.archived ||
      (!actor.finance &&
        ["feeAgreements", "billingItems", "invoices"].includes(viewObject.id)))
  )
    return [];

  const recordSide = (
    record: HistoryRecord | null,
    state: ReadonlyMap<string, HistoryRecord>,
  ) => {
    if (!record) return { value: null, fields: [] };
    const now = currentRecords.get(record.id);
    if (!now || !readable(now, currentRecords) || !readable(record, state))
      return { value: null, fields: [] };
    const oldObject = models
      .get(record.schemaRevision)
      ?.objects.find((object) => object.id === record.objectId);
    const newObject = options.model.objects.find(
      (object) => object.id === record.objectId,
    );
    if (!oldObject || !newObject) return { value: null, fields: [] };
    const fields: BackOfficeField[] = [];
    const values = Object.fromEntries(
      Object.entries(record.values).flatMap(([id, value]) => {
        const oldField = oldObject.fields.find((field) => field.id === id),
          newField = newObject.fields.find((field) => field.id === id);
        if (
          !oldField ||
          !fieldReadable(oldField, record, actor) ||
          (newField ? !fieldReadable(newField, now, actor) : !actor.model)
        )
          return [];
        fields.push(oldField);
        if (oldField.type !== "relation" || value === null)
          return [[id, value]];
        const allowed = (relatedId: string) => {
          const then = state.get(relatedId),
            latest = currentRecords.get(relatedId);
          return Boolean(
            then &&
              latest &&
              readable(then, state) &&
              readable(latest, currentRecords),
          );
        };
        if (typeof value === "string")
          return allowed(value) ? [[id, value]] : [];
        if (
          Array.isArray(value) &&
          value.every((item) => typeof item === "string")
        )
          return [[id, value.filter(allowed)]];
        return [];
      }),
    );
    return { value: auditJson({ ...record, values }), fields };
  };
  const viewSide = (value: AuditJson | null, revision: number) => {
    const parsed = BackOfficeViewSchema.safeParse(value);
    if (!parsed.success) return { value: null, fields: [] };
    const view = parsed.data;
    const oldObject = models
      .get(revision)
      ?.objects.find((object) => object.id === view.objectId);
    const newObject = options.model.objects.find(
      (object) => object.id === view.objectId,
    );
    if (!oldObject || !newObject) return { value: null, fields: [] };
    const allowed = (id: string) => {
      const before = oldObject.fields.find((field) => field.id === id),
        after = newObject.fields.find((field) => field.id === id);
      return Boolean(
        before &&
          after &&
          fieldReadable(before, null, actor) &&
          fieldReadable(after, null, actor),
      );
    };
    return {
      value: auditJson({
        ...view,
        query: oldObject.fields.every((field) => allowed(field.id))
          ? view.query
          : "",
        columns: view.columns.filter(allowed),
        widths: Object.fromEntries(
          Object.entries(view.widths).filter(([id]) => allowed(id)),
        ),
        filters: Object.fromEntries(
          Object.entries(view.filters).filter(([id, value]) => {
            if (!allowed(id)) return false;
            const field = oldObject.fields.find(field => field.id === id);
            if (field?.type !== "relation" || value === null) return true;
            return (Array.isArray(value) ? value : [value]).every(id => {
              const then = typeof id === "string" ? historicalRecords.get(id) : null;
              const now = typeof id === "string" ? currentRecords.get(id) : null;
              return then && now && readable(then, historicalRecords) && readable(now, currentRecords);
            });
          }),
        ),
        sortField: allowed(view.sortField) ? view.sortField : "name",
        groupField:
          view.groupField && allowed(view.groupField) ? view.groupField : null,
        dateField:
          view.dateField && allowed(view.dateField) ? view.dateField : null,
      }),
      fields: [],
    };
  };
  let activeModelRevision = 0;
  let activeStream = "";
  for (const entry of options.entries) {
    const payload = entry.payload;
    if (activeStream !== payload.streamId) {
      activeStream = payload.streamId;
      historicalRecords.clear();
      models.clear();
      activeModelRevision = 0;
      // Baseline rows describe one snapshot. Their SQL enumeration order must
      // not turn an existing parent into an apparently missing relationship.
      for (const baseline of options.entries) {
        if (
          baseline.payload.streamId !== activeStream ||
          !baseline.payload.action.startsWith("baseline.")
        )
          continue;
        if (baseline.payload.entityType === "record") {
          const record = historyRecord(baseline.payload.after);
          if (record) historicalRecords.set(record.id, record);
        }
        if (baseline.payload.entityType === "model") {
          const model = historyModel(baseline.payload.after);
          if (model) {
            models.set(model.revision, model);
            activeModelRevision = model.revision;
          }
        }
      }
    }
    const previousModelRevision = activeModelRevision;
    if (payload.entityType === "model") {
      for (const value of [payload.before, payload.after]) {
        const model = historyModel(value);
        if (model) {
          models.set(model.revision, model);
          activeModelRevision = model.revision;
        }
      }
    }
    const beforeRecord =
      payload.entityType === "record" ? historyRecord(payload.before) : null;
    const afterRecord =
      payload.entityType === "record" ? historyRecord(payload.after) : null;
    const selectedRecord =
      target.type === "record" &&
      payload.entityType === "record" &&
      (payload.entityId === target.id ||
        [beforeRecord, afterRecord].some(
          (record) =>
            record?.objectId === "projectLinks" &&
            record.values.matter === target.id,
        ));
    const beforeDisplay = selectedRecord
      ? recordSide(beforeRecord, historicalRecords)
      : null;
    if (payload.entityType === "record") {
      if (afterRecord) historicalRecords.set(afterRecord.id, afterRecord);
      else if (beforeRecord) historicalRecords.delete(beforeRecord.id);
    }
    let before: { value: AuditJson | null; fields: BackOfficeField[] },
      after: typeof before;
    if (target.type === "record") {
      if (!beforeDisplay) continue;
      before = beforeDisplay;
      after = recordSide(afterRecord, historicalRecords);
    } else if (target.type === "model") {
      if (payload.entityType !== "model") continue;
      before = {
        value: historyModel(payload.before)
          ? auditJson(historyModel(payload.before))
          : null,
        fields: [],
      };
      after = {
        value: historyModel(payload.after)
          ? auditJson(historyModel(payload.after))
          : null,
        fields: [],
      };
    } else {
      const embedded = (value: AuditJson | null) => {
        if (!value || Array.isArray(value) || typeof value !== "object")
          return null;
        const views = z.array(BackOfficeViewSchema).safeParse(value.views);
        return views.success
          ? auditJson(views.data.find((view) => view.id === target.id) ?? null)
          : null;
      };
      if (payload.entityType === "view" && payload.entityId === target.id) {
        before = viewSide(payload.before, previousModelRevision);
        after = viewSide(payload.after, activeModelRevision);
      } else if (payload.entityType === "model") {
        const old = embedded(payload.before),
          next = embedded(payload.after);
        if (canonicalBackOfficeAudit(old) === canonicalBackOfficeAudit(next))
          continue;
        before = viewSide(old, previousModelRevision);
        after = viewSide(next, activeModelRevision);
      } else continue;
    }
    if (before.value === null && after.value === null) continue;
    // Server row envelopes and field-filtered displays are deliberately not
    // represented as the original signed payload.
    const originalBefore =
      target.type === "record"
        ? historyComparableRecord(payload.before)
        : payload.before;
    const originalAfter =
      target.type === "record"
        ? historyComparableRecord(payload.after)
        : payload.after;
    const redacted =
      canonicalBackOfficeAudit(before.value) !==
        canonicalBackOfficeAudit(originalBefore) ||
      canonicalBackOfficeAudit(after.value) !==
        canonicalBackOfficeAudit(originalAfter);
    result.push({
      eventId: payload.eventId,
      entityType: target.type,
      entityId: target.type === "view" ? target.id : payload.entityId,
      recordedAt: payload.recordedAt,
      actor: payload.actor,
      action: payload.action,
      modelRevision: payload.modelRevision,
      before: before.value,
      after: after.value,
      beforeFields: before.fields,
      afterFields: after.fields,
      redacted,
      payload: redacted ? null : payload,
      proof: entry.proof,
    });
  }
  return result.reverse();
}

export function pageBackOfficeHistory(
  items: readonly BackOfficeHistoryItem[],
  limit = 50,
  cursor?: string | null,
) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100)
    throw new Error("Choose a history page size between 1 and 100.");
  const start = cursor
    ? items.findIndex((item) => item.eventId === cursor) + 1
    : 0;
  if (cursor && start === 0)
    throw new Error(
      "History access changed. Refresh the history before continuing.",
    );
  const page = items.slice(start, start + limit);
  return {
    items: page,
    nextCursor:
      start + page.length < items.length ? page.at(-1)!.eventId : null,
  };
}

export function backOfficeHistoryDisplayMatchesPayload(
  item: BackOfficeHistoryItem,
): boolean {
  const payload = item.payload;
  if (
    !payload ||
    item.redacted ||
    payload.eventId !== item.eventId ||
    payload.entityType !== item.entityType ||
    payload.entityId !== item.entityId ||
    payload.action !== item.action ||
    payload.recordedAt !== item.recordedAt ||
    payload.modelRevision !== item.modelRevision ||
    canonicalBackOfficeAudit(payload.actor) !==
      canonicalBackOfficeAudit(item.actor)
  )
    return false;
  const before =
    item.entityType === "record"
      ? historyComparableRecord(payload.before)
      : payload.before;
  const after =
    item.entityType === "record"
      ? historyComparableRecord(payload.after)
      : payload.after;
  return (
    canonicalBackOfficeAudit(before) ===
      canonicalBackOfficeAudit(item.before) &&
    canonicalBackOfficeAudit(after) === canonicalBackOfficeAudit(item.after)
  );
}
