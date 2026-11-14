import { invoiceTemplateSchema } from "@legalwork/types/invoice-template";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  TimeAdjustmentSchema,
  TimeEntrySchema,
  TimePolicySchema,
  TimesheetStateSchema,
  resolveTimePolicy,
  type TimePolicy,
  type TimeEntry,
  type TimesheetState,
} from "@legalwork/types/timesheet";
import { ApiError } from "../errors.js";
import {
  BackOfficeRecordSchema,
  defaultBackOfficeValues,
  type BackOfficeActor,
  type BackOfficeRecord,
} from "./schema.js";
import type { BackOfficeStore } from "./store.js";

const invoice = TimesheetStateSchema.shape.invoices.element;
const product = TimesheetStateSchema.shape.products.element;
export const DocumentSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("adjustment"),
    id: z.string(),
    value: TimeAdjustmentSchema,
    document: z.string().optional(),
  }),
  z.object({
    kind: z.literal("entry"),
    id: z.string(),
    value: TimeEntrySchema,
  }),
  z.object({
    kind: z.literal("policy"),
    id: z.string(),
    value: TimePolicySchema,
  }),
  z.object({
    kind: z.literal("template"),
    id: z.string(),
    value: invoiceTemplateSchema,
  }),
  z.object({ kind: z.literal("product"), id: z.string(), value: product }),
  z.object({
    kind: z.literal("invoice"),
    id: z.string(),
    value: invoice,
    document: z.string(),
  }),
  z.object({ kind: z.literal("request"), id: z.string(), digest: z.string() }),
]);
export type TimeDocument = z.infer<typeof DocumentSchema>;
export function writeTimeDocument(store: BackOfficeStore, scope: string, doc: TimeDocument) {
  store.db.run(
    "INSERT INTO bo_timesheets(scope,id,data) VALUES(?,?,?) ON CONFLICT(scope,id) DO UPDATE SET data=excluded.data",
    [scope, doc.id, JSON.stringify(doc)],
  );
}
export function readTimeDocument(store: BackOfficeStore, scope: string, id: string) {
  const row = store.db.get("SELECT data FROM bo_timesheets WHERE scope=? AND id=?", [scope, id]);
  return row ? DocumentSchema.parse(JSON.parse(String(row.data))) : null;
}
export function timeError(message: string, status = 400): never {
  throw new ApiError(status, "timesheet", message);
}
export type TimeDirectory = Pick<TimesheetState, "clients" | "matters" | "projects" | "people">;
const ids = (value: BackOfficeRecord["values"][string]) =>
  typeof value === "string"
    ? [value]
    : Array.isArray(value)
      ? value.filter((v): v is string => typeof v === "string")
      : [];
export function timeDirectory(
  store: BackOfficeStore,
  scope: string,
  actor: BackOfficeActor,
  people: TimeDirectory["people"],
  workspaces: TimeDirectory["projects"] = [],
): TimeDirectory {
  const options = (object: string) => store.records(scope, actor, object);
  const projects = new Map<string, TimeDirectory["projects"][number]>();
  for (const record of options("projectLinks")) {
    const { projectId, matter, name } = record.values;
    if (typeof projectId !== "string" || typeof matter !== "string") continue;
    const project = projects.get(projectId) ?? {
      id: projectId,
      name: String(name || projectId),
      matterIds: [],
    };
    project.matterIds.push(matter);
    projects.set(projectId, project);
  }
  const visibleMatters = options("matters");
  const visibleIds = new Set(visibleMatters.map((m) => m.id));
  for (const w of workspaces) {
    const matterIds = [
      ...new Set([
        ...(projects.get(w.id)?.matterIds ?? []),
        ...w.matterIds.filter((m) => visibleIds.has(m)),
      ]),
    ];
    if (matterIds.length) projects.set(w.id, { ...w, matterIds });
  }
  return {
    people,
    projects: [...projects.values()],
    clients: options("clients").map((r) => ({
      id: r.id,
      name: String(r.values.name),
    })),
    matters: visibleMatters.map((r) => ({
      id: r.id,
      name: String(r.values.name),
      reference: String(r.values.fileNumber ?? ""),
      clientIds: ids(r.values.clients),
    })),
  };
}

function legacyEntry(record: BackOfficeRecord): TimeEntry | null {
  const v = record.values;
  const date = String(v.startedAt ?? record.createdAt).slice(0, 10),
    activity = "LEGACY";
  const status = (
    {
      Draft: "confirmed",
      Submitted: "submitted",
      Approved: "approved",
      Invoiced: "invoiced",
      "Written off": "approved",
    } as const
  )[String(v.status || "Draft") as "Draft"];
  const draft = {
    date,
    matterId: v.matter,
    clientId: v.client ?? "",
    activity,
    narrative: v.billingNarrative || v.name,
    workedMinutes: v.recordedMinutes,
    billableMinutes: v.billableMinutes ?? 0,
    billable: Number(v.billableMinutes ?? 0) > 0,
  };
  if (!v.startedAt) return null; // A creation timestamp is not evidence of a historical service date.
  const row = TimeEntrySchema.safeParse({
    ...draft,
    id: record.id,
    revision: record.revision,
    workerId: record.ownerId,
    authorId: record.ownerId,
    source: "manual",
    legacy: true,
    status,
    history: [],
    ...(typeof v.startedAt === "string" && typeof v.endedAt === "string"
      ? { startAt: v.startedAt, endAt: v.endedAt }
      : {}),
  });
  return row.success ? row.data : null;
}

export function readTimesheet(
  store: BackOfficeStore,
  scope: string,
  actor: BackOfficeActor,
  people: TimeDirectory["people"],
  workspaces: TimeDirectory["projects"] = [],
  forMutation = false,
): TimesheetState {
  const directory = timeDirectory(store, scope, actor, people, workspaces),
    matters = new Set(directory.matters.map((m) => m.id)),
    clients = new Set(directory.clients.map((c) => c.id)),
    projects = new Set(directory.projects.map((p) => p.id));
  const docs = store.db
    .all("SELECT data FROM bo_timesheets WHERE scope=?", [scope])
    .map((row) => DocumentSchema.parse(JSON.parse(String(row.data))));
  const policies: TimePolicy[] = [];
  for (const doc of docs) {
    if (doc.kind !== "policy") continue;
    const p = doc.value;
    if (
      p.scope === "firm" ||
      (p.scope === "client" ? clients : p.scope === "matter" ? matters : projects).has(p.targetId)
    )
      policies.push(p);
  }
  // Existing signed hourly agreements remain effective in the absence of an explicit override.
  // Select only terms for accessible relationships. A worker may inherit an increment without reading the finance record or rate.
  const agreements = store.db
    .all(
      "SELECT data FROM bo_records WHERE scope=? AND object_id='feeAgreements' AND json_extract(data,'$.archivedAt') IS NULL",
      [scope],
    )
    .map((row) => BackOfficeRecordSchema.parse(JSON.parse(String(row.data))))
    .filter((r) => r.access === "org" || r.ownerId === actor.userId || r.members.includes(actor.userId));
  for (const r of agreements) {
    const { client, matter, hourlyRate, incrementMinutes, basis } = r.values;
    if ((!client && !matter) || (basis && basis !== "Hourly")) continue;
    if (
      (typeof client === "string" && !clients.has(client)) ||
      (typeof matter === "string" && !matters.has(matter))
    )
      continue;
    const found = policies.some(
      (p) =>
        p.scope === (matter ? "matter" : "client") &&
        p.targetId === (matter || client) &&
        p.agreementClientId === (matter && typeof client === "string" ? client : undefined) &&
        p.revision === 0 &&
        p.effectiveFrom === "0001-01-01",
    );
    if (found) continue;
    const values = TimePolicySchema.safeParse({
      scope: matter ? "matter" : "client",
      targetId: matter || client,
      ...(matter && typeof client === "string" ? { agreementClientId: client } : {}),
      effectiveFrom: "0001-01-01",
      revision: 0,
      ...(!matter &&
      Array.isArray(r.values.signedAgreement) &&
      r.values.signedAgreement.length &&
      typeof incrementMinutes === "number"
        ? { bindingIncrement: true }
        : {}),
      ...(typeof incrementMinutes === "number" ? { incrementMinutes } : {}),
      ...(hourlyRate && typeof hourlyRate === "object" && "amountMinor" in hourlyRate
        ? {
            hourlyRate: hourlyRate.amountMinor / 100,
            currency: hourlyRate.currency,
          }
        : {}),
    });
    if (values.success) policies.push(values.data);
  }
  const entries = docs.flatMap((doc) => (doc.kind === "entry" ? [doc.value] : []));
  const managed = new Set(entries.map((e) => e.id));
  for (const r of store.records(scope, actor, "timeEntries")) {
    const legacy = !managed.has(r.id) && legacyEntry(r);
    if (legacy) entries.push(legacy);
  }
  const visible = entries.filter(
    (e) =>
      matters.has(e.matterId) &&
      (!e.clientId || clients.has(e.clientId)) &&
      (e.workerId === actor.userId ||
        (actor.finance &&
          ["submitted", "approved", "invoiced"].includes(e.status) &&
          resolveTimePolicy(policies, e.clientId, e.matterId, e.date, e.projectId).reviewerId ===
            actor.userId)),
  );
  return {
    scope,
    template: actor.finance ? docs.find((doc) => doc.kind === "template")?.value : undefined,
    userId: actor.userId,
    canManage: actor.finance && actor.edit,
    canReview: actor.finance,
    ...directory,
    policies:
      actor.finance || forMutation
        ? policies
        : policies.map(({ hourlyRate, workerRates, currency, ...rules }) => rules),
    adjustments: docs.flatMap((doc) =>
      doc.kind === "adjustment" && visible.some((e) => e.id === doc.value.entryId)
        ? [
            {
              ...doc.value,
              deltaAmount: actor.finance || forMutation ? doc.value.deltaAmount : null,
              currency: actor.finance || forMutation ? doc.value.currency : undefined,
            },
          ]
        : [],
    ),
    products: docs.flatMap((d) =>
      d.kind === "product" && matters.has(d.value.matterId) ? [d.value] : [],
    ),
    entries:
      actor.finance || forMutation
        ? visible
        : visible.map((e) => ({
            ...e,
            hourlyRate: undefined,
            currency: undefined,
            history: e.history.map((h) => ({
              ...h,
              before: h.before ? { ...h.before, hourlyRate: undefined, currency: undefined } : null,
              after: { ...h.after, hourlyRate: undefined, currency: undefined },
            })),
          })),
    invoices: docs.flatMap((d) =>
      actor.finance &&
      d.kind === "invoice" &&
      d.value.entries.every((e) => matters.has(e.matterId) && clients.has(e.clientId))
        ? [d.value]
        : [],
    ),
  };
}

const productForActivity: Readonly<
  Record<string, NonNullable<TimesheetState["products"][number]["productType"]>>
> = {
  DFT: "document",
  EML: "email",
  EMX: "email",
  EMI: "email",
  PLE: "pleading",
  LS: "letter",
  LL: "letter",
  DDR: "report",
};
export function ensureProduct(
  store: BackOfficeStore,
  scope: string,
  state: TimesheetState,
  authorId: string,
  entry: Pick<
    TimeEntry,
    "createWorkProduct" | "workProductId" | "workProductTitle" | "matterId" | "activity" | "narrative"
  >,
) {
  if (entry.createWorkProduct && (entry.workProductId || !entry.workProductTitle))
    timeError("Enter a new work product title without an existing product ID.");
  if (entry.workProductId) {
    const p = state.products.find((p) => p.id === entry.workProductId && p.matterId === entry.matterId);
    if (!p) timeError("Select a work product in this matter.");
    return p;
  }
  const name =
    entry.workProductTitle ||
    (Object.hasOwn(productForActivity, entry.activity) ? entry.narrative.slice(0, 240) : null);
  if (!name) return undefined;
  if (!entry.createWorkProduct) {
    const matches = state.products.filter(
      (p) => p.matterId === entry.matterId && p.name.toLowerCase() === name.toLowerCase(),
    );
    if (matches.length > 1)
      timeError(
        "Several work products have this title. Select the specific work product or create a new one.",
        409,
      );
    if (matches.length === 1) return matches[0];
  }
  const value = {
    name,
    id: randomUUID(),
    matterId: entry.matterId,
    authorId,
    createdAt: new Date().toISOString(),
    productType: Object.hasOwn(productForActivity, entry.activity)
      ? productForActivity[entry.activity]
      : ("document" as const),
  };
  writeTimeDocument(store, scope, { id: value.id, kind: "product", value });
  state.products.push(value);
  return value;
}
export function writeEntry(
  store: BackOfficeStore,
  scope: string,
  actor: BackOfficeActor,
  previous: TimeEntry | null,
  entry: TimeEntry,
  action: string,
  reason?: string,
) {
  const snap = (e: TimeEntry) => ({
    date: e.date,
    matterId: e.matterId,
    clientId: e.clientId,
    projectId: e.projectId,
    activity: e.activity,
    activityLabel: e.activityLabel,
    narrative: e.narrative,
    workedMinutes: e.workedMinutes,
    billable: e.billable,
    billableMinutes: e.billableMinutes,
    workProductId: e.workProductId,
    workProductTitle: e.workProductTitle,
    startAt: e.startAt,
    endAt: e.endAt,
    status: e.status,
    policyDigest: e.policyDigest,
    hourlyRate: e.hourlyRate,
    currency: e.currency,
  });
  entry.revision = (previous?.revision ?? 0) + 1;
  entry.history = [
    ...(previous?.history ?? []),
    {
      actorId: actor.userId,
      at: new Date().toISOString(),
      action,
      reason,
      revision: entry.revision,
      before: previous ? snap(previous) : null,
      after: snap(entry),
    },
  ];
  entry.legacy = false;
  writeTimeDocument(store, scope, {
    id: entry.id,
    kind: "entry",
    value: entry,
  });
  const status = {
    pending: "Draft",
    confirmed: "Draft",
    declined: "Written off",
    submitted: "Submitted",
    approved: "Approved",
    invoiced: "Invoiced",
  }[entry.status];
  projectBillingRecord(store, scope, entry.id, "timeEntries", entry.workerId, {
    name: entry.narrative.slice(0, 240),
    billingNarrative: entry.narrative,
    matter: entry.matterId,
    client: entry.clientId || null,
    startedAt: entry.startAt ?? null,
    endedAt: entry.endAt ?? null,
    recordedMinutes: entry.workedMinutes,
    billableMinutes: entry.billableMinutes,
    status,
    ...(entry.hourlyRate !== undefined && entry.currency
      ? {
          hourlyRate: {
            amountMinor: Math.round(entry.hourlyRate * 100),
            currency: entry.currency,
          },
        }
      : {}),
  });
}

// Local projections preserve historic files and custom fields. They never enter the generic sync outbox.
export function projectBillingRecord(
  store: BackOfficeStore,
  scope: string,
  id: string,
  objectId: "timeEntries" | "invoices",
  ownerId: string,
  values: BackOfficeRecord["values"],
) {
  const existing = store.raw(scope, id),
    model = store.model(scope),
    object = model.objects.find((o) => o.id === objectId);
  if (!object || object.archived) timeError("The corresponding billing object is unavailable.", 409);
  const now = new Date().toISOString(),
    record = BackOfficeRecordSchema.parse({
      ...existing,
      id,
      objectId,
      ownerId,
      revision: (existing?.revision ?? 0) + 1,
      schemaRevision: model.revision,
      values: {
        ...(existing?.values ?? defaultBackOfficeValues(object)),
        ...values,
      },
      sourceId: existing?.sourceId ?? null,
      createdAt: existing?.createdAt ?? now,
      updatedAt: now,
      archivedAt: null,
      access: existing?.access ?? "members",
      members: existing?.members ?? [],
    });
  store.db.run(
    "INSERT INTO bo_records(scope,id,object_id,data) VALUES(?,?,?,?) ON CONFLICT(scope,id) DO UPDATE SET data=excluded.data",
    [scope, id, objectId, JSON.stringify(record)],
  );
}
