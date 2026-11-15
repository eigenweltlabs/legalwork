import { afterEach, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import {
  proposedCharge,
  resolveTimePolicy,
  type TimeDraft,
  type TimesheetCommand,
  type TimeEntry,
} from "@legalwork/types/timesheet";
import { openSqlite } from "../runtime-db.js";
import { BackOfficeStore } from "./store.js";
import { unknownRecords } from "./first-sync.js";
import { commandTimesheet } from "./timesheet.js";
import { submitFirmComparisons } from "./timesheet-sharing.js";
import { readTimeDocument, readTimesheet } from "./timesheet-data.js";
import type { BackOfficeActor } from "./schema.js";

const owner = { userId: "alice", edit: true, finance: true, model: true },
  ben = { ...owner, userId: "ben", finance: false },
  eva = { ...owner, userId: "eva" };
const people = [owner, ben, eva].map((a) => ({ id: a.userId, name: a.userId }));
const stores: BackOfficeStore[] = [];
afterEach(() => {
  while (stores.length) stores.pop()?.close();
});
async function fixture() {
  const store = new BackOfficeStore(await openSqlite(":memory:"));
  stores.push(store);
  const create = (objectId: string, values: Record<string, string | string[]>) =>
    store.saveRecord("local", owner, { objectId, values, revision: 0 });
  const client = create("clients", { name: "Fixture client" }),
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
  const entries = state(eva).entries,
    one = {
      type: "invoice",
      requestId: randomUUID(),
      entries: sel(entries[0]),
    } as const;
  const issued = run(eva, one).invoices[0];
  expect(issued.number).toBe(1043);
  expect(issued.total).toBe(100);
  expect(run(eva, one).invoices[0].id).toBe(issued.id);
  expect(() => run(eva, { ...one, requestId: randomUUID() })).toThrow(/changed/);
  const invoices = run(eva, {
    type: "invoice",
    requestId: randomUUID(),
    entries: sel(entries[1]),
  }).invoices;
  expect(invoices.map((i) => i.number).sort()).toEqual([1043, 1044]);
  const artifact = readTimeDocument(store, "local", issued.id);
  expect(artifact?.kind === "invoice" && artifact.document).toContain("&lt;file&gt;");
  expect(state(ben).invoices).toHaveLength(0);
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
    run(owner, {
      type: "invoice",
      requestId: randomUUID(),
      entries: sel(legacy),
    }),
  ).toThrow(/approved, priced/);
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
  const issue = {
    type: "invoice",
    requestId: randomUUID(),
    entries: sel(approved),
  } as const;
  expect(() => run(eva, issue)).toThrow(/pending corrections/);
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
  expect(() => run(eva, issue)).toThrow(/corrections changed/);
  const issued = run(eva, {
    ...issue,
    adjustmentVersions: [{ id: adjusted.id, revision: adjusted.revision }],
  }).invoices[0];
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
  expect(() =>
    run(eva, {
      type: "invoice",
      requestId: randomUUID(),
      entries: sel(approved),
    }),
  ).toThrow(/up to 90/);
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

test("workers share only verified billing fields on their chosen submission, with fresh consent after return", async () => {
  const { store, d, run, state } = await fixture();
  const key = randomUUID(), digest = "a".repeat(64);
  const first = run(owner, {
    type: "create", entry: d, source: "suggestion", requestId: key, proposalDigest: digest,
  }).entries[0];
  const original = { activity: "RES", narrative: "Original work", workedMinutes: null };
  const originals = new Map([[digest, original]]);
  const submit = { type: "submit", entries: [{ ...sel(first)[0], shareOriginal: { key, digest } }] } as const;
  const share = () => commandTimesheet(store, "local", owner, people, submit, [], originals);

  // The device must resolve the original from its own verified store, never from client-supplied fields.
  expect(() => commandTimesheet(store, "local", owner, people, submit)).toThrow(/verified original/);
  expect(() => commandTimesheet(store, "local", owner, people, { ...submit, sharedBillingOriginals: [original] })).toThrow();
  expect(() => commandTimesheet(store, "local", owner, people, {
    ...submit, entries: [{ ...submit.entries[0], shareOriginal: { key: randomUUID(), digest } }],
  }, [], originals)).toThrow(/verified original/);
  expect(state(eva).entries).toHaveLength(0);
  const shared = share().entries[0];
  expect(state(eva).entries[0].sharedOriginal).toEqual({ ...original, submittedRevision: shared.revision });
  expect(state(ben).entries).toHaveLength(0);
  expect(() => share()).toThrow(/changed/);
  run(eva, { type: "return", entries: sel(shared), reason: "Check text" });
  const resubmitted = run(owner, { type: "submit", entries: sel(state(owner).entries[0]) }).entries[0];
  expect(resubmitted.sharedOriginal).toBeUndefined();
  expect(state(eva).entries[0].sharedOriginal).toBeUndefined();

  const current = { ...state(owner), entries: [first] };
  const cmd: Extract<TimesheetCommand, { type: "submit" }> = { type: "submit", entries: [...submit.entries] };
  let reads = 0, sent = 0;
  const read = async () => { reads++; return originals; };
  const post = async (body: unknown) => {
    sent++;
    expect(body).toEqual({
      type: "submit", entries: sel(first), reason: undefined,
      sharedBillingOriginals: [{ ...original, id: first.id, revision: first.revision, digest }],
    });
    return { ...current, entries: [shared] };
  };
  await expect(submitFirmComparisons(cmd, { ...current, supportsBillingComparisons: false }, read, post)).rejects.toThrow(/does not support/);
  await expect(submitFirmComparisons(cmd, { ...current, entries: [shared] }, read, post)).rejects.toThrow(/Refresh/);
  expect([reads, sent]).toEqual([0, 0]);
  expect((await submitFirmComparisons(cmd, current, read, post)).entries[0].sharedOriginal).toEqual(shared.sharedOriginal);
  await expect(submitFirmComparisons(cmd, current, read, async () => current)).rejects.toThrow(/did not confirm/);
});
