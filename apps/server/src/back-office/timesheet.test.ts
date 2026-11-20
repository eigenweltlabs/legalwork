import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  nonBillableWork,
  proposedCharge,
  proposedStopwatchCharge,
  requiresTimeAllocations,
  resolveTimePolicy,
  type TimeDraft,
  type InvoiceDraftInput,
  type TimesheetCommand,
  type TimeEntry,
  type TimePolicy,
} from "@legalwork/types/timesheet";
import { openSqlite } from "../runtime-db.js";
import { BackOfficeStore } from "./store.js";
import { unknownRecords } from "./first-sync.js";
import { commandTimesheet } from "./timesheet.js";
import { approveInvoice, invoiceDraftRef, prepareInvoice } from "./timesheet-invoice.test-support.js";
import { queryDirectoryRecords } from "./dashboard-query.js";
import { readTimeDocument, readTimesheet } from "./timesheet-data.js";
import { memberSource, timeMemberContactId } from "./time-member-identity.js";
import { timeMemberContact } from "./time-members.js";
import { backOfficeMajorAmount, BackOfficeMoneySchema, z, type BackOfficeActor } from "./schema.js";

const owner = { userId: "alice", edit: true, finance: true, model: true },
  ben = { ...owner, userId: "ben", finance: false },
  eva = { ...owner, userId: "eva" };
const people = [owner, ben, eva].map((a) => ({ id: a.userId, name: a.userId, canRecordTimeFor: true }));
const stores: BackOfficeStore[] = [];
afterEach(() => {
  while (stores.length) stores.pop()?.close();
});
async function fixture() {
  const store = new BackOfficeStore(await openSqlite(":memory:"));
  stores.push(store);
  const create = (objectId: string, values: Record<string, string | string[]>) =>
    store.saveRecord("local", owner, { objectId, values, revision: 0 });
  const client = create("clients", { name: "Fixture client", billingAddress: "Testgasse 5, 1010 Wien" }),
    matter = create("matters", {
      name: "Fixture matter",
      clients: [client.id],
    });
  const d: TimeDraft = {
    date: "2026-11-12",
    clientId: client.id,
    matterId: matter.id,
    activity: "DFT",
    narrative: "Memo amended",
    workedMinutes: 17,
    billable: true,
    billableMinutes: 20,
    workProductTitle: "Fixture memo",
  };
  const run = (actor: BackOfficeActor, cmd: TimesheetCommand) =>
    commandTimesheet(store, "local", actor, people, cmd);
  const state = (actor: BackOfficeActor) => readTimesheet(store, "local", actor, people);
  const result = run(owner, {
    type: "policy",
    policy: {
      scope: "firm",
      targetId: "firm",
      effectiveFrom: "2026-01-01",
      revision: 0,
      language: "English",
      actionFirst: true,
      reviewerId: eva.userId,
      hourlyRate: 300,
      currency: "EUR",
      activityLimits: { DR: 180 },
    },
  });
  expect(result.policies.length).toBe(1);
  return { store, create, d, run, state, matter, client };
}
const sel = (e: TimeEntry) => [{ id: e.id, revision: e.revision }];
test("entry rules, idempotent meetings, products, corrections and atomic independent review", async () => {
  const { store, d, run, state } = await fixture();
  const input = {
    type: "create",
    entry: d,
    requestId: randomUUID(),
    workerIds: ["alice", "ben", "alice"],
  } as const;
  const request = { ...input, workerIds: [...input.workerIds] };
  expect(() => run(owner, { ...request, entry: { ...d, billableMinutes: 4 } })).toThrow(/multiple/);

  expect(() => run({ ...owner, agentId: "workflow" }, request)).toThrow(/person must/);
  const first = run(owner, request).entries[0];
  expect(first.workedMinutes).toBe(17);
  expect(first.billableMinutes).toBe(20);
  expect(run(owner, request).entries.length).toBe(1);
  expect(() => run(owner, { ...request, entry: { ...d, narrative: "different" } })).toThrow(
    /already used/,
  );
  const other = state(ben).entries[0];
  expect(other.status).toBe("pending");
  expect(other.groupId).toBe(first.groupId);
  expect(state(eva).entries).toHaveLength(0);
  expect(() => run(owner, { type: "submit", entries: sel(other) })).toThrow();
  const confirmed = run(ben, { type: "confirm", entries: sel(other) }).entries[0];
  const submittedBen = run(ben, { type: "submit", entries: sel(confirmed) }).entries[0];
  const submitted = run(owner, { type: "submit", entries: sel(first) }).entries[0];
  expect(submitted.suggestion).toBe("Amending Memo");
  const unchanged = run(owner, {
    type: "update",
    id: submitted.id,
    revision: submitted.revision,
    entry: { ...d, workProductId: first.workProductId },
  }).entries[0];
  expect(unchanged).toEqual(submitted);
  expect(state(eva).entries).toHaveLength(2);
  expect(() => run(owner, { type: "approve", entries: sel(submitted) })).toThrow(/independent/);
  expect(() =>
    run(eva, {
      type: "approve",
      entries: [...sel(submitted), { id: other.id, revision: 1 }],
    }),
  ).toThrow(/changed/);
  expect(state(eva).entries.every((e) => e.status === "submitted")).toBe(true);
  const returned = run(owner, {
    type: "update",
    id: first.id,
    revision: submitted.revision,
    entry: {
      ...d,
      activity: "MOD",
      workProductId: first.workProductId,
      narrative: "Revised memo",
    },
  }).entries[0];
  expect(returned.status).toBe("confirmed");
  expect(returned.workProductId).toBe(first.workProductId);
  expect(() => run(eva, { type: "approve", entries: sel(submitted) })).toThrow();
  const latest = run(owner, { type: "submit", entries: sel(returned) }).entries[0];
  expect(() =>
    run(eva, {
      type: "review",
      id: latest.id,
      revision: latest.revision,
      billableMinutes: 10,
      narrative: latest.narrative,
    }),
  ).toThrow(/reason/);
  const reviewed = run(eva, {
    type: "review",
    id: latest.id,
    revision: latest.revision,
    billableMinutes: 10,
    narrative: "Amending memo",
    reason: "Write down",
  }).entries.find((e) => e.id === latest.id)!;
  expect(reviewed.workedMinutes).toBe(17);
  expect(reviewed.history.at(-1)?.before?.billableMinutes).toBe(20);
  const approved = run(eva, {
    type: "approve",
    entries: [...sel(reviewed), ...sel(submittedBen)],
  }).entries;
  expect(approved.every((e) => e.status === "approved" && e.hourlyRate === 300)).toBe(true);
  expect(
    store.journal
      .evidence("local")
      .entries.some(
        (e) => e.payload.entityType === "timesheet" && e.payload.action === "timesheet.approve",
      ),
  ).toBe(true);
});
test("issued numbers follow legacy, pins approvals, download is reproducible and retry-safe", async () => {
  const { store, run, d, create, state } = await fixture();
  create("invoices", {
    name: "Prior",
    invoiceNumber: "1042",
    status: "Issued",
  });
  for (let i = 0; i < 2; i++) {
    const created = run(owner, {
      type: "create",
      requestId: randomUUID(),
      entry: { ...d, narrative: "Research <file> " + i },
    }).entries.find((e) => e.status === "confirmed")!;
    const submitted = run(owner, {
      type: "submit",
      entries: sel(created),
    }).entries.find((e) => e.id === created.id)!;
    run(eva, { type: "approve", entries: sel(submitted) });
  }
  const entries = state(eva).entries;
  const runAsReviewer = (command: TimesheetCommand) => run(eva, command);
  const firstDraft = runAsReviewer(prepareInvoice([entries[0]]));
  expect(firstDraft.invoices).toEqual([]);
  expect(() => runAsReviewer({ type: "issueInvoice", ...invoiceDraftRef(firstDraft), requestId: randomUUID() })).toThrow(/Approve/);
  const one = approveInvoice(runAsReviewer, firstDraft);
  const issued = runAsReviewer(one).invoices[0];
  expect(issued.number).toBe(1043);
  expect(issued.total).toBe(100);
  expect(runAsReviewer(one).invoices[0].id).toBe(issued.id);
  expect(() => runAsReviewer({ ...one, requestId: randomUUID() })).toThrow(/changed/);
  const two = approveInvoice(runAsReviewer, runAsReviewer(prepareInvoice([entries[1]])));
  const invoices = runAsReviewer(two).invoices;
  expect(invoices.map((i) => i.number).sort()).toEqual([1043, 1044]);
  const artifact = readTimeDocument(store, "local", issued.id);
  expect(artifact?.kind === "invoice" && artifact.document).toContain("&lt;file&gt;");
  expect(state(ben).invoices).toHaveLength(0);
});

test.each([
  { currency: "KWD", agreementMinor: 1235, exactAmount: { amountMinor: 12345, minorUnitScale: 1000 }, rate: 12.345, minutes: 60, total: 12.345, compatibilityMinor: 1235 },
  { currency: "JPY", agreementMinor: 735, rate: 7.35, minutes: 30, total: 4, compatibilityMinor: 400 },
  { currency: "EUR", agreementMinor: 201, rate: 2.01, minutes: 30, total: 1.01, compatibilityMinor: 101 },
])("issued invoice and Back Office keep matching precision in $currency", async ({ currency, agreementMinor, exactAmount, rate, minutes, total, compatibilityMinor }) => {
  const { store, run, d, client, matter } = await fixture();
  store.saveRecord("local", owner, {
    objectId: "feeAgreements",
    revision: 0,
    values: {
      name: "Fixture hourly agreement",
      basis: "Hourly",
      matter: matter.id,
      client: client.id,
      hourlyRate: { currency, amountMinor: agreementMinor, ...(exactAmount && { exactAmount }) },
    },
  });
  const created = run(owner, { type: "create", requestId: randomUUID(), entry: { ...d, workedMinutes: minutes, billableMinutes: minutes } }).entries[0];
  const submitted = run(owner, { type: "submit", entries: sel(created) }).entries[0];
  const approved = run(eva, { type: "approve", entries: sel(submitted) }).entries[0];
  expect(approved.hourlyRate).toBe(rate);
  expect(backOfficeMajorAmount(BackOfficeMoneySchema.parse(store.raw("local", approved.id)?.values.hourlyRate))).toBe(rate);

  const preview = run(eva, prepareInvoice([approved]));
  const issued = run(eva, approveInvoice((cmd) => run(eva, cmd), preview)).invoices[0];
  expect(issued.total).toBe(total);
  const artifact = readTimeDocument(store, "local", issued.id);
  expect(artifact?.kind === "invoice" && artifact.document).toContain(new Intl.NumberFormat("en-GB", { style: "currency", currency }).format(total));
  const record = store.raw("local", issued.id);
  const money = BackOfficeMoneySchema.parse(record?.values.netTotal);
  expect(money).toEqual({ amountMinor: compatibilityMinor, currency, ...(exactAmount && { exactAmount }) });
  expect(backOfficeMajorAmount(money)).toBe(total);
  const oldReader = z.object({ amountMinor: z.number().int().safe(), currency: z.string() }).parse(money);
  expect(oldReader.amountMinor / 100).toBe(currency === "KWD" ? 12.35 : total);
  const dashboard = queryDirectoryRecords(store.model("local"), owner, () => record ? [record] : [], {
    source: "backOffice", directoryId: "local", objectId: "invoices", fields: ["netTotal"], currency,
    metrics: [{ name: "netTotal", op: "sum", field: "netTotal" }],
  });
  expect(dashboard.rows).toEqual([{ netTotal: total }]);
});

test("old approved generic rows need a workflow review and audit failure rolls back entries and products", async () => {
  const { store, run, state, d } = await fixture();
  const saved = store.saveRecord("local", owner, {
    objectId: "timeEntries",
    revision: 0,
    values: {
      name: "Existing row",
      matter: d.matterId,
      client: d.clientId,
      startedAt: "2026-11-12T12:00:00Z",
      billingNarrative: "Legacy description",
      status: "Draft",
      recordedMinutes: 10,
      billableMinutes: 10,
    },
  });
  // A populated pre-workflow database already has approved rows.
  store.transaction(
    () => {
      const record = { ...saved, values: { ...saved.values, status: "Approved" } };
      store.db.run("UPDATE bo_records SET data=? WHERE scope=? AND id=?", [
        JSON.stringify(record),
        "local",
        saved.id,
      ]);
    },
    { action: "test.preexisting-record" },
  );
  const legacy = state(owner).entries[0];
  expect(legacy.legacy).toBe(true);
  expect(() =>
    run(owner, prepareInvoice([legacy])),
  ).toThrow(/no longer open/);
  const original = store.journal.flush.bind(store.journal);
  store.journal.flush = () => {
    throw new Error("Journal write failed");
  };
  expect(() => run(owner, { type: "create", requestId: randomUUID(), entry: d })).toThrow(
    /Journal write failed/,
  );
  store.journal.flush = original;
  expect(state(owner).entries).toHaveLength(1);
  expect(state(owner).products).toHaveLength(0);
});
test("client six-minute terms can be overridden by an effective project or activity exception", () => {
  const policy = resolveTimePolicy(
    [
      {
        scope: "client",
        targetId: "c",
        effectiveFrom: "2026-01-01",
        revision: 1,
        incrementMinutes: 6,
      },
      {
        scope: "project",
        targetId: "p",
        effectiveFrom: "2026-11-12",
        revision: 1,
        enforceIncrement: false,
        activityLimits: { DR: 180 },
      },
    ],
    "c",
    "m",
    "2026-11-12",
    "p",
  );
  expect(policy).toMatchObject({
    incrementMinutes: 6,
    enforceIncrement: false,
    maxMinutes: 120,
    activityLimits: { DR: 180 },
  });
});

test("managed grid rows and issued projections cannot bypass revision or reenter generic sync", async () => {
  const { store, d, run } = await fixture();
  const row = run(owner, { type: "create", entry: d, requestId: randomUUID() }).entries[0];
  const generic = store.raw("local", row.id)!;
  expect(generic.values.recordedMinutes).toBe(17);
  expect(() =>
    store.saveRecord("local", owner, {
      id: row.id,
      objectId: "timeEntries",
      revision: generic.revision,
      values: { status: "Approved" },
    }),
  ).toThrow(/Timesheets/);
  expect(unknownRecords(store).some((r) => r.id === row.id)).toBe(false);
  expect(() =>
    store.db.run("UPDATE bo_timesheets SET data='{}' WHERE scope='local' AND id=?", [row.id]),
  ).toThrow();
});
test("reject duplicate private suggestions across request IDs and authenticate source provenance", async () => {
  const { run, d } = await fixture();
  const input = {
    type: "create",
    requestId: randomUUID(),
    entry: d,
    source: "suggestion",
  } as const;
  expect(() => run(owner, input)).toThrow(/private original/);
  run(owner, { ...input, proposalDigest: "a".repeat(64) });
  expect(() =>
    run(owner, {
      ...input,
      requestId: randomUUID(),
      proposalDigest: "a".repeat(64),
    }),
  ).toThrow(/already been recorded/);
});

test("stored project settings resolve from an ordinary workspace matter link", async () => {
  const { store, d, client, matter } = await fixture();
  const workspaces = [
    {
      id: "project-1",
      name: "Project one",
      matterIds: [matter.id, "inaccessible"],
    },
  ];
  expect(readTimesheet(store, "local", owner, people, workspaces).projects).toEqual([
    { ...workspaces[0], matterIds: [matter.id] },
  ]);
  commandTimesheet(
    store,
    "local",
    owner,
    people,
    {
      type: "policy",
      policy: {
        scope: "project",
        targetId: "project-1",
        effectiveFrom: "2026-01-01",
        revision: 0,
        incrementMinutes: 6,
      },
    },
    workspaces,
  );
  expect(() =>
    commandTimesheet(
      store,
      "local",
      owner,
      people,
      {
        type: "create",
        requestId: randomUUID(),
        entry: { ...d, projectId: "project-1", billableMinutes: 4 },
      },
      workspaces,
    ),
  ).toThrow(/6 minutes/);
  const accepted = commandTimesheet(
    store,
    "local",
    owner,
    people,
    {
      type: "create",
      requestId: randomUUID(),
      entry: { ...d, projectId: "project-1", billableMinutes: 6 },
    },
    workspaces,
  ).entries[0];
  expect(accepted.clientId).toBe(client.id);
});

test("a worker neither sees financial terms nor loses the private price from the signed entry", async () => {
  const { store, d, run } = await fixture();
  const cmd = { type: "create", requestId: randomUUID(), entry: d } as const;
  const created = run(ben, cmd).entries[0],
    retry = run(ben, cmd).entries[0];
  expect(created.hourlyRate).toBeUndefined();
  expect(retry.history[0].after.hourlyRate).toBeUndefined();
  const stored = readTimeDocument(store, "local", created.id);
  expect(stored?.kind === "entry" && stored.value.history[0].after.hourlyRate).toBe(300);
});

test("rename keeps the product and revision evidence while approved corrections change only the invoice delta", async () => {
  const { store, run, d, state } = await fixture();
  const created = run(owner, {
    type: "create",
    requestId: randomUUID(),
    entry: d,
  }).entries[0];
  const product = state(owner).products[0];
  expect(product.authorId).toBe(owner.userId);
  expect(new Date(product.createdAt!).toISOString()).toBe(product.createdAt!);
  const details = {
    type: "productDetails" as const,
    id: product.id,
    expectedType: product.productType,
    productType: "memo" as const,
    reference: "Advice memo / May",
  };
  expect(run(owner, details).products[0]).toMatchObject({
    id: product.id,
    productType: "memo",
    reference: "Advice memo / May",
  });
  expect(() => run(owner, details)).toThrow(/changed/);
  expect(
    run(owner, {
      type: "renameProduct",
      id: product.id,
      expectedName: product.name,
      name: "Final memo",
    }).products[0].id,
  ).toBe(product.id);
  expect(() =>
    run(owner, {
      type: "renameProduct",
      id: product.id,
      expectedName: product.name,
      name: "Other name",
    }),
  ).toThrow(/changed/);
  const submitted = run(owner, { type: "submit", entries: sel(created) }).entries[0];
  const approved = run(eva, { type: "approve", entries: sel(submitted) }).entries[0];
  const correction = {
    type: "adjust",
    id: approved.id,
    revision: approved.revision,
    requestId: randomUUID(),
    reason: "Write down",
    billableMinutes: 10,
    narrative: "Final memo",
  } as const;
  const proposed = run(owner, correction).adjustments![0];
  expect(proposed.deltaAmount).toBe(-50);
  expect(run(owner, correction).adjustments).toHaveLength(1);
  expect(() => run(owner, { ...correction, requestId: randomUUID() })).toThrow(/already pending/);
  const preview = prepareInvoice([approved]);
  expect(() => run(eva, preview)).toThrow(/pending corrections/);
  const decide = {
    type: "decideAdjustment",
    id: proposed.id,
    revision: 1,
    approve: true,
  } as const;
  expect(() => run(owner, decide)).toThrow(/independent/);
  const adjusted = run(eva, decide).adjustments![0];
  expect(adjusted.status).toBe("approved");
  expect(() => run(eva, decide)).toThrow(/no longer pending/);
  expect(() => run(eva, preview)).toThrow(/corrections changed/);
  const currentPreview = run(eva, prepareInvoice([approved], [{ id: adjusted.id, revision: adjusted.revision }]));
  const issued = run(eva, approveInvoice((cmd) => run(eva, cmd), currentPreview)).invoices[0];
  expect(issued.total).toBe(50);
  expect(issued.entries[0].billableMinutes).toBe(10);
  const invoiced = state(owner).entries[0];
  expect(invoiced.billableMinutes).toBe(20);
  expect(invoiced.workedMinutes).toBe(17);
  const credit = run(owner, {
    ...correction,
    requestId: randomUUID(),
    revision: invoiced.revision,
    billableMinutes: 0,
    narrative: "Courtesy adjustment",
  }).adjustments!.find((a) => a.status === "pending")!;
  expect(credit.fromMinutes).toBe(10);
  expect(credit.deltaAmount).toBe(-50);
  const decided = run(eva, { ...decide, id: credit.id }).adjustments!.find((a) => a.id === credit.id)!;
  expect(decided.noteNumber).toBe("1-C1");
  const note = readTimeDocument(store, "local", credit.id);
  expect(note?.kind === "adjustment" && note.document).toContain("1-C1");
  expect(note?.kind === "adjustment" && note.document).toContain("Courtesy adjustment");
  expect(state(owner).entries).toHaveLength(1);
  expect(state(eva).invoices[0]).toEqual(issued);
});

test("an over-cap call reaches review with actual minutes intact and cannot be approved until resolved", async () => {
  const { d, run } = await fixture();
  const over = run(owner, {
    type: "create",
    requestId: randomUUID(),
    entry: { ...d, activity: "TEL", workedMinutes: 150, billableMinutes: 150 },
  }).entries[0];
  const sent = run(owner, { type: "submit", entries: sel(over) }).entries[0];
  expect(sent.workedMinutes).toBe(150);
  expect(() => run(eva, { type: "approve", entries: sel(sent) })).toThrow(/up to 120/);
  const revised = run(eva, {
    type: "review",
    id: sent.id,
    revision: sent.revision,
    narrative: "Client call",
    billableMinutes: 120,
    reason: "Client cap",
  }).entries[0];
  const approved = run(eva, { type: "approve", entries: sel(revised) }).entries[0];
  expect(approved.workedMinutes).toBe(150);
  expect(approved.history[0].after.billableMinutes).toBe(150);
  run(owner, {
    type: "policy",
    policy: {
      scope: "matter",
      targetId: d.matterId,
      effectiveFrom: "2026-01-01",
      revision: 0,
      maxMinutes: 90,
    },
  });
  const preview = run(eva, prepareInvoice([approved]));
  const invoice = run(eva, approveInvoice((cmd) => run(eva, cmd), preview)).invoices[0];
  expect(invoice.entries[0].billableMinutes).toBe(120);
  expect(invoice.total).toBe(600);
  const review = run(owner, {
    type: "create",
    requestId: randomUUID(),
    entry: { ...d, activity: "DR", workedMinutes: 150, billableMinutes: 150 },
  });
  const dr = review.entries.find((e) => e.activity === "DR")!;
  const drSent = run(owner, { type: "submit", entries: sel(dr) }).entries.find((e) => e.id === dr.id)!;
  expect(
    run(eva, { type: "approve", entries: sel(drSent) }).entries.find((e) => e.id === dr.id)?.status,
  ).toBe("approved");
});

test("only a server-authorised project exception overrides matching binding client terms; later terms invalidate it", async () => {
  const { d, store, run, matter } = await fixture(),
    workspaces = [{ id: "p", name: "Acquisition", matterIds: [matter.id] }];
  const policy = {
    scope: "client",
    targetId: d.clientId,
    effectiveFrom: "2026-01-01",
    revision: 0,
    incrementMinutes: 6,
    bindingIncrement: true,
  } as const;
  run(owner, { type: "policy", policy });
  const invoke = (actor: BackOfficeActor, cmd: TimesheetCommand) =>
    commandTimesheet(store, "local", actor, people, cmd, workspaces);
  const relax = {
    scope: "project",
    targetId: "p",
    effectiveFrom: "2026-01-01",
    revision: 0,
    enforceIncrement: false,
  } as const;
  expect(() => invoke(owner, { type: "policy", policy: relax })).toThrow(/reason/);
  expect(() =>
    invoke(ben, {
      type: "policy",
      policy: { ...relax, incrementExceptionReason: "Approved by client" },
    }),
  ).toThrow(/access/);
  expect(() =>
    invoke(owner, {
      type: "policy",
      policy: { ...relax, scope: "matter", targetId: matter.id },
    }),
  ).toThrow(/project exception/);
  const authorised = invoke(owner, {
    type: "policy",
    policy: {
      ...relax,
      incrementExceptionReason: "Written instructions for this project",
      incrementException: {
        reason: "Fake",
        authorizedBy: "other",
        authorizedAt: new Date(0).toISOString(),
        terms: [
          {
            clientId: d.clientId,
            revision: 0,
            effectiveFrom: "2026-01-01",
            incrementMinutes: 10,
          },
        ],
      },
    },
  });
  const applied = resolveTimePolicy(authorised.policies, d.clientId, d.matterId, d.date, "p");
  expect(applied.enforceIncrement).toBe(false);
  expect(applied.incrementException?.authorizedBy).toBe(owner.userId);
  expect(applied.incrementException?.terms[0].revision).toBe(1);
  const four = { ...d, projectId: "p", billableMinutes: 4 };
  const line = invoke(owner, {
    type: "create",
    requestId: randomUUID(),
    entry: four,
  }).entries[0];
  const revised = invoke(owner, {
    type: "policy",
    policy: { ...policy, revision: 1, incrementMinutes: 10 },
  });
  const updated = resolveTimePolicy(revised.policies, d.clientId, d.matterId, d.date, "p");
  expect(updated.incrementException).toBeUndefined();
  expect(updated.enforceIncrement).toBe(true);
  expect(updated.incrementMinutes).toBe(10);
  expect(() => invoke(owner, { type: "submit", entries: sel(line) })).toThrow(/multiple of 10/);
  const repaired = invoke(owner, {
    type: "policy",
    policy: {
      ...relax,
      revision: 1,
      incrementExceptionReason: "Renewed consent",
    },
  });
  expect(
    resolveTimePolicy(repaired.policies, d.clientId, d.matterId, d.date, "p").incrementException
      ?.terms[0].revision,
  ).toBe(2);
  expect(invoke(owner, { type: "submit", entries: sel(line) }).entries[0].billableMinutes).toBe(4);
});

test("an hourly legacy agreement scoped to one billing client cannot set another client's fee on the same matter", async () => {
  const { store, matter, client, d, create, run } = await fixture();
  const other = create("clients", { name: "Second client" });
  store.saveRecord("local", owner, {
    id: matter.id,
    revision: matter.revision,
    objectId: "matters",
    values: { clients: [client.id, other.id] },
  });
  store.saveRecord("local", owner, {
    objectId: "feeAgreements",
    revision: 0,
    values: {
      name: "Six minute terms for first client",
      basis: "Hourly",
      matter: matter.id,
      client: client.id,
      incrementMinutes: 6,
      hourlyRate: { amountMinor: 25000, currency: "EUR" },
    },
  });
  expect(() =>
    run(owner, {
      type: "create",
      requestId: randomUUID(),
      entry: { ...d, billableMinutes: 10 },
    }),
  ).toThrow(/multiple of 6/);
  run(owner, {
    type: "policy",
    policy: {
      scope: "matter",
      targetId: matter.id,
      revision: 0,
      effectiveFrom: "2026-01-01",
      language: "English",
    },
  });
  const first = run(owner, {
    type: "create",
    requestId: randomUUID(),
    entry: { ...d, billableMinutes: 12 },
  }).entries[0];
  expect(first.hourlyRate).toBe(250);
  const saved = run(owner, {
    type: "create",
    requestId: randomUUID(),
    entry: { ...d, clientId: other.id, billableMinutes: 10 },
  }).entries.find((e) => e.clientId === other.id)!;
  expect(saved.hourlyRate).toBe(300);
});

test("two identically titled products retain independent IDs and legacy unambiguous reuse", async () => {
  const { d, run } = await fixture();
  const book = (entry: TimeDraft, requestId = randomUUID()) =>
    run(owner, { type: "create", entry, requestId });
  const first = book(d).products[0];
  expect(book(d).products).toHaveLength(1);
  const request = randomUUID(),
    separate: TimeDraft = { ...d, createWorkProduct: true };
  const secondState = book(separate, request);
  expect(secondState.products).toHaveLength(2);
  const second = secondState.products.find((p) => p.id !== first.id);
  expect(second?.name).toBe(first.name);
  expect(book(separate, request).products).toHaveLength(2);
  expect(() => book({ ...d, activity: "MOD" })).toThrow(/Several work products/);
  for (const id of [first.id, second!.id]) {
    const next = book({ ...d, activity: "MOD", workProductId: id });
    expect(next.entries.filter((e) => e.activity === "MOD" && e.workProductId === id)).toHaveLength(1);
    expect(next.entries.some((e) => e.createWorkProduct)).toBe(false);
  }
  expect(() => book({ ...d, workProductId: first.id, createWorkProduct: true })).toThrow(
    /existing product ID/,
  );
});

test("rounding suggests the configured charge without changing worked time or the default manual choice", () => {
  const policy = resolveTimePolicy([], "", "", "2026-11-14");
  expect(proposedCharge(17, policy)).toBe(17);
  expect(proposedCharge(17, { ...policy, rounding: "up" })).toBe(20);
  expect(proposedCharge(17, { ...policy, rounding: "down" })).toBe(10);
  expect(proposedCharge(4, { ...policy, rounding: "nearest" })).toBe(0);
  expect(
    proposedCharge(17, {
      ...policy,
      rounding: "down",
      enforceIncrement: false,
    }),
  ).toBe(17);
});

test("stopwatch rounding is project-specific, dated, persisted and does not rewrite recorded work", async () => {
  const { store, d, matter } = await fixture();
  const projects = [{ id: "p", name: "Project", matterIds: [matter.id] }];
  const invoke = (actor: BackOfficeActor, cmd: TimesheetCommand) =>
    commandTimesheet(store, "local", actor, people, cmd, projects);
  const original = invoke(owner, { type: "create", requestId: randomUUID(), entry: { ...d, projectId: "p" } }).entries[0];
  const policy: TimePolicy = {
    scope: "project", targetId: "p", effectiveFrom: d.date, revision: 0,
    stopwatchRoundUp: false, incrementMinutes: 10, enforceIncrement: false,
  };
  expect(() => invoke(ben, { type: "policy", policy })).toThrow(/access/);
  expect(() => invoke(owner, { type: "policy", policy: { ...policy, scope: "firm", targetId: "firm" } })).toThrow(/project/);
  invoke(owner, { type: "policy", policy });
  const saved = readTimesheet(store, "local", owner, people, projects);
  const current = resolveTimePolicy(saved.policies, d.clientId, d.matterId, d.date, "p");
  expect(current.stopwatchRoundUp).toBe(false);
  expect(proposedStopwatchCharge(13, current)).toBe(10);
  expect(proposedStopwatchCharge(17, current)).toBe(20);
  expect(proposedStopwatchCharge(15, current)).toBe(20);
  expect(proposedStopwatchCharge(4, current)).toBe(0);
  expect(proposedStopwatchCharge(13, resolveTimePolicy(saved.policies, d.clientId, d.matterId, "2026-11-11", "p"))).toBe(20);
  expect(proposedStopwatchCharge(13, resolveTimePolicy(saved.policies, d.clientId, d.matterId, d.date, "other"))).toBe(20);
  expect(proposedStopwatchCharge(13, { ...current, incrementMinutes: 6, stopwatchRoundUp: true })).toBe(18);
  expect(proposedStopwatchCharge(13, { ...current, incrementMinutes: 6 })).toBe(12);
  expect(proposedStopwatchCharge(10, { ...current, stopwatchRoundUp: true })).toBe(10);
  expect(proposedCharge(13, current)).toBe(13);
  expect(saved.entries.find(e => e.id === original.id)).toEqual(original);
});

test("finance editors can review assigned work without appointing themselves or changing its rate", async () => {
  const { run, state, d } = await fixture();
  const editor = { ...eva, model: false };
  const policy = state(editor).policies[0];
  expect(state(editor).canManage).toBe(false);
  expect(() =>
    run(editor, { type: "policy", policy: { ...policy, reviewerId: editor.userId } }),
  ).toThrow(/access/);
  const row = run(owner, { type: "create", requestId: randomUUID(), entry: d }).entries[0];
  const sent = run(owner, { type: "submit", entries: sel(row) }).entries[0];
  expect(run(editor, { type: "approve", entries: sel(sent) }).entries[0].status).toBe("approved");
});

test("conflicting matter agreements require a linked selection and flat fees have no hourly allocation", async () => {
  const { store, d, matter, run } = await fixture();
  const agreement = (name: string, basis: string, rate: number) =>
    store.saveRecord("local", owner, {
      objectId: "feeAgreements",
      revision: 0,
      values: { name, matter: matter.id, basis, hourlyRate: { amountMinor: rate, currency: "EUR" } },
    });
  const hourly = agreement("Hourly", "Hourly", 18200);
  const flat = agreement("Fixed", "Flat fee", 25000);
  const row = run(owner, { type: "create", requestId: randomUUID(), entry: d }).entries[0];
  expect(row.hourlyRate).toBeUndefined();
  expect(() => run(owner, { type: "submit", entries: sel(row) })).toThrow(/Several fee agreements/);
  const projects = [hourly, flat].map((a) => ({
    id: a.id,
    name: a.id,
    matterIds: [matter.id],
    agreementIds: [a.id],
  }));
  const selected = (projectId: string) =>
    commandTimesheet(
      store,
      "local",
      owner,
      people,
      {
        type: "create",
        requestId: randomUUID(),
        entry: { ...d, projectId },
      },
      projects,
    ).entries.find((e) => e.projectId === projectId)!;
  expect(selected(hourly.id).hourlyRate).toBe(182);
  const unpriced = selected(flat.id);
  expect(unpriced.hourlyRate).toBeUndefined();
  expect(store.raw("local", unpriced.id)?.values.hourlyRate).toBeNull();
});

test("worked minutes must match a supplied clock range", async () => {
  const { run, d } = await fixture();
  const timed = { ...d, startAt: "2026-11-12T22:00:00+01:00", endAt: "2026-11-12T22:17:00+01:00" };
  const row = run(owner, { type: "create", entry: timed, requestId: randomUUID() }).entries[0];
  expect(row.workedMinutes).toBe(17);
  expect(() =>
    run(owner, { type: "update", ...sel(row)[0], entry: { ...timed, workedMinutes: 180 } }),
  ).toThrow(/must match/);
});

test("generic draft imports enforce client units and leave submission to the worker", async () => {
  const { store, d } = await fixture();
  const record = { objectId: "timeEntries", revision: 0 };
  const line = {
    name: "Imported",
    matter: d.matterId,
    client: d.clientId,
    startedAt: d.date + "T09:00:00Z",
    recordedMinutes: 10,
    billableMinutes: 10,
    status: "Draft",
  };
  expect(() =>
    store.saveRecord("local", owner, { ...record, values: { ...line, billableMinutes: 4 } }),
  ).toThrow(/multiple/);
  const imported = store.saveRecord("local", owner, { ...record, values: line });
  expect(() =>
    store.saveRecord("local", owner, {
      ...record,
      revision: imported.revision,
      id: imported.id,
      values: { status: "Submitted" },
    }),
  ).toThrow(/Timesheets/);
});

test("imported time resolves a linked worker without transferring record ownership", async () => {
  const { store, d, run, state } = await fixture();
  const timekeeper = timeMemberContact(store, "local", owner, { userId: ben.userId, name: "Worker", email: null });
  const values = {
    name: "Historical research", matter: d.matterId, client: d.clientId, timekeeper,
    serviceDate: d.date, startedAt: "2026-11-13T00:00:00Z", endedAt: "2026-11-13T00:10:00Z",
    recordedMinutes: 10, billableMinutes: 10, status: "Draft", privateNote: "Author's work note",
  };
  const save = (access: "org" | "members", members: string[] = []) =>
    store.saveRecord("local", owner, { objectId: "timeEntries", revision: 0, access, members, values });
  const open = save("org"), shared = save("members", [ben.userId]), privateRecord = save("members");
  expect(state(owner).entries).toHaveLength(0);
  expect(state(eva).entries).toHaveLength(0);
  expect(store.records("local", ben, "timeEntries")).toHaveLength(0);
  expect(state(ben).entries.map(e => e.id).sort()).toEqual([open.id, shared.id].sort());
  const legacy = state(ben).entries.find(e => e.id === open.id)!;
  expect(legacy).toMatchObject({ workerId: ben.userId, authorId: owner.userId, status: "pending", date: d.date,
    startAt: values.startedAt, endAt: values.endedAt });
  expect(() => run(owner, { type: "submit", entries: sel(legacy) })).toThrow(/unavailable/);
  expect(() => run(ben, { type: "submit", entries: sel(legacy) })).toThrow(/stage/);
  expect(() => run(ben, { type: "confirm", entries: [{ id: privateRecord.id, revision: privateRecord.revision }] })).toThrow(/unavailable/);
  const confirmed = run(ben, { type: "confirm", entries: sel(legacy) }).entries.find(e => e.id === legacy.id)!;
  const submitted = run(ben, { type: "submit", entries: sel(confirmed) }).entries.find(e => e.id === legacy.id)!;
  expect(state(eva).entries).toMatchObject([{ id: submitted.id, status: "submitted", workerId: ben.userId }]);
  expect(submitted.history.map(h => h.actorId)).toEqual([ben.userId, ben.userId]);
  expect(store.records("local", ben, "timeEntries")).toHaveLength(0);
  expect(store.raw("local", open.id)).toMatchObject({ ownerId: owner.userId, values: {
    serviceDate: d.date, startedAt: values.startedAt, endedAt: values.endedAt, privateNote: values.privateNote,
  } });
});

test("unresolved imported people cannot silently become the owner's time and can be corrected in records", async () => {
  const { store, d, create, run, state } = await fixture();
  const contact = create("people", { name: "Outside contact" });
  const sourceId = memberSource(owner.userId);
  expect(() => store.saveRecord("local", owner, { objectId: "people", id: timeMemberContactId("local", owner.userId),
    create: true, revision: 0, sourceId, values: { name: "Attempted member link" } })).toThrow(/timekeeper picker/);
  // A historical import could already have claimed the label without a canonical contact ID.
  store.transaction(() => {
    store.db.run("UPDATE bo_records SET data=? WHERE scope=? AND id=?", [JSON.stringify({ ...contact, sourceId }), "local", contact.id]);
  }, { action: "test.preexisting-contact" });
  const record = store.saveRecord("local", owner, { objectId: "timeEntries", revision: 0, values: {
    name: "Imported time", matter: d.matterId, client: d.clientId, timekeeper: contact.id,
    startedAt: d.date, recordedMinutes: 10, billableMinutes: 10, status: "Draft",
  } });
  expect(state(owner).entries).toHaveLength(0);
  expect(state(owner).unresolvedLegacyEntries).toEqual([record.id]);
  expect(state(eva).unresolvedLegacyEntries).toBeUndefined();
  expect(() => run(owner, { type: "submit", entries: [{ id: record.id, revision: record.revision }] })).toThrow(/unavailable/);
  const correction = { objectId: record.objectId, id: record.id, revision: record.revision, values: { timekeeper: null } };
  expect(() => store.saveRecord("local", eva, correction)).toThrow(/original entry owner/);
  store.saveRecord("local", owner, correction);
  const legacy = state(owner).entries[0];
  expect(legacy).toMatchObject({ id: record.id, date: d.date, status: "confirmed", workerId: owner.userId });
  expect(legacy.startAt).toBeUndefined();
  expect(legacy.endAt).toBeUndefined();
  expect(state(owner).unresolvedLegacyEntries).toBeUndefined();
  run(owner, { type: "submit", entries: sel(legacy) });
  expect(store.raw("local", record.id)?.values).toMatchObject({ serviceDate: d.date, startedAt: d.date, endedAt: null });
});

test("imported work does not transfer through a hidden timekeeper relation", async () => {
  const { store, d, run, state } = await fixture();
  const scope = "local";
  const timekeeper = timeMemberContact(store, scope, owner, { userId: ben.userId, name: "Worker", email: null });
  const record = store.saveRecord(scope, owner, { objectId: "timeEntries", revision: 0, values: {
    name: "Imported time", matter: d.matterId, client: d.clientId, timekeeper,
    startedAt: d.date, recordedMinutes: 10, billableMinutes: 0,
  } });
  expect(state(ben).entries.map(({ id }) => id)).toEqual([record.id]);
  const model = store.model(scope);
  const writeModel = (objects: typeof model.objects) => store.transaction(() => {
    store.db.run("UPDATE bo_models SET data=? WHERE scope=?", [JSON.stringify({ ...model, objects }), scope]);
  }, { action: "test.replicated-model" });
  writeModel(model.objects.map(object => object.id === "timeEntries" ? {
    ...object, fields: object.fields.map(field => field.id === "timekeeper" ? { ...field, visibility: "private" } : field),
  } : object));
  expect(state(ben).entries).toHaveLength(0);
  expect(state(owner).entries).toHaveLength(0);
  expect(() => run(ben, { type: "confirm", entries: [{ id: record.id, revision: record.revision }] })).toThrow(/unavailable/);

  writeModel(model.objects.map(object => object.id === "people" ? { ...object, archived: true } : object));
  expect(state(ben).entries).toHaveLength(0);
  expect(state(owner).entries).toHaveLength(0);
  expect(state(owner).unresolvedLegacyEntries).toEqual([record.id]);
  expect(() => timeMemberContact(store, scope, owner, { userId: ben.userId, name: "Worker", email: null }))
    .toThrow(/no people directory/);
});

test("a new reviewer sees only the parts of an entry history belonging to accessible matters", async () => {
  const { store, d, run, state } = await fixture();
  const restricted = store.saveRecord("local", owner, {
    objectId: "matters",
    revision: 0,
    access: "members",
    values: { name: "Restricted matter", clients: [d.clientId] },
  });
  const original = run(owner, {
    type: "create",
    requestId: randomUUID(),
    entry: { ...d, matterId: restricted.id, narrative: "Private analysis" },
  }).entries[0];
  const moved = run(owner, { type: "update", ...sel(original)[0], entry: d }).entries[0];
  run(owner, { type: "submit", entries: sel(moved) });
  const history = state(eva).entries[0].history;
  expect(history.map((h) => h.action)).toEqual(["update", "submit"]);
  expect(history[0].before).toBeNull();
  expect(JSON.stringify(history)).not.toContain("Private analysis");
  expect(state(owner).entries[0].history[0].after.narrative).toBe("Private analysis");
});

test("batch wording acceptance checks reviewed text, revision and current rules atomically", async () => {
  const { d, run, state } = await fixture();
  for (const narrative of ["Brief amended", "Memo amended"])
    run(ben, { type: "create", requestId: randomUUID(), entry: { ...d, narrative } });
  run(ben, { type: "submit", entries: state(ben).entries.flatMap(sel) });
  const before = state(eva).entries;
  const entries = before.map((e) => ({
    id: e.id, revision: e.revision, before: e.narrative, after: e.suggestion!,
  }));
  const [first, last] = entries;
  const apply = (changes: typeof entries) => run(eva, { type: "applyWording", entries: changes });
  expect(() => run(ben, { type: "applyWording", entries })).toThrow(/independent/);
  expect(() => apply([first, { ...last, revision: last.revision - 1 }])).toThrow(/changed/);
  expect(() => apply([first, { ...last, after: "Different service" }])).toThrow(/wording/);
  expect(() => apply([first, { ...last, before: "Different input" }])).toThrow(/wording/);
  expect(() => apply([first, first])).toThrow(/once/);
  expect(state(eva).entries).toEqual(before);
  const policy = state(owner).policies[0];
  run(owner, { type: "policy", policy: { ...policy, actionWords: { DFT: "Revising" } } });
  expect(() => apply(entries)).toThrow(/wording/);
  const checked = entries.map((change) => ({ ...change, after: change.after.replace("Amending", "Revising") }));
  const result = apply(checked).entries;
  for (const line of before) {
    const updated = result.find((row) => row.id === line.id)!;
    const expected = checked.find((change) => change.id === line.id)!;
    expect(updated.narrative).toBe(expected.after);
    expect(updated.revision).toBe(line.revision + 1);
    expect(updated.history.at(-1)?.before?.narrative).toBe(expected.before);
    expect(updated.history.at(-1)?.actorId).toBe(eva.userId);
    expect(updated).toMatchObject({
      status: "submitted", submittedNarrative: line.narrative, workerId: line.workerId,
      workedMinutes: line.workedMinutes, billableMinutes: line.billableMinutes,
      workProductId: line.workProductId, hourlyRate: line.hourlyRate, policyDigest: line.policyDigest,
    });
  }
  expect(() => apply(checked)).toThrow(/changed/);
});

test("a suggestion submission shares only the booked line, including when an older client asks for its private original", async () => {
  const {d,run} = await fixture();
  const key=randomUUID(), digest="a".repeat(64);
  const row = run(owner,{type:"create",entry:d,source:"suggestion",requestId:key,proposalDigest:digest}).entries[0];
  expect(()=>run(owner,{type:"submit",entries:[{...sel(row)[0],shareOriginal:{key,digest}}]})).toThrow(/original proposal/);
  expect(run(owner,{type:"submit",entries:sel(row)}).entries[0].sharedOriginal).toBeUndefined();
});

test("a meeting books independently rounded work for each participant and exposes only the author's original allocation", async () => {
  const { store, client, d, run, state } = await fixture();
  const groupId = randomUUID();
  const policy = { rounding: "up" as const, enforceIncrement: true, incrementMinutes: 10 };
  const times = [
    { workerId: owner.userId, workedMinutes: 60, nonBillableMinutes: 13, billableMinutes: proposedCharge(47, policy) },
    { workerId: ben.userId, workedMinutes: 37, nonBillableMinutes: 7, billableMinutes: proposedCharge(30, policy) },
  ];
  const booking: Extract<TimesheetCommand, { type: "create" }> = {
    type: "create",
    requestId: groupId,
    entry: {
      ...d, workedMinutes: 60, billableMinutes: 47, createWorkProduct: true,
      startAt: d.date + "T09:00:00Z", endAt: d.date + "T10:00:00Z",
    },
    workerIds: [owner.userId, ben.userId],
    workerTimes: times,
  };
  expect(requiresTimeAllocations(booking)).toBe(true);
  expect(requiresTimeAllocations({ ...booking, workerTimes: undefined })).toBe(false);
  for (const workerTimes of [
    [times[0], { ...times[1], billableMinutes: 6 }],
    [times[0], { ...times[1], nonBillableMinutes: 38 }],
    [times[0], times[0]],
    [times[0], { ...times[1], workerId: eva.userId }],
  ]) {
    expect(() => run(owner, { ...booking, workerTimes })).toThrow();
    expect(state(owner).products).toHaveLength(0);
    expect(state(ben).entries).toHaveLength(0);
  }
  const saved = run(owner, booking);
  expect(saved.supportsTimeAllocations).toBe(true);
  const self = saved.entries[0], other = state(ben).entries[0];
  expect(self).toMatchObject({ status: "confirmed", groupId, workedMinutes: 60, nonBillableMinutes: 13,
    billableMinutes: 50, startAt: booking.entry.startAt, endAt: booking.entry.endAt });
  expect(other).toMatchObject({ status: "pending", groupId, workedMinutes: 37, nonBillableMinutes: 7, billableMinutes: 30 });
  expect(other.startAt).toBeUndefined();
  expect(other.endAt).toBeUndefined();
  expect(saved.products).toHaveLength(1);
  expect(other.workProductId).toBe(self.workProductId);
  expect(self.workProductId).toBe(saved.products[0].id);
  expect(run(owner, booking).delegatedEntries).toEqual(saved.delegatedEntries);
  expect(state(ben).entries).toHaveLength(1);
  expect(state(eva).delegatedEntries).toEqual([]);
  expect(() => run(owner, { ...booking, workerTimes: [times[0]] })).toThrow(/already used/);
  expect(saved.delegatedEntries).toHaveLength(1);
  const receipt = saved.delegatedEntries![0];
  expect(receipt).toMatchObject({ id: other.id, workerId: ben.userId, groupId, workedMinutes: 37, nonBillableMinutes: 7 });
  for (const key of ["history", "revision", "status", "currency", "hourlyRate", "policyDigest"]) expect(receipt).not.toHaveProperty(key);
  expect(() => run(owner, { type: "confirm", entries: sel(other) })).toThrow(/unavailable/);
  const confirmed = run(ben, { type: "confirm", entries: sel(other) }).entries[0];
  const olderClient = {
    ...d, workedMinutes: 37, billableMinutes: 30,
    workProductId: other.workProductId, narrative: "Revised privately by worker",
  };
  const updated = run(ben, { type: "update", ...sel(confirmed)[0], entry: olderClient }).entries[0];
  expect(nonBillableWork(updated)).toBe(7);
  expect(updated.history.at(-1)?.after.nonBillableMinutes).toBe(7);
  const submitted = run(ben, { type: "submit", entries: sel(updated) }).entries[0];
  const unmodified = run(ben, { type: "update", ...sel(submitted)[0], entry: olderClient }).entries[0];
  expect(unmodified.revision).toBe(submitted.revision);
  const changed = run(ben, {
    type: "update", ...sel(submitted)[0], entry: { ...olderClient, nonBillableMinutes: 0 },
  }).entries[0];
  expect(changed.status).toBe("confirmed");
  expect(changed.history.at(-1)?.before?.nonBillableMinutes).toBe(7);
  expect(nonBillableWork(changed)).toBe(0);
  expect(state(owner).delegatedEntries).toEqual([receipt]);
  expect(JSON.stringify(state(owner).delegatedEntries)).not.toContain(olderClient.narrative);
  expect(state(owner).entries[0].revision).toBe(self.revision);
  store.saveRecord("local", owner, { id: client.id, objectId: "clients", revision: client.revision, archived: true, values: {} });
  expect(state(owner).delegatedEntries).toEqual([]);
});

test("a delegated-only accepted proposal cannot be booked again under another request ID", async () => {
  const { d, run, state } = await fixture();
  const booking: TimesheetCommand = {
    type: "create", requestId: randomUUID(), source: "suggestion", proposalDigest: "e".repeat(64),
    workerIds: [ben.userId], entry: { ...d, billable: false, billableMinutes: 0 },
    workerTimes: [{ workerId: ben.userId, workedMinutes: 7, nonBillableMinutes: 7, billableMinutes: 0 }],
  };
  const created = run(owner, booking);
  expect(created.entries).toHaveLength(0);
  expect(created.delegatedEntries).toHaveLength(1);
  expect(nonBillableWork(state(ben).entries[0])).toBe(7);
  expect(run(owner, booking).delegatedEntries).toEqual(created.delegatedEntries);
  expect(() => run(owner, { ...booking, requestId: randomUUID() })).toThrow(/already been recorded/);
  expect(state(ben).entries).toHaveLength(1);
});

test("an attendee cannot double-book the same timed meeting from a colleague and a workday suggestion", async () => {
  const { run, d, state } = await fixture();
  const meeting = {
    ...d, activity: "INM", startAt: d.date + "T09:00:00Z", endAt: d.date + "T09:17:00Z",
  };
  const invite = () => run(owner, { type: "create", entry: meeting, workerIds: [ben.userId], requestId: randomUUID() });
  invite();
  const capture = {
    type: "create" as const, source: "suggestion" as const, requestId: randomUUID(), proposalDigest: "7".repeat(64),
    entry: { ...meeting, activity: "EXM", narrative: "Captured subject", startAt: d.date + "T10:00:00+01:00", endAt: d.date + "T10:17:00+01:00" },
  };
  expect(() => run(ben, capture)).toThrow(/already has a meeting/);
  const pending = state(ben).entries[0];
  run(ben, { type: "decline", entries: sel(pending) });
  run(ben, capture);
  invite();
  const next = state(ben).entries.find((e) => e.status === "pending")!;
  expect(() => run(ben, { type: "confirm", entries: sel(next) })).toThrow(/already has a meeting/);
  expect(state(ben).entries.filter((e) => e.status === "confirmed")).toHaveLength(1);
  const separate = run(ben, {
    ...capture, requestId: randomUUID(), proposalDigest: "8".repeat(64),
    entry: { ...meeting, startAt: d.date + "T11:00:00Z", endAt: d.date + "T11:17:00Z" },
  });
  expect(separate.entries.filter((e) => e.status === "confirmed")).toHaveLength(2);
});

test("invoice review keeps original manual wording and allocates a whole-invoice target against protected staff", async () => {
  const { store, d, run, state } = await fixture();
  const firm = state(eva).policies[0];
  run(eva, { type: "policy", policy: { ...firm, workerRates: { [owner.userId]: 10500, [ben.userId]: 2000 } } });
  const book = (worker: BackOfficeActor, narrative: string, minutes: number, date: string) => {
    const saved = run(worker, {
      type: "create", requestId: randomUUID(), entry: { ...d, date, narrative, workedMinutes: minutes, billableMinutes: minutes },
    }).entries.find((entry) => entry.narrative === narrative)!;
    const submitted = run(worker, { type: "submit", entries: sel(saved) }).entries.find((entry) => entry.id === saved.id)!;
    return run(eva, { type: "approve", entries: sel(submitted) }).entries.find((entry) => entry.id === saved.id)!;
  };
  const earlier = book(owner, "Ammending earlier memo", 30, "2026-08-21");
  const later = book(owner, "Later memo amended", 30, "2026-11-12");
  const protectedLine = book(ben, "Independent review", 60, "2026-11-12");
  const period = { to: "2026-11-12" };
  expect(() => run(eva, prepareInvoice([later, protectedLine], [], { period }))).toThrow(/open entries/);
  const entries = [earlier, later, protectedLine];
  const selection: NonNullable<InvoiceDraftInput["reduction"]>["scope"] = { type: "people", ids: [owner.userId] };
  const draftCommand = prepareInvoice(entries, [], {
    period,
    wording: [earlier.id],
    reduction: { scope: selection, adjustment: { type: "target", amountMinor: 700001, basis: "invoice" } },
  });
  const preview = run(eva, draftCommand);
  expect(preview.invoiceDraft).toMatchObject({ totalMinor: 700001, protectedMinor: 200000, selectedBaseMinor: 1050000, selectedTotalMinor: 500001 });
  expect(preview.invoiceDraft?.lines[0]).toMatchObject({
    originalNarrative: "Ammending earlier memo", currentNarrative: "Ammending earlier memo", suggestedNarrative: "Amending earlier memo",
    entry: { narrative: "Amending earlier memo", workerId: owner.userId, authorId: owner.userId, workedMinutes: 30 },
    actualAmountMinor: 525000, baseAmountMinor: 525000,
  });
  expect(preview.invoiceDraft?.lines[1]).toMatchObject({ suggestedNarrative: "Amending Later memo", entry: { narrative: "Later memo amended" } });
  const fullAmounts = Object.fromEntries(preview.invoiceDraft?.lines.map(({ entry, amountMinor }) => [entry.id, amountMinor]) ?? []);
  expect(fullAmounts[protectedLine.id]).toBe(200000);
  const [first, second] = [earlier.id, later.id].sort();
  expect(fullAmounts[first]).toBe(250001);
  expect(fullAmounts[second]).toBe(250000);
  expect(() => run(eva, prepareInvoice(entries, [], {
    period, reduction: { scope: selection, adjustment: { type: "target", amountMinor: 199999, basis: "invoice" } },
  }))).toThrow(/protected/);
  const selectedTarget = run(eva, prepareInvoice(entries, [], {
    period, reduction: { scope: selection, adjustment: { type: "target", amountMinor: 700001, basis: "selection" } },
  }));
  expect(selectedTarget.invoiceDraft).toMatchObject({ totalMinor: 900001, selectedTotalMinor: 700001 });
  const percent = run(eva, prepareInvoice(entries, [], {
    period, reduction: { scope: { type: "entries", ids: [earlier.id] }, adjustment: { type: "percent", basisPoints: 3333 } },
  }));
  expect(percent.invoiceDraft).toMatchObject({ totalMinor: 1075018, protectedMinor: 725000, selectedTotalMinor: 350018 });
  const reviewed = run(eva, draftCommand);
  const issueAsReviewer = (command: TimesheetCommand) => run(eva, command);
  const issue = approveInvoice(issueAsReviewer, reviewed);
  const invoice = issueAsReviewer(issue).invoices[0];
  expect(invoice.approval).toMatchObject({ actorId: eva.userId, revision: reviewed.invoiceDraft?.revision });
  expect(invoice.entries.find((entry) => entry.id === earlier.id)).toMatchObject({
    originalNarrative: "Ammending earlier memo", narrative: "Amending earlier memo", amountMinor: fullAmounts[earlier.id],
  });
  expect(state(owner).entries.find((entry) => entry.id === earlier.id)?.narrative).toBe("Ammending earlier memo");
  const correction = run(owner, {
    type: "adjust", ...sel(state(owner).entries.find((entry) => entry.id === earlier.id)!)[0],
    requestId: randomUUID(), reason: "Remove the billed line", narrative: "Removed service", billableMinutes: 0,
  }).adjustments![0];
  expect(correction.deltaAmount).toBe(-fullAmounts[earlier.id] / 100);
  expect(store.raw("local", protectedLine.id)?.values.invoice).toBe(invoice.id);
});

test("changing fixed-price wording, hours, or the template requires a new invoice approval", async () => {
  const { store, d, run } = await fixture();
  const created = run(owner, { type: "create", requestId: randomUUID(), entry: d }).entries[0];
  const submitted = run(owner, { type: "submit", entries: sel(created) }).entries[0];
  const approved = run(eva, { type: "approve", entries: sel(submitted) }).entries[0];
  const reviewer = (command: TimesheetCommand) => run(eva, command);
  const fixedPrice = { mode: "fixed", currency: "EUR", amountMinor: 120000, showHours: true } as const;
  const visibleHours = reviewer(prepareInvoice([approved], [], { pricing: fixedPrice }));
  const oldIssue = approveInvoice(reviewer, visibleHours);
  const hideHours = prepareInvoice([approved], [], {
    pricing: { ...fixedPrice, showHours: false }, edits: [{ id: approved.id, narrative: "Reviewing the final memo" }],
  });
  const withoutHours = reviewer(hideHours);
  expect(withoutHours.invoiceDraft?.approval).toBeUndefined();
  expect(() => reviewer(oldIssue)).toThrow(/changed/);
  const previousTemplateIssue = approveInvoice(reviewer, withoutHours);
  reviewer({ type: "template", template: { revision: 0, locale: "en-GB", title: "Fixture invoice", letterhead: "Fixture firm", footer: "" } });
  expect(() => reviewer(previousTemplateIssue)).toThrow(/template changed/);
  const updated = reviewer(hideHours);
  const issued = reviewer(approveInvoice(reviewer, updated)).invoices[0];
  expect(issued).toMatchObject({ billingMode: "fixed", showHours: false, totalMinor: 120000, templateRevision: 1 });
  const artifact = readTimeDocument(store, "local", issued.id);
  expect(artifact?.kind === "invoice" && artifact.document).toContain("Fixture invoice 1");
  expect(artifact?.kind === "invoice" && artifact.document).not.toContain("Actual hours");
  expect(issued.entries[0].narrative).toBe("Reviewing the final memo");
  expect(issued.entries[0].workedMinutes).toBe(d.workedMinutes);
});

test("a model wording suggestion for a manual entry stays separate until the reviewer selects it", async () => {
  const { store, d, run, state } = await fixture();
  const created = run(owner, { type: "create", requestId: randomUUID(), entry: { ...d, narrative: "Drafing a memo" } }).entries[0];
  const submitted = run(owner, { type: "submit", entries: sel(created) }).entries[0];
  const approved = run(eva, { type: "approve", entries: sel(submitted) }).entries[0];
  const prepared = run(eva, prepareInvoice([approved]));
  const model = { workspaceId: "fixture", providerID: "fixture", modelID: "proofreader" };
  const request: TimesheetCommand = { type: "reviewInvoiceWording", ...invoiceDraftRef(prepared), model };
  expect(() => run(eva, request)).toThrow(/No invoice wording review/);
  const suggested = commandTimesheet(store, "local", eva, people, request, [], [
    { id: approved.id, narrative: "Drafting a memo", rule: "spelling" },
  ]);
  expect(suggested.invoiceDraft?.lines[0]).toMatchObject({
    originalNarrative: "Drafing a memo", suggestedNarrative: "Drafting a memo", modelRule: "spelling", entry: { narrative: "Drafing a memo" },
  });
  const selected = prepareInvoice([approved], [], {
    wording: [approved.id], expectedSuggestions: [{ id: approved.id, narrative: "Drafting a memo" }],
  });
  expect(run(eva, selected).invoiceDraft?.lines[0].entry.narrative).toBe("Drafting a memo");
  expect(state(owner).entries[0].narrative).toBe("Drafing a memo");
});

test("invoice wording uses the reviewing profile's authorized service-date guideline versions", async () => {
  const { store, d, client, matter, create, run, state } = await fixture();
  const anotherClient = create("clients", { name: "Another client" });
  store.saveRecord("local", owner, { ...matter, values: { clients: [client.id, anotherClient.id] } });
  const book = (date: string) => {
    const created = run(owner, { type: "create", requestId: randomUUID(), entry: { ...d, date, narrative: "Drafing a memo" } })
      .entries.find((entry) => entry.date === date)!;
    const submitted = run(owner, { type: "submit", entries: sel(created) }).entries.find((entry) => entry.id === created.id)!;
    return run(eva, { type: "approve", entries: sel(submitted) }).entries.find((entry) => entry.id === created.id)!;
  };
  const before = book("2026-08-21"), after = book("2026-11-12");
  const guideline: import("@legalwork/types/time-capture").WorkdayGuideline = {
    id: randomUUID(), revision: 1, name: "Client vocabulary", scope: "client", targetId: client.id, effectiveFrom: "2026-01-01",
    rules: { narrativeCorrections: { Drafing: "Preparing" }, instructions: "Confidential early billing guidance." },
  };
  const september = { ...guideline, revision: 2, effectiveFrom: "2026-09-01", rules: {
    narrativeCorrections: { Drafing: "Drafting" }, instructions: "Confidential billing guidance for this client." },
  };
  const unrelated = { ...september, id: randomUUID(), name: "Another client instructions", targetId: anotherClient.id };
  const uploaded = [guideline, september, unrelated];
  const profile = { profileId: "reviewer-one", versions: uploaded };
  const reviewer = (command: TimesheetCommand, context = profile) => commandTimesheet(store, "local", eva, people, command, [], undefined, context);
  const prepared = prepareInvoice([before, after]);
  const preview = reviewer(prepared);
  expect(preview.invoiceDraft?.lines.map((line) => [line.suggestedNarrative, line.guidelineVersions?.map(({ revision }) => revision)]))
    .toEqual([["Preparing a memo", [1]], ["Drafting a memo", [2]]]);
  expect(JSON.stringify(preview.invoiceDraft)).not.toContain("Confidential");
  expect(state(eva).invoiceDraft).toBeUndefined();
  expect(() => reviewer({ type: "approveInvoice", ...invoiceDraftRef(preview) }, { ...profile, profileId: "reviewer-two" })).toThrow(/draft changed/);
  const issue = approveInvoice(reviewer, preview);
  const irrelevant = { ...profile, versions: [...uploaded, { ...unrelated, revision: 3, rules: { instructions: "Unrelated change" } }] };
  expect(reviewer(prepared, irrelevant).invoiceDraft?.approval?.revision).toBe(preview.invoiceDraft?.revision);
  const changed = { ...profile, versions: [...uploaded, { ...september, revision: 3, rules: { ...september.rules, instructions: "New wording guidance" } }] };
  expect(() => reviewer(issue, changed)).toThrow(/content or template changed/);
  expect(reviewer(prepared, changed).invoiceDraft?.approval).toBeUndefined();
  expect(state(owner).entries.every((entry) => entry.narrative === "Drafing a memo")).toBe(true);
});
