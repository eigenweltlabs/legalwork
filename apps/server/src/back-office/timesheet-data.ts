import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  invoiceTemplateSchema,
  DelegatedTimeEntrySchema,
  TimeAdjustmentSchema,
  TimeEntrySchema,
  TimePolicySchema,
  TimesheetStateSchema,
  resolveTimePolicy,
  type TimePolicy,
  type TimeEntry,
  type TimesheetState,
} from "./timesheet-schema.js";
import { ApiError } from "../errors.js";
import { readProjectDetails } from "../project-store.js";
import type { ServerConfig } from "../types.js";
import {
  BackOfficeRecordSchema,
  backOfficeMajorAmount,
  backOfficeMoneyFromMajor,
  defaultBackOfficeValues,
  readableBackOfficeRecord,
  type BackOfficeActor,
  type BackOfficeRecord,
} from "./schema.js";
import type { BackOfficeStore } from "./store.js";
import { timeMemberUserId } from "./time-member-identity.js";

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
export function timeWorkspaces(workspaces: ServerConfig["workspaces"], directoryId: string) {
  return Promise.all(workspaces.map(async (workspace) => {
    const details = await readProjectDetails(workspace.path);
    const references = (objectId: string) => details.fields.flatMap((field) =>
      field.type === "backoffice" && field.objectId === objectId && field.value?.directoryId === directoryId
        ? field.value.recordIds
        : [],
    );
    return {
      id: workspace.id,
      name: workspace.displayName || workspace.name,
      matterIds: references("matters"),
      agreementIds: references("feeAgreements"),
    };
  }));
}
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

const serviceDay = z.iso.date();
const clockInstant = z.iso.datetime({ offset: true });

function legacyServiceDate(values: BackOfficeRecord["values"]) {
  if (typeof values.serviceDate === "string" && serviceDay.safeParse(values.serviceDate).success)
    return values.serviceDate;
  const started = values.startedAt;
  if (typeof started !== "string") return undefined;
  if (serviceDay.safeParse(started).success) return started;
  if (/^\d{4}-\d{2}-\d{2}[T ]/.test(started) && Number.isFinite(Date.parse(started)) &&
      serviceDay.safeParse(started.slice(0, 10)).success)
    return started.slice(0, 10);
}

function legacyEntry(record: BackOfficeRecord, workerId: string): TimeEntry | null {
  const v = record.values;
  const date = legacyServiceDate(v);
  if (!date) return null;
  if (v.status && !["Draft", "Submitted", "Approved", "Invoiced", "Written off"].some((status) => status === v.status)) return null;
  const status = v.status === "Approved" || v.status === "Written off" ? "approved"
    : v.status === "Invoiced" ? "invoiced"
    : workerId === record.ownerId ? "confirmed" : "pending";
  const start = clockInstant.safeParse(v.startedAt), end = clockInstant.safeParse(v.endedAt);
  const row = TimeEntrySchema.safeParse({
    date,
    matterId: v.matter,
    clientId: v.client ?? "",
    activity: "LEGACY",
    narrative: v.billingNarrative || v.name,
    workedMinutes: v.recordedMinutes,
    billableMinutes: v.billableMinutes ?? 0,
    billable: Number(v.billableMinutes ?? 0) > 0,
    id: record.id,
    revision: record.revision,
    workerId,
    authorId: record.ownerId,
    source: "manual",
    legacy: true,
    status,
    history: [],
    ...(start.success && end.success ? { startAt: start.data, endAt: end.data } : {}),
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
    if (!client && !matter) continue;
    if (
      (typeof client === "string" && !clients.has(client)) ||
      (typeof matter === "string" && !matters.has(matter))
    )
      continue;
    const values = TimePolicySchema.safeParse({
      scope: matter ? "matter" : "client",
      targetId: matter || client,
      agreementId: r.id,
      agreementProjects: directory.projects
        .filter((p) => p.agreementIds?.includes(r.id))
        .map((p) => p.id),
      allocationUnavailable: Boolean(basis && basis !== "Hourly") || !hourlyRate,
      ...(basis === "Flat fee" || basis === "Flat fee with included time" || basis === "RVG"
        ? { nonHourlyAgreement: true }
        : {}),
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
            hourlyRate: backOfficeMajorAmount(hourlyRate),
            currency: hourlyRate.currency,
          }
        : {}),
    });
    if (values.success) policies.push(values.data);
  }
  const entries = docs.flatMap((doc) => (doc.kind === "entry" ? [doc.value] : []));
  const managed = new Set(entries.map((e) => e.id));
  const canSeeReferences = (e: Pick<TimeEntry, "clientId" | "matterId">) =>
    matters.has(e.matterId) && (!e.clientId || clients.has(e.clientId));
  const unresolvedLegacyEntries: string[] = [];
  const timeObject = store.model(scope).objects.find((object) => object.id === "timeEntries" && !object.archived);
  if (timeObject) for (const row of store.db.all("SELECT data FROM bo_records WHERE scope=? AND object_id='timeEntries'", [scope])) {
    const record = BackOfficeRecordSchema.parse(JSON.parse(String(row.data)));
    if (managed.has(record.id) || record.archivedAt) continue;
    const { timekeeper } = record.values;
    const contact = typeof timekeeper === "string" ? store.raw(scope, timekeeper) : null;
    const linkedUser = contact && !contact.archivedAt && contact.values.active !== false && store.canRead(scope, contact, actor)
      ? timeMemberUserId(scope, contact) : undefined;
    const workerId = timekeeper == null || timekeeper === "" ? record.ownerId
      : linkedUser && (linkedUser === actor.userId || people.some((person) => person.id === linkedUser && !person.directoryOnly))
        ? linkedUser : undefined;
    // The worker may see their own pending workflow row through the ordinary sharing and matter gates.
    // Keep the generic record and its private fields subject to the original owner's permissions.
    if (!store.canRead(scope, record, actor) &&
        !(workerId === actor.userId && (record.access === "org" || record.members.includes(actor.userId)))) continue;
    const readable = readableBackOfficeRecord(record, timeObject, actor);
    const legacy = legacyEntry(readable, workerId ?? record.ownerId);
    if (!legacy || !canSeeReferences(legacy)) continue;
    if (workerId) entries.push(legacy);
    else if (record.ownerId === actor.userId && legacy.status === "confirmed") unresolvedLegacyEntries.push(record.id);
  }
  const visible = entries.filter(
    (e) =>
      canSeeReferences(e) &&
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
    ...(unresolvedLegacyEntries.length ? { unresolvedLegacyEntries } : {}),
    supportsBillingComparisons: true,
    supportsTimeAllocations: true,
    canManage: actor.model && actor.finance && actor.edit,
    canReview: actor.finance,
    ...directory,
    projects: directory.projects.map(({ agreementIds: _, ...project }) => project),
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
    delegatedEntries: forMutation ? undefined : entries.flatMap((entry) => {
      if (entry.authorId !== actor.userId || entry.workerId === actor.userId || !entry.groupId) return [];
      const created = entry.history[0];
      if (
        !created || created.revision !== 1 || created.action !== "create" ||
        created.actorId !== actor.userId || created.before !== null ||
        !canSeeReferences(created.after) || (created.after.projectId && !projects.has(created.after.projectId))
      ) return [];
      if (scope === "local" && !directory.people.some((person) => person.id === entry.workerId)) {
        const worker = store.raw(scope, entry.workerId);
        if (worker?.objectId === "people" && (worker.archivedAt || !store.canRead(scope, worker, actor))) return [];
      }
      return [DelegatedTimeEntrySchema.parse({
        ...created.after,
        id: entry.id,
        groupId: entry.groupId,
        workerId: entry.workerId,
        createdAt: created.at,
      })];
    }),
    entries: forMutation
      ? visible
      : visible.map((e) => {
          const financial = actor.finance ? {} : { hourlyRate: undefined, currency: undefined };
          return {
            ...e,
            ...financial,
            sharedOriginal: e.sharedOriginal && e.history.some(
              (h) => h.action === "create" && h.before === null && canSeeReferences(h.after),
            ) ? e.sharedOriginal : undefined,
            history: e.history
              .filter((h) => canSeeReferences(h.after))
              .map((h) => ({
                ...h,
                before: h.before && canSeeReferences(h.before) ? { ...h.before, ...financial } : null,
                after: { ...h.after, ...financial },
              })),
          };
        }),
    invoices: docs.flatMap((d) =>
      actor.finance &&
      d.kind === "invoice" &&
      d.value.entries.every((e) => matters.has(e.matterId) && clients.has(e.clientId))
        ? [d.value]
        : [],
    ),
  };
}

/** Generic imports and record edits may stage draft time. Workflow decisions belong to Timesheets. */
export function validateGenericTime(
  store: BackOfficeStore,
  scope: string,
  actor: BackOfficeActor,
  previous: BackOfficeRecord | null,
  values: BackOfficeRecord["values"],
) {
  const old = previous?.values;
  if (
    (values.status && values.status !== "Draft" && values.status !== old?.status) ||
    (old?.status && old.status !== "Draft" && values.status !== old.status) ||
    (values.invoice ?? null) !== (old?.invoice ?? null)
  )
    timeError("Submit, review and invoice time in Timesheets.", 409);
  const changed = [
    "billableMinutes",
    "recordedMinutes",
    "startedAt",
    "serviceDate",
    "endedAt",
    "client",
    "matter",
    "billingNarrative",
    "hourlyRate",
    "timekeeper",
    "name",
  ].some((field) => JSON.stringify(old?.[field]) !== JSON.stringify(values[field]));
  if (!changed) return;
  if (old?.status && !["Draft", "Submitted"].includes(String(old.status)))
    timeError("Previously approved or billed time cannot be rewritten.", 409);
  if (previous && previous.ownerId !== actor.userId && (values.timekeeper ?? null) !== (old?.timekeeper ?? null))
    timeError("Only the original entry owner can correct its timekeeper.", 403);
  const minutes = values.billableMinutes;
  if (minutes == null || minutes === 0) return;
  if (typeof minutes !== "number" || !Number.isInteger(minutes) || minutes < 0 || minutes > 1440)
    timeError("Enter whole chargeable minutes between zero and 1440.");
  const date = legacyServiceDate(values);
  if (
    typeof values.matter !== "string" ||
    typeof values.client !== "string" ||
    !date
  )
    timeError(
      "Billable imports need a matter, billing client and service date. Use Timesheets for duration-only entries.",
    );
  const state = readTimesheet(store, scope, actor, [], [], true);
  if (
    !state.matters.some((m) => m.id === values.matter && m.clientIds.includes(String(values.client))) ||
    !state.clients.some((c) => c.id === values.client)
  )
    timeError("Choose a billing client associated with this matter.");
  const policy = resolveTimePolicy(
    state.policies,
    values.client,
    values.matter,
    date,
  );
  if (policy.enforceIncrement && minutes % policy.incrementMinutes)
    timeError(`Chargeable time must be a multiple of ${policy.incrementMinutes} minutes.`);
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
    nonBillableMinutes: e.nonBillableMinutes,
    billable: e.billable,
    billableMinutes: e.billableMinutes,
    workProductId: e.workProductId,
    workProductTitle: e.workProductTitle,
    startAt: e.startAt,
    endAt: e.endAt,
    status: e.status,
    policyDigest: e.policyDigest,
    nonHourlyApproval: e.nonHourlyApproval,
    adjustmentBaselineRevision: e.adjustmentBaselineRevision,
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
    serviceDate: entry.date,
    startedAt: entry.startAt ?? entry.date,
    endedAt: entry.endAt ?? null,
    recordedMinutes: entry.workedMinutes,
    billableMinutes: entry.billableMinutes,
    status,
    hourlyRate:
      entry.hourlyRate !== undefined && entry.currency
        ? backOfficeMoneyFromMajor(entry.hourlyRate, entry.currency)
        : null,
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
      ownerId: existing?.ownerId ?? ownerId,
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
